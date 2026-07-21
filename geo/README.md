# Geodaten

Grundlage des Karten-Tabs: wo im Stadtgebiet gilt Tempo 30, Tempo 20 oder
verkehrsberuhigter Bereich — und welche Ausschussdokumente behandeln welche
Straße.

Erzeugt und aktualisiert von `tools/fetch_geodata.py` (nur Standardbibliothek,
keine pip-Abhängigkeit). Der Wochen-Sync ruft das Skript automatisch auf;
manuell:

```bash
python tools/fetch_geodata.py            # beide Quellen
python tools/fetch_geodata.py --skip-amt # nur OpenStreetMap
```

## Dateien

| Datei | Inhalt | erzeugt | im Deploy |
|---|---|---|---|
| `tempo30.overpassql` | Overpass-Abfrage Straßen | kuratiert von Hand | — |
| `einrichtungen.overpassql` | Overpass-Abfrage Einrichtungen | kuratiert von Hand | — |
| `tempo30.geojson` | ~3.100 Straßenabschnitte mit Tempo-Klasse | Skript | ja |
| `einrichtungen.geojson` | ~500 Schulen, Kitas, Spielplätze, soziale Einrichtungen | Skript | ja |
| `strassen.json` | amtliches Straßenverzeichnis + statistische Bezirke | Skript | nein¹ |
| `meta.json` | Abrufzeitpunkt, Stückzahlen, Lizenzen | Skript | ja |

¹ `strassen.json` liest nur der GraphBuilder beim Bauen der `graph.db`. Das
Ergebnis steckt danach in den Tabellen `streets` und `document_streets`, das
Frontend braucht die Datei nicht.

## Quellen und Lizenzen

**OpenStreetMap** über die [Overpass-API](https://overpass-api.de) — Geometrie
und Tempo-Klassen der Straßen, Lage der Einrichtungen.
Lizenz: **ODbL**, © OpenStreetMap-Mitwirkende. Die Namensnennung steht in der
Kartenlegende und in der Leaflet-Attribution.

**Stadt Erlangen, Statistik und Stadtforschung** — „Statistische Bezirke der
Stadt Erlangen nach Straßenabschnitten" ([Open
Data](https://erlangen.de/aktuelles/opendata), xlsx).
Lizenz: **Datenlizenz Deutschland Namensnennung 2.0** (dl-de/by-2.0).
Bei einer neuen Ausgabe den Dateinamen in `AMT_URL` (tools/fetch_geodata.py)
nachziehen — die URL trägt den Stand im Namen.

**basemap.de / BKG** — Kartenkacheln (graue Rasterausgabe, ohne Schlüssel
nutzbar). Attribution über die Leaflet-Attributionsleiste.

## Warum das amtliche Verzeichnis die Namensautorität ist

Gesucht wird im Dokumentvolltext nur nach Straßennamen, die im amtlichen
Verzeichnis stehen (914 Namen), nicht nach den Namen aus OpenStreetMap. Zwei
Gründe:

1. **Stadtgrenze.** Die Bounding-Box der Overpass-Abfrage greift bewusst über
   das Stadtgebiet hinaus; von den 1.001 OSM-Straßennamen sind rund 290 gar
   nicht Erlangen (die „Adi-Dassler-Straße" liegt in Herzogenaurach).
2. **Fehltreffer.** OSM kennt Namen, die zugleich Allerweltswörter sind.

Zwei Regeln halten die Zuordnung sauber (`GraphBuilder/StreetIndex.cs`):

- **Wortgrenzen statt Teilstring.** Gesucht wird über Wort-n-Gramme (bis vier
  Wörter, wegen „An der Weißen Marter"), damit „Am Anger" nicht in „Am
  Angerweg" anschlägt.
- **Briefköpfe zählen nicht.** Folgt hinter dem Straßennamen eine Hausnummer
  mit Postleitzahl („Rathausplatz 1 91052 Erlangen"), ist das die
  Absenderadresse und kein Sachbezug. Ohne diesen Filter käme allein der
  Rathausplatz auf 571 statt 192 Dokumente.

Die Zuordnung Straße → statistischer Bezirk gilt **abschnittsweise nach
Hausnummern**; eine lange Straße kann in mehreren Bezirken liegen (Feld
`bezirke`). Das Verzeichnis führt nur Straßen mit Hausnummern.

## Offen

- **Beiratsgebiete.** Die Stadt veröffentlicht die Gebiete der 7 Orts- und
  6 Stadtteilbeiräte als Shapefile (`Elangen_2015_Vektorgeometrie_Stadtteilbeiratsgebiete.zip`).
  Damit ließe sich „welche Dokumente betreffen mein Beiratsgebiet?" beantworten.
  Zwei Hürden: die Datei ist von 2015 und trägt Arbeitsnamen (`SB Zentrum/Nord`,
  `SB West`) statt der heutigen Beiratsnamen, und sie liegt in DHDN/Gauß-Krüger
  Zone 4 — für die Karte wäre eine Umrechnung nach WGS84 nötig.
- **Satzung über Orts- und Stadtteilbeiräte (140.00).** Sie definiert die
  Gebiete rechtsverbindlich, fehlt aber in `recht/registry.json`; das verlinkte
  PDF liefert derzeit 404.
