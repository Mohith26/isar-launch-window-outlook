import * as O from '../src/outlook.js';
import { EVENTS } from '../src/events.js';
import { applyMap } from '../src/qmap.js';

const $ = (s) => document.querySelector(s);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const COLORS = { go: '#095edd', wind: '#000b27', ops: '#4a5874', gust: '#7f8aa3', snow: '#bfcbe0', cold: '#9aa6bf', thunder: '#f64e6c', missing: '#ededed' };
const WX = { 0: 'Clear', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Rime fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Dense drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains', 80: 'Showers', 81: 'Showers', 82: 'Heavy showers', 85: 'Snow showers', 86: 'Snow showers', 95: 'Thunderstorm', 96: 'Thunderstorm, hail', 99: 'Thunderstorm, hail' };
const STORE = 'isar-outlook-plans-v1';

let S, QMAP, plan, grid, sm, sh, tab = 'overview', sel = null, liveCache = null, livePlanKey = null;

// ------------------------------------------------------------------ plan <-> form <-> URL
const FIELDS = {
  open: ['open', (p) => `${String(p.openMonth).padStart(2, '0')}-${String(p.openDay).padStart(2, '0')}`],
  dl: ['deadline', (p) => p.deadline], ws: ['wstart', (p) => `${String(Math.floor(p.winStartMin / 60)).padStart(2, '0')}:${String(p.winStartMin % 60).padStart(2, '0')}`],
  wd: ['wdur', (p) => p.winDurMin], alt: ['alt', (p) => p.altKm], ltan: ['ltan', (p) => p.ltan], dir: ['dir', (p) => p.dir],
  w: ['c-wind', (p) => p.crit.maxWind], g: ['c-gust', (p) => p.crit.maxGust], ops: ['c-ops', (p) => p.crit.opsGust], cold: ['c-cold', (p) => p.crit.minTemp],
  pt: ['ptech', (p) => Math.round(p.pTech * 100)], turn: ['turn', (p) => p.techTurn], consec: ['consec', (p) => p.maxConsec], rest: ['rest', (p) => p.rest],
};
const clamp = (v, lo, hi, d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
function readForm() {
  const v = (id) => $('#' + id).value, n = (id) => parseFloat(v(id));
  const D = O.DEFAULT_PLAN;
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(v('open').trim());
  let openMonth = D.openMonth, openDay = D.openDay;
  if (m) { const mo = +m[1], dd = +m[2]; if (mo >= 1 && mo <= 12 && dd >= 1 && dd <= new Date(Date.UTC(2025, mo, 0)).getUTCDate()) { openMonth = mo; openDay = dd; } }
  const [hh, mm] = (v('wstart') || '20:00').split(':').map(Number);
  const mode = document.querySelector('.seg [aria-pressed="true"]').dataset.mode;
  return {
    ...D, openMonth, openDay, deadline: clamp(Math.round(n('deadline')), 1, D.horizon, D.deadline), windowMode: mode,
    winStartMin: clamp(hh * 60 + mm, 0, 1439, D.winStartMin), winDurMin: clamp(n(mode === 'orbit' ? 'wdur2' : 'wdur'), 5, 600, 90),
    altKm: clamp(n('alt'), 300, 1200, 510), ltan: clamp(n('ltan'), 0, 24, 23.3), dir: v('dir'),
    crit: { ...D.crit, maxWind: clamp(n('c-wind'), 1, 40, 9), maxGust: clamp(n('c-gust'), 1, 50, 13), opsGust: clamp(n('c-ops'), 1, 60, 15), minTemp: clamp(n('c-cold'), -60, 20, -15) },
    pTech: clamp(n('ptech'), 0, 95, 30) / 100, techTurn: clamp(Math.round(n('turn')), 1, 30, 3), maxConsec: clamp(Math.round(n('consec')), 1, 10, 3), rest: clamp(Math.round(n('rest')), 1, 7, 1),
  };
}
function writeForm(p) {
  for (const [, [id, f]] of Object.entries(FIELDS)) $('#' + id).value = f(p);
  $('#wdur2').value = p.winDurMin;
  setMode(p.windowMode);
}
function setMode(mode) {
  document.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  $('#fixed-f').hidden = mode !== 'fixed'; $('#orbit-f').hidden = mode !== 'orbit';
}
function planToHash(p) {
  const q = new URLSearchParams();
  q.set('tab', tab);
  for (const [k, [, f]] of Object.entries(FIELDS)) q.set(k, f(p));
  q.set('mode', p.windowMode);
  if (sel) q.set('night', `${grid[sel.s].year}.${sel.k}`);
  return '#' + q.toString();
}
function planFromHash() {
  const q = new URLSearchParams(location.hash.slice(1));
  if (q.get('tab')) tab = q.get('tab');
  for (const [k, [id]] of Object.entries(FIELDS)) if (q.has(k)) $('#' + id).value = q.get(k);
  if (q.has('wd')) $('#wdur2').value = q.get('wd');
  setMode(q.get('mode') === 'orbit' ? 'orbit' : 'fixed');
  return q.get('night');
}

// ------------------------------------------------------------------ compute
function compute() {
  plan = readForm();
  grid = O.seasonGrid(S, plan);
  sm = O.summarize(grid, plan);
  sh = O.shapley(grid);
}
const dayLabel = (k, p = plan) => { const d = new Date(Date.UTC(2026, p.openMonth - 1, p.openDay) + k * O.DAY); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };
const pct = (x, d = 0) => (100 * x).toFixed(d) + '%';
const causeOf = (mask) => (mask & O.BIT.wind ? 'wind' : mask & O.BIT.ops ? 'ops' : mask & O.BIT.gust ? 'gust' : mask & O.BIT.thunder ? 'thunder' : mask & O.BIT.snow ? 'snow' : mask & O.BIT.cold ? 'cold' : 'wind');
const hhmm = (t) => new Date(t).toISOString().slice(11, 16);

// ------------------------------------------------------------------ views
function baseline() { const s = loadSaved(); return s.length ? s[0] : null; }
function renderOverview() {
  const b = baseline();
  const dl = Math.min(plan.deadline, plan.horizon);
  const top = sh.phi.indexOf(Math.max(...sh.phi));
  const dlt = (v, bv, fmt) => (b && bv !== undefined && Math.abs(v - bv) > 1e-9 ? `<span class="delta">${v > bv ? '+' : ''}${fmt(v - bv)} vs “${esc(b.name)}”</span>` : '');
  const w = plan.windowMode === 'orbit' ? 'in-plane window from the target orbit' : `${hhmm(Date.UTC(2026, 0, 1) + plan.winStartMin * 60000)}–${hhmm(Date.UTC(2026, 0, 1) + (plan.winStartMin + plan.winDurMin) * 60000)} UTC`;
  $('#tab-overview').innerHTML = `
  <div class="cards">
    <div class="card"><span class="num">01</span><div class="k">Launchable nights</div><div class="v">${pct(sm.goRate)}</div><div class="d">of ${sm.seasons} seasons × ${plan.horizon} nights met every launch criterion ${dlt(sm.goRate, b?.goRate, (x) => (100 * x).toFixed(1) + ' pts')}</div></div>
    <div class="card"><span class="num">02</span><div class="k">Launch within ${dl} days</div><div class="v">${pct(sm.byDeadline)}</div><div class="d">90% band ${pct(sm.band[0])}–${pct(sm.band[1])} over seasons ${dlt(sm.byDeadline, b?.byDeadline, (x) => (100 * x).toFixed(1) + ' pts')}</div></div>
    <div class="card"><span class="num">03</span><div class="k">Likely launch night</div><div class="v">${Number.isFinite(sm.p50) ? dayLabel(sm.p50) : '—'}</div><div class="d">P80 ${Number.isFinite(sm.p80) ? dayLabel(sm.p80) : 'after window'} · P90 ${Number.isFinite(sm.p90) ? dayLabel(sm.p90) : 'after window'}</div></div>
    <div class="card"><span class="num">04</span><div class="k">Most nights lost to</div><div class="v" style="font-size:40px">${O.CRITERIA[top].label}</div><div class="d">${pct(sh.phi[top] / (sh.total || 1))} of the ${pct(sh.total)} lost nights (Shapley share)</div></div>
  </div>
  <div class="box">
    <div class="bh"><div><h3>When does the campaign fly?</h3><p>Probability the vehicle has launched by each night, window ${w}. Exact replay of each season; band = 90% bootstrap over seasons.</p></div>
      <div class="legend"><span><i style="background:${COLORS.go}"></i>P(launched)</span><span><i style="background:rgba(9,94,221,.16)"></i>90% band</span><span><i style="background:#000b27;height:2px"></i>target</span></div></div>
    ${cdfChart()}
  </div>
  <div class="box">
    <div class="bh"><div><h3>Launch weather by night</h3><p>Share of the ${sm.seasons} seasons in which each night's window met the criteria. Click a bar to open the night.</p></div></div>
    ${calChart()}
  </div>`;
  $('#tab-overview').querySelectorAll('[data-k]').forEach((el) => el.addEventListener('click', () => { const k = +el.dataset.k; switchTab('nights'); openNight(worstSeasonAt(k), k); }));
}
const worstSeasonAt = (k) => { const i = grid.findIndex((s) => !s.days[k].go); return i < 0 ? 0 : i; };

function cdfChart() {
  const W = 1000, H = 260, L = 44, R = 12, T = 12, B = 30, n = Math.min(plan.horizon, 42);
  const x = (k) => L + ((k + 1) / n) * (W - L - R), y = (v) => T + (1 - v) * (H - T - B);
  let band = '', line = `M${L},${y(0)}`;
  if (sm.bandLo) { band = `M${x(0)},${y(sm.bandHi[0])}`; for (let k = 1; k < n; k++) band += `L${x(k)},${y(sm.bandHi[k])}`; for (let k = n - 1; k >= 0; k--) band += `L${x(k)},${y(sm.bandLo[k])}`; band += 'Z'; }
  for (let k = 0; k < n; k++) line += `L${x(k)},${y(sm.cdf[k])}`;
  let g = '';
  for (const v of [0, 0.25, 0.5, 0.75, 1]) g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#ededed"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${v * 100}%</text>`;
  for (let k = 0; k < n; k += 7) g += `<text x="${x(k)}" y="${H - 8}" text-anchor="middle">${dayLabel(k)}</text>`;
  const dl = Math.min(plan.deadline, n) - 1;
  const mk = dl >= 0 ? `<line x1="${x(dl)}" x2="${x(dl)}" y1="${T}" y2="${H - B}" stroke="#000b27" stroke-dasharray="3 3"/><circle cx="${x(dl)}" cy="${y(sm.byDeadline)}" r="4.5" fill="#095edd" stroke="#fff" stroke-width="2"/><text x="${x(dl) + 8}" y="${y(sm.byDeadline) + 16}" style="fill:#000b27">${pct(sm.byDeadline)} by ${dayLabel(dl)}</text>` : '';
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Cumulative probability of launch by night">${g}<path d="${band}" fill="rgba(9,94,221,.14)"/><path d="${line}" fill="none" stroke="#095edd" stroke-width="2.4"/>${mk}</svg>`;
}
function calChart() {
  const cal = O.goCalendar(grid, plan.horizon), W = 1000, H = 150, L = 44, R = 12, T = 8, B = 26, n = plan.horizon, bw = (W - L - R) / n;
  let s = '';
  for (const v of [0, 0.5, 1]) s += `<line x1="${L}" x2="${W - R}" y1="${T + (1 - v) * (H - T - B)}" y2="${T + (1 - v) * (H - T - B)}" stroke="#ededed"/><text x="${L - 8}" y="${T + (1 - v) * (H - T - B) + 4}" text-anchor="end">${v * 100}%</text>`;
  for (let k = 0; k < n; k++) { const h = cal[k] * (H - T - B); s += `<rect data-k="${k}" x="${L + k * bw + 1}" y="${T + (H - T - B) - h}" width="${Math.max(1, bw - 2)}" height="${h}" rx="1.5" fill="#095edd" opacity="${0.35 + 0.65 * cal[k]}" style="cursor:pointer"><title>${dayLabel(k)}: ${pct(cal[k])} of seasons GO</title></rect>`; }
  for (let k = 0; k < n; k += 7) s += `<text x="${L + k * bw + bw / 2}" y="${H - 6}" text-anchor="middle">${dayLabel(k)}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Share of seasons with launch weather each night">${s}</svg>`;
}

function renderNights() {
  const n = plan.horizon;
  const cols = `52px repeat(${n}, minmax(0, 1fr))`;
  let h = `<div class="box"><div class="bh"><div><h3>Every night of every season</h3><p>Rows are the ${grid.length} seasons since ${grid[0].year}; columns the nights from ${dayLabel(0)}. Blue nights met every criterion; the rest are shaded by what failed. Arrow keys move, Enter opens.</p></div>
  <div class="legend">${['go', 'wind', 'ops', 'gust', 'snow', 'cold', 'thunder'].map((k) => `<span><i style="background:${COLORS[k]}"></i>${k === 'go' ? 'Go' : O.CRITERIA.find((c) => c.key === k).label}</span>`).join('')}</div></div>
  <div class="heat" style="grid-template-columns:${cols}" role="grid" aria-label="Launch weather by season and night">`;
  grid.forEach((s, i) => {
    h += `<div class="rowl" role="rowheader">${s.year}/${String((s.year + 1) % 100).padStart(2, '0')}</div>`;
    s.days.forEach((d, k) => { const c = d.missing ? 'missing' : d.go ? 'go' : causeOf(d.mask); h += `<button class="cell${sel && sel.s === i && sel.k === k ? ' sel' : ''}" data-s="${i}" data-k="${k}" style="background:${COLORS[c]}" aria-label="${s.year} ${dayLabel(k)}: ${c === 'go' ? 'go' : 'no-go, ' + c}" tabindex="${sel ? (sel.s === i && sel.k === k ? 0 : -1) : i === 0 && k === 0 ? 0 : -1}"></button>`; });
  });
  h += `</div><div class="heat" style="grid-template-columns:${cols};margin-top:6px"><div></div>${Array.from({ length: n }, (_, k) => `<div class="mono" style="font-size:10px;color:rgba(0,11,39,.5);white-space:nowrap">${k % 14 === 0 ? dayLabel(k) : ''}</div>`).join('')}</div></div>`;
  h += `<div class="box"><div class="bh"><div><h3>Seasons ranked by launch odds</h3><p>Probability of launching within ${plan.deadline} days in each historical season, with the first launchable night.</p></div></div>${seasonTable()}</div>`;
  $('#tab-nights').innerHTML = h;
  $('#tab-nights').querySelectorAll('.cell').forEach((el) => el.addEventListener('click', () => openNight(+el.dataset.s, +el.dataset.k)));
}
function seasonTable() {
  const rows = [...sm.perSeason].sort((a, b) => a.byDeadline - b.byDeadline).slice(0, 8);
  return `<table class="t"><thead><tr><th>Season</th><th>Launchable nights</th><th>First launchable</th><th>P(launch ≤ ${plan.deadline} d)</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${r.year}/${String((r.year + 1) % 100).padStart(2, '0')}</td><td class="n">${r.goDays} of ${plan.horizon}</td><td class="n">${Number.isFinite(r.firstGo) ? dayLabel(r.firstGo) : 'none'}</td><td class="n">${pct(r.byDeadline, 1)}</td></tr>`).join('')}</tbody></table>`;
}

function openNight(s, k) {
  sel = { s, k };
  const season = grid[s], d = season.days[k];
  const hrs = d.hrs || [];
  const crit = plan.crit;
  const opsFrom = d.t0 - crit.opsHours * O.HOUR, opsIdx = []; for (let i = Math.floor((opsFrom - S.start) / O.HOUR); i < Math.floor((d.t0 - S.start) / O.HOUR); i++) opsIdx.push(i);
  const opsMax = Math.max(...opsIdx.map((i) => S.gust[i]));
  const date = new Date(season.open + k * O.DAY);
  const pmf = O.campaignPmf(season.days.map((x) => x.go), plan);
  const launchedBy = pmf.slice(0, k + 1).reduce((a, b) => a + b, 0);
  $('#dbody').innerHTML = `<span class="tag">${season.year}/${String((season.year + 1) % 100).padStart(2, '0')} season · night ${k + 1}</span>
    <h3>${date.getUTCDate()} ${MON[date.getUTCMonth()]} ${date.getUTCFullYear()}</h3>
    <p style="color:rgba(0,11,39,.62);margin:0 0 14px">Window ${hhmm(d.t0)}–${hhmm(d.t1)} UTC</p>
    <span class="verdict ${d.go ? 'go' : 'nogo'}">${d.go ? 'GO' : 'NO-GO · ' + O.CRITERIA.filter((c) => d.mask & O.BIT[c.key]).map((c) => c.label.toLowerCase()).join(', ')}</span>
    <table class="t" style="margin-top:18px"><thead><tr><th>Hour (UTC)</th><th>Wind</th><th>Gust</th><th>Temp</th><th>Weather</th></tr></thead><tbody>
    ${hrs.map((i) => { const m = O.hourFail(S, i, crit); return `<tr><td class="n">${hhmm(S.start + i * O.HOUR)}</td><td class="n ${m & O.BIT.wind ? 'bad' : ''}">${S.wind[i].toFixed(1)}</td><td class="n ${m & O.BIT.gust ? 'bad' : ''}">${S.gust[i].toFixed(1)}</td><td class="n ${m & O.BIT.cold ? 'bad' : ''}">${S.temp[i].toFixed(1)}°</td><td class="${m & (O.BIT.snow | O.BIT.thunder) ? 'bad' : ''}">${WX[S.code[i]] || 'Code ' + S.code[i]}</td></tr>`; }).join('')}
    </tbody></table>
    <p style="margin:16px 0 4px" class="lbl">Pre-launch operations (${crit.opsHours} h before the window)</p>
    <p style="margin:0 0 6px">Highest gust <b class="${opsMax > crit.opsGust ? 'bad' : 'ok'}">${opsMax.toFixed(1)} m/s</b> against a ${crit.opsGust} m/s limit.</p>
    ${sparkline(opsIdx.concat(hrs))}
    <p style="margin:18px 0 4px" class="lbl">This season, replayed</p>
    <p style="margin:0">Probability the vehicle had launched by this night: <b>${pct(launchedBy, 1)}</b>. Launchable nights this season: ${season.days.filter((x) => x.go).length} of ${plan.horizon}.</p>
    <div style="display:flex;gap:8px;margin-top:22px"><button class="btn btn-ghost-blue btn-sm" id="prevn">← Previous</button><button class="btn btn-ghost-blue btn-sm" id="nextn">Next →</button></div>
    <p class="hint" style="margin-top:14px">Values are ERA5 hourly winds bias-corrected to Andøya airport observations, so they read like an anemometer near the pad.</p>`;
  $('#drawer').classList.add('open'); $('#drawer').setAttribute('aria-hidden', 'false');
  $('#prevn').onclick = () => moveSel(0, -1); $('#nextn').onclick = () => moveSel(0, 1);
  if (tab === 'nights') { document.querySelectorAll('.cell.sel').forEach((c) => c.classList.remove('sel')); const c = document.querySelector(`.cell[data-s="${s}"][data-k="${k}"]`); if (c) c.classList.add('sel'); }
  syncHash();
}
function sparkline(idx) {
  const W = 400, H = 70, vals = idx.map((i) => S.gust[i]), mx = Math.max(plan.crit.opsGust + 3, ...vals);
  const x = (j) => 4 + (j / (vals.length - 1)) * (W - 8), y = (v) => H - 6 - (v / mx) * (H - 12);
  const lim = y(plan.crit.opsGust);
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" aria-label="Gusts before and during the window"><line x1="0" x2="${W}" y1="${lim}" y2="${lim}" stroke="#f64e6c" stroke-dasharray="3 3"/><path d="${vals.map((v, j) => `${j ? 'L' : 'M'}${x(j)},${y(v)}`).join('')}" fill="none" stroke="#095edd" stroke-width="2"/></svg>`;
}
function closeNight() { $('#drawer').classList.remove('open'); $('#drawer').setAttribute('aria-hidden', 'true'); sel = null; document.querySelectorAll('.cell.sel').forEach((c) => c.classList.remove('sel')); syncHash(); }
function moveSel(ds, dk) {
  if (!sel) { openNight(0, 0); return; }
  const s = Math.max(0, Math.min(grid.length - 1, sel.s + ds)), k = Math.max(0, Math.min(plan.horizon - 1, sel.k + dk));
  openNight(s, k);
  const c = document.querySelector(`.cell[data-s="${s}"][data-k="${k}"]`); if (c) c.focus({ preventScroll: true });
}

