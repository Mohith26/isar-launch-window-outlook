#!/usr/bin/env python3
"""Download hourly ERA5 reanalysis for Isar Aerospace's launch sites and pack it for the page.

Source: Open-Meteo historical weather API (ERA5, 0.25 deg, hourly), https://open-meteo.com/en/docs/historical-weather-api
(Hersbach et al. 2020, Copernicus Climate Change Service; Open-Meteo, CC BY 4.0).

Output per site: data/raw/era5_<site>.bin (bias-corrected into data/<site>.bin by scripts/build.mjs), 4 bytes per hour from START 00:00 UTC, hour-major:
  byte 0: 10 m wind speed, 0.25 m/s units (capped 63.75 m/s)
  byte 1: 10 m wind gust, 0.25 m/s units (capped 63.75 m/s)
  byte 2: 2 m temperature, round((T + 60) * 2)  (0.5 C units, -60 C offset)
  byte 3: WMO weather code (0-99), 255 = missing
plus data/sites.json with the metadata. No randomness: re-running reproduces the files exactly
(unless ERA5 is revised upstream, which Open-Meteo flags as rare).
Usage: python3 scripts/fetch_era5.py
"""
import json, os, urllib.request, time

START, END = "1995-01-01", "2026-10-31"
SITES = {
    "andoya": {"name": "Andøya Spaceport (Nordmela)", "lat": 69.135, "lon": 15.640, "tz": "Europe/Oslo"},
}
VARS = "wind_speed_10m,wind_gusts_10m,temperature_2m,weather_code"
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")

def fetch(lat, lon, a, b):
    url = (f"https://archive-api.open-meteo.com/v1/archive?latitude={lat}&longitude={lon}&start_date={a}&end_date={b}"
           f"&hourly={VARS}&models=era5&wind_speed_unit=ms&timezone=GMT")
    for attempt in range(5):
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                return json.load(r)
        except Exception as e:  # rate limits: back off and retry
            time.sleep(10 * (attempt + 1))
    raise RuntimeError("download failed: " + url)

def q(x, scale, off=0.0):
    if x is None: return 255
    return max(0, min(254, round((x + off) * scale)))

def main():
    meta = {"source": "ERA5 hourly reanalysis via Open-Meteo historical weather API (models=era5, 0.25 deg)",
            "start": START + "T00:00Z", "end": END + "T23:00Z", "bytesPerHour": 4,
            "encoding": ["wind10 m/s*4", "gust10 m/s*4", "(t2m C + 60)*2", "WMO weather code"], "sites": {}}
    for key, s in SITES.items():
        out = bytearray()
        grid = None
        for y0 in range(1995, 2027, 4):
            a = f"{y0}-01-01"; b = min(f"{y0+3}-12-31", END)
            d = fetch(s["lat"], s["lon"], a, b)
            grid = (d["latitude"], d["longitude"])
            h = d["hourly"]
            for w, g, t, c in zip(h["wind_speed_10m"], h["wind_gusts_10m"], h["temperature_2m"], h["weather_code"]):
                out += bytes([q(w, 4), q(g, 4), q(t, 2, 60), 255 if c is None else int(c)])
            print(key, a, b, len(h["time"]), flush=True)
            time.sleep(2)
        with open(os.path.join(ROOT, "data", "raw", "era5_" + key + ".bin"), "wb") as f: f.write(out)
        meta["sites"][key] = dict(s, gridLat=grid[0], gridLon=grid[1], hours=len(out) // 4)
    with open(os.path.join(ROOT, "data", "sites.json"), "w") as f: json.dump(meta, f, indent=1, ensure_ascii=False)

if __name__ == "__main__":
    main()
