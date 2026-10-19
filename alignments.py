#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Carlos Baiget Orts <asinfreedom@gmail.com>
# Developed with the assistance of Claude (Anthropic)
"""
alignments.py — Syzygeon: searches the full time span of the JPL DE441 ephemeris for the
dates when the planets are most tightly grouped / aligned.

Points of view (--frame) and kinds of grouping:

  helio (default)  Seen from the Sun.
      * axis (default): bodies close to a straight line through the Sun, on
        either side. Amplitude = width of the band holding them all.
      * --same-side: the Sun is one end; every body on the same side.
        Amplitude = angle of the smallest sector, vertex at the Sun.
  geo              Seen from the Earth, Sun included: smallest arc of sky
                   holding the Sun and the bodies (the "Kali Yuga" kind).
  sky              Seen from the Earth, Sun left out: planets bunched together
                   in the sky. --min-elongation keeps only groups far enough
                   from the Sun to be seen at night.

Options that apply to every frame:
  --moon        adds the Moon (seen from the Sun it is never more than ~0.15°
                from the Earth, so there it hardly matters).
  --classical   naked-eye planets only (drops Uranus, Neptune and Pluto).
  --outliers N  best grouping of all bodies but N (N = 1 or 2), whichever
                they are: "when were the most planets together?".
  --measure 3d  (geo and sky) true angular distance, latitude included,
                instead of longitude only: amplitude = largest separation
                between any two bodies of the group.

Every listed grouping also says whether a solar or lunar eclipse happens within
±2 days, and dates can be shown in TDB or in civil time (UT, via ΔT).

Only the LOCAL MINIMA of the amplitude that can matter (below a cap per
criterion, see cap_for) are kept, refined to ~1 s. The cache stores every
criterion at once, so changing any option never forces a recomputation.

Requirements: pip install numpy jplephem
Ephemeris:    de441_part-1.bsp and de441_part-2.bsp from
              https://ssd.jpl.nasa.gov/ftp/eph/planets/bsp/

Ctrl+C stops the computation, saves the cache and shows what has been found.
The next run loads the cache, shows the results and resumes where it stopped.
"""

import argparse
import bisect
import glob
import json
import math
import os
import signal
import sys
import time
from collections import namedtuple

import numpy as np

try:
    from jplephem.spk import SPK
except ImportError:
    sys.exit("jplephem is missing:  pip install jplephem numpy")

CACHE_VERSION = 3
BLOCK_DAYS = 10000            # size of each work unit (~27 years)
AUTOSAVE_S = 120              # also save the cache every 2 minutes
REFINE_ITER = 24              # golden-section: ±step → ~1e-5 days (~1 s)
ECLIPSE_WINDOW = 2.0          # days either side of a grouping searched for an eclipse
TWO_PI = 2.0 * math.pi

# Global body ids (also used to name the ends of the arc)
SUN, MERCURY, VENUS, EARTH, MARS, JUPITER, SATURN, URANUS, NEPTUNE, PLUTO, MOON = range(11)
BODY_NAMES = ["Sun", "Mercury", "Venus", "Earth", "Mars", "Jupiter", "Saturn",
              "Uranus", "Neptune", "Pluto", "Moon"]
NONE = 255                    # "no body" in the outliers columns
# SPK target of the (system) barycentre of each planet relative to the SSB.
# Barycentre and planet centre differ by a few thousand km at most.
SPK_TARGET = {MERCURY: 1, VENUS: 2, MARS: 4, JUPITER: 5, SATURN: 6,
              URANUS: 7, NEPTUNE: 8, PLUTO: 9}
OUTER = {URANUS, NEPTUNE, PLUTO}
KINDS = ("helio_axis", "helio_side", "geo", "sky")

R_SUN, R_MOON, R_EARTH = 696000.0, 1737.4, 6378.137      # km

# Only minima narrower than these caps (degrees) are refined and kept: wider
# ones are never interesting, and keeping them all would take ~100 MB.
def cap_for(kind, measure, outliers):
    if measure == "3d":
        return 90.0
    if kind == "helio_axis":
        return (60.0, 30.0, 20.0)[outliers]
    if kind == "helio_side" and outliers == 0:
        return 120.0
    return (90.0, 60.0, 45.0)[outliers]


# --outliers is only offered while at least this many planets stay in the group
# (otherwise "3 of 5 planets together" happens all the time).
MIN_PLANETS_IN_GROUP = 5

Mode = namedtuple("Mode", "kind frame doubled bodies measure outliers cap")


# ----------------------------------------------------------------------------
# Criteria ("modes")
# ----------------------------------------------------------------------------
def build_modes(pluto):
    """Every criterion stored in the cache, by name."""
    planets = [MERCURY, VENUS, EARTH, MARS, JUPITER, SATURN, URANUS, NEPTUNE]
    if pluto:
        planets.append(PLUTO)
    modes = {}
    for kind in KINDS:
        frame = "helio" if kind.startswith("helio") else "geo"
        doubled = kind == "helio_axis"
        for moon in (False, True):
            for classical in (False, True):
                own = [b for b in planets if not (classical and b in OUTER)]
                if frame == "helio":
                    bodies = own
                else:
                    bodies = ([SUN] if kind == "geo" else []) + [b for b in own if b != EARTH]
                if moon:
                    bodies = bodies + [MOON]
                base = kind + ("_moon" if moon else "") + ("_classical" if classical else "")
                n_planets = len([b for b in bodies if b not in (SUN, MOON)])
                for o in (0, 1, 2):
                    if o and n_planets - o < MIN_PLANETS_IN_GROUP:
                        continue
                    modes[base + (f"_out{o}" if o else "")] = Mode(
                        kind, frame, doubled, bodies, "lon", o, cap_for(kind, "lon", o))
                if frame == "geo":
                    modes[base + "_3d"] = Mode(kind, frame, False, bodies, "3d", 0, cap_for(kind, "3d", 0))
    return modes


