#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
LLM-Anreicherung der UVPA-Sitzungsdokumente (Phase 2).

Erzeugt pro Dokument eine Markdown-Datei unter enrichment/docs/<pfad>.md mit
YAML-Frontmatter (themen, modell, erstellt) und einer deutschen Kurz-
zusammenfassung. Die Themen kommen ausschließlich aus der kuratierten
Taxonomie in enrichment/themen.md (eine Quelle der Wahrheit).

Läuft inkrementell: Dokumente mit vorhandener .md-Datei werden übersprungen —
der wöchentliche Sync bezahlt nur neue Dokumente. Jede fertige Zusammenfassung
wird sofort geschrieben (absturzsicher, einfach neu starten).

HINWEIS: Der LLM-Provider wird gerade neu festgelegt. Die frühere
Gemini-Anbindung (Nutzung des GEMINI_API_KEY) wurde auf Wunsch des
Projektinhabers entfernt; der Basislauf vom 2026-07-19 (4.736 Dokumente,
gemini-3.1-flash-lite) liegt bereits unter enrichment/docs/. Für künftige
Läufe muss call_llm() mit dem neuen Provider implementiert werden.

Aufruf:
    python enrichment/enrich.py [--limit N] [--dry-run] [--model M] [--workers N]
"""

import argparse
import json
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DOCS_OUT = REPO / "enrichment" / "docs"
THEMEN_MD = REPO / "enrichment" / "themen.md"
INDEX_JSON = REPO / "index.json"

DEFAULT_MODEL = ""          # wird mit dem neuen LLM-Provider festgelegt
TEXT_CAP_DEFAULT = 12_000   # Zeichen Dokumenttext pro Anfrage
TEXT_CAP_LONG = 20_000      # für NI/EI/SU (decken ganze Sitzungen ab)

TYPE_INSTRUCTIONS = {
    "VO": "Beschlussvorlage/Mitteilung: Worum geht es, was wird beantragt oder "
          "vorgeschlagen, was soll entschieden werden?",
    "BL": "Beschluss/Beratungsergebnis: Was wurde entschieden oder zur "
          "Kenntnis genommen?",
    "NI": "Niederschrift einer ganzen Sitzung: Fasse die wichtigsten Beschlüsse "
          "und Diskussionspunkte über alle Tagesordnungspunkte zusammen "
          "(hier sind 4-6 Sätze erlaubt).",
    "EI": "Einladung mit Tagesordnung: Nenne die inhaltlich wichtigsten "
          "Tagesordnungspunkte der Sitzung.",
    "SU": "Sitzungsunterlagen-Paket: Nenne die inhaltlich wichtigsten "
          "Tagesordnungspunkte der Sitzung.",
    "":   "Anlage: Was für ein Dokument ist das (Plan, Karte, Bericht, "
          "Präsentation, Stellungnahme ...) und was zeigt bzw. enthält es?",
}


def load_themen() -> list[str]:
    """Sachthemen aus der kuratierten Tabelle in themen.md (Quelle der Wahrheit)."""
    themen = []
    in_sach = False
    for line in THEMEN_MD.read_text(encoding="utf-8").splitlines():
        if line.startswith("## Sachthemen"):
            in_sach = True
            continue
        if in_sach and line.startswith("## "):
            break
        m = re.match(r"^\|\s*\d+\s*\|\s*(.+?)\s*\|", line)
        if in_sach and m:
            themen.append(m.group(1))
    if len(themen) < 10:
        sys.exit(f"Fehler: nur {len(themen)} Themen aus {THEMEN_MD} geparst — Tabellenformat prüfen.")
    return themen


def collect_docs() -> list[dict]:
    """Alle Dokumente aus index.json mit vorhandener PDF, die noch keine .md haben."""
    sessions = json.loads(INDEX_JSON.read_text(encoding="utf-8"))
    jobs, skipped_done, skipped_missing = [], 0, 0

    def add(doc, folder, session, top=None):
        nonlocal skipped_done, skipped_missing
        rel = f"{folder}/{doc['filename']}"
        pdf = REPO / folder / doc["filename"]
        out = DOCS_OUT / f"{rel}.md"
        if out.exists():
            skipped_done += 1
            return
        if not pdf.exists():
            skipped_missing += 1
            return
        jobs.append({
            "rel": rel, "pdf": pdf, "out": out,
            "type_code": doc.get("type_code", ""),
            "title": doc.get("title", ""),
            "date": session["date"],
            "top_title": (top or {}).get("title", ""),
            "top_nr": (top or {}).get("top_nr", ""),
        })

    for s in sessions:
        for d in s["header_docs"]:
            add(d, s["folder"], s)
        for t in s["tops"]:
            for d in t["docs"]:
                add(d, t["folder"], s, t)

    print(f"Dokumente: {len(jobs)} offen, {skipped_done} bereits angereichert, "
          f"{skipped_missing} ohne PDF im Repo.")
    return jobs


def extract_text(pdf: Path, cap: int) -> str:
    import pypdf
    try:
        reader = pypdf.PdfReader(str(pdf))
        parts = []
        total = 0
        for page in reader.pages:
            t = page.extract_text() or ""
            parts.append(t)
            total += len(t)
            if total >= cap:
                break
        return "\n".join(parts)[:cap].strip()
    except Exception:
        return ""


def build_user_content(job: dict, text: str) -> str:
    tc = job["type_code"] if job["type_code"] in TYPE_INSTRUCTIONS else ""
    ctx = [f"Dokumenttyp-Anweisung: {TYPE_INSTRUCTIONS[tc]}",
           f"Sitzungsdatum: {job['date']}"]
    if job["top_title"]:
        ctx.append(f"Tagesordnungspunkt: {job['top_nr']} {job['top_title']}")
    ctx.append(f"Dokumenttitel: {job['title']}")
    return "\n".join(ctx) + f"\n\n--- Dokumenttext (ggf. gekürzt) ---\n{text}"


def build_system_prompt(themen: list[str]) -> str:
    return (
        "Du bereitest Dokumente des Umwelt-, Verkehrs- und Planungsausschusses (UVPA) "
        "der Stadt Erlangen für eine Dokumentensuche auf. Die Nutzer sind kommunal-"
        "politische Beiräte ohne IT-Kenntnisse.\n\n"
        "Liefere für das Dokument:\n"
        "1. zusammenfassung: 2-4 Sätze auf Deutsch (bei Niederschriften bis 6). "
        "Konkret und informativ: Worum geht es, was wird beantragt/beschlossen/mitgeteilt, "
        "welche Orte oder Projekte sind betroffen. Keine Floskeln wie "
        "\"Das Dokument behandelt ...\" — direkt zur Sache.\n"
        "2. themen: 0 bis 4 wirklich zutreffende Themen, ausschließlich aus dieser Liste:\n"
        + "\n".join(f"- {t}" for t in themen)
    )


def build_response_schema(themen: list[str]) -> dict:
    """Erwartetes Ausgabeformat — vom neuen Provider als Structured Output zu erzwingen."""
    return {
        "type": "object",
        "properties": {
            "zusammenfassung": {"type": "string"},
            "themen": {"type": "array", "items": {"type": "string", "enum": themen}},
        },
        "required": ["zusammenfassung", "themen"],
    }


def call_llm(system_prompt: str, content: str, schema: dict, model: str) -> dict:
    """LLM-Aufruf — Provider wird neu festgelegt.

    Muss ein Dict {"zusammenfassung": str, "themen": list[str]} liefern,
    validiert gegen `schema`. Die frühere Gemini-Anbindung (GEMINI_API_KEY)
    wurde auf Wunsch des Projektinhabers entfernt.
    """
    raise SystemExit(
        "Kein LLM-Provider konfiguriert: Die Nutzung des GEMINI_API_KEY wurde "
        "entfernt. Neuen Provider in call_llm() implementieren."
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="max. Anzahl Dokumente")
    ap.add_argument("--dry-run", action="store_true", help="nur zählen/schätzen, keine API-Aufrufe")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--workers", type=int, default=6, help="parallele Anfragen")
    args = ap.parse_args()

    themen = load_themen()
    print(f"Taxonomie: {len(themen)} Themen aus {THEMEN_MD.name}.")

    jobs = collect_docs()
    if args.limit:
        jobs = jobs[: args.limit]
    if not jobs:
        print("Nichts zu tun.")
        return

    system_prompt = build_system_prompt(themen)
    schema = build_response_schema(themen)

    print("Extrahiere PDF-Texte …")
    tasks = []
    no_text = 0
    for i, job in enumerate(jobs):
        cap = TEXT_CAP_LONG if job["type_code"] in ("NI", "EI", "SU") else TEXT_CAP_DEFAULT
        text = extract_text(job["pdf"], cap)
        if not text:
            no_text += 1
            continue
        tasks.append((job, build_user_content(job, text)))
        if (i + 1) % 500 == 0:
            print(f"  … {i + 1}/{len(jobs)}", flush=True)

    print(f"{len(tasks)} Anfragen ({no_text} ohne extrahierbaren Text übersprungen).")

    if args.dry_run:
        print("Dry-Run — keine API-Aufrufe.")
        return

    lock = threading.Lock()
    done = {"ok": 0, "err": 0}
    t0 = time.time()

    def process(job: dict, content: str) -> None:
        data = call_llm(system_prompt, content, schema, args.model)
        out: Path = job["out"]
        out.parent.mkdir(parents=True, exist_ok=True)
        frontmatter = (
            "---\n"
            f"themen: {json.dumps(data.get('themen', []), ensure_ascii=False)}\n"
            f"modell: {args.model}\n"
            f"erstellt: {date.today().isoformat()}\n"
            "---\n\n"
        )
        out.write_text(frontmatter + data.get("zusammenfassung", "").strip() + "\n",
                       encoding="utf-8")

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(process, job, content): job for job, content in tasks}
        for fut in as_completed(futures):
            job = futures[fut]
            with lock:
                try:
                    fut.result()
                    done["ok"] += 1
                except SystemExit:
                    raise
                except Exception as exc:
                    done["err"] += 1
                    print(f"  FEHLER {job['rel']}: {type(exc).__name__}: {str(exc)[:120]}",
                          flush=True)
                n = done["ok"] + done["err"]
                if n % 100 == 0:
                    rate = n / max(time.time() - t0, 1)
                    eta = (len(tasks) - n) / max(rate, 0.01) / 60
                    print(f"  … {n}/{len(tasks)} ({rate:.1f}/s, Rest ~{eta:.0f} min)",
                          flush=True)

    print(f"Fertig: {done['ok']} Zusammenfassungen geschrieben, {done['err']} Fehler "
          f"(werden beim nächsten Lauf erneut versucht). "
          f"Dauer: {(time.time() - t0) / 60:.1f} min")


if __name__ == "__main__":
    main()
