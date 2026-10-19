/* SPDX-License-Identifier: GPL-3.0-or-later
   Copyright (C) 2026 Carlos Baiget Orts <asinfreedom@gmail.com>
   Developed with the assistance of Claude (Anthropic) */
/* Syzygeon — planetary alignments viewer.
   Reads the dataset written by export_web.py (data/manifest.json + one .bin per
   criterion). Nothing is computed from the ephemeris here: the page filters the
   precomputed groupings and draws the stored positions. */
"use strict";

const DATA_DIR = "data/";
// Address of the project's repository. Leave empty to work it out on GitHub
// Pages (https://<user>.github.io/<repo>/ -> https://github.com/<user>/<repo>);
// set it if the page is served from another domain.
const REPO_URL = "https://github.com/carbaior/syzygeon";
// Visitor counter (GoatCounter: free for open projects, no cookies, no stored
// IPs). Put your site code here, e.g. "syzygeon" for https://syzygeon.goatcounter.com,
// and enable "Allow adding visitor counts on your website" in its settings.
// Empty = no counting and no counter shown.
const GOATCOUNTER = "cjbo";
const FORMAT = 2;
const MAX_ROWS = 5000;              // rows rendered in the table (CSV exports all)
const TWO_PI = 2 * Math.PI;
const DEG = 180 / Math.PI;
const JD_GREGORIAN = 2299160.5;
const SUN = 0, MERCURY = 1, VENUS = 2, EARTH = 3, MARS = 4, JUPITER = 5, SATURN = 6,
      URANUS = 7, NEPTUNE = 8, PLUTO = 9, MOON = 10, NONE = 255;
const ECLIPSE_NAMES = { 1: "solar", 2: "lunar", 3: "penumbral lunar" };   // CSV only (kept in English)

const $ = (sel) => document.querySelector(sel);
const form = $("#controls");
const tbody = $("#table tbody");

const state = {
  manifest: null,
  data: {},            // criterion name -> decoded arrays
  rows: [],            // listed record indices, chronological
  pool: [],            // every record passing the filters (for the timeline)
  rec: -1,             // selected record index
  view: null,          // "helio" | "geo" (diagram centre); null = follow the criterion
  scale: "schematic",
  lonSystem: "plane",  // "plane" | "tropical" | "sidereal"
};

/* ------------------------------------------------------------------------ */
/* Languages                                                                */
/* Every visible text comes from i18n/<code>.json; missing keys fall back to */
/* English. To add a language see README.md ("Adding a language").          */
/* ------------------------------------------------------------------------ */
const I18N_DIR = "i18n/";
const i18n = { list: [], fallbackCode: "en", fallback: {}, dict: {}, lang: null, cache: {} };
const locale = () => (i18n.lang ? i18n.lang.locale : "en-GB");

function rawText(key, vars) {
  let s = key in i18n.dict ? i18n.dict[key] : i18n.fallback[key];
  if (s === undefined) return key;
  if (typeof s === "object") {                // plural forms: { one, few, many, other, ... }
    const n = vars && (vars.count !== undefined ? vars.count : vars.n);
    const cat = new Intl.PluralRules(locale()).select(typeof n === "number" ? n : 0);
    s = s[cat] !== undefined ? s[cat] : s.other;
  }
  return s;
}
const fillVar = (v) => (typeof v === "number" ? v.toLocaleString(locale()) : String(v));
function t(key, vars = {}) {
  return rawText(key, vars).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? fillVar(vars[k]) : m));
}
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Like t(), but returns HTML: the text is escaped and `html` values are inserted as markup.
function tHtml(key, vars = {}, html = {}) {
  return escapeHtml(rawText(key, vars)).replace(/\{(\w+)\}/g, (m, k) =>
    (k in html ? html[k] : (k in vars ? escapeHtml(fillVar(vars[k])) : m)));
}
const sentences = (...parts) => parts.filter(Boolean).join(t("sep"));
const bodyName = (b) => t(`body.${b}`);
const monthShort = (m) => new Intl.DateTimeFormat(locale(), { month: "short", timeZone: "UTC" })
  .format(new Date(Date.UTC(2000, m - 1, 15)));
const listText = (items) => (typeof Intl.ListFormat === "function"
  ? new Intl.ListFormat(locale(), { type: "conjunction" }).format(items) : items.join(", "));