function renderLimits() {
  const sweep = O.limitSweep(S, plan, 'maxWind', [6, 7, 8, 9, 10, 11, 12, 13, 14]);
  const mh = O.monthHourGrid(S, plan.crit);
  const W = 520, H = 230, L = 40, R = 10, T = 12, B = 30, xs = (v) => L + ((v - 6) / 8) * (W - L - R), ys = (g) => T + (1 - g) * (H - T - B);
  let sw = '';
  for (const g of [0, 0.25, 0.5, 0.75, 1]) sw += `<line x1="${L}" x2="${W - R}" y1="${ys(g)}" y2="${ys(g)}" stroke="#ededed"/><text x="${L - 6}" y="${ys(g) + 4}" text-anchor="end">${g * 100}%</text>`;
  sweep.forEach((p) => { sw += `<text x="${xs(p.value)}" y="${H - 8}" text-anchor="middle">${p.value}</text>`; });
  sw += `<path d="${sweep.map((p, j) => `${j ? 'L' : 'M'}${xs(p.value)},${ys(p.goRate)}`).join('')}" fill="none" stroke="#095edd" stroke-width="2.4"/>`;
  sweep.forEach((p) => { sw += `<circle cx="${xs(p.value)}" cy="${ys(p.goRate)}" r="${p.value === plan.crit.maxWind ? 5 : 3}" fill="${p.value === plan.crit.maxWind ? '#000b27' : '#095edd'}"><title>${p.value} m/s: ${pct(p.goRate, 1)} launchable</title></circle>`; });
  const cur = O.limitSweep(S, plan, 'maxWind', [plan.crit.maxWind])[0];
  sw += `<text x="${xs(Math.min(13, Math.max(6.5, plan.crit.maxWind)))}" y="${ys(cur.goRate) - 12}" text-anchor="middle" style="fill:#000b27">${pct(cur.goRate, 1)} at ${plan.crit.maxWind} m/s</text>`;
  const bars = O.CRITERIA.map((c, k) => ({ c, v: sh.phi[k] })).sort((a, b) => b.v - a.v);
  const mx = Math.max(...bars.map((b) => b.v), 1e-9);
  const hm = `<div class="heat" style="grid-template-columns:40px repeat(24, minmax(0,1fr))">${mh.map((row, mo) => `<div class="rowl">${MON[mo]}</div>${row.map((v, h) => `<div class="cell" title="${MON[mo]} ${String(h).padStart(2, '0')}:00 UTC: ${pct(v)} of hours pass" style="background:rgba(9,94,221,${(0.08 + 0.92 * v * v).toFixed(3)})"></div>`).join('')}`).join('')}<div></div>${Array.from({ length: 24 }, (_, h) => `<div class="mono" style="font-size:10px;color:rgba(0,11,39,.5);text-align:center">${h % 3 === 0 ? h : ''}</div>`).join('')}</div>`;
  $('#tab-limits').innerHTML = `<div class="grid2">
    <div class="box"><div class="bh"><div><h3>What costs the nights</h3><p>Exact Shapley attribution of the ${pct(sh.total, 1)} lost nights across criteria (shares add up to the total).</p></div></div>
      <table class="t"><tbody>${bars.map((b) => `<tr><td style="width:44%">${b.c.label}<div class="hint" style="margin:2px 0 0">${b.c.note}</div></td><td><div class="bar" style="height:10px"><span style="width:${(100 * b.v) / mx}%;background:${COLORS[b.c.key]}"></span></div></td><td class="n" style="width:90px;text-align:right">${pct(b.v, 1)}</td></tr>`).join('')}</tbody></table></div>
    <div class="box"><div class="bh"><div><h3>Ground-wind limit vs launchable nights</h3><p>Same window and season, sweeping only the sustained-wind limit (m/s).</p></div></div><svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Launchable nights versus wind limit">${sw}</svg></div>
  </div>
  <div class="box"><div class="bh"><div><h3>Hours that pass the launch criteria, by month</h3><p>All hours 1995–2026 at the pad (launch criteria only, ops period excluded). Useful for choosing an LTAN and season.</p></div></div>${hm}</div>`;
}

