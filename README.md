# Syzygeon

*Syzygy + aeon: planetary alignments across 30,000 years.*


Finds the dates of tightest grouping of the planets over the whole span of the
JPL DE441 ephemeris (13,200 BC to AD 17,191), and lets you browse them in a web
page with a diagram of the solar system, a timeline and traditional longitudes
for each date.

## What it measures

| Point of view | Grouping | Amplitude |
|---|---|---|
| Seen from the Sun, along a line | bodies close to a line through the Sun, either side | width of the band holding them all |
| Seen from the Sun, one side | the Sun is one end | angle of the smallest sector, vertex at the Sun |
| Seen from the Earth, Sun included | the Sun and the bodies in one patch of sky (the Kali Yuga kind) | smallest arc of sky holding them |
| Seen from the Earth, Sun left out | planets bunched together in the night sky | smallest arc of sky holding them |

On the page these are two points of view, from the Sun or from the Earth, and
an *Include the Sun* checkbox for the Earth view. Each can be combined with:

- **the Moon** (seen from the Sun it never strays more than 0.15° from the
  Earth, so there it hardly matters);
- **naked-eye planets only** (no Uranus, Neptune or Pluto);
- **bodies allowed outside the group** (any one or any two, whichever they
  are), offered while at least 5 planets stay in the group;
- **true distance in the sky** (seen from the Earth): the largest separation
  between any two bodies, latitude included, instead of longitude only;
- **distance from the Sun** (Sun left out): keep only groups far enough from
  the Sun to be seen at night;
- **eclipses**: every grouping records whether a solar or lunar eclipse
  happens within ±2 days.

Dates can be shown in TDB (the ephemeris time) or in civil time (UT) through
ΔT, with its uncertainty, which reaches days at the ends of the range.

## Repository layout

| Path | What it is |
|---|---|
| `alignments.py` | Computes the groupings from DE441 and keeps them in a resumable cache |
| `export_web.py` | Turns the cache into the compact dataset the web page reads |
| `docs/` | The web viewer (static HTML/CSS/JS, served by GitHub Pages or locally) |
| `docs/data/` | The exported dataset (generated, committed) |
| `docs/i18n/`, `docs/flags/` | Translations of the page and the flags of the language menu |
| `tools/check_i18n.py` | Checks that the translations are complete and consistent |
| `LICENSE` | GNU General Public License v3 (code) |

## 1. Compute

```
pip install numpy jplephem
# download de441_part-1.bsp and de441_part-2.bsp from
# https://ssd.jpl.nasa.gov/ftp/eph/planets/bsp/ into this folder
python alignments.py                       # Ctrl+C to stop; run again to resume
python alignments.py --frame geo --moon --classical --time ut --top 50
python alignments.py --frame sky --moon --min-elongation 30
python alignments.py --frame helio --outliers 1
python alignments.py --help
```

The full range takes roughly 10–30 minutes, depending on the computer. The
cache (`alignments_cache_*.npz`, about 15 MB) holds every criterion at once,
so changing any option afterwards never recomputes anything. Only groupings
narrower than a cap per criterion are kept (90° for most, 60° for the line
through the Sun, tighter when bodies may be left out); wider ones are never
interesting.

## 2. Export for the web

```
pip install pyerfa
python export_web.py          # needs the cache and the DE441 files
```

This writes `docs/data/`: one binary file per criterion plus `manifest.json`,
about 70 MB in all and up to ~5 MB per criterion. The page only downloads the
criterion being viewed. ERFA provides the long-term precession of Vondrák et
al. (2011), used for tropical and sidereal longitudes.

## 3. Publish on GitHub Pages

```
git add alignments.py export_web.py README.md .gitignore docs
git commit -m "Syzygeon"
git push
```

Then in the repository: **Settings → Pages → Build and deployment → Deploy
from a branch → `main`, folder `/docs`**. The page appears at
<https://carbaior.github.io/syzygeon/>.

The page links to its repository, <https://github.com/carbaior/syzygeon>, set
in `REPO_URL` at the top of `docs/app.js`. If you fork the project, change it,
or leave it empty: on GitHub Pages the link is then worked out from the address
(`https://<user>.github.io/<repo>/`), and elsewhere it is hidden.

The `.bsp` ephemeris files (3 GB) and the raw cache are not needed by the page
and are excluded by `.gitignore`.

To try the page before publishing it, see the next section.

## Visitor counter (optional)

The page can count visits and show the total in its footer with
[GoatCounter](https://www.goatcounter.com/), which is free for open projects,
uses no cookies and does not store IP addresses, so no cookie banner is
normally needed. It is set up for <https://cjbo.goatcounter.com> (`GOATCOUNTER = "cjbo"` in
`docs/app.js`); if you fork the project, empty that line or use your own code:

1. Create a free account at <https://www.goatcounter.com/signup> and choose a
   site code, for example `syzygeon` (the dashboard will then live at
   `https://syzygeon.goatcounter.com`).
