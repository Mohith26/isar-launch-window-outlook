// Launch Window Outlook: the probability that a Spectrum launch campaign gets off the pad by a
// given date, computed from 31 years of hourly ERA5 weather at the pad, the daily launch window
// (fixed, or derived from the target orbit), launch commit criteria, and a scrub/turnaround model.
// Pure ES module, no dependencies, no Math.random; used by the page, the report script and tests.
//
// 1. Window geometry. For a sun-synchronous orbit the plane is fixed relative to the Sun: RAAN =
//    sun right ascension + 15 deg x (LTAN - 12 h). The pad lies in the plane when its sidereal angle
//    minus RAAN equals atan2(cos i sin u, +-cos u) with u = asin(sin(lat) / sin(i)) (northbound / +,
//    southbound / -). i comes from the J2 node-rate condition. Solved per day by fixed-point
//    iteration on GMST and a low-precision solar ephemeris (Astronomical Almanac, ~0.01 deg).
// 2. Weather. Each hour is scored against the launch commit criteria (bit mask of the criteria it
//    fails). A day is GO if at least one hourly sample inside the window passes every launch
//    criterion and the pre-launch operations period (rollout/fuelling) stays under the ground-ops
//    gust limit.
// 3. Campaign. For every historical season the day-by-day GO sequence is replayed through an exact
//    dynamic program over (day, consecutive attempt days): a GO day is an attempt that succeeds with
//    probability 1 - pTech, otherwise the team stands down for the turnaround; after maxConsecutive
//    attempt days the crew rests. The result is the exact launch-day distribution for that season
//    (no Monte Carlo); seasons are averaged with equal weight and the uncertainty band comes from a
//    seeded bootstrap over seasons.
// 4. Attribution. Lost window-days are attributed to criteria with exact Shapley values (all 2^m
//    criterion subsets), so the shares add up to the total lost-day rate.

export const DAY = 86400000, HOUR = 3600000;
const D2R = Math.PI / 180, R2D = 180 / Math.PI;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ------------------------------------------------------------------------------- weather data
/** Decode a packed site (4 bytes/hour, see scripts/fetch_era5.py). */
export function decodeSite(bytes, startIso, meta = {}) {
  const n = Math.floor(bytes.length / 4);
  const wind = new Float32Array(n), gust = new Float32Array(n), temp = new Float32Array(n), code = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    wind[i] = bytes[4 * i] / 4; gust[i] = bytes[4 * i + 1] / 4; temp[i] = bytes[4 * i + 2] / 2 - 60; code[i] = bytes[4 * i + 3];
  }
  return { ...meta, n, wind, gust, temp, code, start: Date.parse(startIso) };
}

export const CRITERIA = [
  { key: 'wind', label: 'Sustained wind', unit: 'm/s', note: '10 m mean wind above limit' },
  { key: 'gust', label: 'Wind gusts', unit: 'm/s', note: '10 m gust above limit' },
  { key: 'snow', label: 'Snow / icing', unit: '', note: 'moderate or heavy snow, or freezing precipitation' },
  { key: 'thunder', label: 'Thunderstorm', unit: '', note: 'thunderstorm in the hour' },
  { key: 'cold', label: 'Cold limit', unit: '°C', note: '2 m temperature below limit' },
  { key: 'ops', label: 'Pre-launch ops wind', unit: 'm/s', note: 'gust above the ground-ops limit during rollout and fuelling' },
];
export const BIT = Object.fromEntries(CRITERIA.map((c, k) => [c.key, 1 << k]));
export const ALL = (1 << CRITERIA.length) - 1;

/**
 * Default launch commit criteria (assumptions, editable on the page). Spectrum's real criteria are
 * not public. Limits are on ERA5 grid-cell values (smoother than a pad anemometer) and were chosen
 * to be consistent with Isar's public 2025-2026 campaign log (see backtest()).
 */
export const DEFAULT_CRIT = { maxWind: 9, maxGust: 13, minTemp: -15, opsGust: 15, opsHours: 8, noSnow: true, noThunder: true };

const SNOWY = new Set([56, 57, 66, 67, 73, 75, 77, 85, 86]); // freezing drizzle/rain, moderate/heavy snow, snow grains, snow showers
const THUNDER = (c) => c >= 95 && c <= 99;