async function loadDict(code) {
  if (i18n.cache[code]) return i18n.cache[code];
  const res = await fetch(`${I18N_DIR}${code}.json`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${code}.json (HTTP ${res.status})`);
  i18n.cache[code] = await res.json();
  return i18n.cache[code];
}

// Language from the address (#lang=xx), then the saved choice, then the browser.
function pickLanguage() {
  const codes = i18n.list.map((l) => l.code);
  const fromHash = new URLSearchParams(location.hash.slice(1)).get("lang");
  let saved = null;
  try { saved = localStorage.getItem("lang"); } catch (e) { /* storage unavailable */ }
  for (const c of [fromHash, saved]) if (c && codes.includes(c)) return c;
  for (const pref of navigator.languages || [navigator.language]) {
    const low = (pref || "").toLowerCase();
    const hit = codes.find((c) => c === low) || codes.find((c) => c === low.split("-")[0]);
    if (hit) return hit;
  }
  return i18n.fallbackCode;
}

function applyStatic() {
  document.querySelectorAll("[data-i18n]").forEach((node) => { node.textContent = t(node.dataset.i18n); });
  document.querySelectorAll("[data-i18n-attr]").forEach((node) => {
    for (const pair of node.dataset.i18nAttr.split(";")) {
      const [attr, key] = pair.split(":").map((x) => x.trim());
      node.setAttribute(attr, t(key));
    }
  });
  renderVisits();
  const plane = state.manifest && state.manifest.plane === "ecliptic" ? "footer.planeEcliptic" : "footer.planeInvariable";
  $("#footer-text").innerHTML = tHtml("footer.text", { plane: t(plane) }, { code: "<code>alignments.py</code>" });
}

async function setLanguage(code, rerender = true) {
  const lang = i18n.list.find((l) => l.code === code) || i18n.list.find((l) => l.code === i18n.fallbackCode);
  try { i18n.dict = await loadDict(lang.code); } catch (e) { i18n.dict = {}; }
  i18n.lang = lang;
  document.documentElement.lang = lang.code;
  document.documentElement.dir = lang.dir || "ltr";
  try { localStorage.setItem("lang", lang.code); } catch (e) { /* storage unavailable */ }
  applyStatic();
  applyTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
  renderPicker();
  if (rerender && state.manifest) {
    describeCoverage();
    await update(currentJd());
  }
}

function renderPicker() {
  const lang = i18n.lang;
  $("#lang-flag").src = `flags/${lang.flag}.svg`;
  $("#lang-name").textContent = lang.name;
  $("#lang-list").innerHTML = i18n.list.map((l) =>
    `<li role="option" id="lang-opt-${l.code}" data-code="${l.code}" lang="${l.code}" aria-selected="${l.code === lang.code}">` +
    `<img class="flag" src="flags/${l.flag}.svg" alt="" width="21" height="14"><span>${escapeHtml(l.name)}</span></li>`).join("");
}

function wirePicker() {
  const btn = $("#lang-button"), list = $("#lang-list");
  let active = 0;
  const items = () => [...list.querySelectorAll("li")];
  const setActive = (k) => {
    const it = items();
    active = (k + it.length) % it.length;
    it.forEach((li, j) => li.classList.toggle("active", j === active));
    list.setAttribute("aria-activedescendant", it[active].id);
    it[active].scrollIntoView({ block: "nearest" });
  };
  const open = () => {
    list.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    setActive(Math.max(0, i18n.list.findIndex((l) => l.code === i18n.lang.code)));
    list.focus();
  };
  const close = (focusButton) => {
    list.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    if (focusButton) btn.focus();
  };
  const choose = (code) => { close(true); if (code !== i18n.lang.code) setLanguage(code); };
  btn.addEventListener("click", () => (list.hidden ? open() : close(false)));
  btn.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); open(); }
  });
  list.addEventListener("click", (e) => { const li = e.target.closest("li"); if (li) choose(li.dataset.code); });
  list.addEventListener("mousemove", (e) => { const li = e.target.closest("li"); if (li) setActive(items().indexOf(li)); });
  list.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(active + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(active - 1); }
    else if (e.key === "Home") { e.preventDefault(); setActive(0); }
    else if (e.key === "End") { e.preventDefault(); setActive(items().length - 1); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose(items()[active].dataset.code); }
    else if (e.key === "Escape") { e.preventDefault(); close(true); }
    else if (e.key === "Tab") close(false);
  });
  document.addEventListener("click", (e) => { if (!list.hidden && !$("#lang-picker").contains(e.target)) close(false); });
}

/* ------------------------------------------------------------------------ */
/* Calendar and time scales (same algorithms as alignments.py)              */
/* ------------------------------------------------------------------------ */
const fdiv = (a, b) => Math.floor(a / b);

function calToJd(year, month, day, gregorian) {
  const a = fdiv(14 - month, 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  let jdn = day + fdiv(153 * m + 2, 5) + 365 * y + fdiv(y, 4);
  jdn += gregorian ? fdiv(y, 400) - fdiv(y, 100) - 32045 : -32083;
  return jdn - 0.5;
}

function jdToCal(jd, gregorian) {
  let z = Math.floor(jd + 0.5);
  const f = jd + 0.5 - z;
  const [period, years] = gregorian ? [146097, 400] : [1461, 4];
  const q = fdiv(z - 2451545, period);
  z -= q * period;
  let a = z;
  if (gregorian) {
    const alpha = fdiv(4 * z - 7468865, 146097);
    a = z + 1 + alpha - fdiv(alpha, 4);
  }
  const b = a + 1524;
  const c = fdiv(20 * b - 2442, 7305);
  const d = fdiv(1461 * c, 4);
  const e = fdiv(10000 * (b - d), 306001);
  const day = b - d - fdiv(306001 * e, 10000);
  const month = e < 14 ? e - 1 : e - 13;
  const year = (month > 2 ? c - 4716 : c - 4715) + q * years;
  const minutes = Math.round(f * 1440);
  if (minutes === 1440) {
    const next = jdToCal(Math.floor(jd + 0.5) + 0.5, gregorian);
    return { year: next.year, month: next.month, day: next.day, hour: 0, minute: 0 };
  }
  return { year, month, day, hour: Math.floor(minutes / 60), minute: minutes % 60 };
}

const yearToJd = (y) => calToJd(y, 1, 1, y >= 1583);
const jdToYear = (jd) => 2000 + (jd - 2451545) / 365.25;
const isGregorian = (jd, cal) => (cal === "auto" ? jd >= JD_GREGORIAN : cal === "gregorian");
const pad = (n, w = 2) => String(Math.abs(n)).padStart(w, "0");
// Years are passed as strings so they are never written with thousands separators.
const yearText = (y) => (y <= 0 ? t("year.bc", { y: String(1 - y) }) : (y < 1000 ? t("year.ad", { y: String(y) }) : String(y)));
const yearTextEra = (y) => (y <= 0 ? t("year.bc", { y: String(1 - y) }) : t("year.ad", { y: String(y) }));

function dateParts(jd, cal) {
  const g = isGregorian(jd, cal);
  const c = jdToCal(jd, g);
  return {
    text: t("date.format", { d: String(c.day), m: String(c.month), mon: monthShort(c.month), y: yearText(c.year) }),
    time: `${pad(c.hour)}:${pad(c.minute)}`,
    calKey: g ? "gregorian" : "julian",
    iso: `${c.year < 0 ? "-" : "+"}${pad(c.year, 5)}-${pad(c.month)}-${pad(c.day)} ${pad(c.hour)}:${pad(c.minute)} ${g ? "Greg" : "Jul"}`,
    astroYear: c.year,
  };
}

/* ΔT = TT − UT in seconds and its 1-sigma uncertainty (see alignments.py). */
function deltaT(jd) {
  const y = jdToYear(jd);
  let dt, u, t;
  if (y < -500 || y >= 2150) { u = (y - 1820) / 100; dt = -20 + 32 * u * u; }
  else if (y < 500) { u = y / 100; dt = 10583.6 - 1014.41 * u + 33.78311 * u ** 2 - 5.952053 * u ** 3 - 0.1798452 * u ** 4 + 0.022174192 * u ** 5 + 0.0090316521 * u ** 6; }
  else if (y < 1600) { u = (y - 1000) / 100; dt = 1574.2 - 556.01 * u + 71.23472 * u ** 2 + 0.319781 * u ** 3 - 0.8503463 * u ** 4 - 0.005050998 * u ** 5 + 0.0083572073 * u ** 6; }
  else if (y < 1700) { t = y - 1600; dt = 120 - 0.9808 * t - 0.01532 * t ** 2 + t ** 3 / 7129; }
  else if (y < 1800) { t = y - 1700; dt = 8.83 + 0.1603 * t - 0.0059285 * t ** 2 + 0.00013336 * t ** 3 - t ** 4 / 1174000; }
  else if (y < 1860) { t = y - 1800; dt = 13.72 - 0.332447 * t + 0.0068612 * t ** 2 + 0.0041116 * t ** 3 - 0.00037436 * t ** 4 + 0.0000121272 * t ** 5 - 0.0000001699 * t ** 6 + 0.000000000875 * t ** 7; }
  else if (y < 1900) { t = y - 1860; dt = 7.62 + 0.5737 * t - 0.251754 * t ** 2 + 0.01680668 * t ** 3 - 0.0004473624 * t ** 4 + t ** 5 / 233174; }
  else if (y < 1920) { t = y - 1900; dt = -2.79 + 1.494119 * t - 0.0598939 * t ** 2 + 0.0061966 * t ** 3 - 0.000197 * t ** 4; }
  else if (y < 1941) { t = y - 1920; dt = 21.20 + 0.84493 * t - 0.076100 * t ** 2 + 0.0020936 * t ** 3; }
  else if (y < 1961) { t = y - 1950; dt = 29.07 + 0.407 * t - t ** 2 / 233 + t ** 3 / 2547; }
  else if (y < 1986) { t = y - 1975; dt = 45.45 + 1.067 * t - t ** 2 / 260 - t ** 3 / 718; }
  else if (y < 2005) { t = y - 2000; dt = 63.86 + 0.3345 * t - 0.060374 * t ** 2 + 0.0017275 * t ** 3 + 0.000651814 * t ** 4 + 0.00002373599 * t ** 5; }
  else if (y < 2050) { t = y - 2000; dt = 62.92 + 0.32217 * t + 0.005589 * t ** 2; }
  else { dt = -20 + 32 * ((y - 1820) / 100) ** 2 - 0.5628 * (2150 - y); }
  const huber = (n) => 365.25 * n * Math.sqrt((n * 0.058 / 3) * (1 + n / 2500)) / 1000;
  const t2 = ((y - 1820) / 100) ** 2;
  let sigma;
  if (y <= -1000) sigma = huber(-500 - y);
  else if (y <= 1200) sigma = 0.8 * t2;
  else if (y <= 1600) sigma = Math.max(20, 0.8 * t2);
  else if (y <= 1700) sigma = 20 - 15 * (y - 1600) / 100;
  else if (y <= 1800) sigma = 5 - 4 * (y - 1700) / 100;
  else if (y <= 1900) sigma = 1 - 0.9 * (y - 1800) / 100;
  else if (y <= 2005) sigma = 0.1;
  else sigma = Math.max(0.1, huber(y - 2005));
  return { dt, sigma };
}

function durationText(s) {
  const sign = s < 0 ? "−" : "";
  s = Math.abs(s);
  const f = (x, dp) => x.toLocaleString(locale(), { minimumFractionDigits: dp, maximumFractionDigits: dp });
  let txt;
  if (s < 10) txt = t("unit.s", { n: f(s, 1) });
  else if (s < 120) txt = t("unit.s", { n: f(s, 0) });
  else if (s < 7200) txt = t("unit.min", { n: f(s / 60, 1) });
  else if (s < 172800) txt = t("unit.h", { n: f(s / 3600, 1) });
  else txt = t("unit.days", { n: f(s / 86400, 1), count: Number((s / 86400).toFixed(1)) });
  return sign + txt;
}

// JD in the chosen time scale
const shownJd = (jd, s) => (s.time === "ut" ? jd - deltaT(jd).dt / 86400 : jd);

/* ------------------------------------------------------------------------ */
/* Stellarium Web link and clipboard                                        */
/* ------------------------------------------------------------------------ */
const STELLARIUM = "https://stellarium-web.org/";
const COPY_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8.5" height="8.5" rx="1.6"/><path d="M10.5 3.2V2.6A1.6 1.6 0 0 0 8.9 1H2.6A1.6 1.6 0 0 0 1 2.6v6.3a1.6 1.6 0 0 0 1.6 1.6h.6"/></svg>';
const CHECK_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 8.5l3.5 3.5 7.5-8"/></svg>';

// ΔT model used by Stellarium Web itself (Stephenson, Morrison & Hohenkerk 2016,
// with its own extrapolations), so that the link opens the same TT instant.
const SMH2016 = [
  [-720.0, 400.0, 20550.593, -21268.478, 11863.418, -4541.129],
  [400.0, 1000.0, 6604.404, -5981.266, -505.093, 1349.609],
  [1000.0, 1500.0, 1467.654, -2452.187, 2460.927, -1183.759],
  [1500.0, 1600.0, 292.635, -216.322, -43.614, 56.681],
  [1600.0, 1650.0, 89.380, -66.754, 31.607, -10.497],
  [1650.0, 1720.0, 43.736, -49.043, 0.227, 15.811],
  [1720.0, 1800.0, 10.730, -1.321, 62.250, -52.946],
  [1800.0, 1810.0, 18.714, -4.457, -1.509, 2.507],
  [1810.0, 1820.0, 15.255, 0.046, 6.012, -4.634],
  [1820.0, 1830.0, 16.679, -1.831, -7.889, 3.799],
  [1830.0, 1840.0, 10.758, -6.211, 3.509, -0.388],
  [1840.0, 1850.0, 7.668, -0.357, 2.345, -0.338],
  [1850.0, 1855.0, 9.317, 1.659, 0.332, -0.932],
  [1855.0, 1860.0, 10.376, -0.472, -2.463, 1.596],
  [1860.0, 1865.0, 9.038, -0.610, 2.325, -2.497],
  [1865.0, 1870.0, 8.256, -3.450, -5.166, 2.729],
  [1870.0, 1875.0, 2.369, -5.596, 3.020, -0.919],
  [1875.0, 1880.0, -1.126, -2.312, 0.264, -0.037],
  [1880.0, 1885.0, -3.211, -1.894, 0.154, 0.562],
  [1885.0, 1890.0, -4.388, 0.101, 1.841, -1.438],
  [1890.0, 1895.0, -3.884, -0.531, -2.473, 1.870],
  [1895.0, 1900.0, -5.017, 0.134, 3.138, -0.232],
  [1900.0, 1905.0, -1.977, 5.715, 2.443, -1.257],
  [1905.0, 1910.0, 4.923, 6.828, -1.329, 0.720],
  [1910.0, 1915.0, 11.142, 6.330, 0.831, -0.825],
  [1915.0, 1920.0, 17.479, 5.518, -1.643, 0.262],
  [1920.0, 1925.0, 21.617, 3.020, -0.856, 0.008],
  [1925.0, 1930.0, 23.789, 1.333, -0.831, 0.127],
  [1930.0, 1935.0, 24.418, 0.052, -0.449, 0.142],
  [1935.0, 1940.0, 24.164, -0.419, -0.022, 0.702],
  [1940.0, 1945.0, 24.426, 1.645, 2.086, -1.106],
  [1945.0, 1950.0, 27.050, 2.499, -1.232, 0.614],
  [1950.0, 1953.0, 28.932, 1.127, 0.220, -0.277],
  [1953.0, 1956.0, 30.002, 0.737, -0.610, 0.631],
  [1956.0, 1959.0, 30.760, 1.409, 1.282, -0.799],
  [1959.0, 1962.0, 32.652, 1.577, -1.115, 0.507],
  [1962.0, 1965.0, 33.621, 0.868, 0.406, 0.199],
  [1965.0, 1968.0, 35.093, 2.275, 1.002, -0.414],
  [1968.0, 1971.0, 37.956, 3.035, -0.242, 0.202],
  [1971.0, 1974.0, 40.951, 3.157, 0.364, -0.229],
  [1974.0, 1977.0, 44.244, 3.198, -0.323, 0.172],
  [1977.0, 1980.0, 47.291, 3.069, 0.193, -0.192],
  [1980.0, 1983.0, 50.361, 2.878, -0.384, 0.081],
  [1983.0, 1986.0, 52.936, 2.354, -0.140, -0.166],
  [1986.0, 1989.0, 54.984, 1.577, -0.637, 0.448],
  [1989.0, 1992.0, 56.373, 1.649, 0.709, -0.277],
  [1992.0, 1995.0, 58.453, 2.235, -0.122, 0.111],
  [1995.0, 1998.0, 60.677, 2.324, 0.212, -0.315],
  [1998.0, 2001.0, 62.899, 1.804, -0.732, 0.112],
  [2001.0, 2004.0, 64.082, 0.675, -0.396, 0.193],
  [2004.0, 2007.0, 64.555, 0.463, 0.184, -0.008],
  [2007.0, 2010.0, 65.194, 0.809, 0.161, -0.101],
  [2010.0, 2013.0, 66.063, 0.828, -0.142, 0.168],
  [2013.0, 2016.0, 66.917, 1.046, 0.360, -0.282],
];

function stellariumDeltaT(utJd) {
  const y = jdToYear(utJd);
  if (y < -720) { const u = (y - 1825) / 100; return -320 + 32.5 * u * u; }
  if (y > 2016) {
    const t = y - 2000, dt2016 = 62.92 + 0.32217 * 16 + 0.005589 * 16 * 16;
    return 62.92 + 0.32217 * t + 0.005589 * t * t - (dt2016 - 68.1024);
  }
  let i = 0;
  while (SMH2016[i][1] < y) i++;
  const [k0, k1, a0, a1, a2, a3] = SMH2016[i];
  const t = (y - k0) / (k1 - k0);
  return ((a3 * t + a2) * t + a1) * t + a0;
}

// Mean obliquity of the ecliptic (Laskar 1986, valid ±10,000 years; clamped beyond).
function obliquity(jd) {
  const U = Math.max(-1, Math.min(1, (jd - 2451545) / 3652500));
  const c = [84381.448, -4680.93, -1.55, 1999.25, -51.38, -249.67, -39.05, 7.12, 27.87, 5.79, 2.45];
  let e = 0;
  for (let k = c.length - 1; k >= 0; k--) e = e * U + c[k];
  return e / 3600 / DEG;
}

function isoUtc(jd) {
  const c = jdToCal(jd, true);                // JavaScript dates are proleptic Gregorian
  const y = c.year >= 0 && c.year <= 9999 ? pad(c.year, 4) : `${c.year < 0 ? "-" : "+"}${pad(c.year, 6)}`;
  return `${y}-${pad(c.month)}-${pad(c.day)}T${pad(c.hour)}:${pad(c.minute)}:00Z`;
}

/* Link to Stellarium Web at the moment of record i, from a place on Earth where
   the group is overhead, centred on the body of the group nearest its middle. */
function stellariumLink(d, i, crit) {
  const pos = positions(d, i);
  const outs = leftOut(d, i);
  let group = crit.bodies.filter((b) => b !== EARTH && !outs.includes(b));
  if (!group.length) group = [SUN];
  const vec = (b) => {
    const l = pos[b].trop / DEG, t = pos[b].lat / DEG;
    return [Math.cos(t) * Math.cos(l), Math.cos(t) * Math.sin(l), Math.sin(t)];
  };
  const m = group.map(vec).reduce((s, v) => s.map((x, k) => x + v[k]), [0, 0, 0]);
  const norm = Math.hypot(...m);
  const centre = norm > 1e-3 ? m.map((x) => x / norm) : vec(group[0]);
  let target = group[0], bestDot = -2;
  for (const b of group) {
    const v = vec(b), dot = v[0] * centre[0] + v[1] * centre[1] + v[2] * centre[2];
    if (dot > bestDot) { bestDot = dot; target = b; }
  }
  const eps = obliquity(d.jd[i]);
  const [x, y, z] = centre;
  const ra = Math.atan2(y * Math.cos(eps) - z * Math.sin(eps), x) * DEG;
  const dec = Math.asin(y * Math.sin(eps) + z * Math.cos(eps)) * DEG;
  let ut = d.jd[i] - stellariumDeltaT(d.jd[i]) / 86400;
  ut = d.jd[i] - stellariumDeltaT(ut) / 86400;
  const D = ut - 2451545, T = D / 36525;
  const gmst = 280.46061837 + 360.98564736629 * D + 0.000387933 * T * T - T ** 3 / 38710000;
  const lng = ((((ra - gmst) % 360) + 540) % 360) - 180;
  const fov = crit.frame === "geo" ? Math.round(Math.max(25, Math.min(140, d.amp[i] * 1.4 + 15))) : 140;
  const q = new URLSearchParams({ date: isoUtc(ut), lat: dec.toFixed(3), lng: lng.toFixed(3), elev: "0", fov: String(fov) });
  return `${STELLARIUM}skysource/${names()[target]}?${q.toString()}`;
}

const copyButton = (text, label) =>
  `<button type="button" class="copy-btn" data-copy="${escapeHtml(text)}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">${COPY_ICON}</button>`;
const stelAnchor = (href, text) =>
  `<a class="stel-link" href="${href}" target="_blank" rel="noopener" title="${escapeHtml(t("stel.title"))}">${escapeHtml(text)}</a>`;
const jdText = (jd) => jd.toLocaleString(locale(), { useGrouping: false, minimumFractionDigits: 5, maximumFractionDigits: 5 });
const copyDateText = (p, s) => t("copy.dateText", { date: p.text, time: p.time, scale: s.time === "ut" ? "UT" : "TDB", calendar: t(`calName.${p.calKey}`) });

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {                               // older browsers or no permission
    const ta = document.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch (e2) { /* nothing else to try */ }
    ta.remove();
  }
  const label = btn.getAttribute("aria-label");
  btn.innerHTML = CHECK_ICON;
  btn.classList.add("copied");
  btn.setAttribute("aria-label", t("copy.done"));
  setTimeout(() => { btn.innerHTML = COPY_ICON; btn.classList.remove("copied"); btn.setAttribute("aria-label", label); }, 1500);
}

/* ------------------------------------------------------------------------ */
/* Data                                                                     */
/* ------------------------------------------------------------------------ */
async function loadManifest() {
  const res = await fetch(DATA_DIR + "manifest.json", { cache: "no-cache" });
  if (!res.ok) throw new Error(`manifest.json could not be read (HTTP ${res.status})`);
  const m = await res.json();
  if (m.format !== FORMAT) throw new Error(`the dataset has format ${m.format}; this page reads format ${FORMAT}. Run the current export_web.py`);
  return m;
}

async function loadCriterion(name) {
  if (state.data[name]) return state.data[name];
  const info = state.manifest.criteria[name];
  const res = await fetch(DATA_DIR + info.file, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${info.file} could not be read (HTTP ${res.status})`);
  const buf = await res.arrayBuffer();
  const n = info.count;
  const nb = state.manifest.pos_bodies.length;
  if (buf.byteLength !== n * (24 + 10 * nb + 5)) throw new Error(`${info.file} has an unexpected size`);
  let o = 0;
  const take = (Type, len) => { const a = new Type(buf, o, len); o += len * Type.BYTES_PER_ELEMENT; return a; };
  const d = {
    n,
    jd: take(Float64Array, n),
    amp: take(Float32Array, n),
    elong: take(Float32Array, n),
    eclDt: take(Float32Array, n),
    ayan: take(Float32Array, n),
    pos: take(Uint16Array, n * nb * 5),
    ends: take(Uint8Array, 2 * n),
    out: take(Uint8Array, 2 * n),
    ecl: take(Uint8Array, n),
  };
  state.data[name] = d;
  return d;
}

