#!/usr/bin/env python3
"""Holt die Geodaten für den Karten-Tab — deterministisch, ohne LLM, ohne Fremd-Key.

Zwei Quellen, beide öffentlich:

  1. OpenStreetMap über die Overpass-API — Geometrie und Tempo-Klassen der
     Straßen sowie die Einrichtungen (Schulen, Kitas, soziale Einrichtungen,
     Spielplätze). Die Abfragen stehen kuratiert und kommentiert in
     geo/*.overpassql.  Lizenz: ODbL, © OpenStreetMap-Mitwirkende.

  2. Stadt Erlangen, Statistik und Stadtforschung — „Statistische Bezirke der
     Stadt Erlangen nach Straßenabschnitten" (Open Data, xlsx). Liefert das
     amtliche Straßenverzeichnis samt Zuordnung zum statistischen Bezirk.
     Lizenz: Datenlizenz Deutschland Namensnennung 2.0.

Das amtliche Verzeichnis ist die Namensautorität: Nur Straßennamen, die dort
stehen, werden später im Dokumentvolltext gesucht. Das hält Ortsfremdes
draußen (die Bounding-Box greift bewusst über die Stadtgrenze) und verhindert
Fehltreffer durch OSM-Namen, die zugleich Allerweltswörter sind.

Aufruf:  python tools/fetch_geodata.py [--out geo] [--skip-osm] [--skip-amt]
"""

from __future__ import annotations

import argparse
import io
import json
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

# Overpass-Spiegel: der erste, der antwortet, gewinnt. Der Hauptserver
# quittiert Lastspitzen mit 504/429 — dann ist der nächste dran.
OVERPASS_MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.osm.ch/api/interpreter",
]

# „Statistische Bezirke der Stadt Erlangen nach Straßenabschnitten"
# Bei einer neuen Ausgabe hier den Dateinamen nachziehen (Übersicht:
# https://erlangen.de/aktuelles/opendata).
AMT_URL = ("https://erlangen.de/uwao-api/faila/files/bypath/Dokumente/Statistik/"
           "Statistik%20Open%20Data/bezirke_strassenabschnitte_2025.10.xlsx")

UA = "UVPA-Erlangen/1.0 (ehrenamtliches Dokumentenportal; +https://erlangen-kommunal.github.io/UVPA/)"

# Koordinaten auf 5 Nachkommastellen (~1 m). Genauer bringt für eine
# Übersichtskarte nichts, kostet aber ein Drittel der Dateigröße.
PRECISION = 5

XLSX_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def log(msg: str) -> None:
    print(msg, flush=True)


def http_get(url: str, timeout: int = 240) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


# ── OpenStreetMap ────────────────────────────────────────────────────────────

def overpass(query: str) -> dict:
    """Führt eine Overpass-Abfrage aus und probiert dabei die Spiegel durch."""
    body = urllib.parse.urlencode({"data": query}).encode("utf-8")
    last_err = None
    for mirror in OVERPASS_MIRRORS:
        for attempt in (1, 2):
            try:
                req = urllib.request.Request(
                    mirror, data=body,
                    headers={"User-Agent": UA,
                             "Content-Type": "application/x-www-form-urlencoded"})
                with urllib.request.urlopen(req, timeout=300) as r:
                    return json.loads(r.read().decode("utf-8"))
            except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as e:
                last_err = e
                code = getattr(e, "code", None)
                log(f"  {mirror} → {code or e} (Versuch {attempt})")
                # 429/504 = überlastet; kurz warten und einmal nachfassen.
                if code in (429, 504) and attempt == 1:
                    time.sleep(20)
                else:
                    break
    raise RuntimeError(f"Kein Overpass-Spiegel erreichbar: {last_err}")


def road_class(tags: dict) -> str | None:
    """Tempo-Klasse eines Wegs — bestimmt Farbe und Legende auf der Karte."""
    if tags.get("highway") == "living_street":
        return "living"
    if tags.get("maxspeed") == "20":
        return "t20"
    if tags.get("maxspeed") == "30":
        return "t30"
    if "maxspeed:conditional" in tags:
        return "cond"
    return None


def fetch_roads(query: str) -> dict:
    data = overpass(query)
    features = []
    for el in data.get("elements", []):
        geom = el.get("geometry")
        if not geom:
            continue
        tags = el.get("tags", {})
        cls = road_class(tags)
        if cls is None:
            continue
        coords = [[round(p["lon"], PRECISION), round(p["lat"], PRECISION)] for p in geom]
        props = {"cls": cls}
        if tags.get("name"):
            props["name"] = tags["name"]
        # Die zeitliche Bedingung ist der eigentliche Informationsgehalt der
        # bedingten Begrenzungen ("30 @ (Mo-Fr 07:00-17:00)") — mitnehmen.
        if tags.get("maxspeed:conditional"):
            props["cond"] = tags["maxspeed:conditional"]
        features.append({"type": "Feature", "properties": props,
                         "geometry": {"type": "LineString", "coordinates": coords}})
    return {"type": "FeatureCollection", "features": features}


