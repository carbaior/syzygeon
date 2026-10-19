#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Carlos Baiget Orts <asinfreedom@gmail.com>
# Developed with the assistance of Claude (Anthropic)
"""
export_web.py — Syzygeon: builds the compact dataset used by the web viewer (docs/) from
the cache written by alignments.py.

The cache only stores dates, amplitudes and a few attributes. The viewer also
draws the solar system and lists traditional longitudes for every date, so
this script reads the DE441 files once more to add, at each grouping:
  * the position of every body (longitudes in the projection plane, distance),
  * its geocentric ecliptic longitude and latitude of date (tropical), using
    the long-term precession of Vondrák et al. (2011) from ERFA,
  * the Lahiri ayanamsha of that date, to give sidereal longitudes.

Usage (in the folder holding the cache and the de441*.bsp files):
    pip install pyerfa
    python export_web.py

Binary layout of each docs/data/<criterion>.bin (little-endian, n records,
B bodies in the order of manifest.json "pos_bodies"):
    float64[n]        JD (TDB)
    float32[n]        amplitude, degrees
    float32[n]        smallest elongation from the Sun of the group (sky only, else NaN)
    float32[n]        days from the grouping to the nearest eclipse (NaN if none)
    float32[n]        Lahiri ayanamsha of date, degrees
    uint16[n*B*5]     per record and body: heliocentric longitude, geocentric
                      longitude (both in the projection plane, fraction of a
                      turn * 65536), heliocentric distance (r / R_MAX * 65535),
                      geocentric tropical longitude of date (turn * 65536),
                      geocentric latitude of date ((lat + 90°) / 180° * 65535)
    uint8[n*2]        body ids at the two ends of the arc
    uint8[n*2]        body ids left out of the group (255 = none)
    uint8[n]          eclipse: 0 none, 1 solar, 2 lunar, 3 lunar penumbral
"""

import argparse
import datetime
import glob
import json
import math
import os
import sys

import numpy as np

import alignments as A

try:
    import erfa
except ImportError:
    sys.exit("pyerfa is missing:  pip install pyerfa")

FORMAT_VERSION = 2
R_MAX = 55.0                  # AU, scale of the stored heliocentric distance
AU_KM = 149597870.7           # DE441 positions are in km
# Lahiri ayanamsha: 23°15'00.658" (true, i.e. with nutation) on 1956-03-21 0h TT
# (Indian Astronomical Ephemeris). The mean value used here subtracts the
# nutation in longitude of that date (16.769", IAU 1980). The sidereal origin is
# then kept fixed among the stars and projected onto each ecliptic of date.
LAHIRI_T0 = 2435553.5
LAHIRI_MEAN_T0 = 23.0 + 15.0 / 60 + 0.658 / 3600 - 16.768927 / 3600


def ecliptic_frames(jd):
    """Mean equinox and ecliptic of date (Vondrák long-term precession), as
    three (N,3) unit vectors in the J2000/ICRF frame: x (equinox), y, z (pole)."""
    epj = 2000.0 + (np.asarray(jd, float) - 2451545.0) / 365.25
    pole_ecl = erfa.ltpecl(epj)
    pole_equ = erfa.ltpequ(epj)
    x = np.cross(pole_equ, pole_ecl)
    x /= np.linalg.norm(x, axis=-1, keepdims=True)
    y = np.cross(pole_ecl, x)
    return x, y, pole_ecl


def lahiri_origin():
    x, y, _ = ecliptic_frames(np.array([LAHIRI_T0]))
    a = math.radians(LAHIRI_MEAN_T0)
    return (math.cos(a) * x + math.sin(a) * y)[0]


def turn16(a):
    return (np.round(np.mod(a, A.TWO_PI) / A.TWO_PI * 65536).astype(np.int64) % 65536).astype("<u2")


