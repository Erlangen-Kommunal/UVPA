# UVPA Erlangen — Dokumentensuche

Durchsuchbares Archiv der öffentlichen Unterlagen des **Umwelt-, Verkehrs- und
Planungsausschusses** der Stadt Erlangen, seit 2020.

**→ https://erlangen-kommunal.github.io/UVPA/**

Ehrenamtlich erstellt. Es werden ausschließlich öffentlich zugängliche Daten
verwendet. Diese Anwendung steht in keiner Verbindung zur Stadt Erlangen.

Schwesterprojekt: [Infoportal Stadtteilbeirat Büchenbach](https://github.com/Erlangen-Kommunal/SBR-Buechenbach).

---

## Wozu

Die Unterlagen liegen zwar öffentlich im Ratsinformationssystem, sind dort aber
nur sitzungsweise zu durchblättern. Wer wissen will, was in fünf Jahren zu einer
bestimmten Straße beschlossen wurde, sucht lange. Diese Seite legt einen
Volltextindex über alle Dokumente und verbindet sie mit Themen, Stadtteilen,
Straßen und Beiratsgebieten.

Zielgruppe sind kommunalpolitische Beiräte ohne IT-Kenntnisse — die Oberfläche
bleibt deshalb bewusst einfach. **Keine KI-Suche, nur SQL und Volltextindex**:
Ergebnisse sollen nachvollziehbar sein.

## Was drin ist

- ~5.000 PDFs aus 69 Sitzungen, nach `{Datum}/TOP_{Nr}_{Vorlage}_{Titel}/` abgelegt
- Volltext aller Dokumente, dazu Kurzzusammenfassungen und Themen je Dokument
- Kuratierte Register: [Verkehrs- und Stadtentwicklungspläne](plaene/registry.json)
  und [Stadtrecht](recht/registry.json)
- Geodaten: Tempo-30-Netz, amtliches Straßenverzeichnis, Beiratsgebiete
  (siehe [geo/README.md](geo/README.md))
- Beratungsfolge der Vorlagen — welches Gremium wann mit welchem Ergebnis befasst war

## Aufbau

```
uvp_agent.py          Scraper: Index + PDFs aus dem Ratsinformationssystem
tools/                Geodaten, Beratungsfolge, Passwort-Hash
enrichment/           Zusammenfassungen (je Dokument eine .md) + Themen-Taxonomie
GraphBuilder/         C#/.NET — baut graph.db (DuckDB) aus alldem
web/                  statisches Frontend (DuckDB-Wasm, Leaflet, Cytoscape)
plaene/ recht/ geo/   kuratierte Register und Geodaten
```

`graph.db` wird in der CI gebaut und ist **nicht** im Repo (`.gitignore`).

## Selbst bauen

```bash
python uvp_agent.py --sync                 # Index + neue PDFs (kein API-Key nötig)
python tools/fetch_geodata.py              # Geodaten auffrischen
python tools/fetch_beratungsfolge.py       # Beratungsfolge der Vorlagen
dotnet run --project GraphBuilder -- .     # graph.db bauen
cd web && python -m http.server            # lokal ansehen
```

Lokal fehlt `auth.json`, dann entfällt das Passwort-Gate.

## Automatik

- `.github/workflows/sync.yml` — donnerstags 04:00 Europe/Berlin: Scrape,
  neue PDFs committen. Deterministisch, ohne LLM.
- `.github/workflows/deploy.yml` — bei jedem Push auf `main`: graph.db bauen,
  `auth.json` erzeugen, auf GitHub Pages veröffentlichen.

Die **Zusammenfassungen entstehen nicht in der CI**, sondern werden lokal von
einem KI-Agenten in der Entwicklungsumgebung geschrieben. `enrichment/enrich.py`
enthält Taxonomie, Prompts und Schema als Referenz; `call_llm()` ist bewusst
eine leere Stelle ohne Anbieter. Ablauf: [enrichment/README.md](enrichment/README.md).

## Hinweise für Mitarbeitende

- Ein Pre-Commit-Hook blockt Dateien ab 12 MB: `git config core.hooksPath .githooks`
- Das Passwort-Gate ist eine Nutzungshürde, **kein Datenschutz** — die Dokumente
  sind amtlich öffentlich. Das Passwort steht in `.secrets` (gitignored).
- Bei Frontend-Änderungen `APP_VERSION` in `web/app.js` **und** die
  `?v=`-Parameter in `web/index.html` gemeinsam hochzählen, sonst sehen
  wiederkehrende Besucher die alte Datei.
- Offene Punkte und bekannte Fallstricke: [OFFENE_PUNKTE.md](OFFENE_PUNKTE.md)
- Datenquellen mit Lizenz- und CORS-Status: [geo/DATENQUELLEN.md](geo/DATENQUELLEN.md)

## Daten und Lizenzen

Dokumente: Stadt Erlangen, Ratsinformationssystem (amtlich öffentlich).
Karten: [basemap.de](https://basemap.de) (BKG), OpenStreetMap-Mitwirkende (ODbL),
Luftbild und Flurstücke der Bayerischen Vermessungsverwaltung (CC BY 4.0).
Straßenverzeichnis und Beiratsgebiete: Stadt Erlangen, Statistik und
Stadtforschung (dl-de/by-2.0).
