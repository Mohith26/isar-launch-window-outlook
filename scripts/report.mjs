// Recompute every number the README, the email and the page's default view quote.
// Usage: node scripts/report.mjs  (writes results/results.json)
import fs from 'node:fs';
import * as O from '../src/outlook.js';
import { EVENTS } from '../src/events.js';

const R = (p) => new URL('../' + p, import.meta.url);
const meta = JSON.parse(fs.readFileSync(R('data/sites.json')));
const S = O.decodeSite(fs.readFileSync(R('data/andoya.bin')), meta.start, meta.sites.andoya);
const plan = O.DEFAULT_PLAN;
const grid = O.seasonGrid(S, plan);
const sm = O.summarize(grid, plan);
const weatherOnly = O.summarize(grid, { ...plan, pTech: 0 }, { boot: 0 });
const sh = O.shapley(grid);
const summer = { ...plan, openMonth: 6, openDay: 1 };
const smSummer = O.summarize(O.seasonGrid(S, summer), summer, { boot: 0 });
const windSweep = O.limitSweep(S, plan, 'maxWind', [7, 8, 9, 10, 11, 12, 13]);
const bt = O.backtest(S, EVENTS, plan.crit);
const inc = O.ssoInclination(plan.altKm);
const r4 = (x) => +x.toFixed(4);
const res = {
  generatedFrom: 'data/andoya.bin (ERA5 1995-2026, bias-corrected to Andøya airport observations)',
  plan: { open: '26 Nov', windowUTC: '20:00-21:30', horizonDays: plan.horizon, deadlineDays: plan.deadline, crit: plan.crit, pTech: plan.pTech, techTurn: plan.techTurn, maxConsec: plan.maxConsec, rest: plan.rest },
  seasons: sm.seasons,
  winter: {
    goNightsPct: +(100 * sm.goRate).toFixed(1),
    pLaunchByDeadline: r4(sm.byDeadline), band90: sm.band.map(r4),
    p50Day: sm.p50, p80Day: sm.p80, p90Day: sm.p90,
    weatherOnlyP90Day: weatherOnly.p90,
    longestNoGoStreakNights: Math.max(...grid.map((s) => { let m = 0, c = 0; for (const d of s.days) { c = d.go ? 0 : c + 1; m = Math.max(m, c); } return m; })),
    lostNightsPct: +(100 * sh.total).toFixed(1),
    lostShare: Object.fromEntries(O.CRITERIA.map((c, k) => [c.key, +(100 * sh.phi[k] / sh.total).toFixed(1)])),
  },
  summerGoNightsPct: +(100 * smSummer.goRate).toFixed(1),
  windLimitSweep: windSweep.map((w) => ({ maxWind: w.value, goNightsPct: +(100 * w.goRate).toFixed(1) })),
  backtest: { agree: bt.filter((b) => b.agree === true).length, labelled: bt.filter((b) => b.agree !== null).length, rows: bt.map((b) => ({ date: b.windowOpen, logged: b.weather, predicted: b.predicted })) },
  orbit: { altKm: plan.altKm, ssoInclinationDeg: +inc.toFixed(3), impliedLtanAt2045UTC_26Nov: +O.impliedLtan(Date.UTC(2026, 10, 26, 20, 45), S.lat, S.lon, inc, 'north').toFixed(2) },
  biasCorrection: JSON.parse(fs.readFileSync(R('data/qmap.json'))).holdout,
};
fs.writeFileSync(R('results/results.json'), JSON.stringify(res, null, 1));
console.log(JSON.stringify(res, null, 1));
