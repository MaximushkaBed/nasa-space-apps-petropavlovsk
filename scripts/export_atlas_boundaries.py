"""Build a searchable Natural Earth boundary index and per-country geometry."""

import json
from pathlib import Path
import re
import sys

from shapely.geometry import mapping, shape

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "web/data/atlas-boundaries"
KAZAKH_ALIASES = {
    "Akzhar": ["Акжарский район", "Ақжар ауданы"],
    "Ualikhanov": ["Уалихановский район", "Уәлиханов ауданы"],
    "Северо-Казахстанская область": ["СКО", "Солтүстік Қазақстан облысы"],
}


def export(countries_file, regions_file, kazakh_districts_file=None):
    OUTPUT.mkdir(parents=True, exist_ok=True)
    chunks = {}
    index = []
    country_codes = {}
    for level, file in enumerate(filter(None, (countries_file, regions_file, kazakh_districts_file))):
        features = json.loads(Path(file).read_text(encoding="utf-8"))["features"]
        for feature in features:
            props = feature["properties"]
            code = props.get("adm0_a3") or props.get("ADM0_A3") or props.get("shapeGroup")
            values = {key.lower(): value for key, value in props.items()}
            name = values.get("name_ru") or values.get("name_en") or values.get("name") or props.get("shapeName")
            if not code or not re.fullmatch(r"[A-Z0-9]{3}", code) or not name or not feature["geometry"]:
                continue
            if level == 0:
                for key in ("iso_a2", "iso_a2_eh"):
                    alpha2 = values.get(key)
                    if alpha2 and re.fullmatch(r"[A-Z]{2}", alpha2):
                        country_codes[code] = alpha2
                        break
            country = values.get("admin") or ("Казахстан" if level == 2 else "")
            names = list(dict.fromkeys(value for value in
                         (values.get("name_ru"), values.get("name_en"), values.get("name"),
                          values.get("name_alt"), values.get("geonunit")) if value and value != name))
            if code == "KAZ":
                names.extend(KAZAKH_ALIASES.get(name, []))
            raw = shape(feature["geometry"])
            geom = raw.simplify(.013 if level == 0 else .008, preserve_topology=True)
            if geom.is_empty:
                continue
            chunk = chunks.setdefault(code, [])
            index.append([name, country if level else "", names, code, len(chunk), level])
            chunk.append(round_geometry(mapping(geom)))
    def write(file, value):
        content = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        file.write_text(content + "\n", encoding="utf-8")
    for code, geometries in chunks.items():
        write(OUTPUT / f"{code}.json", geometries)
    write(OUTPUT / "index.json", index)
    write(OUTPUT / "country-codes.json", dict(sorted(country_codes.items())))


def round_geometry(geometry):
    def compact(node):
        if isinstance(node[0], (int, float)):
            return [round(node[0], 4), round(node[1], 4)]
        return [compact(child) for child in node]
    return {"type": geometry["type"], "coordinates": compact(geometry["coordinates"])}


if __name__ == "__main__":
    export(*sys.argv[1:])