POI_KIND = [
    ("school", lambda t: t.get("amenity") == "school"),
    ("kindergarten", lambda t: t.get("amenity") == "kindergarten"),
    ("social", lambda t: t.get("amenity") == "social_facility"),
    ("playground", lambda t: t.get("leisure") == "playground"),
]


def fetch_pois(query: str) -> dict:
    data = overpass(query)
    features = []
    for el in data.get("elements", []):
        tags = el.get("tags", {})
        kind = next((k for k, pred in POI_KIND if pred(tags)), None)
        if kind is None:
            continue
        center = el.get("center") or ({"lat": el.get("lat"), "lon": el.get("lon")})
        if center.get("lat") is None or center.get("lon") is None:
            continue
        props = {"kind": kind}
        if tags.get("name"):
            props["name"] = tags["name"]
        features.append({
            "type": "Feature", "properties": props,
            "geometry": {"type": "Point", "coordinates": [
                round(center["lon"], PRECISION), round(center["lat"], PRECISION)]},
        })
    return {"type": "FeatureCollection", "features": features}


# ── Amtliches Straßenverzeichnis (xlsx) ──────────────────────────────────────

def xlsx_rows(blob: bytes, sheet_name: str) -> list[dict[str, str]]:
    """Liest ein Arbeitsblatt als Liste von {Spaltenbuchstabe: Wert}.

    Bewusst ein Minimalparser statt openpyxl: die Datei ist simpel und der
    Wochen-Sync soll ohne zusätzliche pip-Abhängigkeit auskommen.
    """
    z = zipfile.ZipFile(io.BytesIO(blob))
    shared = [
        "".join(t.text or "" for t in si.iter(XLSX_NS + "t"))
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall(XLSX_NS + "si")
    ]
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    rel_ns = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
    rels = {r.get("Id"): r.get("Target")
            for r in ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))}

    target = None
    for sheet in wb.iter(XLSX_NS + "sheet"):
        if sheet.get("name") == sheet_name:
            target = rels[sheet.get(rel_ns + "id")]
            break
    if target is None:
        raise KeyError(f"Arbeitsblatt „{sheet_name}“ nicht in der Datei "
                       f"(vorhanden: {[s.get('name') for s in wb.iter(XLSX_NS + 'sheet')]})")

    path = "xl/" + target.lstrip("/").removeprefix("xl/")
    rows = []
    for row in ET.fromstring(z.read(path)).iter(XLSX_NS + "row"):
        cells = {}
        for c in row.findall(XLSX_NS + "c"):
            col = re.match(r"[A-Z]+", c.get("r")).group()
            v = c.find(XLSX_NS + "v")
            inline = c.find(XLSX_NS + "is")
            if c.get("t") == "s" and v is not None:
                val = shared[int(v.text)]
            elif inline is not None:
                val = "".join(t.text or "" for t in inline.iter(XLSX_NS + "t"))
            else:
                val = v.text if v is not None else ""
            cells[col] = (val or "").strip()
        rows.append(cells)
    return rows


def norm(s: str) -> str:
    """Vergleichsform eines Straßennamens (Unicode-Normalform, gestraffte Leerzeichen)."""
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", s)).strip()