/** Launch-criteria failure mask for hour index i (0 = passes). */
export function hourFail(S, i, crit = DEFAULT_CRIT) {
  if (i < 0 || i >= S.n) return ALL;
  let m = 0;
  if (S.wind[i] > crit.maxWind) m |= BIT.wind;
  if (S.gust[i] > crit.maxGust) m |= BIT.gust;
  if (crit.noSnow && SNOWY.has(S.code[i])) m |= BIT.snow;
  if (crit.noThunder && THUNDER(S.code[i])) m |= BIT.thunder;
  if (S.temp[i] < crit.minTemp) m |= BIT.cold;
  return m;
}

/** Hours (indices) whose sample time lies inside [t0, t1]; at least the nearest hour. */
export function windowHours(S, t0, t1) {
  const a = Math.ceil((t0 - S.start) / HOUR), b = Math.floor((t1 - S.start) / HOUR);
  if (b >= a) { const out = []; for (let i = a; i <= b; i++) out.push(i); return out; }
  return [Math.round(((t0 + t1) / 2 - S.start) / HOUR)];
}

/**
 * Evaluate one daily window. Returns { go, mask } where mask holds, for a no-go day, the criteria
 * that fail in EVERY window hour (plus 'ops' if the pre-launch period failed), and `fails(sub)`
 * says whether the day would be no-go if only the criteria in bit set `sub` were enforced.
 */
export function evalWindow(S, t0, t1, crit = DEFAULT_CRIT) {
  const hrs = windowHours(S, t0, t1);
  const masks = hrs.map((i) => hourFail(S, i, crit));
  let opsFail = false;
  const opsStart = Math.floor((t0 - crit.opsHours * HOUR - S.start) / HOUR), opsEnd = Math.floor((t0 - S.start) / HOUR);
  for (let i = Math.max(0, opsStart); i < Math.min(S.n, opsEnd); i++) if (S.gust[i] > crit.opsGust) { opsFail = true; break; }
  if (opsStart < 0 || opsEnd > S.n || hrs[hrs.length - 1] >= S.n || hrs[0] < 0) return { go: false, missing: true, masks, opsFail: true, mask: ALL };
  const fails = (sub) => ((sub & BIT.ops) && opsFail) || masks.every((m) => (m & sub) !== 0);
  const go = !fails(ALL);
  let mask = 0;
  if (!go) { mask = masks.reduce((a, m) => a & m, ALL & ~BIT.ops); if (opsFail) mask |= BIT.ops; }
  return { go, mask, masks, opsFail, hrs, fails };
}

// ------------------------------------------------------------------------------- orbit geometry
export const MU = 398600.4418, RE = 6378.137, J2 = 1.08262668e-3;
const julian = (ms) => ms / DAY + 2440587.5;
/** Greenwich mean sidereal angle in degrees (IAU 1982, adequate to ~0.1 s). */
export function gmstDeg(ms) {
  const d = julian(ms) - 2451545.0, T = d / 36525;
  return (((280.46061837 + 360.98564736629 * d + 0.000387933 * T * T) % 360) + 360) % 360;
}
/** Apparent solar right ascension in degrees (low-precision Astronomical Almanac formula). */
export function sunRaDeg(ms) {
  const n = julian(ms) - 2451545.0;
  const L = 280.460 + 0.9856474 * n, g = (357.528 + 0.9856003 * n) * D2R;
  const lam = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R, eps = (23.439 - 0.0000004 * n) * D2R;
  return ((Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam)) * R2D) % 360 + 360) % 360;
}
/** Sun-synchronous inclination (deg) for a circular orbit at altitude h km (J2 node rate = 360 deg / tropical year). */
export function ssoInclination(hKm) {
  const a = RE + hKm, n = Math.sqrt(MU / (a * a * a));
  const want = (2 * Math.PI) / (365.2422 * 86400);
  const c = -want / (1.5 * J2 * (RE / a) ** 2 * n);
  if (c < -1 || c > 1) return NaN;
  return Math.acos(c) * R2D;
}
export const wrapDeg = (x) => ((x % 360) + 540) % 360 - 180; // to (-180, 180]
const wrap = wrapDeg;
/**
 * UTC time (ms) on the UTC day starting at dayMs when the pad lies in the orbit plane.
 * dir 'north' = northbound pass (Andoya launches north over the Norwegian Sea).
 */