2. In its *Settings*, enable **Allow adding visitor counts on your website**.
3. Put the code in `GOATCOUNTER` at the top of `docs/app.js`:
   `const GOATCOUNTER = "syzygeon";`

Visits from `localhost` are not counted, so testing offline does not inflate
the figure. The dashboard also shows which pages, countries and languages the
visitors come from.

## Run it offline

The page needs no server software beyond the one that comes with Python, so
it can run on your own computer without internet and without GitHub.

1. Make sure `docs/data/` holds the exported dataset (step 2 above).
2. From the repository folder, start Python's built-in web server:

   ```
   python -m http.server 8000 --directory docs
   ```

   On Windows use `py` instead of `python` if `python` is not found; on some
   Linux and macOS systems it is `python3`.
3. Open <http://localhost:8000> in a browser.
4. Stop the server with Ctrl+C in that terminal.

To use another port, change `8000` in the command and in the address. To open
the page from other devices on your network (a tablet, say), add
`--bind 0.0.0.0` and browse to `http://<your-computer's-IP>:8000`.

Opening `index.html` by double-clicking it does not work: browsers do not let a
page read its data files from disk, so it must be served over `http://`.

Without internet everything works except two things that live online: the
Alegreya fonts, which fall back to the system's fonts, and the links to
Stellarium Web.

## The web page

- Every option is a control; the address bar keeps the settings and the
  selected date, so a link reproduces the same view.
- The timeline plots every stored grouping over time (tighter is higher).
  Click a dot to see that date; drag across it to zoom into those years;
  double-click to zoom back out.
- Selecting a row or a dot draws the configuration, centred on the Sun or the
  Earth, and lists each body's longitude in the orbital plane, in the tropical
  zodiac or in the sidereal zodiac (Lahiri ayanamsha).
