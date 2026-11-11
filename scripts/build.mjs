// Build data/andoya.bin: ERA5 hourly winds at the Nordmela pad, bias-corrected to Andøya airport
// observations by monthly quantile mapping (src/qmap.js), plus data/qmap.json (maps + validation).
// Inputs: data/raw/era5_andoya.bin (scripts/fetch_era5.py), data/raw/obs_andoya.bin (scripts/fetch_isd.py).
// Deterministic: no randomness, integer-quantized output. Usage: node scripts/build.mjs
import fs from 'node:fs';
import { fitMap, applyMap } from '../src/qmap.js';

const R = (p) => new URL('../' + p, import.meta.url);
const era = fs.readFileSync(R('data/raw/era5_andoya.bin')), obs = fs.readFileSync(R('data/raw/obs_andoya.bin'));
const START = Date.UTC(1995, 0, 1), H = 3600000, nE = era.length / 4, nO = obs.length / 2;
const month = (i) => new Date(START + i * H).getUTCMonth(), year = (i) => new Date(START + i * H).getUTCFullYear();

function fit(train) {
  const maps = { wind: [], gust: [] };
  for (let mo = 0; mo < 12; mo++) {
    const xw = [], yw = [], xg = [], yg = [];
    for (let i = 0; i < Math.min(nE, nO); i++) {
      if (obs[2 * i] === 255 || month(i) !== mo || !train(year(i))) continue;
      xw.push(era[4 * i] / 4); yw.push(obs[2 * i] / 4); xg.push(era[4 * i + 1] / 4); yg.push(obs[2 * i + 1] / 4);
    }
    maps.wind.push(fitMap(xw, yw)); maps.gust.push(fitMap(xg, yg));
  }
  return maps;
}
function errors(maps, test) {
  let n = 0, raw = 0, cor = 0, rawG = 0, corG = 0;
  for (let i = 0; i < Math.min(nE, nO); i++) {
    if (obs[2 * i] === 255 || !test(year(i))) continue;
    const mo = month(i), w = era[4 * i] / 4, g = era[4 * i + 1] / 4, ow = obs[2 * i] / 4, og = obs[2 * i + 1] / 4;
    raw += Math.abs(w - ow); cor += Math.abs(applyMap(maps.wind[mo], w) - ow); rawG += Math.abs(g - og); corG += Math.abs(applyMap(maps.gust[mo], g) - og); n++;
  }
  return { hours: n, windMAE_raw: +(raw / n).toFixed(3), windMAE_corrected: +(cor / n).toFixed(3), gustMAE_raw: +(rawG / n).toFixed(3), gustMAE_corrected: +(corG / n).toFixed(3) };
}
// out-of-sample check: fit on 1995-2019, evaluate on 2020-2025
const holdout = errors(fit((y) => y < 2020), (y) => y >= 2020);
// production maps: all overlapping years
const maps = fit(() => true);
const out = Buffer.alloc(era.length);
for (let i = 0; i < nE; i++) {
  const mo = month(i);
  const w = applyMap(maps.wind[mo], era[4 * i] / 4), g = Math.max(w, applyMap(maps.gust[mo], era[4 * i + 1] / 4));
  out[4 * i] = Math.max(0, Math.min(254, Math.round(w * 4)));
  out[4 * i + 1] = Math.max(0, Math.min(254, Math.round(g * 4)));
  out[4 * i + 2] = era[4 * i + 2]; out[4 * i + 3] = era[4 * i + 3];
}
fs.writeFileSync(R('data/andoya.bin'), out);
const round = (m) => ({ x: m.x.map((v) => +v.toFixed(3)), y: m.y.map((v) => +v.toFixed(3)) });
fs.writeFileSync(R('data/qmap.json'), JSON.stringify({ method: 'monthly empirical quantile mapping, 101 quantiles, ERA5 -> Andøya airport (ENAN) hourly max', train: '1995-2025 matched hours', holdout, maps: { wind: maps.wind.map(round), gust: maps.gust.map(round) } }));
console.log('holdout 2020-2025', holdout);