export function inPlaneTime(dayMs, latDeg, lonDeg, incDeg, ltanHours, dir = 'north') {
  const i = incDeg * D2R, phi = latDeg * D2R;
  const su = Math.sin(phi) / Math.sin(i);
  if (Math.abs(su) > 1) return NaN;
  const u = Math.asin(su);
  const delta = Math.atan2(Math.cos(i) * Math.sin(u), (dir === 'north' ? 1 : -1) * Math.cos(u)) * R2D;
  let t = dayMs + DAY / 2;
  for (let k = 0; k < 4; k++) {
    const raan = sunRaDeg(t) + 15 * (ltanHours - 12);
    const err = wrap(gmstDeg(t) + lonDeg - raan - delta); // degrees of rotation still to go
    t -= (err / 360) * DAY; // sidereal angle minus RAAN advances 360.9856 - 0.9856 = 360 deg per day
  }
  // bring into [dayMs, dayMs + DAY)
  while (t < dayMs) t += DAY; while (t >= dayMs + DAY) t -= DAY;
  return t;
}
/** LTAN (hours) implied by an in-plane time t (inverse of inPlaneTime, same geometry). */
export function impliedLtan(t, latDeg, lonDeg, incDeg, dir = 'north') {
  const i = incDeg * D2R, u = Math.asin(Math.sin(latDeg * D2R) / Math.sin(i));
  const delta = Math.atan2(Math.cos(i) * Math.sin(u), (dir === 'north' ? 1 : -1) * Math.cos(u)) * R2D;
  const raan = gmstDeg(t) + lonDeg - delta;
  return (((raan - sunRaDeg(t)) / 15 + 12) % 24 + 24) % 24;
}

// ------------------------------------------------------------------------------- campaign plan
/**
 * plan = { site, openMonth (1-12), openDay, horizon (days), deadline (days after open),
 *          windowMode: 'fixed'|'orbit', winStartMin (UTC minutes), winDurMin,
 *          altKm, ltan, dir, crit, pTech, techTurn (days), maxConsec, rest (days) }
 */
export const DEFAULT_PLAN = {
  site: 'andoya', openMonth: 11, openDay: 26, horizon: 84, deadline: 7,
  windowMode: 'fixed', winStartMin: 20 * 60, winDurMin: 90, altKm: 510, ltan: 23.3, dir: 'north',
  crit: DEFAULT_CRIT, pTech: 0.3, techTurn: 3, maxConsec: 3, rest: 1,
};

/** Window [t0, t1] (ms) on the UTC day dayMs. */
export function windowFor(plan, S, dayMs) {
  if (plan.windowMode === 'orbit') {
    const inc = ssoInclination(plan.altKm);
    const tc = inPlaneTime(dayMs, S.lat, S.lon, inc, plan.ltan, plan.dir);
    return [tc - (plan.winDurMin / 2) * 60000, tc + (plan.winDurMin / 2) * 60000];
  }
  const t0 = dayMs + plan.winStartMin * 60000;
  return [t0, t0 + plan.winDurMin * 60000];
}

/** Seasons available in the data: years y whose campaign (open .. open + horizon) is fully covered. */
export function seasonYears(S, plan) {
  const out = [];
  const first = new Date(S.start).getUTCFullYear(), last = new Date(S.start + S.n * HOUR).getUTCFullYear();
  for (let y = first; y <= last; y++) {
    const open = Date.UTC(y, plan.openMonth - 1, plan.openDay);
    if (open - 2 * DAY >= S.start && open + (plan.horizon + 1) * DAY <= S.start + S.n * HOUR) out.push(y);
  }
  return out;
}

/** Day-by-day window evaluations for every season: seasons[s].days[k] = evalWindow result. */
export function seasonGrid(S, plan) {
  return seasonYears(S, plan).map((y) => {
    const open = Date.UTC(y, plan.openMonth - 1, plan.openDay);
    const days = [];
    for (let k = 0; k < plan.horizon; k++) { const d = open + k * DAY; const [t0, t1] = windowFor(plan, S, d); days.push({ ...evalWindow(S, t0, t1, plan.crit), t0, t1 }); }
    return { year: y, open, days };
  });
}