/* Positions of record i, per body id. */
function positions(d, i) {
  const m = state.manifest, nb = m.pos_bodies.length, out = {};
  m.pos_bodies.forEach((id, k) => {
    const o = (i * nb + k) * 5;
    out[id] = {
      hlon: d.pos[o] / 65536 * TWO_PI,
      glon: d.pos[o + 1] / 65536 * TWO_PI,
      r: d.pos[o + 2] / 65535 * m.r_max_au,
      trop: d.pos[o + 3] / 65536 * 360,
      lat: d.pos[o + 4] / 65535 * 180 - 90,
    };
  });
  const e = out[EARTH];
  for (const id of Object.keys(out).map(Number)) {
    const p = out[id];
    if (id === SUN) p.gdist = e.r;
    else if (id === EARTH) p.gdist = 0;
    else if (id === MOON) p.gdist = 0.00257;
    else p.gdist = Math.sqrt(Math.max(0, p.r * p.r + e.r * e.r - 2 * p.r * e.r * Math.cos(p.hlon - e.hlon)));
  }
  return out;
}

const leftOut = (d, i) => [d.out[2 * i], d.out[2 * i + 1]].filter((b) => b !== NONE);
const names = () => state.manifest.body_names;

/* ------------------------------------------------------------------------ */
/* Settings                                                                 */
/* ------------------------------------------------------------------------ */
function readSettings() {
  // Read the controls directly: FormData would skip disabled fieldsets.
  const E = form.elements;
  const num = (k) => (E[k].value === "" ? null : Number(E[k].value));
  // "geo" with the Sun left out is the "sky" criterion family.
  const frame = E.frame.value === "geo" && !E.sun.checked ? "sky" : E.frame.value;
  return {
    frame,
    kind: E.kind.value,
    measure: E.measure.value,
    moon: E.moon.checked,
    classical: E.classical.checked,
    outliers: Number(E.outliers.value || 0),
    top: num("top"),
    max: num("max"),
    window: num("window") ?? 0,
    from: num("from"),
    to: num("to"),
    elong: num("elong"),
    eclipse: E.eclipse.value || "",
    calendar: E.calendar.value,
    time: E.time.value,
  };
}