function renderBacktest() {
  const bt = O.backtest(S, EVENTS, plan.crit);
  const lab = bt.filter((b) => b.agree !== null), ok = lab.filter((b) => b.agree).length;
  const q = QMAP.holdout;
  $('#tab-backtest').innerHTML = `<div class="box"><div class="bh"><div><h3>Against Isar's public campaign record</h3><p>With the current criteria, ${ok} of ${lab.length} weather-labelled days match what the team did. The default limits were chosen to fit these days, so this is a consistency check, not an independent test.</p></div></div>
    <table class="t"><thead><tr><th>Window (UTC)</th><th>What happened</th><th>Logged weather</th><th>Outlook</th><th>Max gust</th></tr></thead><tbody>
    ${bt.map((b) => `<tr><td class="n">${b.windowOpen.replace('T', ' ').replace('Z', '')}</td><td>${esc(b.what)}<div class="hint" style="margin:2px 0 0">${esc(b.source)}</div></td><td>${b.weather}</td><td class="${b.agree === false ? 'bad' : b.agree ? 'ok' : ''}">${b.predicted}${b.agree === null ? '' : b.agree ? ' ✓' : ' ✗'}</td><td class="n">${b.maxGust.toFixed(1)} m/s</td></tr>`).join('')}
    </tbody></table></div>
    <div class="box"><div class="bh"><div><h3>Bias correction check</h3><p>ERA5 averages wind over a ~25 km cell. Monthly quantile mapping to Andøya airport observations, fitted on 1995–2019 and tested on ${q.hours.toLocaleString('en')} held-out hours (2020–2025).</p></div></div>
    <table class="t"><thead><tr><th></th><th>Raw ERA5</th><th>Bias-corrected</th></tr></thead><tbody>
    <tr><td>Mean abs. error, wind</td><td class="n">${q.windMAE_raw.toFixed(2)} m/s</td><td class="n ok">${q.windMAE_corrected.toFixed(2)} m/s</td></tr>
    <tr><td>Mean abs. error, gust</td><td class="n">${q.gustMAE_raw.toFixed(2)} m/s</td><td class="n ok">${q.gustMAE_corrected.toFixed(2)} m/s</td></tr></tbody></table></div>`;
}