def parse_amt(blob: bytes) -> dict:
    """xlsx → {name: {schluessel, bezirke:[{nr,name}], abschnitte:[…]}}."""
    rows = xlsx_rows(blob, "Nach Straßen")

    stand = ""
    for r in rows[:6]:
        m = re.search(r"Stand:\s*([\d.]+)", r.get("A", ""))
        if m:
            d, mo, y = m.group(1).rstrip(".").split(".")
            stand = f"{y}-{mo}-{d}"
            break

    streets: dict[str, dict] = {}
    bezirke: dict[str, str] = {}
    for r in rows:
        key, name, bez = r.get("A", ""), r.get("B", ""), r.get("K", "")
        # Datenzeilen tragen einen numerischen Straßenschlüssel; Titel-,
        # Kopf- und Leerzeilen fallen damit von selbst heraus.
        if not key.isdigit() or not name:
            continue
        name = norm(name)
        m = re.match(r"(\d+)\s+(.*)", bez)
        bez_nr, bez_name = (m.group(1), norm(m.group(2))) if m else ("", "")
        if bez_nr:
            bezirke[bez_nr] = bez_name

        entry = streets.setdefault(name, {"schluessel": key, "bezirke": [], "abschnitte": []})
        if bez_nr and bez_nr not in [b["nr"] for b in entry["bezirke"]]:
            entry["bezirke"].append({"nr": bez_nr, "name": bez_name})
        # Hausnummernbereiche: ungerade C–E, gerade G–I (D/F/H/J sind
        # Buchstabenzusätze wie „23B“). Nur mitschreiben, wenn belegt.
        abschnitt = {k: v for k, v in (
            ("u_von", r.get("C", "") + r.get("D", "")),
            ("u_bis", r.get("E", "") + r.get("F", "")),
            ("g_von", r.get("G", "") + r.get("H", "")),
            ("g_bis", r.get("I", "") + r.get("J", "")),
        ) if v}
        if abschnitt and bez_nr:
            abschnitt["bezirk"] = bez_nr
            entry["abschnitte"].append(abschnitt)

    return {
        "stand": stand,
        "quelle": "Stadt Erlangen, Statistik und Stadtforschung (Open Data)",
        "quelle_url": AMT_URL,
        "lizenz": "Datenlizenz Deutschland Namensnennung 2.0 (dl-de/by-2.0)",
        "bezirke": [{"nr": nr, "name": bezirke[nr]} for nr in sorted(bezirke)],
        "strassen": [dict(name=n, **v) for n, v in sorted(streets.items())],
    }


# ── Hauptlauf ────────────────────────────────────────────────────────────────

def write_json(path: Path, data, compact: bool) -> None:
    # GeoJSON kompakt (es wird nur maschinell gelesen und geht über die
    # Leitung), die kuratierten Verzeichnisse eingerückt und damit diffbar.
    text = json.dumps(data, ensure_ascii=False,
                      separators=(",", ":") if compact else None,
                      indent=None if compact else 2)
    path.write_text(text + ("" if compact else "\n"), encoding="utf-8")
    log(f"  → {path} ({path.stat().st_size / 1024:.0f} KB)")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="geo", help="Zielverzeichnis (Vorgabe: geo)")
    ap.add_argument("--skip-osm", action="store_true", help="OpenStreetMap-Abruf auslassen")
    ap.add_argument("--skip-amt", action="store_true",
                    help="Amtliches Straßenverzeichnis nicht neu laden")
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    meta = {}
    if (out / "meta.json").exists():
        meta = json.loads((out / "meta.json").read_text(encoding="utf-8"))

    if not args.skip_osm:
        log("OpenStreetMap: Tempo-30-Netz …")
        roads = fetch_roads((out / "tempo30.overpassql").read_text(encoding="utf-8"))
        write_json(out / "tempo30.geojson", roads, compact=True)

        log("OpenStreetMap: Einrichtungen …")
        pois = fetch_pois((out / "einrichtungen.overpassql").read_text(encoding="utf-8"))
        write_json(out / "einrichtungen.geojson", pois, compact=True)

        counts: dict[str, int] = {}
        for f in roads["features"]:
            counts[f["properties"]["cls"]] = counts.get(f["properties"]["cls"], 0) + 1
        for f in pois["features"]:
            k = f["properties"]["kind"]
            counts[k] = counts.get(k, 0) + 1
        meta["osm"] = {
            "abgerufen": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "quelle": "OpenStreetMap über Overpass-API",
            "lizenz": "ODbL, © OpenStreetMap-Mitwirkende",
            "wege": len(roads["features"]),
            "einrichtungen": len(pois["features"]),
            "klassen": counts,
        }
        log(f"  {len(roads['features'])} Wege, {len(pois['features'])} Einrichtungen: {counts}")

    if not args.skip_amt:
        log("Stadt Erlangen: Statistische Bezirke nach Straßenabschnitten …")
        amt = parse_amt(http_get(AMT_URL))
        write_json(out / "strassen.json", amt, compact=False)
        meta["amtlich"] = {
            "abgerufen": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "stand": amt["stand"],
            "quelle": amt["quelle"],
            "quelle_url": amt["quelle_url"],
            "lizenz": amt["lizenz"],
            "strassen": len(amt["strassen"]),
            "bezirke": len(amt["bezirke"]),
        }
        log(f"  {len(amt['strassen'])} Straßen, {len(amt['bezirke'])} statistische Bezirke "
            f"(Stand {amt['stand']})")

    write_json(out / "meta.json", meta, compact=False)
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())
