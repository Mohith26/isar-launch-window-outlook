import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as O from '../src/outlook.js';
import { fitMap, applyMap, quantile } from '../src/qmap.js';
import { EVENTS } from '../src/events.js';

const R = (p) => new URL('../' + p, import.meta.url);
const meta = JSON.parse(fs.readFileSync(R('data/sites.json')));
const S = O.decodeSite(fs.readFileSync(R('data/andoya.bin')), meta.start, meta.sites.andoya);
const RES = JSON.parse(fs.readFileSync(R('results/results.json')));
const plan = O.DEFAULT_PLAN;

test('data covers 1995-01-01 to 2026-10-31 hourly with no missing weather codes', () => {
  assert.equal(S.n, meta.sites.andoya.hours);
  assert.equal(new Date(S.start + (S.n - 1) * O.HOUR).toISOString(), '2026-10-31T23:00:00.000Z');
  for (let i = 0; i < S.n; i += 97) assert.ok(S.code[i] !== 255 && S.gust[i] >= S.wind[i] - 1e-9);
});

test('SSO inclination from J2 matches the textbook values (97.4 deg at 500 km, 98.2 deg at 700 km)', () => {
  assert.ok(Math.abs(O.ssoInclination(500) - 97.40) < 0.03);
  assert.ok(Math.abs(O.ssoInclination(700) - 98.19) < 0.03);
  assert.ok(Number.isNaN(O.ssoInclination(6000)));
});

test('solar ephemeris: sun RA is ~0 h at the March equinox and ~12 h at the September equinox', () => {
  assert.ok(Math.abs(O.wrapDeg(O.sunRaDeg(Date.UTC(2026, 2, 20, 14, 46)))) < 0.1);
  assert.ok(Math.abs(O.wrapDeg(O.sunRaDeg(Date.UTC(2026, 8, 23, 0, 5)) - 180)) < 0.1);
  // GMST at J2000.0 epoch
  assert.ok(Math.abs(O.gmstDeg(Date.UTC(2000, 0, 1, 12)) - 280.46061837) < 1e-6);
});

test('PROPERTY: in-plane time puts the pad exactly in the orbit plane, and impliedLtan inverts it', () => {
  const r = O.mulberry32(5);
  for (let k = 0; k < 300; k++) {
    const day = Date.UTC(2026, 0, 1) + Math.floor(r() * 365) * O.DAY;
    const alt = 400 + r() * 500, ltan = r() * 24, dir = r() < 0.5 ? 'north' : 'south', inc = O.ssoInclination(alt);
    const t = O.inPlaneTime(day, S.lat, S.lon, inc, ltan, dir);
    assert.ok(t >= day && t < day + O.DAY);
    // pad unit vector dotted with the orbit normal is ~0
    const raan = (O.sunRaDeg(t) + 15 * (ltan - 12)) * Math.PI / 180, th = (O.gmstDeg(t) + S.lon) * Math.PI / 180, i = inc * Math.PI / 180, la = S.lat * Math.PI / 180;
    const dot = Math.sin(i) * Math.sin(raan) * Math.cos(la) * Math.cos(th) - Math.sin(i) * Math.cos(raan) * Math.cos(la) * Math.sin(th) + Math.cos(i) * Math.sin(la);
    assert.ok(Math.abs(dot) < 2e-4, `plane residual ${dot}`);
    const back = O.impliedLtan(t, S.lat, S.lon, inc, dir);
    assert.ok(Math.abs(((back - ltan + 36) % 24) - 12) < 1e-3);
  }
});

test('hour criteria: each limit trips its own bit', () => {
  const T = { n: 1, wind: [10], gust: [14], temp: [-20], code: [75], start: 0 };
  const m = O.hourFail(T, 0, O.DEFAULT_CRIT);
  assert.equal(m, O.BIT.wind | O.BIT.gust | O.BIT.cold | O.BIT.snow);
  const ok = { n: 1, wind: [3], gust: [5], temp: [2], code: [3], start: 0 };
  assert.equal(O.hourFail(ok, 0, O.DEFAULT_CRIT), 0);
  assert.equal(O.hourFail({ ...ok, code: [96] }, 0, O.DEFAULT_CRIT), O.BIT.thunder);
});

test('window evaluation: one passing hour is enough; ops-period gusts veto the night', () => {
  const n = 24, mk = (f) => Array.from({ length: n }, (_, h) => f(h));
  const T = { n, start: 0, wind: mk((h) => (h === 21 ? 4 : 12)), gust: mk((h) => (h === 21 ? 6 : 14)), temp: mk(() => 0), code: mk(() => 3) };
  const crit = { ...O.DEFAULT_CRIT, opsGust: 15 };
  assert.equal(O.evalWindow(T, 20 * O.HOUR, 21.5 * O.HOUR, crit).go, true);
  const T2 = { ...T, gust: mk((h) => (h === 21 ? 6 : h === 15 ? 20 : 14)) };
  const r = O.evalWindow(T2, 20 * O.HOUR, 21.5 * O.HOUR, crit);
  assert.equal(r.go, false); assert.ok(r.mask & O.BIT.ops);
});

