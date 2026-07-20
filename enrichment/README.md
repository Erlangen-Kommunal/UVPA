# Dokument-Anreicherung (LLM) — manuell, lokal

Dieser Ordner enthält die **LLM-gestützte Analyse** der Ausschussdokumente:
je Dokument eine `.md`-Datei unter `docs/<pfad-der-pdf>.md` mit einer
deutschen Kurzzusammenfassung und Themen-Tags.

## Bewusste Architektur-Entscheidung

Die Anreicherung ist **absichtlich vom automatischen Workflow getrennt**:

- **Automatisch & deterministisch** (GitHub Actions): Der Wochen-Sync
  (`.github/workflows/sync.yml` → `uvp_agent.py --sync`) lädt neue Dokumente
  aus dem Ratsinfosystem und komprimiert sie. Der Build & Deploy
  (`.github/workflows/deploy.yml`) baut `graph.db` und veröffentlicht die Seite.
  **Kein LLM, kein API-Key in der CI.**

- **Manuell & lokal** (dieser Ordner): Die `.md`-Zusammenfassungen werden
  **von Hand ausgelöst** über den in VS Code integrierten KI-Agenten. Kein
  fremder API-Key nötig; das Modell des Agenten schreibt die Dateien direkt.

## Ablauf: neue Dokumente anreichern

1. **Was fehlt?** Ein Dokument ist noch nicht angereichert, wenn zu seiner PDF
   keine gleichnamige `.md` unter `docs/` existiert. Nach einem Sync sind das
   die neu hinzugekommenen Sitzungsdokumente.

2. **Den Agenten beauftragen.** Im Repo den KI-Agenten bitten, z. B.:
   *„Reichere die noch nicht angereicherten Dokumente an."* Der Agent
   ermittelt die offenen Dokumente (Abgleich `index.json` ↔ vorhandene `.md`),
   liest die PDF-Texte und schreibt pro Dokument eine `.md` nach dem unten
   beschriebenen Format.

3. **`.md` committen.** Die Ergebnisse sind Daten, die ins Repo gehören.

4. **Deploy.** Der Push löst Build & Deploy aus; `graph.db` enthält dann die
   neuen Zusammenfassungen und Themen. Suche, Themen-Filter und die
   Reader-Zusammenfassung greifen automatisch.

## Dateiformat (`docs/<pfad>.md`)

```markdown
---
themen: ["Radverkehr", "Parken"]
modell: <name des verwendeten modells>
erstellt: JJJJ-MM-TT
---

<2–4 Sätze auf Deutsch; bei Niederschriften bis 6. Konkret: worum geht es,
was wird beantragt/beschlossen/mitgeteilt, welche Orte oder Projekte sind
betroffen. Keine Floskeln.>
```

- **`themen`**: 0–4 Einträge, **ausschließlich** aus der kuratierten Taxonomie
  (Abschnitt „Sachthemen" in [`themen.md`](themen.md)). Nur wirklich zutreffende
  Themen. `GraphBuilder` speichert sie intern mit `|` getrennt (Themennamen
  enthalten teils Kommas), im Frontmatter stehen sie als JSON-Array.
- Der **Body** ist die Zusammenfassung — sie fließt in den Volltext-Suchindex,
  erscheint als Snippet in der Trefferliste und als Box im Reader.

## Prompt-Vorlage

Die typ-spezifischen Anweisungen (Beschlussvorlage vs. Niederschrift vs.
Anlage …), der Systemprompt und das Ausgabeschema liegen als Referenz in
[`enrich.py`](enrich.py) — die Funktionen `build_system_prompt()`,
`build_user_content()`, `build_response_schema()` und `TYPE_INSTRUCTIONS`.
Das Skript selbst führt **keine** LLM-Aufrufe mehr aus (`call_llm()` ist eine
leere Provider-Andockstelle); es dient als dokumentierte Vorlage und zum
Ermitteln der offenen Dokumente (`collect_docs()`, `--dry-run`).

Offene Dokumente auflisten, ohne etwas zu erzeugen:

```sh
python enrichment/enrich.py --dry-run
```

## Stand des Erst-Backfills

Der vollständige Erstlauf über 4.736 Dokumente (Stand 2026-07-19) liegt unter
`docs/`. Nicht angereichert sind ~304 rein gescannte PDFs ohne extrahierbare
Textebene (bräuchten OCR) und ~104 im Repo fehlende Übergroß-Dateien.