/**
 * Exact launch-day distribution for one GO/NO-GO sequence. Returns Float64Array pmf of length
 * go.length + 1; pmf[k] = P(launch on day k), last entry = P(not launched within the horizon).
 */
export function campaignPmf(go, { pTech = 0.3, techTurn = 3, maxConsec = 3, rest = 1 } = {}) {
  const H = go.length, C = Math.max(1, maxConsec);
  const p = Array.from({ length: H + 1 }, () => new Float64Array(C + 1));
  const pmf = new Float64Array(H + 1);
  p[0][0] = 1;
  for (let d = 0; d < H; d++) for (let c = 0; c <= C; c++) {
    const m = p[d][c]; if (!m) continue;
    if (c === C) { const nd = Math.min(H, d + rest); if (nd >= H) pmf[H] += m; else p[nd][0] += m; continue; }
    if (!go[d]) { if (d + 1 >= H) pmf[H] += m; else p[d + 1][0] += m; continue; }
    pmf[d] += m * (1 - pTech);
    const s = m * pTech;
    if (!s) continue;
    // after a scrub on an attempt day: a turnaround of techTurn days, which also resets crew count
    const nd = d + Math.max(1, techTurn);
    if (nd >= H) pmf[H] += s; else if (techTurn <= 1 && c + 1 < C) p[nd][c + 1] += s; else p[nd][0] += s;
  }
  return pmf;
}

const quantileDay = (cdf, q) => { for (let k = 0; k < cdf.length; k++) if (cdf[k] >= q - 1e-12) return k; return Infinity; };

/** Combine seasons: mean pmf, cdf, quantiles, P(by deadline), bootstrap band over seasons. */
export function summarize(grid, plan, { boot = 400, seed = 20261126 } = {}) {
  const H = plan.horizon;
  const pmfs = grid.map((s) => campaignPmf(s.days.map((d) => d.go), plan));
  const cdfOf = (idx) => { const c = new Float64Array(H); let acc = 0; for (let k = 0; k < H; k++) { for (const s of idx) acc += pmfs[s][k] / idx.length; c[k] = acc; } return c; };
  const all = grid.map((_, s) => s);
  const cdf = cdfOf(all);
  const dl = Math.min(H, plan.deadline) - 1;
  const byDeadline = dl >= 0 ? cdf[dl] : 0;
  // weather-only facts
  const goRate = grid.reduce((a, s) => a + s.days.filter((d) => d.go).length, 0) / (grid.length * H);
  const firstGo = grid.map((s) => { const k = s.days.findIndex((d) => d.go); return k < 0 ? Infinity : k; });
  const r = mulberry32(seed), bs = [];
  for (let b = 0; b < boot; b++) {
    const idx = all.map(() => Math.floor(r() * all.length));
    let v = 0; for (const s of idx) for (let k = 0; k <= dl; k++) v += pmfs[s][k] / idx.length; bs.push(v);
  }
  bs.sort((a, b) => a - b);
  if (!boot) bs.push(byDeadline);
  // per-day 90% band of the cumulative curve (same seeded bootstrap scheme)
  let bandLo = null, bandHi = null;
  if (boot) {
    const r2 = mulberry32(seed + 1), B = Math.min(boot, 200), cols = Array.from({ length: H }, () => new Float64Array(B));
    for (let b = 0; b < B; b++) { const idx = all.map(() => Math.floor(r2() * all.length)); const c = cdfOf(idx); for (let k = 0; k < H; k++) cols[k][b] = c[k]; }
    bandLo = new Float64Array(H); bandHi = new Float64Array(H);
    for (let k = 0; k < H; k++) { const v = cols[k].sort(); bandLo[k] = v[Math.floor(0.05 * B)]; bandHi[k] = v[Math.ceil(0.95 * B) - 1]; }
  }
  const perSeason = grid.map((s, i) => ({ year: s.year, byDeadline: pmfs[i].slice(0, dl + 1).reduce((a, b) => a + b, 0), firstGo: firstGo[i], goDays: s.days.filter((d) => d.go).length }));
  return {
    seasons: grid.length, cdf, bandLo, bandHi, byDeadline, band: [bs[Math.floor(0.05 * boot)], bs[Math.ceil(0.95 * boot) - 1]],
    p50: quantileDay(cdf, 0.5), p80: quantileDay(cdf, 0.8), p90: quantileDay(cdf, 0.9), withinHorizon: cdf[H - 1],
    goRate, firstGoMedian: median(firstGo), firstGoWithin7: firstGo.filter((k) => k < 7).length / firstGo.length, perSeason,
  };
}
export function median(a) { const s = [...a].sort((x, y) => x - y), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; }