function criterionName(s) {
  let base = s.frame === "helio" ? (s.kind === "side" ? "helio_side" : "helio_axis") : s.frame;
  base += (s.moon ? "_moon" : "") + (s.classical ? "_classical" : "");
  if (s.frame !== "helio" && s.measure === "3d") return base + "_3d";
  return base + (s.outliers ? `_out${s.outliers}` : "");
}

const E_sun = () => form.elements.sun;

// Enable only the options that exist in the dataset; fix the form if needed.
function syncAvailability() {
  const crits = state.manifest.criteria;
  let s = readSettings();
  const helio = s.frame === "helio";
  $("#kind-set").disabled = !helio;
  $("#measure-set").disabled = helio;
  E_sun().disabled = helio;
  $("#sun-choice").classList.toggle("disabled", helio);
  $("#elong-field").classList.toggle("disabled", s.frame !== "sky");
  form.elements.elong.disabled = s.frame !== "sky";

  if (!helio && s.measure === "3d" && s.outliers) {        // 3D has no outlier variants
    form.elements.outliers.value = "0";
    s = readSettings();
  }
  for (const opt of form.elements.outliers.options) {
    const o = Number(opt.value);
    const probe = { ...s, outliers: o, measure: "longitude" };
    opt.disabled = o > 0 && (!crits[criterionName(probe)] || (!helio && s.measure === "3d"));
  }
  if (form.elements.outliers.selectedOptions[0].disabled) {
    form.elements.outliers.value = "0";
    s = readSettings();
  }
  const hints = [];
  if (helio) hints.push(t("hint.sunHelio"));
  if (helio && s.moon) hints.push(t("hint.moonHelio"));
  const anyOff = [...form.elements.outliers.options].some((o) => o.disabled);
  if (anyOff && !(!helio && s.measure === "3d")) {
    hints.push(t("hint.outliers", { n: state.manifest.min_planets_in_group }));
  }
  $("#bodies-hint").textContent = sentences(...hints);
  $("#measure-hint").textContent = !helio && s.measure === "3d" ? t("measure.hint3d") : "";
  return s;
}

// Settings <-> URL hash, so a view can be shared as a link.
function writeHash(s, jd) {
  const p = new URLSearchParams();
  p.set("frame", s.frame);
  if (s.frame === "helio") p.set("kind", s.kind);
  else if (s.measure === "3d") p.set("measure", "3d");
  if (s.moon) p.set("moon", "1");
  if (s.classical) p.set("classical", "1");
  if (s.outliers) p.set("outliers", s.outliers);
  if (s.top !== null) p.set("top", s.top);
  if (s.max !== null) p.set("max", s.max);
  p.set("window", s.window);
  if (s.from !== null) p.set("from", s.from);
  if (s.to !== null) p.set("to", s.to);
  if (s.elong !== null && s.frame === "sky") p.set("elong", s.elong);
  if (s.eclipse) p.set("eclipse", s.eclipse);
  if (s.calendar !== "auto") p.set("cal", s.calendar);
  if (s.time !== "tdb") p.set("time", s.time);
  if (state.view) p.set("view", state.view);
  if (state.scale !== "schematic") p.set("scale", state.scale);
  if (state.lonSystem !== "plane") p.set("lon", state.lonSystem);
  if (jd !== undefined) p.set("jd", jd.toFixed(5));
  history.replaceState(null, "", "#" + p.toString());
}

const DEFAULTS = { frame: "helio", sun: "1", kind: "axis", measure: "longitude", moon: "0", classical: "0", outliers: "0",
  top: "30", max: "", window: "3650", from: "", to: "", elong: "", eclipse: "", calendar: "auto", time: "tdb" };

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  // Start from the defaults so that a shared link means the same thing everywhere.
  for (const [name, value] of Object.entries(DEFAULTS)) {
    const el = form.elements[name];
    if (el instanceof RadioNodeList) el.value = value;
    else if (el.type === "checkbox") el.checked = value === "1";
    else el.value = value;
  }
  state.view = null; state.scale = "schematic"; state.lonSystem = "plane";
  const set = (name, value) => {
    const el = form.elements[name];
    if (!el || value === null) return;
    if (el instanceof RadioNodeList) el.value = value;
    else if (el.type === "checkbox") el.checked = value === "1";
    else el.value = value;
  };
  for (const [k, field] of [["frame", "frame"], ["kind", "kind"], ["measure", "measure"], ["moon", "moon"],
    ["classical", "classical"], ["outliers", "outliers"], ["top", "top"], ["max", "max"], ["window", "window"],
    ["from", "from"], ["to", "to"], ["elong", "elong"], ["eclipse", "eclipse"], ["cal", "calendar"], ["time", "time"]]) {
    if (p.has(k)) set(field, p.get(k));
  }
  if (p.get("frame") === "sky") { form.elements.frame.value = "geo"; form.elements.sun.checked = false; }
  if (["helio", "geo"].includes(p.get("view"))) state.view = p.get("view");
  if (p.get("scale") === "true") state.scale = "true";
  if (["tropical", "sidereal"].includes(p.get("lon"))) state.lonSystem = p.get("lon");
  return p.has("jd") ? Number(p.get("jd")) : null;
}

/* ------------------------------------------------------------------------ */
/* Selection (same rules as the command-line program)                       */
/* ------------------------------------------------------------------------ */
function filterPool(d, s) {
  const lo = s.from === null ? -Infinity : yearToJd(s.from);
  const hi = s.to === null ? Infinity : yearToJd(s.to + 1);
  const pool = [];
  for (let i = 0; i < d.n; i++) {
    if (d.jd[i] < lo || d.jd[i] >= hi) continue;
    if (s.max !== null && d.amp[i] > s.max) continue;
    if (s.frame === "sky" && s.elong !== null && !(d.elong[i] >= s.elong)) continue;
    const e = d.ecl[i];
    if (s.eclipse === "any" && !e) continue;
    if (s.eclipse === "solar" && e !== 1) continue;
    if (s.eclipse === "lunar" && e !== 2 && e !== 3) continue;
    pool.push(i);
  }
  return pool;
}

