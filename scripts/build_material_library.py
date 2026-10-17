"""Build the bundled material library from refractiveindex.info (CC0) files.

Usage: python scripts/build_material_library.py <dir with downloaded .yml files>

Files come from https://github.com/polyanskiy/refractiveindex.info-database
(database/data/main/<path>.yml). Formula materials are sampled every 10 nm;
tables keep their measured points. Rows are limited to the solver's bounds
(200-2500 nm, 0 < n <= 10, 0 <= k <= 10); no point is extrapolated.
"""

import json
import math
import re
import sys
from pathlib import Path

SOURCES = [
    ("Si", "Silicon (crystalline)", "Si/nk/Green-2008", "semiconductor"),
    ("GaAs", "Gallium arsenide", "GaAs/nk/Aspnes", "semiconductor"),
    ("SiO2", "Silicon dioxide (fused silica)", "SiO2/nk/Malitson", "dielectric"),
    ("Si3N4", "Silicon nitride", "Si3N4/nk/Luke", "dielectric"),
    ("TiO2", "Titanium dioxide (rutile, ordinary)", "TiO2/nk/Devore-o", "dielectric"),
    ("Al2O3", "Aluminium oxide (sapphire, ordinary)", "Al2O3/nk/Malitson-o", "dielectric"),
    ("MgF2", "Magnesium fluoride (ordinary)", "MgF2/nk/Dodge-o", "dielectric"),
    ("HfO2", "Hafnium oxide (e-beam film)", "HfO2/nk/Al-Kuhaili", "dielectric"),
    ("Ta2O5", "Tantalum pentoxide (film)", "Ta2O5/nk/Gao", "dielectric"),
    ("Au", "Gold", "Au/nk/Johnson", "metal"),
    ("Ag", "Silver", "Ag/nk/Johnson", "metal"),
    ("Al", "Aluminium", "Al/nk/Rakic-LD", "metal"),
    ("Cu", "Copper", "Cu/nk/Johnson", "metal"),
    ("Cr", "Chromium", "Cr/nk/Johnson", "metal"),
]
MAX_ROWS = 180


def block(text, key):
    match = re.search(rf"^{key}: \|\n((?:    .*\n?)+)", text, re.M)
    return " ".join(line.strip() for line in match.group(1).splitlines()) if match else ""


def reference(text):
    plain = re.sub(r"<[^>]+>", "", block(text, "REFERENCES"))
    return re.sub(r"\s+", " ", plain).strip()[:300]


def formula(kind, c, um):
    if kind == 1:
        n2 = 1 + c[0] + sum(c[i] * um**2 / (um**2 - c[i + 1] ** 2) for i in range(1, len(c) - 1, 2))
        return math.sqrt(n2)
    if kind == 4:
        n2 = c[0]
        for i in (1, 5):
            if i + 3 < len(c):
                n2 += c[i] * um ** c[i + 1] / (um**2 - c[i + 2] ** c[i + 3])
        for i in range(9, len(c) - 1, 2):
            n2 += c[i] * um ** c[i + 1]
        return math.sqrt(n2)
    if kind == 5:
        return c[0] + sum(c[i] * um ** c[i + 1] for i in range(1, len(c) - 1, 2))
    raise ValueError(f"Unsupported formula {kind}")


def rows(text):
    kind = re.search(r"type: (.+)", text).group(1).strip()
    if kind == "tabulated nk":
        data = re.search(r"data: \|\n((?:\s+[-\d.eE+]+\s+[-\d.eE+]+\s+[-\d.eE+]+\n?)+)", text).group(1)
        out = [tuple(float(x) for x in line.split()) for line in data.strip().splitlines()]
        return [(um * 1000, n, k) for um, n, k in out]
    number = int(kind.split()[1])
    lo, hi = (float(x) for x in re.search(r"wavelength_range: (.+)", text).group(1).split())
    coefficients = [float(x) for x in re.search(r"coefficients: (.+)", text).group(1).split()]
    start, end = math.ceil(lo * 100) * 10, math.floor(hi * 100) * 10
    return [(nm, formula(number, coefficients, nm / 1000), 0.0) for nm in range(start, end + 1, 10)]


def main(directory):
    library = []
    for key, name, path, family in SOURCES:
        text = (Path(directory) / f"{path.replace('/', '_')}.yml").read_text()
        table = [(w, n, k) for w, n, k in rows(text) if 200 <= w <= 2500]
        # Keep the longest run inside the solver's n/k bounds.
        runs, current = [], []
        for row in table:
            if 0 < row[1] <= 10 and 0 <= row[2] <= 10:
                current.append(row)
            else:
                runs.append(current)
                current = []
        runs.append(current)
        table = max(runs, key=len)
        if len(table) > MAX_ROWS:
            step = (len(table) - 1) / (MAX_ROWS - 1)
            table = [table[round(i * step)] for i in range(MAX_ROWS)]
        library.append({
            "id": key,
            "name": name,
            "family": family,
            "range_nm": [round(table[0][0], 2), round(table[-1][0], 2)],
            "source": f"refractiveindex.info ({path}); {reference(text)}",
            "material": {
                "name": f"{key} ({path.split('/')[-1]})",
                "kind": "tabulated",
                "n": round(table[len(table) // 2][1], 6),
                "k": round(table[len(table) // 2][2], 6),
                "wavelengths_nm": [round(w, 2) for w, _, _ in table],
                "n_values": [round(n, 6) for _, n, _ in table],
                "k_values": [round(k, 6) for _, _, k in table],
                "source": f"refractiveindex.info {path} (CC0)",
            },
        })
    out = Path(__file__).parents[1] / "frontend/src/core/materials/library.json"
    out.write_text(json.dumps(library, separators=(",", ":")) + "\n")
    for item in library:
        print(f"{item['id']:6} {item['range_nm']} rows={len(item['material']['wavelengths_nm'])}")


if __name__ == "__main__":
    main(sys.argv[1])
