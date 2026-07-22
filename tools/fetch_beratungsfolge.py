"""Beratungsfolge der Vorlagen aus dem Ratsinformationssystem holen.

Warum: Der Index kennt je Tagesordnungspunkt die Vorlagennummer (`kvonr`), aber
nicht, welche weiteren Gremien dieselbe Vorlage behandelt haben. Genau das ist
für die Beiratsarbeit interessant — ob der Stadtrat einem Ausschussbeschluss
gefolgt ist, ob eine Sache noch im Bau- oder Haupt­ausschuss liegt, wie oft sie
vertagt wurde.

Quelle ist die Registerkarte „Beratungen" einer Vorlage:

    https://ratsinfo.erlangen.de/vo0053.asp?__kvonr=<Nummer>

Jede Beratung steht dort als Akkordeon-Karte, deren Kopfzeile dem Muster
`TT.MM.JJJJ <Gremium> TOP <Nr> <öffentlich|nichtöffentlich> - <Ergebnis>` folgt.

Nur Standardbibliothek — wie tools/fetch_geodata.py, damit der Wochen-Sync ohne
zusätzliche Abhängigkeiten läuft. Der Lauf ist inkrementell: bereits erfasste
Vorlagen werden übersprungen, solange nicht `--force` gesetzt ist.

Aufruf:
    python tools/fetch_beratungsfolge.py            # nur neue Vorlagen
    python tools/fetch_beratungsfolge.py --force    # alles neu holen
    python tools/fetch_beratungsfolge.py --limit 20 # Probelauf
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
INDEX_JSON = REPO / "index.json"
OUT_JSON = REPO / "beratungsfolge.json"

BASE = "https://ratsinfo.erlangen.de"
UA = "SBR-Infoportal/1.0 (ehrenamtlich; Kontakt ueber github.com/Erlangen-Kommunal)"

# Kopfzeile einer Akkordeon-Karte. Das Ergebnis fehlt gelegentlich (z. B. bei
# noch nicht behandelten Vorlagen), deshalb ist der letzte Teil optional.
KOPF_RE = re.compile(
    r'<button[^>]*data-toggle="collapse"[^>]*>(.*?)</button>',
    re.I | re.S,
)
ZEILE_RE = re.compile(
    r"^(?P<datum>\d{2}\.\d{2}\.\d{4})\s+"
    r"(?P<gremium>.+?)\s+"
    r"TOP\s+(?P<top>\S+)\s+"
    r"(?P<oeff>öffentlich|nichtöffentlich)"
    r"(?:\s*-\s*(?P<ergebnis>.*?))?$"
)
SITZUNG_RE = re.compile(r'href="(si0057\.asp\?__ksinr=(\d+)[^"]*)"', re.I)


def entferne_tags(s: str) -> str:
    s = re.sub(r"(?s)<span[^>]*smc-badge[^>]*>.*?</span>", " ", s)  # "2 Dok."-Zähler
    s = re.sub(r"<[^>]+>", " ", s)
    return re.sub(r"\s+", " ", html.unescape(s)).strip()


def hole(url: str, versuche: int = 3) -> str:
    letzter = None
    for n in range(versuche):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=45) as r:
                return r.read().decode("utf-8", errors="replace")
        except (urllib.error.URLError, OSError, TimeoutError) as e:
            letzter = e
            time.sleep(1.5 * (n + 1))
    raise RuntimeError(f"{url}: {letzter}")


def parse_beratungen(html_text: str) -> list[dict]:
    """Kopfzeilen und zugehörige Sitzungslinks zu Beratungseinträgen verbinden."""
    kaerten = re.split(r'(?=<div id="smcpanel\d+")', html_text)
    out = []
    for karte in kaerten:
        kopf = KOPF_RE.search(karte)
        if not kopf:
            continue
        text = entferne_tags(kopf.group(1))
        m = ZEILE_RE.match(text)
        if not m:
            continue
        sitzung = SITZUNG_RE.search(karte)
        d, mo, y = m.group("datum").split(".")
        ergebnis = (m.group("ergebnis") or "").strip()
        out.append({
            "datum": f"{y}-{mo}-{d}",
            "gremium": m.group("gremium").strip(),
            "top": m.group("top"),
            "oeffentlich": m.group("oeff") == "öffentlich",
            "ergebnis": ergebnis,
            "ksinr": sitzung.group(2) if sitzung else "",
            "url": f"{BASE}/{sitzung.group(1)}" if sitzung else "",
        })
    return out


def sammle_vorlagen() -> dict[str, str]:
    """kvonr → Vorlagennummer, aus allen Tagesordnungspunkten des Index."""
    sessions = json.loads(INDEX_JSON.read_text(encoding="utf-8"))
    vorlagen: dict[str, str] = {}
    for s in sessions:
        for top in s.get("tops", []):
            kvonr = (top.get("kvonr") or "").strip()
            if kvonr:
                vorlagen.setdefault(kvonr, (top.get("vorlage_nr") or "").strip())
    return vorlagen


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--force", action="store_true", help="auch bereits erfasste Vorlagen neu holen")
    ap.add_argument("--limit", type=int, default=0, help="nur die ersten N Vorlagen (Probelauf)")
    ap.add_argument("--workers", type=int, default=4, help="parallele Abrufe (Vorgabe 4)")
    args = ap.parse_args()

    if not INDEX_JSON.exists():
        sys.exit(f"{INDEX_JSON} fehlt — zuerst 'python uvp_agent.py --sync' laufen lassen.")

    vorlagen = sammle_vorlagen()
    bestand: dict[str, dict] = {}
    if OUT_JSON.exists() and not args.force:
        bestand = json.loads(OUT_JSON.read_text(encoding="utf-8"))

    offen = [k for k in vorlagen if k not in bestand]
    if args.limit:
        offen = offen[: args.limit]
    print(f"Vorlagen im Index: {len(vorlagen)} — bereits erfasst: {len(bestand)}, offen: {len(offen)}")
    if not offen:
        print("Nichts zu tun.")
        return

    fehler = 0

    def arbeite(kvonr: str) -> tuple[str, dict | None]:
        try:
            seite = hole(f"{BASE}/vo0053.asp?__kvonr={kvonr}")
            return kvonr, {
                "vorlage_nr": vorlagen[kvonr],
                "beratungen": parse_beratungen(seite),
            }
        except Exception as e:  # noqa: BLE001 — ein Ausfall darf den Lauf nicht kippen
            print(f"  ! {kvonr}: {e}")
            return kvonr, None

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for i, (kvonr, daten) in enumerate(pool.map(arbeite, offen), 1):
            if daten is None:
                fehler += 1
            else:
                bestand[kvonr] = daten
            if i % 100 == 0:
                print(f"  … {i}/{len(offen)}", flush=True)

    OUT_JSON.write_text(
        json.dumps(bestand, ensure_ascii=False, indent=1, sort_keys=True),
        encoding="utf-8",
    )

    mehrfach = sum(1 for v in bestand.values() if len(v["beratungen"]) > 1)
    gesamt = sum(len(v["beratungen"]) for v in bestand.values())
    print(f"\n{OUT_JSON.name}: {len(bestand)} Vorlagen, {gesamt} Beratungen, "
          f"{mehrfach} Vorlagen in mehr als einem Gremium, {fehler} Fehler.")


if __name__ == "__main__":
    main()