function selectRows(d, pool, s) {
  const idx = pool.slice().sort((a, b) => d.amp[a] - d.amp[b] || d.jd[a] - d.jd[b]);
  const accepted = [], jds = [];
  const top = s.top && s.top > 0 ? s.top : Infinity;
  for (const i of idx) {
    const t = d.jd[i];
    if (s.window > 0) {
      let a = 0, b = jds.length;
      while (a < b) { const mid = (a + b) >> 1; if (jds[mid] < t) a = mid + 1; else b = mid; }
      if ((a < jds.length && jds[a] - t < s.window) || (a > 0 && t - jds[a - 1] < s.window)) continue;
      jds.splice(a, 0, t);
    }
    accepted.push(i);
    if (accepted.length >= top) break;
  }
  return accepted.sort((a, b) => d.jd[a] - d.jd[b]);
}

/* ------------------------------------------------------------------------ */
/* Geometry                                                                 */
/* ------------------------------------------------------------------------ */
function smallestArc(angles) {
  const s = angles.map((a) => ((a % TWO_PI) + TWO_PI) % TWO_PI).sort((a, b) => a - b);
  let best = s[0] + TWO_PI - s[s.length - 1], j = s.length - 1;
  for (let k = 0; k < s.length - 1; k++) {
    const g = s[k + 1] - s[k];
    if (g > best) { best = g; j = k; }
  }
  return { start: s[(j + 1) % s.length], width: TWO_PI - best };
}

/* ------------------------------------------------------------------------ */
/* Table                                                                    */
/* ------------------------------------------------------------------------ */
const fmt = (x, d) => x.toLocaleString(locale(), { minimumFractionDigits: d, maximumFractionDigits: d });

function columns(crit, s, d) {
  const scale = s.time === "ut" ? "UT" : "TDB";
  const cols = [
    { head: t("th.date"), cell: (i) => {
      const p = dateParts(shownJd(d.jd[i], s), s.calendar);
      return `${stelAnchor(stellariumLink(d, i, crit), p.text)}<span class="cal">${escapeHtml(t(`calShort.${p.calKey}`))}</span>` +
        copyButton(copyDateText(p, s), t("copy.date"));
    } },
    { head: t("th.time", { scale }), cell: (i) => dateParts(shownJd(d.jd[i], s), s.calendar).time },
    { head: t("th.jd"), num: true, cell: (i) =>
      stelAnchor(stellariumLink(d, i, crit), jdText(d.jd[i])) + copyButton(d.jd[i].toFixed(5), t("copy.jd")) },
    { head: t("th.amp"), num: true, cls: "amp", cell: (i) => `${fmt(d.amp[i], 3)}°` },
    { head: t("th.days"), num: true, cell: (i, k) => (k === 0 ? "" : fmt(d.jd[i] - d.jd[state.rows[k - 1]], 2)) },
    { head: t(crit.measure === "3d" ? "th.pair" : "th.arc"),
      cell: (i) => escapeHtml(t(crit.measure === "3d" ? "cell.pair" : "cell.arc",
        { a: bodyName(d.ends[2 * i]), b: bodyName(d.ends[2 * i + 1]) })) },
  ];
  if (crit.outliers) cols.push({ head: t("th.leftOut"), cell: (i) => escapeHtml(listText(leftOut(d, i).map(bodyName))) });
  if (crit.kind === "sky") cols.push({ head: t("th.fromSun"), num: true, cell: (i) => `${fmt(d.elong[i], 1)}°` });
  if (s.time === "ut") cols.push({ head: t("th.dtSigma"), num: true, cell: (i) => `±${escapeHtml(durationText(deltaT(d.jd[i]).sigma))}` });
  if (state.rows.some((i) => d.ecl[i])) {
    cols.push({ head: t("th.eclipse"), cell: (i) => (d.ecl[i] ? `<span class="ecl">${escapeHtml(t(`eclipseShort.${d.ecl[i]}`))}</span>` : "") });
  }
  return cols;
}

function renderTable(d, s, crit) {
  const cols = columns(crit, s, d);
  const headRow = $("#table thead tr");
  headRow.innerHTML = cols.map((c) => `<th scope="col"${c.num ? ' class="num"' : ""}>${escapeHtml(c.head)}</th>`).join("");
  const frag = document.createDocumentFragment();
  let bestPos = -1;
  state.rows.forEach((i, k) => { if (bestPos < 0 || d.amp[i] < d.amp[state.rows[bestPos]]) bestPos = k; });
  state.rows.slice(0, MAX_ROWS).forEach((i, k) => {
    const tr = document.createElement("tr");
    tr.dataset.rec = i;
    tr.tabIndex = -1;
    tr.setAttribute("aria-selected", "false");
    if (k === bestPos) tr.classList.add("best");
    tr.innerHTML = cols.map((c) => `<td class="${[c.num ? "num" : "", c.cls || ""].join(" ").trim()}">${c.cell(i, k)}</td>`).join("");
    frag.appendChild(tr);
  });
  tbody.replaceChildren(frag);
  return bestPos < 0 ? -1 : state.rows[bestPos];
}

function markSelected(scroll) {
  for (const tr of tbody.querySelectorAll('tr[aria-selected="true"]')) {
    tr.setAttribute("aria-selected", "false");
    tr.tabIndex = -1;
  }
  const tr = tbody.querySelector(`tr[data-rec="${state.rec}"]`);
  if (tr) {
    tr.setAttribute("aria-selected", "true");
    tr.tabIndex = 0;
    if (scroll) tr.scrollIntoView({ block: "nearest" });
  }
}

/* ------------------------------------------------------------------------ */
/* Diagram                                                                  */
/* ------------------------------------------------------------------------ */
const SVG_NS = "http://www.w3.org/2000/svg";
const C = 320, RIM = 300;

function el(name, attrs, parent) {
  const e = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}
const pt = (a, r) => [C + r * Math.cos(a), C - r * Math.sin(a)];   // counter-clockwise, 0° to the right

function wedgePath(a0, w, r) {
  const [x0, y0] = pt(a0, r), [x1, y1] = pt(a0 + w, r);
  return `M${C},${C} L${x0.toFixed(2)},${y0.toFixed(2)} A${r},${r} 0 ${w > Math.PI ? 1 : 0} 0 ${x1.toFixed(2)},${y1.toFixed(2)} Z`;
}

function clearDial() {
  [...$("#dial").querySelectorAll(":scope > :not(title)")].forEach((n) => n.remove());
}

