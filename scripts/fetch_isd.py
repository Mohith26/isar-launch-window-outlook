#!/usr/bin/env python3
"""Hourly wind observations at Andøya airport (ENAN, WMO 01010, ~8 km from the Nordmela pad).

Source: NOAA Integrated Surface Database (ISD) global-hourly, AWS open data
https://noaa-global-hourly-pds.s3.amazonaws.com/<year>/01010099999.csv (public domain).
Writes data/raw/obs_andoya.bin: 2 bytes per UTC hour from 1995-01-01T00Z
  byte 0: max mean wind in the hour, 0.25 m/s units (255 = no valid report)
  byte 1: max gust in the hour (reported gust, or the mean wind when no gust group), 0.25 m/s units
Usage: python3 scripts/fetch_isd.py [cache_dir]
"""
import csv, os, sys, urllib.request, datetime as dt

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
START = dt.datetime(1995, 1, 1); YEARS = range(1995, 2026)
cache = sys.argv[1] if len(sys.argv) > 1 else "/tmp/isd"
os.makedirs(cache, exist_ok=True)

def get(y):
    p = os.path.join(cache, f"enan{y}.csv")
    if not os.path.exists(p) or os.path.getsize(p) < 10000:
        urllib.request.urlretrieve(f"https://noaa-global-hourly-pds.s3.amazonaws.com/{y}/01010099999.csv", p)
    return p

def main():
    n = int((dt.datetime(2026, 1, 1) - START).total_seconds() // 3600)
    wind = [-1.0] * n; gust = [-1.0] * n
    for y in YEARS:
        with open(get(y), newline="") as f:
            for r in csv.DictReader(f):
                t = dt.datetime.fromisoformat(r["DATE"]); i = int((t - START).total_seconds() // 3600)
                if not 0 <= i < n: continue
                w = r["WND"].split(",")
                if len(w) < 5 or w[3] == "9999" or w[4] not in "0145": continue
                ws = int(w[3]) / 10
                g = ws
                oc = r.get("OC1") or ""
                if oc:
                    o = oc.split(",")
                    if o[0] != "9999" and o[1] in "0145": g = max(g, int(o[0]) / 10)
                wind[i] = max(wind[i], ws); gust[i] = max(gust[i], g)
    out = bytearray()
    for w, g in zip(wind, gust):
        out += bytes([255, 255]) if w < 0 else bytes([min(254, round(w * 4)), min(254, round(g * 4))])
    with open(os.path.join(ROOT, "data", "raw", "obs_andoya.bin"), "wb") as f: f.write(out)
    cov = sum(1 for w in wind if w >= 0)
    print("hours", n, "with obs", cov)

if __name__ == "__main__":
    main()