def main():
    ap = argparse.ArgumentParser(description="Export the alignments cache for the web viewer.",
                                 formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    ap.add_argument("--cache", default=None,
                    help="cache file (default: the only alignments_cache_*.npz here)")
    ap.add_argument("--ephemeris", nargs="+", default=None,
                    help=".bsp files (default: de441*.bsp in the current directory)")
    ap.add_argument("--out", default=os.path.join("docs", "data"), help="output folder")
    args = ap.parse_args()

    if args.cache is None:
        found = sorted(glob.glob("alignments_cache_*.npz"))
        if len(found) != 1:
            sys.exit("Use --cache to choose the cache file." if found else
                     "No alignments_cache_*.npz here; run alignments.py first or use --cache.")
        args.cache = found[0]
    paths = args.ephemeris or sorted(glob.glob("de441*.bsp"))
    if not paths:
        sys.exit("No de441*.bsp found in the current directory; use --ephemeris.")

    z = np.load(args.cache, allow_pickle=False)
    meta = json.loads(str(z["meta"]))
    if meta.get("version") != A.CACHE_VERSION:
        sys.exit("This cache was written by another version of alignments.py; "
                 "run alignments.py --reset to rebuild it.")
    eph = A.Ephemeris(paths, meta["pluto"])
    modes = A.build_modes(meta["pluto"])
    if list(modes) != meta["modes"]:
        sys.exit("The cache criteria do not match this version of alignments.py.")
    e1, e2 = A.plane_basis(meta["plane"])
    origin = lahiri_origin()

    pos_ids = [A.SUN, A.MERCURY, A.VENUS, A.EARTH, A.MARS, A.JUPITER, A.SATURN,
               A.URANUS, A.NEPTUNE] + ([A.PLUTO] if meta["pluto"] else []) + [A.MOON]
    nb = len(pos_ids)
    os.makedirs(args.out, exist_ok=True)

    done = sorted(int(b) for b in z["done"])
    valid = A.valid_blocks(eph, meta["step"])
    ranges = []
    for b in done:
        if ranges and ranges[-1][1] == b * A.BLOCK_DAYS:
            ranges[-1][1] = (b + 1) * A.BLOCK_DAYS
        else:
            ranges.append([b * A.BLOCK_DAYS, (b + 1) * A.BLOCK_DAYS])

    manifest = {
        "format": FORMAT_VERSION,
        "license": "CC-BY-4.0",
        "generated": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "plane": meta["plane"], "pluto": meta["pluto"], "step_days": meta["step"],
        "body_names": A.BODY_NAMES, "pos_bodies": pos_ids, "r_max_au": R_MAX,
        "eclipse_window_days": A.ECLIPSE_WINDOW,
        "min_planets_in_group": A.MIN_PLANETS_IN_GROUP,
        "coverage": {"first_jd": valid[0] * A.BLOCK_DAYS,
                     "last_jd": (valid[-1] + 1) * A.BLOCK_DAYS,
                     "blocks_done": len(set(done) & set(valid)), "blocks_total": len(valid),
                     "computed_jd_ranges": ranges},
        "criteria": {},
    }

    total = 0
    for name, mode in modes.items():
        jd = z[f"jd_{name}"]
        n = jd.size
        pos = np.empty((n, nb, 5), dtype="<u2")
        ayan = np.empty(n, dtype="<f4")
        for i0 in range(0, n, 50000):
            t = jd[i0:i0 + 50000]
            sl = slice(i0, i0 + t.size)
            p = eph.barycentric(t)
            ex, ey, ez = ecliptic_frames(t)
            ayan[sl] = np.degrees(np.arctan2(ey @ origin, ex @ origin))
            for k, b in enumerate(pos_ids):
                hv = p[b] - p[A.SUN]
                gv = p[b] - p[A.EARTH]
                pos[sl, k, 0] = turn16(np.arctan2(e2 @ hv, e1 @ hv)) if b != A.SUN else 0
                pos[sl, k, 1] = turn16(np.arctan2(e2 @ gv, e1 @ gv)) if b != A.EARTH else 0
                r = np.hypot(e1 @ hv, e2 @ hv) / AU_KM
                pos[sl, k, 2] = np.clip(np.round(r / R_MAX * 65535), 0, 65535)
                if b == A.EARTH:
                    pos[sl, k, 3], pos[sl, k, 4] = 0, 32768
                    continue
                g = gv.T
                lon = np.arctan2(np.sum(g * ey, axis=1), np.sum(g * ex, axis=1))
                lat = np.arcsin(np.sum(g * ez, axis=1) / np.linalg.norm(g, axis=1))
                pos[sl, k, 3] = turn16(lon)
                pos[sl, k, 4] = np.clip(np.round((np.degrees(lat) + 90) / 180 * 65535), 0, 65535)
        fname = f"{name}.bin"
        with open(os.path.join(args.out, fname), "wb") as f:
            f.write(jd.astype("<f8").tobytes())
            f.write(z[f"amp_{name}"].astype("<f4").tobytes())
            f.write(z[f"elong_{name}"].astype("<f4").tobytes())
            f.write(z[f"ecl_dt_{name}"].astype("<f4").tobytes())
            f.write(ayan.tobytes())
            f.write(pos.tobytes())
            f.write(z[f"ends_{name}"].astype(np.uint8).tobytes())
            f.write(z[f"out_{name}"].astype(np.uint8).tobytes())
            f.write(z[f"ecl_{name}"].astype(np.uint8).tobytes())
        size = os.path.getsize(os.path.join(args.out, fname))
        total += size
        manifest["criteria"][name] = {
            "kind": mode.kind, "frame": mode.frame, "axis": bool(mode.doubled),
            "measure": mode.measure, "outliers": mode.outliers, "bodies": mode.bodies,
            "count": int(n), "file": fname, "max_amplitude_deg": mode.cap}
        print(f"  {name:36s} {n:8d} groupings  {size / 1e6:6.2f} MB")

    with open(os.path.join(args.out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=1)
    print(f"Written to {args.out}: {total / 1e6:.1f} MB in total "
          f"({manifest['coverage']['blocks_done']}/{len(valid)} blocks computed).")


if __name__ == "__main__":
    main()