function renderDial(d, i, crit) {
  const svg = $("#dial");
  clearDial();
  const view = state.view || crit.frame;
  const pos = positions(d, i);
  const all = state.manifest.pos_bodies;
  const outSet = new Set(leftOut(d, i));
  const inGroup = new Set(crit.bodies.filter((b) => !outSet.has(b)));

  const rim = el("g", {}, svg);
  el("circle", { cx: C, cy: C, r: RIM, fill: "none", stroke: "var(--ring)", "stroke-width": 1.5 }, rim);
  for (let deg = 0; deg < 360; deg += 5) {
    const a = deg / DEG, len = deg % 30 === 0 ? 14 : 6;
    const [x0, y0] = pt(a, RIM), [x1, y1] = pt(a, RIM - len);
    el("line", { x1: x0, y1: y0, x2: x1, y2: y1, stroke: "var(--ring)", "stroke-width": deg % 30 ? 1 : 1.5 }, rim);
    if (deg % 30 === 0) {
      const [tx, ty] = pt(a, RIM + 20);
      el("text", { x: tx, y: ty + 5, "text-anchor": "middle", class: "tick-label" }, rim).textContent = `${deg}°`;
    }
  }

  const ringIds = view === "helio"
    ? all.filter((b) => b !== SUN && b !== MOON)
    : [MOON, MERCURY, VENUS, SUN, MARS, JUPITER, SATURN, URANUS, NEPTUNE, PLUTO].filter((b) => all.includes(b));
  const radius = {};
  const inner = 46, outer = RIM - 42;
  if (state.scale === "schematic") {
    ringIds.forEach((b, k) => { radius[b] = inner + k * (outer - inner) / Math.max(1, ringIds.length - 1); });
  } else {
    const dist = (b) => (view === "helio" ? pos[b].r : pos[b].gdist);
    const dmax = Math.max(...ringIds.map(dist));
    ringIds.forEach((b) => { radius[b] = 26 + (outer - 26) * Math.sqrt(dist(b) / dmax); });
    if (view === "geo") radius[MOON] = 18;
  }
  const lon = (b) => (view === "helio" ? pos[b].hlon : pos[b].glon);

  if (view === crit.frame) {
    const angles = [...inGroup].map((b) => (crit.frame === "helio" ? pos[b].hlon : pos[b].glon));
    if (crit.axis) {
      const arc = smallestArc(angles.map((a) => 2 * a));
      el("path", { d: wedgePath(arc.start / 2, arc.width / 2, RIM - 1), class: "wedge" }, svg);
      el("path", { d: wedgePath(arc.start / 2 + Math.PI, arc.width / 2, RIM - 1), class: "wedge" }, svg);
    } else {
      const arc = smallestArc(angles);
      el("path", { d: wedgePath(arc.start, arc.width, RIM - 1), class: "wedge" }, svg);
    }
  }

  const g = el("g", {}, svg);
  for (const b of ringIds) {
    el("circle", { cx: C, cy: C, r: radius[b], fill: "none", stroke: "var(--ring)", "stroke-width": 1,
      "stroke-dasharray": inGroup.has(b) ? "none" : "3 4" }, g);
  }
  for (const b of ringIds) {
    if (!inGroup.has(b)) continue;
    const [x, y] = pt(lon(b), radius[b]);
    el("line", { x1: C, y1: C, x2: x, y2: y, stroke: "var(--ray)", "stroke-width": 1 }, g);
  }
  el("circle", view === "helio" ? { cx: C, cy: C, r: 11, fill: "var(--sun)" } : { cx: C, cy: C, r: 8, fill: "var(--planet)" }, g);

  const size = { [SUN]: 9, [JUPITER]: 7.5, [SATURN]: 7, [URANUS]: 6, [NEPTUNE]: 6, [MOON]: 4, [PLUTO]: 3.5 };
  const dots = ringIds.map((b) => {
    const [x, y] = pt(lon(b), radius[b]);
    return { b, x, y, a: lon(b), s: size[b] || 5 };
  });
  const boxes = [{ x0: C - 12, y0: C - 12, x1: C + 12, y1: C + 12 }];
  for (const p of dots) boxes.push({ x0: p.x - p.s - 1, y0: p.y - p.s - 1, x1: p.x + p.s + 1, y1: p.y + p.s + 1 });
  const hits = (q) => boxes.some((o) => q.x0 < o.x1 && q.x1 > o.x0 && q.y0 < o.y1 && q.y1 > o.y0);
  for (const p of dots) {
    const grp = el("g", { class: inGroup.has(p.b) ? "" : "excluded" }, g);
    el("circle", { cx: p.x, cy: p.y, r: p.s,
      fill: p.b === SUN ? "var(--sun)" : (p.b === MOON ? "var(--moon)" : "var(--planet)") }, grp);
    const label = bodyName(p.b);
    const text = el("text", { x: 0, y: 0, class: "body-label", "text-anchor": "middle" }, grp);
    text.textContent = label;
    const w = (text.getComputedTextLength() || label.length * 8.6) + 4, h = 17;
    const ca = Math.cos(p.a), sa = Math.sin(p.a);
    const dirs = [[ca, -sa], [-sa, -ca], [sa, ca], [-ca, sa]];
    let chosen = null;
    for (let step = 0; step < 4 && !chosen; step++) {
      for (const [ux, uy] of dirs) {
        const off = Math.abs(ux) * w / 2 + Math.abs(uy) * h / 2 + p.s + 3 + step * 13;
        const cx = p.x + ux * off, cy = p.y + uy * off;
        const q = { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 };
        if (q.x0 < -38 || q.x1 > 678 || q.y0 < -38 || q.y1 > 678) continue;
        if (!hits(q)) { chosen = { cx, cy, q }; break; }
      }
    }
    if (!chosen) {
      const off = w / 2 + p.s + 3, cx = p.x + ca * off, cy = p.y - sa * off;
      chosen = { cx, cy, q: { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 } };
    }
    boxes.push(chosen.q);
    text.setAttribute("x", chosen.cx.toFixed(1));
    text.setAttribute("y", (chosen.cy + 5.5).toFixed(1));
  }
  if (view === "helio" && all.includes(MOON)) {
    const [ex, ey] = pt(lon(EARTH), radius[EARTH]);
    const a = pos[MOON].glon;
    el("circle", { cx: ex + 13 * Math.cos(a), cy: ey - 13 * Math.sin(a), r: 3.2, fill: "var(--moon)",
      class: inGroup.has(MOON) ? "" : "excluded" }, g);
  }

  let shade;
  if (view !== crit.frame) shade = t(crit.frame === "helio" ? "caption.switchSun" : "caption.switchEarth");
  else if (crit.axis) shade = t("caption.axis");
  else if (crit.frame === "geo") shade = t("caption.geo");
  else shade = t("caption.side");
  $("#dial-caption").textContent = sentences(
    t(view === "helio" ? "caption.centredSun" : "caption.centredEarth"),
    t(state.scale === "schematic" ? "caption.even" : "caption.sqrt"),
    shade, t("caption.dimmed"));
}

/* ------------------------------------------------------------------------ */
/* Details                                                                  */
/* ------------------------------------------------------------------------ */
function signText(lonDeg) {
  const l = ((lonDeg % 360) + 360) % 360;
  const k = Math.floor(l / 30), within = l - 30 * k;
  const dd = Math.floor(within), mm = Math.floor((within - dd) * 60);
  return `${dd}°${pad(mm)}′ ${t(`sign.${k}`)}`;
}

function renderDetails(d, i, s, crit) {
  const box = $("#details");
  const shown = shownJd(d.jd[i], s);
  const p = dateParts(shown, s.calendar);
  const ampHtml = `<strong>${escapeHtml(fmt(d.amp[i], 3))}°</strong>`;
  const outs = leftOut(d, i);
  const subject = outs.length ? t("sent.subjectBut", { list: listText(outs.map(bodyName)) }) : t("sent.subjectAll");
  const Subject = subject.charAt(0).toLocaleUpperCase(locale()) + subject.slice(1);
  const a = bodyName(d.ends[2 * i]), b = bodyName(d.ends[2 * i + 1]);
  let main;
  if (crit.measure === "3d") main = tHtml("sent.3d", {}, { amp: ampHtml });
  else if (crit.frame === "geo") main = tHtml("sent.geo", { subject }, { amp: ampHtml });
  else if (crit.axis) main = tHtml("sent.axis", { Subject }, { amp: ampHtml });
  else main = tHtml("sent.side", { subject }, { amp: ampHtml });
  const sentence = sentences(main,
    escapeHtml(t(crit.measure === "3d" ? "sent.pair" : "sent.arc", { a, b })),
    crit.kind === "sky" ? escapeHtml(t("sent.elong", { deg: `${fmt(d.elong[i], 1)}°` })) : "");

  const k = state.rows.indexOf(i);
  const prev = k > 0 ? t("details.afterPrevious", { days: fmt(d.jd[i] - d.jd[state.rows[k - 1]], 2) })
    : t(k === 0 ? "details.first" : "details.hidden");
  const { dt, sigma } = deltaT(d.jd[i]);
  const stel = stellariumLink(d, i, crit);
  const jdHtml = stelAnchor(stel, jdText(d.jd[i])) + copyButton(d.jd[i].toFixed(5), t("copy.jd"));
  const calendar = t(`calName.${p.calKey}`);
  const timeLine = s.time === "ut"
    ? sentences(escapeHtml(t("details.timeUt", { time: p.time, calendar })),
      escapeHtml(t("details.deltaT", { dt: durationText(dt), sigma: durationText(sigma) })),
      tHtml("details.jdUt", {}, { jd: jdHtml }))
    : sentences(escapeHtml(t("details.timeTdb", { time: p.time, calendar })),
      tHtml("details.jdTdb", {}, { jd: jdHtml }),
      escapeHtml(t(dt >= 0 ? "details.utEarlier" : "details.utLater", { dt: durationText(Math.abs(dt)) })));
  const far = Math.abs(jdToYear(d.jd[i]) - 2000) > 5000 ? escapeHtml(t("stel.far")) : "";
  let eclipse = "";
  if (d.ecl[i]) {
    const off = d.eclDt[i] * 86400;
    const when = Math.abs(off) < 3600 ? t("when.withinHour")
      : t(off < 0 ? "when.before" : "when.after", { dur: durationText(Math.abs(off)) });
    eclipse = `<p class="eclipse-note">${escapeHtml(t(`eclipseNote.${d.ecl[i]}`, { when }))}</p>`;
  }

  const pos = positions(d, i);
  const inGroup = new Set(crit.bodies.filter((x) => !outs.includes(x)));
  const degs = (x) => `${fmt(x, 2)}°`;
  const ayan = d.ayan[i];
  let head, rowFor, note;
  if (state.lonSystem === "plane") {
    head = [t("col.body"), t("col.fromSun"), t("col.fromEarth"), t("col.distSun")];
    rowFor = (bb, q) => [bb === SUN ? "" : degs(q.hlon * DEG), bb === EARTH ? "" : degs(q.glon * DEG),
      bb === SUN ? "" : (bb === MOON ? fmt(q.r, 3) : fmt(q.r, 2))];
    note = t(state.manifest.plane === "ecliptic" ? "note.ecliptic" : "note.plane");
  } else {
    const sid = state.lonSystem === "sidereal";
    head = [t("col.body"), t(sid ? "col.sidereal" : "col.tropical"), t("col.lat"), t("col.sign")];
    rowFor = (bb, q) => {
      if (bb === EARTH) return ["", "", ""];
      const l = sid ? q.trop - ayan : q.trop;
      const l360 = ((l % 360) + 360) % 360;
      return [degs(l360), `${q.lat >= 0 ? "+" : "−"}${fmt(Math.abs(q.lat), 2)}°`, signText(l360)];
    };
    note = sid ? t("note.sidereal", { ayan: `${fmt(((ayan % 360) + 360) % 360, 3)}°` }) : t("note.tropical");
  }
  const rows = state.manifest.pos_bodies.map((bb) => {
    const cells = rowFor(bb, pos[bb]);
    return `<tr class="${inGroup.has(bb) ? "" : "out"}"><td>${escapeHtml(bodyName(bb))}</td>${cells.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`;
  }).join("");
  box.innerHTML = `
    <h2>${stelAnchor(stel, p.text)}${copyButton(copyDateText(p, s), t("copy.date"))}</h2>
    <p class="when">${sentences(timeLine, escapeHtml(prev))}</p>
    <p class="stel-hint">${sentences(tHtml("stel.hint", {}, { key: "<kbd>A</kbd>" }), far)}</p>
    <p class="amplitude">${sentence}</p>
    ${eclipse}
    <div class="segmented lon-system" role="radiogroup" aria-label="${escapeHtml(t("lon.group"))}">
      <button type="button" role="radio" data-lon="plane">${escapeHtml(t("lon.plane"))}</button>
      <button type="button" role="radio" data-lon="tropical">${escapeHtml(t("lon.tropical"))}</button>
      <button type="button" role="radio" data-lon="sidereal">${escapeHtml(t("lon.sidereal"))}</button>
    </div>
    <div class="table-scroll"><table>
      <thead><tr>${head.map((h) => `<th scope="col">${escapeHtml(h)}</th>`).join("")}</tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p class="note">${escapeHtml(sentences(note, t("note.greyed")))}</p>`;
  box.querySelectorAll("[data-lon]").forEach((btn) => {
    btn.setAttribute("aria-checked", String(btn.dataset.lon === state.lonSystem));
    btn.addEventListener("click", () => { state.lonSystem = btn.dataset.lon; showRecord(state.rec, false); });
  });
}