test('campaign DP: pmf sums to 1, all-go with no scrubs launches on day 0, never-go never launches', () => {
  const pmf = O.campaignPmf(new Array(30).fill(true), { pTech: 0 });
  assert.equal(pmf[0], 1);
  const none = O.campaignPmf(new Array(30).fill(false), { pTech: 0.3 });
  assert.equal(none[30], 1);
  const r = O.mulberry32(11);
  for (let k = 0; k < 50; k++) {
    const go = Array.from({ length: 40 }, () => r() < 0.6);
    const p = O.campaignPmf(go, { pTech: r() * 0.8, techTurn: 1 + Math.floor(r() * 4), maxConsec: 1 + Math.floor(r() * 4), rest: 1 + Math.floor(r() * 2) });
    assert.ok(Math.abs(p.reduce((a, b) => a + b, 0) - 1) < 1e-12);
    go.forEach((g, d) => { if (!g) assert.equal(p[d], 0); });
  }
});

test('PROPERTY: the exact DP equals a brute-force simulation of the same scrub rules', () => {
  const r = O.mulberry32(42);
  const go = Array.from({ length: 25 }, () => r() < 0.55), P = { pTech: 0.4, techTurn: 2, maxConsec: 2, rest: 1 };
  const exact = O.campaignPmf(go, P), N = 200000, hist = new Float64Array(26);
  for (let s = 0; s < N; s++) {
    let d = 0, c = 0, out = 25;
    while (d < 25) {
      if (c === P.maxConsec) { d += P.rest; c = 0; continue; }
      if (!go[d]) { d++; c = 0; continue; }
      if (r() >= P.pTech) { out = d; break; }
      d += P.techTurn; c = 0;
    }
    hist[out]++;
  }
  for (let k = 0; k <= 25; k++) assert.ok(Math.abs(hist[k] / N - exact[k]) < 0.006, `day ${k}`);
});

test('Shapley attribution is efficient (shares add up to the lost-night rate) and non-negative', () => {
  const g = O.seasonGrid(S, plan), sh = O.shapley(g);
  assert.ok(Math.abs(sh.phi.reduce((a, b) => a + b, 0) - sh.total) < 1e-12);
  for (const p of sh.phi) assert.ok(p >= -1e-12);
  const lost = g.flatMap((s) => s.days).filter((d) => !d.go).length / (g.length * plan.horizon);
  assert.ok(Math.abs(lost - sh.total) < 1e-12);
});

test('quantile mapping is monotone and reproduces the target quantiles', () => {
  const r = O.mulberry32(3), x = [], y = [];
  for (let k = 0; k < 5000; k++) { x.push(r() * 8); y.push(2 * r() * 8 + 1); }
  const m = fitMap(x, y);
  let prev = -Infinity;
  for (let v = -1; v < 10; v += 0.05) { const a = applyMap(m, v); assert.ok(a >= prev - 1e-9); prev = a; }
  const xs = [...x].sort((a, b) => a - b), ys = [...y].sort((a, b) => a - b);
  for (const p of [0.1, 0.5, 0.9]) assert.ok(Math.abs(applyMap(m, quantile(xs, p)) - quantile(ys, p)) < 1e-9);
});

test('bias correction beats raw ERA5 on held-out years (2020-2025)', () => {
  const h = JSON.parse(fs.readFileSync(R('data/qmap.json'))).holdout;
  assert.ok(h.hours > 40000);
  assert.ok(h.windMAE_corrected < 0.7 * h.windMAE_raw);
  assert.ok(h.gustMAE_corrected < h.gustMAE_raw);
});

test('default criteria agree with every weather-labelled day in Isar public campaign log', () => {
  const bt = O.backtest(S, EVENTS, plan.crit).filter((b) => b.agree !== null);
  assert.ok(bt.length >= 7);
  for (const b of bt) assert.equal(b.predicted, b.weather, b.windowOpen);
});

test('HEADLINE: 65.4% of Flight 3 window nights launchable over 31 winters vs 92.5% in June; wind drives most losses', () => {
  const g = O.seasonGrid(S, plan), sm = O.summarize(g, plan);
  assert.equal(sm.seasons, 31);
  assert.equal(+(100 * sm.goRate).toFixed(1), RES.winter.goNightsPct);
  assert.equal(RES.winter.goNightsPct, 65.4);
  assert.equal(RES.summerGoNightsPct, 92.5);
  assert.equal(+sm.byDeadline.toFixed(4), RES.winter.pLaunchByDeadline);
  const sh = O.shapley(g);
  assert.equal(O.CRITERIA[sh.phi.indexOf(Math.max(...sh.phi))].key, 'wind');
});

test('raising the ground-wind limit never reduces availability (monotone sweep)', () => {
  const sw = O.limitSweep(S, plan, 'maxWind', [6, 8, 10, 12, 14]);
  for (let k = 1; k < sw.length; k++) assert.ok(sw[k].goRate >= sw[k - 1].goRate);
});

test('bootstrap band brackets the point estimate and is deterministic', () => {
  const g = O.seasonGrid(S, plan), a = O.summarize(g, plan), b = O.summarize(g, plan);
  assert.deepEqual(a.band, b.band);
  assert.ok(a.band[0] <= a.byDeadline && a.byDeadline <= a.band[1]);
});
