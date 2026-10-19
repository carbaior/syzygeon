#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Carlos Baiget Orts <asinfreedom@gmail.com>
# Developed with the assistance of Claude (Anthropic)
"""
check_i18n.py — Checks the translations of the web viewer.

For every language listed in docs/i18n/languages.json it verifies that:
  * its translation file and flag exist and the file is valid JSON;
  * it has every key of the English file (missing keys fall back to English
    on the page, so they are reported as warnings) and no unknown keys;
  * each text uses exactly the same {placeholders} as the English one;
  * plural texts ({"one": ..., "other": ...}) have an "other" form and only
    valid plural categories (zero, one, two, few, many, other).

Usage:  python tools/check_i18n.py            (from the repository root)
Exit status is 1 if there are errors, 0 otherwise.
"""

import json
import os
import re
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "docs")
I18N = os.path.join(ROOT, "i18n")
CATEGORIES = {"zero", "one", "two", "few", "many", "other"}
PLACEHOLDER = re.compile(r"\{(\w+)\}")


def placeholders(value):
    texts = value.values() if isinstance(value, dict) else [value]
    return set().union(*(set(PLACEHOLDER.findall(t)) for t in texts))


def main():
    with open(os.path.join(I18N, "languages.json"), encoding="utf-8") as f:
        config = json.load(f)
    fallback = config.get("fallback", "en")
    with open(os.path.join(I18N, f"{fallback}.json"), encoding="utf-8") as f:
        source = json.load(f)

    errors = warnings = 0
    codes = set()
    for lang in config["languages"]:
        code = lang["code"]
        problems = []
        if code in codes:
            problems.append(("error", "listed twice in languages.json"))
        codes.add(code)
        for field in ("code", "name", "flag", "locale"):
            if not lang.get(field):
                problems.append(("error", f'languages.json entry has no "{field}"'))
        if not os.path.exists(os.path.join(ROOT, "flags", f"{lang.get('flag')}.svg")):
            problems.append(("error", f"flag docs/flags/{lang.get('flag')}.svg is missing"))
        path = os.path.join(I18N, f"{code}.json")
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
        except FileNotFoundError:
            problems.append(("error", f"docs/i18n/{code}.json is missing"))
            data = None
        except json.JSONDecodeError as e:
            problems.append(("error", f"docs/i18n/{code}.json is not valid JSON: {e}"))
            data = None
        if data is not None:
            for key in source:
                if key not in data:
                    problems.append(("warning", f'missing "{key}" (English is shown instead)'))
            for key, value in data.items():
                if key not in source:
                    problems.append(("error", f'unknown key "{key}"'))
                    continue
                if isinstance(value, dict):
                    bad = set(value) - CATEGORIES
                    if bad:
                        problems.append(("error", f'"{key}": unknown plural forms {sorted(bad)}'))
                    if "other" not in value:
                        problems.append(("error", f'"{key}": plural texts need an "other" form'))
                elif not isinstance(value, str):
                    problems.append(("error", f'"{key}" must be a text or a set of plural forms'))
                    continue
                want, got = placeholders(source[key]), placeholders(value)
                if want != got:
                    problems.append(("error", f'"{key}": placeholders {sorted(got)} should be {sorted(want)}'))
        status = "ok" if not problems else ""
        print(f"{code:4s} {lang.get('name', ''):12s} {status}")
        for level, msg in problems:
            print(f"     {level}: {msg}")
            errors += level == "error"
            warnings += level == "warning"
    print(f"\n{len(codes)} languages, {errors} errors, {warnings} warnings.")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