/* ------------------------------------------------------------------------ */
/* Timeline                                                                 */
/* ------------------------------------------------------------------------ */
const timeline = {
  canvas: $("#timeline"),
  tooltip: $("#tooltip"),
  pts: [],             // {i, x, y, listed}
  x0: 0, x1: 1,        // year range
  ymax: 90,
  pad: { l: 46, r: 12, t: 10, b: 26 },
  drag: null,
};

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function niceStep(span, target) {
  const raw = span / target, p = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

function drawTimeline() {
  const T = timeline, cv = T.canvas;
  if (!current) return;
  const { d, s, crit } = current;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const c = state.manifest.coverage;
  T.x0 = s.from !== null ? s.from : jdToYear(c.first_jd);
  T.x1 = s.to !== null ? s.to + 1 : jdToYear(c.last_jd);
  if (T.x1 <= T.x0) T.x1 = T.x0 + 1;
  T.ymax = s.max !== null ? Math.min(s.max, crit.max_amplitude_deg) : crit.max_amplitude_deg;
  const P = T.pad, pw = w - P.l - P.r, ph = h - P.t - P.b;
  const X = (yr) => P.l + (yr - T.x0) / (T.x1 - T.x0) * pw;
  const Y = (a) => P.t + a / T.ymax * ph;             // 0° at the top: tighter is higher

  ctx.font = `13px ${css("--sans") || "sans-serif"}`;
  ctx.fillStyle = css("--muted");
  ctx.strokeStyle = css("--line");
  ctx.lineWidth = 1;
  const ys = niceStep(T.ymax, 4);
  ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (let a = 0; a <= T.ymax + 1e-9; a += ys) {
    const y = Math.round(Y(a)) + 0.5;
    ctx.beginPath(); ctx.moveTo(P.l, y); ctx.lineTo(w - P.r, y); ctx.stroke();
    ctx.fillText(`${a}°`, P.l - 6, y);
  }
  const xs = niceStep(T.x1 - T.x0, Math.max(3, Math.floor(pw / 110)));
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  for (let yr = Math.ceil(T.x0 / xs) * xs; yr <= T.x1; yr += xs) {
    const x = Math.round(X(yr)) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, P.t + ph); ctx.lineTo(x, P.t + ph + 4); ctx.stroke();
    const label = yearText(Math.round(yr)), half = ctx.measureText(label).width / 2;
    ctx.fillText(label, Math.min(Math.max(x, half + 2), w - half - 2), P.t + ph + 7);   // keep labels inside
  }

  const listed = new Set(state.rows);
  T.pts = [];
  for (const i of state.pool) {
    const yr = jdToYear(d.jd[i]);
    if (yr < T.x0 || yr > T.x1 || d.amp[i] > T.ymax) continue;
    T.pts.push({ i, x: X(yr), y: Y(d.amp[i]), listed: listed.has(i) });
  }
  ctx.fillStyle = css("--dot-other");
  for (const p of T.pts) if (!p.listed) ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
  ctx.fillStyle = css("--brass");
  for (const p of T.pts) {
    if (!p.listed) continue;
    ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, TWO_PI); ctx.fill();
  }
  const sel = T.pts.find((p) => p.i === state.rec);
  if (sel) {
    ctx.strokeStyle = css("--ink"); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(sel.x, sel.y, 7.5, 0, TWO_PI); ctx.stroke();
  }
  if (T.drag && Math.abs(T.drag.x1 - T.drag.x0) > 3) {
    ctx.fillStyle = css("--wedge");
    ctx.fillRect(Math.min(T.drag.x0, T.drag.x1), P.t, Math.abs(T.drag.x1 - T.drag.x0), ph);
  }
  $("#timeline-title").textContent = t(crit.measure === "3d" ? "timeline.titleSep" : "timeline.titleAmp",
    { from: yearTextEra(Math.round(T.x0)), to: yearTextEra(Math.round(T.x1)) });
}

function nearestPoint(mx, my) {
  let best = null, bd = 24 * 24;
  for (const p of timeline.pts) {
    const dd = (p.x - mx) ** 2 + (p.y - my) ** 2;
    if (dd < bd || (dd === bd && p.listed)) { bd = dd; best = p; }
  }
  return best;
}