/** Calendar: per day offset, fraction of seasons with a GO window. */
export function goCalendar(grid, H) { const out = new Float64Array(H); for (const s of grid) s.days.forEach((d, k) => { if (d.go) out[k] += 1 / grid.length; }); return out; }

/**
 * Exact Shapley attribution of the no-go day rate to the criteria. v(S) = share of window-days
 * that are no-go when only criteria in S are enforced; phi_k sums to v(all).
 */
export function shapley(grid) {
  const m = CRITERIA.length, days = grid.flatMap((s) => s.days.filter((d) => !d.missing));
  const v = new Float64Array(1 << m);
  for (let S = 1; S < 1 << m; S++) { let c = 0; for (const d of days) if (d.fails(S)) c++; v[S] = c / days.length; }
  const fact = [1]; for (let k = 1; k <= m; k++) fact[k] = fact[k - 1] * k;
  const pop = (x) => { let c = 0; while (x) { c += x & 1; x >>= 1; } return c; };
  const phi = CRITERIA.map((_, k) => {
    let s = 0;
    for (let S = 0; S < 1 << m; S++) if (!(S & (1 << k))) { const n = pop(S); s += (fact[n] * fact[m - n - 1] / fact[m]) * (v[S | (1 << k)] - v[S]); }
    return s;
  });
  return { total: v[(1 << m) - 1], phi, v };
}

/** Window-duration sweep: P(launch by deadline) for each duration (minutes). */
export function durationSweep(S, plan, durations) {
  return durations.map((dur) => { const p = { ...plan, winDurMin: dur }; return { dur, byDeadline: summarize(seasonGrid(S, p), p, { boot: 0 }).byDeadline }; });
}

/** Share of window-nights that are GO as one launch limit varies (e.g. maxWind 6..15 m/s). */
export function limitSweep(S, plan, key, values) {
  return values.map((v) => { const p = { ...plan, crit: { ...plan.crit, [key]: v } }; const g = seasonGrid(S, p); return { value: v, goRate: g.reduce((a, s) => a + s.days.filter((d) => d.go).length, 0) / (g.length * p.horizon) }; });
}

/** Month x hour availability heatmap: share of days in the month whose hour passes launch criteria. */
export function monthHourGrid(S, crit = DEFAULT_CRIT) {
  const g = Array.from({ length: 12 }, () => new Float64Array(24)), n = Array.from({ length: 12 }, () => new Float64Array(24));
  for (let i = 0; i < S.n; i++) { const d = new Date(S.start + i * HOUR), mo = d.getUTCMonth(), h = d.getUTCHours(); n[mo][h]++; if (!hourFail(S, i, crit)) g[mo][h]++; }
  return g.map((row, mo) => Array.from(row, (x, h) => x / n[mo][h]));
}

/** Backtest the criteria against dated events from Isar's public campaign log. */
export function backtest(S, events, crit = DEFAULT_CRIT) {
  return events.map((e) => {
    const t0 = Date.parse(e.windowOpen), t1 = t0 + e.durMin * 60000;
    const r = evalWindow(S, t0, t1, crit);
    const predicted = r.go ? 'go' : 'no-go';
    return { ...e, predicted, agree: e.weather === 'unknown' ? null : predicted === e.weather, mask: r.mask, maxGust: Math.max(...r.hrs.map((i) => S.gust[i])) };
  });
}

/** CSV of the per-day outlook: date offset, calendar date, share of seasons GO, cumulative P(launched). */
export function toCSV(plan, cal, cdf, openLabelFn) {
  const rows = [['day', 'date', 'share_of_seasons_weather_go', 'p_launched_by_end_of_day']];
  for (let k = 0; k < cal.length; k++) rows.push([k, openLabelFn(k), cal[k].toFixed(4), cdf[k].toFixed(4)]);
  return rows.map((r) => r.join(',')).join('\n') + '\n';
}