// ------------------------------------------------------------------ live forecast (ECMWF ensemble)
async function renderLive(force = false) {
  const el = $('#tab-live');
  const key = JSON.stringify([plan.windowMode, plan.winStartMin, plan.winDurMin, plan.altKm, plan.ltan, plan.dir, plan.crit, plan.pTech, plan.techTurn, plan.maxConsec, plan.rest]);
  if (liveCache && !force) return drawLive(liveCache);
  el.innerHTML = `<div class="box"><div class="bh"><div><h3>Next 14 nights</h3><p>Fetching the 51-member ECMWF ensemble for the pad…</p></div></div><div class="live-grid">${'<div class="skel"></div>'.repeat(14)}</div></div>`;
  try {
    const url = `https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${S.lat}&longitude=${S.lon}&hourly=wind_speed_10m,wind_gusts_10m,temperature_2m,weather_code&models=ecmwf_ifs025&wind_speed_unit=ms&forecast_days=15&timezone=GMT`;
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    liveCache = await r.json();
    livePlanKey = key;
    drawLive(liveCache);
  } catch (e) {
    el.innerHTML = `<div class="box"><div class="empty"><p class="err" style="margin:0 0 12px">Couldn't load the forecast (${esc(e.message)}).</p><button class="btn btn-ghost-blue btn-sm" id="retry">Retry</button></div></div>`;
    $('#retry').onclick = () => renderLive(true);
  }
}
function drawLive(D) {
  const h = D.hourly, times = h.time.map((t) => Date.parse(t + 'Z'));
  const members = Object.keys(h).filter((k) => k.startsWith('wind_speed_10m')).map((k) => k.replace('wind_speed_10m', ''));
  const start = times[0];
  const today = Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth(), new Date(start).getUTCDate());
  const nights = [], seqs = members.map(() => []);
  for (let k = 0; k < 14; k++) {
    const day = today + k * O.DAY;
    let goN = 0, valid = 0;
    members.forEach((m, j) => {
      const series = { n: times.length, start, lat: S.lat, lon: S.lon, wind: [], gust: [], temp: h['temperature_2m' + m] || h.temperature_2m, code: h['weather_code' + m] || h.weather_code };
      if (!series.code) series.code = times.map(() => 3);
      times.forEach((t, i) => { const mo = new Date(t).getUTCMonth(); const w = applyMap(QMAP.maps.wind[mo], h['wind_speed_10m' + m][i] ?? NaN); series.wind.push(w); series.gust.push(Math.max(w, applyMap(QMAP.maps.gust[mo], h['wind_gusts_10m' + m]?.[i] ?? h['wind_speed_10m' + m][i]))); });
      const [t0, t1] = O.windowFor(plan, S, day);
      const r = O.evalWindow(series, t0, t1, plan.crit);
      if (r.missing || r.hrs.some((i) => !Number.isFinite(series.wind[i]))) { seqs[j].push(false); return; }
      valid++; if (r.go) goN++; seqs[j].push(r.go);
    });
    nights.push({ day, p: valid ? goN / valid : NaN, valid });
  }
  const pmfs = seqs.map((s) => O.campaignPmf(s, plan));
  const p14 = pmfs.reduce((a, p) => a + p.slice(0, 14).reduce((x, y) => x + y, 0), 0) / pmfs.length;
  const issued = new Date(start).toISOString().slice(0, 10);
  $('#tab-live').innerHTML = `<div class="box"><div class="bh"><div><h3>Next 14 nights at the pad</h3><p>Share of the ${members.length} ECMWF ensemble members (issued ${issued}) whose window meets the criteria, bias-corrected like the climatology. If the vehicle were ready tonight: <b>${pct(p14)}</b> chance of launching within 14 nights under the current scrub rules.</p></div><button class="btn btn-ghost-blue btn-sm" id="refresh">Refresh</button></div>
    <div class="live-grid">${nights.map((n) => { const d = new Date(n.day); return `<div class="night"><div class="dte">${d.toUTCString().slice(0, 3)} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}</div><div class="pp">${Number.isFinite(n.p) ? pct(n.p) : '—'}</div><div class="bar"><span style="width:${Number.isFinite(n.p) ? 100 * n.p : 0}%"></span></div></div>`; }).join('')}</div>
    <p class="hint" style="margin:14px 0 0">Raw ensemble frequencies, not yet calibrated against past forecasts; the Open-Meteo ECMWF feed ends at 15 days. Live data, so these numbers are not in the committed results.</p></div>`;
  $('#refresh').onclick = () => renderLive(true);
}

