// Empirical quantile mapping (bias correction of reanalysis winds to a station).
// ERA5 averages winds over a ~25 km grid cell, so at a coastal pad it reads about half of what an
// anemometer reports. For each calendar month we pair every hour that has both an ERA5 value and an
// Andøya airport observation, take K matched quantiles of each, and map ERA5 values through the
// piecewise-linear transfer function (constant offset beyond the end quantiles). The mapped series
// has the station's distribution by construction and keeps ERA5's complete, gap-free timeline.

/** Sorted-array quantile with linear interpolation (type 7). */
export function quantile(sorted, p) {
  const h = (sorted.length - 1) * p, lo = Math.floor(h), hi = Math.ceil(h);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

/** Fit a monotone transfer function from model values x to observed values y (paired or not). */
export function fitMap(x, y, K = 100) {
  const xs = Float64Array.from(x).sort(), ys = Float64Array.from(y).sort();
  const px = [], py = [];
  for (let k = 0; k <= K; k++) {
    const p = k / K, a = quantile(xs, p), b = quantile(ys, p);
    if (px.length && a <= px[px.length - 1]) { py[py.length - 1] = Math.max(py[py.length - 1], b); continue; } // merge ties in x
    px.push(a); py.push(Math.max(b, py.length ? py[py.length - 1] : -Infinity));
  }
  return { x: px, y: py };
}

/** Apply a fitted map. */
export function applyMap(m, v) {
  const { x, y } = m, n = x.length;
  if (n === 1) return y[0] + (v - x[0]);
  if (v <= x[0]) return y[0] + (v - x[0]);
  if (v >= x[n - 1]) return y[n - 1] + (v - x[n - 1]);
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (x[mid] <= v) lo = mid; else hi = mid; }
  return y[lo] + ((v - x[lo]) / (x[hi] - x[lo])) * (y[hi] - y[lo]);
}