- Every date and Julian Day has a button that copies it, and is a link that
  opens that moment in [Stellarium Web](https://stellarium-web.org/), seen from
  a place on Earth where the group is overhead. Stellarium Web has no URL
  option for the atmosphere: press **A** there to switch it off and see the
  planets in daylight. The link converts the time with Stellarium's own ΔT
  model so it shows the same instant; far from the present its simpler
  planetary theory may place the planets somewhat differently from DE441.
- *Export list as CSV* saves the current list in the same format as the
  command-line program.
- Dark theme by default; the choice is remembered.

## Historical alignments to try

Famous groupings that Syzygeon finds. Amplitudes are from an independent check
with ERFA's planetary theory; DE441 agrees to within a few tenths of a degree.
Dates before 1582 are in the Julian calendar; in the year fields of the page,
1953 BC is written −1952.

| Date | What happened | Grouping | How to see it |
|---|---|---|---|
| 26–27 Feb 1953 BC | The tightest massing of the five naked-eye planets in millennia, linked in Chinese tradition to the founding of the Xia dynasty ([Pankenier, *Early China*](https://www.cambridge.org/core/journals/early-china/article/abs/astronomical-evidence-for-the-bamboo-annals-chronicle-of-early-xia/29055589282FB592C72B5C250F155B85)) | 5 planets within **4.2°**, 27° from the Sun, visible at dusk | From the Earth; *Include the Sun* off; naked-eye planets only |
| 28–29 May 1059 BC | The "Mandate of Heaven" conjunction, tied to the fall of the Shang and rise of the Zhou ([Lehigh University](https://news.lehigh.edu/a-detectives-dynastic-coup)) | 5 planets within **6.4°**, visible | From the Earth; *Include the Sun* off; naked-eye planets only |
| 18 Feb 3102 BC | Traditional start of the Kali Yuga, said to begin with all planets together ([Wikipedia](https://en.wikipedia.org/wiki/Kali_Yuga)) | Sun, Moon and planets within about **40°**: real but loose, ten times wider than 1953 BC; late Pisces in the Lahiri sidereal zodiac | From the Earth; Sun and Moon on; naked-eye planets; *Sidereal* longitudes |
| 16 Sep 1186 | The "Letter of Toledo" announced the end of the world for this conjunction in Libra ([The Museum of Hoaxes](https://hoaxes.org/archive/permalink/the_toledo_letter/)) | 5 planets within **8.5°**; with Sun and Moon **11.5°**, beside the Sun and invisible | From the Earth, with or without the Sun |
| 19 Feb 1524 | Johannes Stöffler's predicted universal flood, with panic across Germany ([Les Enluminures](https://textmanuscripts.com/blog/entry/2_16_the_deluge_of_doom)) | 5 planets within **10.5°** in Pisces | From the Earth; *Include the Sun* off; naked-eye planets only |
| 4–5 Feb 1962 | Seven bodies together and a total solar eclipse the same day ([Earth Magazine](https://www.earthmagazine.org/article/benchmarks-february-4-1962-five-planets-align-no-end-world/)) | Sun, Moon and 5 planets within **16°**; the page flags the eclipse | From the Earth; Sun and Moon on; naked-eye planets |
| 10 Mar 1982 | "The Jupiter Effect" predicted earthquakes from a planetary alignment ([Wikipedia](https://en.wikipedia.org/wiki/The_Jupiter_Effect)) | All 8 planets on one side of the Sun within **95°**: far from a line | From the Sun; all on one side of the Sun |
| 5 May 2000 | Another doomsday alignment ([NASA NSSDC](https://nssdc.gsfc.nasa.gov/planetary/alignment.html)) | Sun, Moon and 5 planets within **26°**, but hidden in the Sun's glare | From the Earth; Sun and Moon on; naked-eye planets |
| 8 Sep 2040 | The best visible grouping of this century ([B.A.S.](https://historic.bas.org.in/What_will_you_be_doing_on_September_9th__2040_at_7_00_PM_.htm)) | 5 planets within **9.2°**, 20° from the Sun, in the evening sky | From the Earth; *Include the Sun* off; naked-eye planets only |

Each date and Julian Day on the page opens that moment in Stellarium Web;
press **A** there to switch the atmosphere off and see the planets by day.

## Languages

The page is available in English, Spanish, Catalan, French, Italian, German,
Portuguese, Latvian, Russian, Japanese, Chinese and Hindi. It picks the visitor's
browser language, can be changed from the menu in the header, and remembers
the choice. `#lang=xx` in the address forces a language.

### Adding a language

1. Copy `docs/i18n/en.json` to `docs/i18n/<code>.json` (an ISO 639-1 code such
   as `ko`, `ar`, `nl`) and translate the texts. Keep every `{placeholder}`
   exactly as it is; you may move it within the sentence. Texts written as
   `{"one": ..., "other": ...}` are plural forms: use the forms your language
   needs (`zero`, `one`, `two`, `few`, `many`, `other`); `other` is required.
   A few entries shape dates and sentences rather than words: `date.format`
   (`{d}` day, `{m}` month number, `{mon}` short month name, `{y}` year),
   `year.bc` and `year.ad`, and `sep`, the space between sentences (empty for
   Chinese and Japanese).
2. Add a flag as `docs/flags/<flag>.svg` (any 3:2 SVG) unless one is already
   there.
3. Add the language to `docs/i18n/languages.json`: its code, its name in its
   own language, the flag file name, a locale for numbers and month names
   (for example `ko-KR`) and the writing direction (`ltr`, or `rtl` for Arabic
   or Hebrew, whose layout has not been checked yet).
4. Run `python tools/check_i18n.py`. It reports missing or unknown keys and
   placeholders that do not match English. Missing texts are not fatal: the
   page shows them in English.

The translations were written in one pass and would benefit from a review by
native speakers, especially Japanese, Chinese, Hindi and Russian. The command
line program and the CSV files stay in English.

## Notes

- Grouping is measured on longitudes projected onto the invariable plane of the
  solar system (`--plane ecliptic` uses the J2000 ecliptic instead), except with
  *true distance in the sky*.
- Positions are geometric (no light time or aberration).
- ΔT: Espenak & Meeus polynomials for Morrison & Stephenson (2004), with the
  long-term parabola outside 500 BC–AD 2150; uncertainty after Morrison &
  Stephenson and Huber (2000).
- Lahiri ayanamsha: 23°15′00.658″ on 1956‑03‑21 (true; the mean value is used),
  with the sidereal origin kept fixed among the stars and projected onto each
  ecliptic of date. It gives 23.857° at J2000.
- Eclipses: a solar eclipse is flagged when the Moon's disc reaches the Sun's as
  seen from somewhere on Earth; a lunar one when the Moon reaches the Earth's
  umbra (or only the penumbra).
- Years are astronomical: year 0 is 1 BC, year −3101 is 3102 BC. Dates use the
  Julian calendar before 15 October 1582 and the Gregorian one from then on,
  unless `--calendar` says otherwise.

## License

- **Code** (`alignments.py`, `export_web.py`, `tools/`, and the web page in
  `docs/`): GNU General Public License, version 3 or (at your option) any later
  version. See [`LICENSE`](LICENSE). You may use, study, change and share it;
  if you distribute a modified version, it must also be under the GPL with its
  source code available.
- **Exported data** (`docs/data/`): [Creative Commons Attribution 4.0
  (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/). Use it freely,
  crediting Syzygeon. See [`docs/data/LICENSE.md`](docs/data/LICENSE.md).
- **Translations** (`docs/i18n/`) and **flags** (`docs/flags/`) are part of the
  page and follow the code licence.

Third-party material: the JPL DE441 ephemeris (Park et al. 2021) is freely
distributed by JPL and is not included here; the Alegreya and Alegreya Sans
fonts (SIL Open Font License) are loaded from Google Fonts; the ΔT
coefficients used for Stellarium links come from Stephenson, Morrison &
Hohenkerk (2016, *Proc. R. Soc. A* 472:20160404).

## Credits

Built by Carlos Baiget Orts in conversation with Claude (Anthropic).

Copyright (C) 2026 Carlos Baiget Orts <asinfreedom@gmail.com>.