def mode_name(args):
    if args.frame == "helio":
        base = "helio_side" if args.same_side else "helio_axis"
    else:
        base = args.frame
    base += ("_moon" if args.moon else "") + ("_classical" if args.classical else "")
    if args.measure == "3d":
        return base + "_3d"
    return base + (f"_out{args.outliers}" if args.outliers else "")


# ----------------------------------------------------------------------------
# Calendar and time scales
# ----------------------------------------------------------------------------
JD_GREGORIAN = 2299160.5      # 1582-10-15 Gregorian = the day after 1582-10-04 Julian


def cal_to_jd(year, month, day, gregorian):
    """Calendar date (astronomical year) to JD at 0h. Works for negative years."""
    a = (14 - month) // 12
    y = year + 4800 - a
    m = month + 12 * a - 3
    jdn = day + (153 * m + 2) // 5 + 365 * y + y // 4
    jdn += (y // 400 - y // 100 - 32045) if gregorian else -32083
    return jdn - 0.5


def jd_to_cal(jd, gregorian):
    """JD to (astronomical year, month, day, hour, minute). Works for negative JD."""
    z = math.floor(jd + 0.5)
    f = jd + 0.5 - z
    period, years = (146097, 400) if gregorian else (1461, 4)
    q = (z - 2451545) // period           # shift by whole cycles to the J2000 region
    z -= q * period
    if gregorian:
        alpha = (4 * z - 7468865) // 146097       # = floor((z-1867216.25)/36524.25)
        a = z + 1 + alpha - alpha // 4
    else:
        a = z
    b = a + 1524
    c = (20 * b - 2442) // 7305                   # = floor((b-122.1)/365.25)
    d = (1461 * c) // 4
    e = (10000 * (b - d)) // 306001
    day = b - d - (306001 * e) // 10000
    month = e - 1 if e < 14 else e - 13
    year = (c - 4716 if month > 2 else c - 4715) + q * years
    minutes = int(round(f * 1440))
    if minutes == 1440:                           # rounded up to next midnight
        return jd_to_cal(math.floor(jd + 0.5) + 0.5, gregorian)[:3] + (0, 0)
    return year, month, day, minutes // 60, minutes % 60


def format_date(jd, calendar):
    greg = (jd >= JD_GREGORIAN) if calendar == "auto" else (calendar == "gregorian")
    y, m, d, hh, mm = jd_to_cal(jd, greg)
    return f"{y:+06d}-{m:02d}-{d:02d} {hh:02d}:{mm:02d} {'Greg' if greg else 'Jul'}"


def year_to_jd(year):
    return cal_to_jd(year, 1, 1, year >= 1583)


def delta_t(jd):
    """ΔT = TT − UT in seconds and its 1-sigma uncertainty.
    Values: Espenak & Meeus polynomials (Morrison & Stephenson 2004), with the
    long-term parabola outside −500…2150. Uncertainty: Morrison & Stephenson
    0.8·t² s for −1000…1200, Huber (2000) outside the measured era."""
    y = 2000.0 + (jd - 2451545.0) / 365.25
    if y < -500 or y >= 2150:
        u = (y - 1820) / 100
        dt = -20 + 32 * u * u
    elif y < 500:
        u = y / 100
        dt = (10583.6 - 1014.41 * u + 33.78311 * u**2 - 5.952053 * u**3 - 0.1798452 * u**4
              + 0.022174192 * u**5 + 0.0090316521 * u**6)
    elif y < 1600:
        u = (y - 1000) / 100
        dt = (1574.2 - 556.01 * u + 71.23472 * u**2 + 0.319781 * u**3 - 0.8503463 * u**4
              - 0.005050998 * u**5 + 0.0083572073 * u**6)
    elif y < 1700:
        t = y - 1600
        dt = 120 - 0.9808 * t - 0.01532 * t**2 + t**3 / 7129
    elif y < 1800:
        t = y - 1700
        dt = 8.83 + 0.1603 * t - 0.0059285 * t**2 + 0.00013336 * t**3 - t**4 / 1174000
    elif y < 1860:
        t = y - 1800
        dt = (13.72 - 0.332447 * t + 0.0068612 * t**2 + 0.0041116 * t**3 - 0.00037436 * t**4
              + 0.0000121272 * t**5 - 0.0000001699 * t**6 + 0.000000000875 * t**7)
    elif y < 1900:
        t = y - 1860
        dt = 7.62 + 0.5737 * t - 0.251754 * t**2 + 0.01680668 * t**3 - 0.0004473624 * t**4 + t**5 / 233174
    elif y < 1920:
        t = y - 1900
        dt = -2.79 + 1.494119 * t - 0.0598939 * t**2 + 0.0061966 * t**3 - 0.000197 * t**4
    elif y < 1941:
        t = y - 1920
        dt = 21.20 + 0.84493 * t - 0.076100 * t**2 + 0.0020936 * t**3
    elif y < 1961:
        t = y - 1950
        dt = 29.07 + 0.407 * t - t**2 / 233 + t**3 / 2547
    elif y < 1986:
        t = y - 1975
        dt = 45.45 + 1.067 * t - t**2 / 260 - t**3 / 718
    elif y < 2005:
        t = y - 2000
        dt = (63.86 + 0.3345 * t - 0.060374 * t**2 + 0.0017275 * t**3 + 0.000651814 * t**4
              + 0.00002373599 * t**5)
    elif y < 2050:
        t = y - 2000
        dt = 62.92 + 0.32217 * t + 0.005589 * t**2
    else:
        dt = -20 + 32 * ((y - 1820) / 100) ** 2 - 0.5628 * (2150 - y)

    def huber(n):
        return 365.25 * n * math.sqrt((n * 0.058 / 3) * (1 + n / 2500)) / 1000
    t2 = ((y - 1820) / 100) ** 2
    if y <= -1000:
        sigma = huber(-500 - y)
    elif y <= 1200:
        sigma = 0.8 * t2
    elif y <= 1600:
        sigma = max(20.0, 0.8 * t2)
    elif y <= 1700:
        sigma = 20 + (5 - 20) * (y - 1600) / 100
    elif y <= 1800:
        sigma = 5 + (1 - 5) * (y - 1700) / 100
    elif y <= 1900:
        sigma = 1 + (0.1 - 1) * (y - 1800) / 100
    elif y <= 2005:
        sigma = 0.1
    else:
        sigma = max(0.1, huber(y - 2005))
    return dt, sigma


def format_duration_s(s):
    sign = "-" if s < 0 else ""
    s = abs(s)
    if s < 120:
        return f"{sign}{s:.0f}s"
    if s < 7200:
        return f"{sign}{s / 60:.1f}min"
    if s < 172800:
        return f"{sign}{s / 3600:.1f}h"
    return f"{sign}{s / 86400:.1f}d"


# ----------------------------------------------------------------------------
# Ephemeris
# ----------------------------------------------------------------------------
class Ephemeris:
    def __init__(self, paths, pluto):
        self.kernels = [SPK.open(p) for p in paths]
        self.bodies = [b for b in SPK_TARGET if pluto or b != PLUTO]
        self.pairs = [(0, 10), (0, 3), (3, 399), (3, 301)] + [(0, SPK_TARGET[b]) for b in self.bodies]
        self.segs = {}
        for pair in self.pairs:
            found = [k.pairs[pair] for k in self.kernels if pair in k.pairs]
            if not found:
                sys.exit(f"No ephemeris file contains the segment {pair}.")
            self.segs[pair] = sorted(found, key=lambda s: s.start_jd)
        # coverage: union of intervals per segment, intersection across segments
        self.coverage = {}
        for pair, found in self.segs.items():
            iv = []
            for s in found:
                if iv and s.start_jd <= iv[-1][1]:
                    iv[-1][1] = max(iv[-1][1], s.end_jd)
                else:
                    iv.append([s.start_jd, s.end_jd])
            self.coverage[pair] = iv
        self.jd_min = max(iv[0][0] for iv in self.coverage.values())
        self.jd_max = min(iv[-1][1] for iv in self.coverage.values())

    def covers(self, t0, t1):
        return all(any(a <= t0 and t1 <= b for a, b in iv) for iv in self.coverage.values())

    def _calc(self, pair, t):
        found = self.segs[pair]
        if len(found) == 1:
            return found[0].compute(t)
        out = np.full((3, t.size), np.nan)
        pending = np.ones(t.size, bool)
        for s in found:
            m = pending & (t >= s.start_jd) & (t <= s.end_jd)
            if m.any():
                out[:, m] = s.compute(t[m])
                pending &= ~m
        return out

    def sun_earth_moon(self, t):
        emb = self._calc((0, 3), t)
        return self._calc((0, 10), t), emb + self._calc((3, 399), t), emb + self._calc((3, 301), t)

    def barycentric(self, t):
        """Dict body id -> (3,N) position (km) relative to the solar-system barycentre."""
        sun, earth, moon = self.sun_earth_moon(t)
        pos = {SUN: sun, EARTH: earth, MOON: moon}
        for b in self.bodies:
            pos[b] = self._calc((0, SPK_TARGET[b]), t)
        return pos


def plane_basis(plane):
    """Two orthonormal ICRF vectors spanning the projection plane."""
    if plane == "invariable":
        # Pole of the invariable plane (Souami & Souchay 2012): RA 273.8527°, Dec 66.9911°
        ra, de = math.radians(273.8527), math.radians(66.9911)
        n = np.array([math.cos(de) * math.cos(ra), math.cos(de) * math.sin(ra), math.sin(de)])
    else:  # J2000 ecliptic
        eps = math.radians(23.4392911)
        n = np.array([0.0, -math.sin(eps), math.cos(eps)])
    e1 = np.cross([0.0, 0.0, 1.0], n)
    e1 /= np.linalg.norm(e1)
    e2 = np.cross(n, e1)
    return e1, e2


# ----------------------------------------------------------------------------
# Metric
# ----------------------------------------------------------------------------
def kofn_arc(ang, outliers, details=False):
    """Smallest arc holding all but `outliers` of the angles of each row.
    ang: (N,n) radians. With details also returns the columns at the start and
    end of the arc and the columns left out ((N,2), -1 = none)."""
    a = np.mod(ang, TWO_PI)
    order = np.argsort(a, axis=1)
    s = np.take_along_axis(a, order, axis=1)
    n = s.shape[1]
    k = n - outliers
    s2 = np.concatenate([s, s + TWO_PI], axis=1)
    spans = s2[:, k - 1:k - 1 + n] - s2[:, :n]
    i = spans.argmin(axis=1)
    rows = np.arange(len(i))
    val = spans[rows, i]
    if not details:
        return val
    start = order[rows, i]
    end = order[rows, (i + k - 1) % n]
    out = np.full((len(i), 2), -1)
    for m in range(outliers):
        out[:, m] = order[rows, (i + k + m) % n]
    return val, start, end, out


def max_separation(units, details=False):
    """Largest angle between any two directions. units: (N,n,3) unit vectors."""
    n = units.shape[1]
    pi, pj = np.triu_indices(n, 1)
    dots = np.einsum("nkc,nkc->nk", units[:, pi], units[:, pj])
    k = dots.argmin(axis=1)
    rows = np.arange(len(k))
    val = np.arccos(np.clip(dots[rows, k], -1.0, 1.0))
    if not details:
        return val
    return val, pi[k], pj[k]


class Metric:
    def __init__(self, eph, plane, modes):
        self.eph = eph
        self.e1, self.e2 = plane_basis(plane)
        self.modes = modes
        self.names = list(modes)
        # groups of longitude criteria sharing one sort
        self.groups = {}
        self.groups3d = {}
        for im, (name, m) in enumerate(modes.items()):
            if m.measure == "3d":
                self.groups3d.setdefault(tuple(m.bodies), []).append(im)
            else:
                self.groups.setdefault((m.frame, m.doubled, tuple(m.bodies)), []).append((im, m.outliers))

    def state(self, t):
        """Vectors and projected longitudes for both frames."""
        pos = self.eph.barycentric(t)
        vec = {"helio": {b: v - pos[SUN] for b, v in pos.items() if b != SUN},
               "geo": {b: v - pos[EARTH] for b, v in pos.items() if b != EARTH}}
        lon = {f: {b: np.arctan2(self.e2 @ v, self.e1 @ v) for b, v in d.items()} for f, d in vec.items()}
        return vec, lon

    @staticmethod
    def units(vec, bodies, sel=slice(None)):
        u = np.stack([vec["geo"][b][:, sel].T for b in bodies], axis=1)
        return u / np.linalg.norm(u, axis=2, keepdims=True)

    def evaluate(self, st, mode, sel=slice(None), details=False):
        """Amplitude (radians) of one criterion at the times `sel` of state `st`;
        with details also the body ids at both ends and the ids left out
        ((N,2), NONE = none)."""
        vec, lon = st
        ids = np.array(mode.bodies)
        if mode.measure == "3d":
            r = max_separation(self.units(vec, mode.bodies, sel), details)
            if not details:
                return r
            return r[0], ids[r[1]], ids[r[2]], np.full((len(r[0]), 2), NONE)
        f = 2.0 if mode.doubled else 1.0
        ang = np.stack([lon[mode.frame][b][sel] for b in mode.bodies], axis=1) * f
        r = kofn_arc(ang, mode.outliers, details)
        if not details:
            return r / f
        val, start, end, out = r
        out_ids = np.where(out >= 0, ids[np.maximum(out, 0)], NONE)
        return val / f, ids[start], ids[end], out_ids

    def all_modes(self, t):
        st = self.state(t)
        vec, lon = st
        res = np.empty((len(self.names), t.size))
        for (frame, doubled, bodies), members in self.groups.items():
            f = 2.0 if doubled else 1.0
            a = np.mod(np.stack([lon[frame][b] for b in bodies], axis=1) * f, TWO_PI)
            s = np.sort(a, axis=1)
            n = s.shape[1]
            s2 = np.concatenate([s, s + TWO_PI], axis=1)
            for im, o in members:
                k = n - o
                res[im] = (s2[:, k - 1:k - 1 + n] - s2[:, :n]).min(axis=1) / f
        for bodies, members in self.groups3d.items():
            v = max_separation(self.units(vec, list(bodies)))
            for im in members:
                res[im] = v
        return res

    def per_candidate(self, t, mode_idx):
        """Each candidate's own criterion (one ephemeris call for all of them)."""
        st = self.state(t)
        out = np.empty(t.size)
        for im in np.unique(mode_idx):
            sel = mode_idx == im
            out[sel] = self.evaluate(st, self.modes[self.names[im]], sel)
        return out


def refine(met, tk, mode_idx, h, v_sample):
    """Vectorised golden-section search in [t-h, t+h] for every candidate."""
    gr = (math.sqrt(5.0) - 1.0) / 2.0
    a, b = tk - h, tk + h
    c, d = b - gr * (b - a), a + gr * (b - a)
    fc, fd = met.per_candidate(c, mode_idx), met.per_candidate(d, mode_idx)
    for _ in range(REFINE_ITER):
        left = fc < fd
        a2 = np.where(left, a, c)
        b2 = np.where(left, d, b)
        c2 = np.where(left, b2 - gr * (b2 - a2), d)
        d2 = np.where(left, c, a2 + gr * (b2 - a2))
        fn = met.per_candidate(np.where(left, c2, d2), mode_idx)
        fc, fd = np.where(left, fn, fd), np.where(left, fc, fn)
        a, b, c, d = a2, b2, c2, d2
    t = np.where(fc < fd, c, d)
    v = np.minimum(fc, fd)
    worse = v > v_sample                  # safeguard if the function was not unimodal
    t[worse], v[worse] = tk[worse], v_sample[worse]
    return t, v


# ----------------------------------------------------------------------------
# Eclipses near a date
# ----------------------------------------------------------------------------
def _sun_moon(eph, t):
    """Geocentric Sun–Moon angle and the eclipse limits at times t."""
    sun, earth, moon = eph.sun_earth_moon(t)
    s, m = sun - earth, moon - earth
    ds, dm = np.linalg.norm(s, axis=0), np.linalg.norm(m, axis=0)
    sep = np.arccos(np.clip(np.sum(s * m, axis=0) / (ds * dm), -1, 1))
    ss, sm = np.arcsin(R_SUN / ds), np.arcsin(R_MOON / dm)
    ps, pm = np.arcsin(R_EARTH / ds), np.arcsin(R_EARTH / dm)
    solar = ss + sm + pm - ps                       # partial eclipse somewhere on Earth
    umbral = 1.02 * (pm + ps - ss) + sm             # Moon touches the umbra
    penumbral = 1.02 * (pm + ps + ss) + sm          # Moon touches the penumbra
    return sep, solar, umbral, penumbral


def eclipse_events(eph, t0, t1):
    """Every solar and lunar eclipse whose greatest phase falls in [t0, t1].
    Returns (times, kinds) sorted by time; kinds: 1 solar, 2 lunar (umbral),
    3 lunar (penumbral only)."""
    grid = np.arange(math.floor(t0) - 1.0, math.ceil(t1) + 2.0, 0.5)
    sep = _sun_moon(eph, grid)[0]
    gr = (math.sqrt(5.0) - 1.0) / 2.0
    times, kinds = [], []
    for solar in (True, False):
        d = sep if solar else math.pi - sep
        loc = np.nonzero((d[1:-1] <= d[:-2]) & (d[1:-1] < d[2:]))[0] + 1
        if loc.size == 0:
            continue
        f = (lambda x: _sun_moon(eph, x)[0]) if solar else (lambda x: math.pi - _sun_moon(eph, x)[0])
        a, b = grid[loc] - 0.5, grid[loc] + 0.5
        c, e = b - gr * (b - a), a + gr * (b - a)
        fc, fe = f(c), f(e)
        for _ in range(22):
            left = fc < fe
            a2, b2 = np.where(left, a, c), np.where(left, e, b)
            c2 = np.where(left, b2 - gr * (b2 - a2), e)
            e2 = np.where(left, c, a2 + gr * (b2 - a2))
            fn = f(np.where(left, c2, e2))
            fc, fe = np.where(left, fn, fe), np.where(left, fc, fn)
            a, b, c, e = a2, b2, c2, e2
        tm = np.where(fc < fe, c, e)
        sep_m, sol, umb, pen = _sun_moon(eph, tm)
        if solar:
            k = np.where(sep_m < sol, 1, 0)
        else:
            dm = math.pi - sep_m
            k = np.where(dm < umb, 2, np.where(dm < pen, 3, 0))
        keep = (k > 0) & (tm >= t0) & (tm <= t1)
        times.append(tm[keep])
        kinds.append(k[keep])
    if not times:
        return np.zeros(0), np.zeros(0, np.uint8)
    tt, kk = np.concatenate(times), np.concatenate(kinds).astype(np.uint8)
    o = np.argsort(tt)
    return tt[o], kk[o]


def eclipses_near(ev_t, ev_k, t):
    """Nearest eclipse within ±ECLIPSE_WINDOW days of each time: (kind, offset)."""
    kinds = np.zeros(t.size, np.uint8)
    offset = np.full(t.size, np.nan, np.float32)
    if ev_t.size == 0 or t.size == 0:
        return kinds, offset
    j = np.clip(np.searchsorted(ev_t, t), 1, ev_t.size - 1) if ev_t.size > 1 else np.zeros(t.size, int)
    if ev_t.size > 1:
        j = np.where(np.abs(ev_t[j - 1] - t) < np.abs(ev_t[j] - t), j - 1, j)
    dt = ev_t[j] - t
    hit = np.abs(dt) <= ECLIPSE_WINDOW
    kinds[hit], offset[hit] = ev_k[j][hit], dt[hit]
    return kinds, offset


ECLIPSE_NAMES = {0: "", 1: "solar", 2: "lunar", 3: "lunar (penumbral)"}


# ----------------------------------------------------------------------------
# Cache
# ----------------------------------------------------------------------------
FIELDS = {"jd": (np.float64, ()), "amp": (np.float32, ()), "ends": (np.uint8, (2,)),
          "out": (np.uint8, (2,)), "elong": (np.float32, ()), "ecl": (np.uint8, ()),
          "ecl_dt": (np.float32, ())}


class Cache:
    def __init__(self, path, key, mode_names):
        self.path, self.key, self.mode_names = path, key, mode_names
        self.done = set()
        self.data = {m: {f: [] for f in FIELDS} for m in mode_names}
        self.dirty = False

    def load(self):
        if not os.path.exists(self.path):
            return False
        with np.load(self.path, allow_pickle=False) as z:
            meta = json.loads(str(z["meta"]))
            if meta != self.key:
                sys.exit(f"The cache {self.path} was created with different parameters or an older\n"
                         f"version of this program:\n  {meta}\nCurrent parameters:\n  {self.key}\n"
                         "Use another --cache or --reset.")
            self.done = set(int(x) for x in z["done"])
            for m in self.mode_names:
                self.data[m] = {f: [z[f"{f}_{m}"]] for f in FIELDS}
        return True

    def arrays(self, m):
        d = self.data[m]
        if len(d["jd"]) != 1:
            if d["jd"]:
                cat = {f: np.concatenate(d[f]) for f in FIELDS}
                o = np.argsort(cat["jd"])
                for f in FIELDS:
                    d[f] = [cat[f][o]]
            else:
                for f, (dt, shape) in FIELDS.items():
                    d[f] = [np.empty((0,) + shape, dt)]
        return {f: d[f][0] for f in FIELDS}

    def add(self, block, results):
        for m, cols in results.items():
            for f in FIELDS:
                self.data[m][f].append(cols[f])
        self.done.add(block)
        self.dirty = True

    def save(self):
        if not self.dirty:
            return
        content = {"meta": np.array(json.dumps(self.key)),
                   "done": np.array(sorted(self.done), dtype=np.int64)}
        for m in self.mode_names:
            for f, arr in self.arrays(m).items():
                content[f"{f}_{m}"] = arr
        tmp = self.path + ".tmp"
        with open(tmp, "wb") as fh:
            np.savez(fh, **content)
        os.replace(tmp, self.path)        # atomic write: the cache is never left corrupt
        self.dirty = False


# ----------------------------------------------------------------------------
# Computing one block
# ----------------------------------------------------------------------------
def process_block(met, block, n, h):
    k = np.arange(block * n - 1, (block + 1) * n + 1, dtype=np.int64)
    t = k * h
    vals = met.all_modes(t)
    cand_t, cand_m, cand_v = [], [], []
    for im, name in enumerate(met.names):
        x = vals[im]
        loc = np.nonzero((x[1:-1] <= x[:-2]) & (x[1:-1] < x[2:])
                         & (x[1:-1] < math.radians(met.modes[name].cap)))[0] + 1
        cand_t.append(t[loc])
        cand_v.append(x[loc])
        cand_m.append(np.full(loc.size, im))
    ct, cm, cv = np.concatenate(cand_t), np.concatenate(cand_m), np.concatenate(cand_v)
    res = {}
    if ct.size:
        tr, vr = refine(met, ct, cm, h, cv)
        st = met.state(tr)
        ev_t, ev_k = eclipse_events(met.eph, t[0] - ECLIPSE_WINDOW - h, t[-1] + ECLIPSE_WINDOW + h)
        ecl, ecl_dt = eclipses_near(ev_t, ev_k, tr)
    for im, name in enumerate(met.names):
        mode = met.modes[name]
        sel = (cm == im) if ct.size else np.zeros(0, bool)
        if sel.any():
            sel &= vr < math.radians(mode.cap)
        if not sel.any():
            res[name] = {f: np.empty((0,) + shape, dt) for f, (dt, shape) in FIELDS.items()}
            continue
        amp, start, end, out = met.evaluate(st, mode, sel, details=True)
        elong = np.full(sel.sum(), np.nan, np.float32)
        if mode.kind == "sky":
            sun = met.units(st[0], [SUN], sel)[:, 0]
            e = np.full(sel.sum(), np.inf)
            for b in mode.bodies:
                u = met.units(st[0], [b], sel)[:, 0]
                ang = np.degrees(np.arccos(np.clip(np.sum(u * sun, axis=1), -1, 1)))
                left_out = (out[:, 0] == b) | (out[:, 1] == b)
                e = np.where(left_out, e, np.minimum(e, ang))
            elong = e.astype(np.float32)
        res[name] = {"jd": tr[sel], "amp": np.degrees(vr[sel]).astype(np.float32),
                     "ends": np.stack([start, end], 1).astype(np.uint8),
                     "out": out.astype(np.uint8), "elong": elong,
                     "ecl": ecl[sel], "ecl_dt": ecl_dt[sel]}
    return res


def valid_blocks(eph, step, lo=-math.inf, hi=math.inf):
    """Blocks fully covered by the ephemeris (with a margin) that overlap [lo, hi)."""
    margin = 3 * step + ECLIPSE_WINDOW + 1
    b0 = math.floor(eph.jd_min / BLOCK_DAYS)
    b1 = math.ceil(eph.jd_max / BLOCK_DAYS)
    return [b for b in range(b0, b1 + 1)
            if eph.covers(b * BLOCK_DAYS - margin, (b + 1) * BLOCK_DAYS + margin)
            and (b + 1) * BLOCK_DAYS > lo and b * BLOCK_DAYS < hi]


# ----------------------------------------------------------------------------
# Selection and output
# ----------------------------------------------------------------------------
def select(jd, amp, threshold, top, window):
    """Minima below the threshold and/or the N best; within ±window days only
    the best one is kept (non-maximum suppression)."""
    order = np.argsort(amp, kind="stable")
    if threshold is not None:
        order = order[amp[order] <= threshold]
    accepted, jds = [], []
    for i in order:
        t = jd[i]
        if window > 0:
            p = bisect.bisect_left(jds, t)
            if (p < len(jds) and jds[p] - t < window) or (p > 0 and t - jds[p - 1] < window):
                continue
        bisect.insort(jds, t)
        accepted.append(i)
        if top and len(accepted) >= top:
            break
    return np.array(sorted(accepted, key=lambda i: jd[i]), dtype=np.int64)


def describe(mode, args):
    if mode.kind == "geo":
        title = "Seen from Earth: smallest arc of sky holding the Sun and the bodies"
    elif mode.kind == "sky":
        title = "Seen from Earth, Sun left out: bodies bunched together in the sky"
    elif mode.kind == "helio_side":
        title = "Sun at one end: smallest sector (vertex at the Sun) holding the bodies"
    else:
        title = "Alignment along a line through the Sun (bodies on either side)"
    if mode.measure == "3d":
        title += "\n Measure: largest angular distance between two bodies (latitude included)"
    if mode.outliers:
        title += f"\n Any {mode.outliers} bod{'y' if mode.outliers == 1 else 'ies'} may stay outside the group"
    return title


def show(cache, args, modes, valid_blocks_, lo, hi, out=sys.stdout):
    name = mode_name(args)
    mode = modes[name]
    a = cache.arrays(name)
    keep = (a["jd"] >= lo) & (a["jd"] < hi)
    if args.min_elongation is not None:
        keep &= a["elong"] >= args.min_elongation
    if args.eclipse == "solar":
        keep &= a["ecl"] == 1
    elif args.eclipse == "lunar":
        keep &= (a["ecl"] == 2) | (a["ecl"] == 3)
    elif args.eclipse == "any":
        keep &= a["ecl"] > 0
    a = {f: v[keep] for f, v in a.items()}
    jd, amp = a["jd"], a["amp"].astype(np.float64)
    done = len(cache.done & set(valid_blocks_))
    pct = 100.0 * done / max(1, len(valid_blocks_))
    p = lambda s="": print(s, file=out)
    p()
    p("=" * 100)
    p(" " + describe(mode, args))
    p(f" Bodies: {', '.join(BODY_NAMES[b] for b in mode.bodies)}")
    p(f" Frame: {'heliocentric' if mode.frame == 'helio' else 'geocentric'}   |   plane: {args.plane}"
      f"   |   times: {'UT (TDB − ΔT)' if args.time == 'ut' else 'TDB'}")
    filt = []
    if args.threshold is not None:
        filt.append(f"amplitude ≤ {args.threshold}°")
    if args.top:
        filt.append(f"best {args.top}")
    filt.append(f"1 per ±{args.window:g} days")
    if args.min_elongation is not None:
        filt.append(f"≥ {args.min_elongation:g}° from the Sun")
    if args.eclipse:
        filt.append(f"with a {args.eclipse if args.eclipse != 'any' else ''} eclipse".replace("  ", " "))
    p(f" Filter: {', '.join(filt)}   |   blocks computed: {done}/{len(valid_blocks_)} ({pct:.1f} %)")
    p(f" Groupings stored for this criterion (≤ {mode.cap:g}°): {jd.size}")
    p("=" * 100)
    if jd.size == 0:
        p(" (no results yet)")
        return
    sel = select(jd, amp, args.threshold, args.top, args.window)
    show_out = mode.outliers > 0
    show_el = mode.kind == "sky"
    show_ecl = bool((a["ecl"][sel] > 0).any())
    show_dt = args.time == "ut"
    head = f" {'JD (TDB)':>16}  {'Date (astronomical year)':<24} {'Amplitude':>10}  {'Δ days':>11}  {'Arc ends':<19}"
    if show_out:
        head += f" {'Left out':<17}"
    if show_el:
        head += f" {'Elong.':>7}"
    if show_dt:
        head += f" {'ΔT ± σ':>15}"
    if show_ecl:
        head += "  Eclipse"
    p(head)
    p(" " + "-" * 98)
    names = BODY_NAMES + [""] * 256
    rows, prev = [], None
    for i in sel:
        delta = "" if prev is None else f"{jd[i] - prev:11.2f}"
        prev = jd[i]
        dts, sig = delta_t(jd[i])
        when = jd[i] - dts / 86400.0 if args.time == "ut" else jd[i]
        date = format_date(when, args.calendar)
        ends = f"{names[a['ends'][i, 0]]} – {names[a['ends'][i, 1]]}"
        line = f" {jd[i]:16.5f}  {date:<24} {amp[i]:9.4f}°  {delta:>11}  {ends:<19}"
        left = ", ".join(names[x] for x in a["out"][i] if x != NONE)
        if show_out:
            line += f" {left:<17}"
        if show_el:
            line += f" {a['elong'][i]:6.1f}°"
        if show_dt:
            line += f" {format_duration_s(dts) + '±' + format_duration_s(sig):>15}"
        ecl = ""
        if a["ecl"][i]:
            ecl = f"{ECLIPSE_NAMES[int(a['ecl'][i])]} {a['ecl_dt'][i]:+.1f} d"
        if show_ecl:
            line += f"  {ecl}"
        p(line)
        rows.append((jd[i], date, amp[i], delta.strip(), ends, left,
                     "" if np.isnan(a["elong"][i]) else f"{a['elong'][i]:.2f}", ecl,
                     dts if args.time == "ut" else "", sig if args.time == "ut" else ""))
    p(" " + "-" * 98)
    best = int(np.argmin(amp))
    p(f" Best of everything stored: {amp[best]:.4f}° at JD {jd[best]:.5f}")
    p(" Astronomical year numbering: 0 = 1 BC, -1 = 2 BC.  Geometric positions.  Eclipse = a solar or")
    p(f" lunar eclipse within ±{ECLIPSE_WINDOW:g} days (offset in days from the grouping).")
    if args.time == "ut":
        p(" UT from ΔT of Espenak & Meeus / Morrison & Stephenson (2004); σ from Morrison & Stephenson")
        p(" and Huber (2000). Far from the present the date itself is uncertain.")
    if args.csv:
        with open(args.csv, "w", encoding="utf-8") as f:
            f.write("jd_tdb,date,time_scale,amplitude_deg,days_since_previous,arc_ends,left_out,"
                    "min_elongation_deg,eclipse,delta_t_s,delta_t_sigma_s\n")
            for r in rows:
                dt_s = f"{r[8]:.0f}" if r[8] != "" else ""
                sg_s = f"{r[9]:.0f}" if r[9] != "" else ""
                f.write(f"{r[0]:.6f},{r[1]},{args.time.upper()},{r[2]:.6f},{r[3]},{r[4]},"
                        f"\"{r[5]}\",{r[6]},{r[7]},{dt_s},{sg_s}\n")
        p(f" CSV written to {args.csv}")


def _on_signal(signum, frame):
    raise KeyboardInterrupt


def fmt_duration(s):
    s = int(s)
    return f"{s // 3600}h{(s % 3600) // 60:02d}m" if s >= 3600 else f"{s // 60}m{s % 60:02d}s"


# ----------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(
        description="Syzygeon: dates of tightest planetary alignment/grouping using JPL DE441.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    ap.add_argument("--ephemeris", nargs="+", default=None,
                    help=".bsp files (default: de441*.bsp in the current directory)")
    ap.add_argument("--frame", choices=["helio", "geo", "sky"], default="helio",
                    help="helio = seen from the Sun; geo = seen from Earth with the Sun; "
                         "sky = seen from Earth without the Sun")
    ap.add_argument("--same-side", action="store_true",
                    help="helio only: all bodies on the same side of the Sun (Sun at one end)")
    ap.add_argument("--moon", action="store_true", help="include the Moon")
    ap.add_argument("--classical", action="store_true",
                    help="naked-eye planets only (exclude Uranus, Neptune and Pluto)")
    ap.add_argument("--outliers", type=int, choices=[0, 1, 2], default=0,
                    help="how many bodies may stay outside the group")
    ap.add_argument("--measure", choices=["longitude", "3d"], default="longitude",
                    help="geo/sky only: 3d = true angular distance, latitude included")
    ap.add_argument("--min-elongation", type=float, default=None,
                    help="sky only: every body of the group at least this far from the Sun (deg)")
    ap.add_argument("--eclipse", choices=["any", "solar", "lunar"], default=None,
                    help=f"only groupings with an eclipse within ±{ECLIPSE_WINDOW:g} days")
    ap.add_argument("--pluto", action="store_true", help="include Pluto (uses a separate cache)")
    ap.add_argument("--threshold", type=float, default=None,
                    help="show every grouping with amplitude ≤ THRESHOLD degrees")
    ap.add_argument("--top", type=int, default=None,
                    help="show only the N best (default 30 when no --threshold)")
    ap.add_argument("--window", type=float, default=3650.0,
                    help="within ±WINDOW days only the best one is shown (0 = all)")
    ap.add_argument("--calendar", choices=["auto", "julian", "gregorian"], default="auto",
                    help="auto = Julian before 1582-10-15, Gregorian from then on")
    ap.add_argument("--time", choices=["tdb", "ut"], default="tdb",
                    help="time scale of the dates shown (ut = civil time via ΔT)")
    ap.add_argument("--plane", choices=["invariable", "ecliptic"], default="invariable",
                    help="plane onto which longitudes are projected")
    ap.add_argument("--step", type=float, default=1.0,
                    help="sampling step in days before refinement")
    ap.add_argument("--from", dest="year_from", type=int, default=None,
                    help="first astronomical year (optional)")
    ap.add_argument("--to", dest="year_to", type=int, default=None,
                    help="last astronomical year (optional)")
    ap.add_argument("--cache", default=None, help="cache file (.npz)")
    ap.add_argument("--reset", action="store_true", help="delete the cache and start over")
    ap.add_argument("--show-only", action="store_true",
                    help="show what is in the cache without computing")
    ap.add_argument("--csv", default=None, help="export the displayed table to CSV")
    args = ap.parse_args()
    if args.threshold is None and args.top is None:
        args.top = 30
    if args.frame != "helio" and args.same_side:
        ap.error("--same-side only applies to --frame helio")
    if args.measure == "3d" and args.frame == "helio":
        ap.error("--measure 3d applies to --frame geo or sky")
    if args.measure == "3d" and args.outliers:
        ap.error("--measure 3d cannot be combined with --outliers")
    if args.min_elongation is not None and args.frame != "sky":
        ap.error("--min-elongation only applies to --frame sky")

    paths = args.ephemeris or sorted(glob.glob("de441*.bsp"))
    if not paths:
        sys.exit("No de441*.bsp found in the current directory; use --ephemeris.")
    eph = Ephemeris(paths, args.pluto)
    modes = build_modes(args.pluto)
    if mode_name(args) not in modes:
        ap.error(f"--outliers {args.outliers} is not available here: the group must keep at least "
                 f"{MIN_PLANETS_IN_GROUP} planets")
    met = Metric(eph, args.plane, modes)

    h = args.step
    n = int(round(BLOCK_DAYS / h))
    if abs(n * h - BLOCK_DAYS) > 1e-9:
        sys.exit(f"--step must divide {BLOCK_DAYS} days exactly.")
    lo = eph.jd_min if args.year_from is None else max(eph.jd_min, year_to_jd(args.year_from))
    hi = eph.jd_max if args.year_to is None else min(eph.jd_max, year_to_jd(args.year_to + 1))
    valid = valid_blocks(eph, h, lo, hi)
    if not valid:
        sys.exit("The requested range is not covered by the ephemeris files.")

    key = {"version": CACHE_VERSION, "plane": args.plane, "pluto": args.pluto,
           "step": h, "block": BLOCK_DAYS, "modes": list(modes),
           "caps": [modes[m].cap for m in modes]}
    path = args.cache or f"alignments_cache_{args.plane}_{'9' if args.pluto else '8'}p_step{h:g}.npz"
    if args.reset and os.path.exists(path):
        os.remove(path)
    cache = Cache(path, key, list(modes))
    if cache.load():
        print(f"Cache loaded: {path} ({len(cache.done)} blocks already computed)")
    print(f"Ephemeris: {', '.join(os.path.basename(p) for p in paths)}")
    print(f"Range: {format_date(valid[0] * BLOCK_DAYS, 'auto')} … "
          f"{format_date((valid[-1] + 1) * BLOCK_DAYS, 'auto')}  "
          f"({len(valid)} blocks of {BLOCK_DAYS} days)")

    show(cache, args, modes, valid, lo, hi)
    pending = [b for b in valid if b not in cache.done]
    if args.show_only or not pending:
        if not pending:
            print("\nThe whole range has been computed.")
        return

    print(f"\nComputing {len(pending)} pending blocks (Ctrl+C to stop and save)…")
    signal.signal(signal.SIGTERM, _on_signal)
    name = mode_name(args)
    t_start, t_saved, done_now = time.time(), time.time(), 0
    interrupted = False
    try:
        for b in pending:
            cache.add(b, process_block(met, b, n, h))
            done_now += 1
            now = time.time()
            if now - t_saved > AUTOSAVE_S:
                cache.save()
                t_saved = now
            arr = cache.arrays(name)
            rate = (now - t_start) / done_now
            best = ""
            if arr["jd"].size:
                i = int(np.argmin(arr["amp"]))
                best = f"best {arr['amp'][i]:.2f}° {format_date(arr['jd'][i], args.calendar)[:12]}"
            upto = format_date((b + 1) * BLOCK_DAYS, args.calendar)[:6]
            sys.stdout.write(f"\r  {done_now}/{len(pending)}  up to year {upto}  "
                             f"ETA {fmt_duration(rate * (len(pending) - done_now))}  {best}   ")
            sys.stdout.flush()
    except KeyboardInterrupt:
        interrupted = True
    finally:
        # Save first (a second Ctrl+C cannot interrupt it), then report.
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        saved = cache.dirty
        cache.save()
        signal.signal(signal.SIGINT, signal.default_int_handler)
        signal.signal(signal.SIGTERM, signal.SIG_DFL)
    if interrupted:
        print("\n\nStopped by the user.")
    if saved:
        print(f"\nCache saved to {path} ({len(cache.done)} blocks).")
    show(cache, args, modes, valid, lo, hi)
    if interrupted:
        print("\nRun the same command again to resume.")


if __name__ == "__main__":
    main()
