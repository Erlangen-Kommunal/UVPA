"""Laedt gezielt die noch fehlenden Sitzungen nach.

Der volle --sync-Lauf ist zweimal in der Kompressionsphase gestorben (MuPDF
kaempft mit den 100-MB-Sitzungsunterlagen). Dieses Skript nutzt dieselben
Funktionen, ueberspringt aber compress_existing() und den erzwungenen
Index-Neuscrape.
"""
import sys
from pathlib import Path

REPO = Path(r"c:\Csharp\UVPA")
sys.path.insert(0, str(REPO))

import requests
import uvp_agent as ua

FEHLEND = {"2020-04-21", "2026-07-14"}

http = requests.Session()
sessions = ua.load_index(http, force=False)
print(f"Index: {len(sessions)} Sitzungen")

neu = fehler = 0
for s in sessions:
    if s["date"] not in FEHLEND:
        continue
    print(f"\n=== {s['date']} ===")
    session_dir = ua.DOWNLOAD_DIR / s["folder"]
    session_dir.mkdir(parents=True, exist_ok=True)
    ziele = [(d, session_dir) for d in s["header_docs"]]
    for top in s["tops"]:
        top_dir = ua.DOWNLOAD_DIR / top["folder"]
        if top["docs"]:
            top_dir.mkdir(parents=True, exist_ok=True)
        ziele += [(d, top_dir) for d in top["docs"]]
    print(f"  {len(ziele)} Dokumente gelistet")
    for doc, ordner in ziele:
        if (ordner / doc["filename"]).exists():
            continue
        r = ua._download_one(doc, ordner, http)
        if r.startswith("OK:"):
            neu += 1
            print(f"  + {r}")
        elif not r.startswith("Already:"):
            fehler += 1
            print(f"  ! {r}")

print(f"\nFertig: {neu} neue Dokumente, {fehler} Fehler.")