function wireTimeline() {
  const T = timeline, cv = T.canvas;
  const local = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const yearAt = (x) => T.x0 + (x - T.pad.l) / (cv.clientWidth - T.pad.l - T.pad.r) * (T.x1 - T.x0);
  cv.addEventListener("pointerdown", (e) => {
    const [x] = local(e);
    T.drag = { x0: x, x1: x };
    cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener("pointermove", (e) => {
    const [x, y] = local(e);
    if (T.drag) { T.drag.x1 = x; drawTimeline(); }
    const p = !T.drag || Math.abs(T.drag.x1 - T.drag.x0) <= 3 ? nearestPoint(x, y) : null;
    const tip = T.tooltip;
    if (!p) { tip.hidden = true; cv.style.cursor = T.drag ? "col-resize" : "crosshair"; return; }
    cv.style.cursor = "pointer";
    const { d, s } = current;
    const dp = dateParts(shownJd(d.jd[p.i], s), s.calendar);
    const line = d.ecl[p.i] ? t("tooltip.withEclipse", { date: dp.text, eclipse: t(`eclipseName.${d.ecl[p.i]}`) }) : dp.text;
    tip.innerHTML = `<strong>${escapeHtml(fmt(d.amp[p.i], 2))}°</strong><span>${escapeHtml(line)}</span>`;
    tip.hidden = false;
    const left = Math.min(p.x + 12, cv.clientWidth - tip.offsetWidth - 4);
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = `${Math.max(0, p.y - tip.offsetHeight - 8)}px`;
  });
  cv.addEventListener("pointerleave", () => { T.tooltip.hidden = true; });
  cv.addEventListener("pointerup", (e) => {
    const drag = T.drag; T.drag = null;
    const [x, y] = local(e);
    if (drag && Math.abs(drag.x1 - drag.x0) > 6) {
      const a = Math.floor(yearAt(Math.min(drag.x0, drag.x1)));
      const b = Math.ceil(yearAt(Math.max(drag.x0, drag.x1)));
      form.elements.from.value = a;
      form.elements.to.value = Math.max(a, b - 1);
      update(currentJd());
      return;
    }
    drawTimeline();
    const p = nearestPoint(x, y);
    if (p) showRecord(p.i, true);
  });
  cv.addEventListener("dblclick", () => {
    form.elements.from.value = ""; form.elements.to.value = "";
    update(currentJd());
  });
  new ResizeObserver(() => drawTimeline()).observe(cv);
}

/* ------------------------------------------------------------------------ */
/* Orchestration                                                            */
/* ------------------------------------------------------------------------ */
let current = null;   // { name, d, s, crit }

function syncToggles() {
  const view = state.view || (current ? current.crit.frame : "helio");
  document.querySelectorAll("[data-view]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.view === view)));
  document.querySelectorAll("[data-scale]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.scale === state.scale)));
}

function showRecord(i, scroll) {
  if (!current || i < 0) return;
  const { d, s, crit } = current;
  state.rec = i;
  markSelected(scroll);
  renderDial(d, i, crit);
  renderDetails(d, i, s, crit);
  drawTimeline();
  writeHash(s, d.jd[i]);
  syncToggles();
}

function describeCoverage() {
  applyStatic();                               // first, so the texts below are not overwritten
  const c = state.manifest.coverage;
  const a = dateParts(c.first_jd, "auto"), b = dateParts(c.last_jd, "auto");
  $("#lede").textContent = t("lede.range", { from: yearTextEra(a.astroYear), to: yearTextEra(b.astroYear) });
  const date = state.manifest.generated.slice(0, 10);
  $("#coverage").textContent = c.blocks_done === c.blocks_total
    ? t("coverage.full", { date })
    : t("coverage.partial", { pct: fmt(100 * c.blocks_done / c.blocks_total, 1), date });
}

let token = 0;
async function update(keepJd) {
  const s = syncAvailability();
  const name = criterionName(s);
  const crit = state.manifest.criteria[name];
  const my = ++token;
  $("#summary").classList.remove("error");
  if (!crit) {
    $("#summary").textContent = t("summary.notAvailable");
    $("#summary").classList.add("error");
    return;
  }
  let d;
  try {
    d = await loadCriterion(name);
  } catch (err) {
    $("#summary").textContent = t("summary.loadError", { error: err.message });
    $("#summary").classList.add("error");
    return;
  }
  if (my !== token) return;                     // a newer change has started
  current = { name, d, s, crit };
  state.pool = filterPool(d, s);
  state.rows = selectRows(d, state.pool, s);
  const best = renderTable(d, s, crit);

  const n = state.rows.length;
  $("#summary").textContent = sentences(
    n === 0 ? t("summary.none") : t("summary.dates", { n }),
    n > MAX_ROWS ? t("summary.truncated", { n: MAX_ROWS }) : "",
    s.max !== null && s.max > crit.max_amplitude_deg ? t("summary.cap", { cap: `${fmt(crit.max_amplitude_deg, 0)}°` }) : "");

  if (n === 0) {
    state.rec = -1;
    $("#details").innerHTML = "";
    clearDial();
    $("#dial-caption").textContent = "";
    drawTimeline();
    writeHash(s);
    return;
  }
  let rec = best;
  if (keepJd !== undefined && keepJd !== null) {
    let k = -1, bd = 1e-4;
    for (const i of state.pool) { const dd = Math.abs(d.jd[i] - keepJd); if (dd < bd) { bd = dd; k = i; } }
    if (k >= 0) rec = k;
  }
  showRecord(rec, true);
}

function exportCsv() {
  if (!current || state.rows.length === 0) return;
  const { d, s, name } = current;
  const n = names();
  const lines = ["jd_tdb,date,time_scale,amplitude_deg,days_since_previous,arc_ends,left_out,min_elongation_deg,eclipse,delta_t_s,delta_t_sigma_s"];
  state.rows.forEach((i, k) => {
    const delta = k === 0 ? "" : (d.jd[i] - d.jd[state.rows[k - 1]]).toFixed(2);
    const { dt, sigma } = deltaT(d.jd[i]);
    const ut = s.time === "ut";
    lines.push([
      d.jd[i].toFixed(6), dateParts(shownJd(d.jd[i], s), s.calendar).iso, s.time.toUpperCase(),
      d.amp[i].toFixed(6), delta, `${n[d.ends[2 * i]]} – ${n[d.ends[2 * i + 1]]}`,
      `"${leftOut(d, i).map((b) => n[b]).join(", ")}"`,
      Number.isNaN(d.elong[i]) ? "" : d.elong[i].toFixed(2),
      d.ecl[i] ? `${ECLIPSE_NAMES[d.ecl[i]]} ${d.eclDt[i] >= 0 ? "+" : ""}${d.eclDt[i].toFixed(1)} d` : "",
      ut ? dt.toFixed(0) : "", ut ? sigma.toFixed(0) : "",
    ].join(","));
  });
  const blob = new Blob(["﻿" + lines.join("\r\n") + "\r\n"], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `syzygeon_${name}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = $("#theme-toggle");
  btn.textContent = t(theme === "dark" ? "theme.light" : "theme.dark");
  btn.setAttribute("aria-pressed", String(theme === "light"));
  try { localStorage.setItem("theme", theme); } catch (e) { /* storage unavailable */ }
  drawTimeline();
}

function currentJd() {
  if (!current || state.rec < 0) return null;
  return current.d.jd[state.rec];
}

function wireEvents() {
  let timer;
  form.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => update(currentJd()), 200); });
  form.addEventListener("change", () => { clearTimeout(timer); update(currentJd()); });
  form.addEventListener("submit", (e) => e.preventDefault());
  $("#export").addEventListener("click", exportCsv);
  $("#theme-toggle").addEventListener("click", () =>
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));

  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".copy-btn");
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    copyText(btn.dataset.copy, btn);
  }, true);
  tbody.addEventListener("click", (e) => {
    const tr = e.target.closest("tr");
    if (!tr) return;
    showRecord(Number(tr.dataset.rec), false);
    tr.focus({ preventScroll: true });
  });
  tbody.addEventListener("keydown", (e) => {
    const shown = state.rows.slice(0, MAX_ROWS);
    let k = shown.indexOf(state.rec);
    if (e.key === "ArrowDown") k = Math.min(shown.length - 1, k + 1);
    else if (e.key === "ArrowUp") k = Math.max(0, k - 1);
    else if (e.key === "Home") k = 0;
    else if (e.key === "End") k = shown.length - 1;
    else return;
    e.preventDefault();
    showRecord(shown[k], true);
    const tr = tbody.querySelector(`tr[data-rec="${shown[k]}"]`);
    if (tr) tr.focus({ preventScroll: true });
  });

  document.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => {
    state.view = current && b.dataset.view === current.crit.frame ? null : b.dataset.view;
    showRecord(state.rec, false);
  }));
  document.querySelectorAll("[data-scale]").forEach((b) => b.addEventListener("click", () => {
    state.scale = b.dataset.scale;
    showRecord(state.rec, false);
  }));
  wireTimeline();
}

function startCounter() {
  if (!GOATCOUNTER) return;
  const base = `https://${GOATCOUNTER}.goatcounter.com`;
  const script = document.createElement("script");   // records this visit (skipped on localhost)
  script.async = true;
  script.src = "https://gc.zgo.at/count.js";
  script.dataset.goatcounter = `${base}/count`;
  document.head.appendChild(script);
  fetch(`${base}/counter/TOTAL.json`)
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      const n = j && parseInt(String(j.count).replace(/\D/g, ""), 10);
      if (Number.isFinite(n)) { state.visits = n; renderVisits(); }
    })
    .catch(() => { /* counter unavailable: show nothing */ });
}

function renderVisits() {
  const el = $("#visits");
  if (!Number.isFinite(state.visits)) { el.hidden = true; return; }
  el.textContent = t("visits", { n: state.visits });
  el.hidden = false;
}

function repoUrl() {
  if (REPO_URL) return REPO_URL;
  const host = location.hostname.toLowerCase();
  if (!host.endsWith(".github.io")) return null;
  const user = host.slice(0, -".github.io".length);
  const repo = location.pathname.split("/").filter(Boolean)[0];
  return `https://github.com/${user}/${repo && repo !== "index.html" ? repo : host}`;
}

async function init() {
  startCounter();
  const repo = repoUrl();
  if (repo) { $("#repo-link").href = repo; $("#repo-link").hidden = false; }
  // Languages first, so that every message (even errors) is translated.
  try {
    const res = await fetch(`${I18N_DIR}languages.json`, { cache: "no-cache" });
    const cfg = await res.json();
    i18n.list = cfg.languages;
    i18n.fallbackCode = cfg.fallback || "en";
    i18n.fallback = await loadDict(i18n.fallbackCode);
  } catch (e) {
    i18n.list = [{ code: "en", name: "English", flag: "gb", locale: "en-GB", dir: "ltr" }];
  }
  wirePicker();
  await setLanguage(pickLanguage(), false);
  wireEvents();
  try {
    state.manifest = await loadManifest();
  } catch (err) {
    const msg = $("#summary");
    msg.classList.add("error");
    msg.textContent = t("summary.noDataset", { error: err.message });
    return;
  }
  describeCoverage();
  const jd = readHash();
  await update(jd);
  // A link pasted while the page is open changes only the hash: follow it.
  window.addEventListener("hashchange", async () => {
    const lang = new URLSearchParams(location.hash.slice(1)).get("lang");
    if (lang && lang !== i18n.lang.code && i18n.list.some((l) => l.code === lang)) await setLanguage(lang, false);
    await update(readHash());
  });
}

init();