// ------------------------------------------------------------------ saved plans, export, chrome
function loadSaved() { try { return JSON.parse(localStorage.getItem(STORE)) || []; } catch { return []; } }
function storeSaved(list) { localStorage.setItem(STORE, JSON.stringify(list)); }
function renderSaved() {
  const list = loadSaved();
  $('#saved').innerHTML = list.length ? `<span class="lbl">Saved plans · first is the baseline</span>${list.map((p, i) => `<div class="saved-item"><span>${esc(p.name)} <span class="mono" style="color:rgba(0,11,39,.5);font-size:12px">${pct(p.byDeadline)} ≤ ${p.deadline}d</span></span><span><button data-load="${i}">Load</button> <button class="x" data-del="${i}" aria-label="Delete ${esc(p.name)}">✕</button></span></div>`).join('')}` : `<span class="lbl">Saved plans</span><p class="hint" style="margin:6px 0 0">Save a plan to compare against it. The first saved plan becomes the baseline on the overview.</p>`;
  $('#saved').querySelectorAll('[data-load]').forEach((b) => b.addEventListener('click', () => { const p = loadSaved()[+b.dataset.load]; location.hash = p.hash; }));
  $('#saved').querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => { const l = loadSaved(); l.splice(+b.dataset.del, 1); storeSaved(l); renderSaved(); renderTab(); }));
}
function savePlan() {
  const list = loadSaved();
  const w = plan.windowMode === 'orbit' ? `LTAN ${plan.ltan}` : hhmm(Date.UTC(2026, 0, 1) + plan.winStartMin * 60000);
  const name = `${dayLabel(0)} · ${w} · wind ≤ ${plan.crit.maxWind}`;
  list.push({ name, hash: planToHash(plan), byDeadline: sm.byDeadline, goRate: sm.goRate, deadline: plan.deadline, at: new Date().toISOString() });
  storeSaved(list.slice(-8)); renderSaved(); renderTab(); toast('Plan saved');
}
function exportCSV() {
  const csv = O.toCSV(plan, O.goCalendar(grid, plan.horizon), sm.cdf, (k) => dayLabel(k));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `isar-launch-outlook-${String(plan.openMonth).padStart(2, '0')}${String(plan.openDay).padStart(2, '0')}.csv`;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); toast('CSV exported');
}
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('show'), 2200); }
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function updateHints() {
  const inc = O.ssoInclination(plan.altKm), day = Date.UTC(2026, plan.openMonth - 1, plan.openDay);
  const t = O.inPlaneTime(day, S.lat, S.lon, inc, plan.ltan, plan.dir);
  $('#orbit-h').textContent = `SSO inclination ${inc.toFixed(2)}°. On ${dayLabel(0)} the pad is in the plane at ${hhmm(t)} UTC (window centred on it).`;
  const w = plan.windowMode === 'orbit' ? `in-plane window, LTAN ${plan.ltan} h` : `${hhmm(Date.UTC(2026, 0, 1) + plan.winStartMin * 60000)}–${hhmm(Date.UTC(2026, 0, 1) + (plan.winStartMin + plan.winDurMin) * 60000)} UTC`;
  $('#mission-tag').textContent = `Andøya Spaceport · from ${dayLabel(0)} · ${w}`;
}
function syncHash() { const h = planToHash(plan); if (h !== location.hash) history.replaceState(null, '', h); }
function renderTab() {
  document.querySelectorAll('[role="tab"]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  for (const t of ['overview', 'nights', 'limits', 'backtest', 'live']) $('#tab-' + t).hidden = t !== tab;
  ({ overview: renderOverview, nights: renderNights, limits: renderLimits, backtest: renderBacktest, live: () => renderLive() })[tab]();
}
function switchTab(t) { tab = t; renderTab(); syncHash(); }
function refresh() { compute(); updateHints(); if (sel) sel = { s: Math.min(sel.s, grid.length - 1), k: Math.min(sel.k, plan.horizon - 1) }; renderTab(); syncHash(); if (sel && $('#drawer').classList.contains('open')) openNight(sel.s, sel.k); }

async function main() {
  try {
    const [meta, bin, qm] = await Promise.all([fetch('data/sites.json').then((r) => r.json()), fetch('data/andoya.bin').then((r) => { if (!r.ok) throw new Error('data ' + r.status); return r.arrayBuffer(); }), fetch('data/qmap.json').then((r) => r.json())]);
    S = O.decodeSite(new Uint8Array(bin), meta.start, meta.sites.andoya);
    QMAP = qm;
  } catch (e) { $('#boot').innerHTML = `<span class="err">Couldn't load the weather archive (${esc(e.message)}). Reload to retry.</span>`; return; }
  writeForm(O.DEFAULT_PLAN);
  const night = planFromHash();
  compute(); updateHints();
  if (night) { const [y, k] = night.split('.').map(Number); const s = grid.findIndex((g) => g.year === y); if (s >= 0 && k >= 0 && k < plan.horizon) sel = { s, k }; }
  renderTab(); renderSaved();
  if (sel) openNight(sel.s, sel.k);
  $('#boot').remove();

  $('#plan').addEventListener('change', refresh);
  $('#plan').addEventListener('submit', (e) => { e.preventDefault(); refresh(); savePlan(); });
  document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => { setMode(b.dataset.mode); if (b.dataset.mode === 'orbit') $('#wdur2').value = $('#wdur').value; else $('#wdur').value = $('#wdur2').value; refresh(); }));
  $('#reset').onclick = () => { writeForm(O.DEFAULT_PLAN); refresh(); toast('Reset to the Flight 3 window'); };
  $('#export').onclick = exportCSV;
  document.querySelectorAll('[role="tab"]').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  $('#dclose').onclick = closeNight;
  window.addEventListener('hashchange', () => { const night2 = planFromHash(); refresh(); if (night2) { const [y, k] = night2.split('.').map(Number); const s = grid.findIndex((g) => g.year === y); if (s >= 0) openNight(s, k); } });
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    const tabs = { 1: 'overview', 2: 'nights', 3: 'limits', 4: 'backtest', 5: 'live' };
    if (tabs[e.key]) { switchTab(tabs[e.key]); e.preventDefault(); }
    else if (e.key === 'Escape') closeNight();
    else if (e.key === 's') { savePlan(); e.preventDefault(); }
    else if (e.key === 'e') exportCSV();
    else if (e.key === '?') toast('1-5 views · ←→↑↓ move night · Enter open · Esc close · S save · E export');
    else if (tab === 'nights' && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) { e.preventDefault(); moveSel(e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0, e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0); }
    else if (tab === 'nights' && e.key === 'Enter' && e.target.classList.contains('cell')) openNight(+e.target.dataset.s, +e.target.dataset.k);
  });
}
main();
