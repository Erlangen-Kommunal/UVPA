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

## Beiratsgebiete — wie die Zuordnung zustande kommt

`beiraete.geojson` enthält die Gebiete der 7 Orts- und 6 Stadtteilbeiräte,
jede Straße in `strassen.json` trägt `beirat` (größter Anteil) und `beiraete`
(alle mit mindestens 15 % Anteil).

**Die Quellenlage ist unbequem und das sollte man wissen:**

Die Satzung über Orts- und Stadtteilbeiräte (140.00, Fassung vom 20.02.2020)
nennt in § 1 nur die *Namen* — „Für die Stadtteile Innenstadt, Alterlangen,
Ost, Süd, Anger/Bruck und Büchenbach besteht je ein Stadtteilbeirat" — und
keine Grenzen. Auch auf erlangen.de steht keine Gebietsbeschreibung. Die
einzige amtliche Geometrie ist das Open-Data-Shapefile **von 2015**, und das
trägt Arbeitsnamen (`SB Zentrum/Nord`, `SB West`, `SB Regnitz`, `SB Süd-Ost`),
weil die Stadtteilbeiräte erst am 27.07.2016 beschlossen wurden.

Die Übersetzung dieser Arbeitsnamen auf die heutigen steht in
`tools/fetch_geodata.py` (`BEIRAT_NAMEN`) und ist dort einzeln begründet.
Vier Zuordnungen sind durch den Inhalt erzwungen (SB West enthält die
Büchenbach-Bezirke, SB Regnitz die Alterlangen-Bezirke, …), `SB Süd-Ost` →
Süd ist zusätzlich extern bestätigt (Rathenau, Röthelheim, Sebaldus).

**Belege für die Umrechnung und die Zuordnung** — beides wurde gegen
unabhängige Quellen geprüft, nicht nur plausibel gemacht:

| Prüfung | Ergebnis |
|---|---|
| Umgerechnete Bezirksgrenzen vs. amtliches Straßenverzeichnis (über OSM-Geometrie) | 87,5 % exakt gleicher Bezirk, 0,5 % Nachbarbezirk, Rest außerhalb der bebauten Bezirke |
| Verschnitt Bezirke × Beiratsgebiete, geprüft an den eindeutig benannten Ortsbeiräten | 7 von 7 zu 100 % korrekt (Bezirk 50 → OB Eltersdorf usw.) |
| Straße → Beirat, geometrisch vs. über den statistischen Bezirk | 99,2 % gleich; alle 7 Abweichungen in den drei Bezirken, die über eine Beiratsgrenze reichen |

**Die Zuordnung ist nicht überall eindeutig, und das ist keine Schwäche der
Methode, sondern die Wirklichkeit:** 37 Straßen verlaufen entlang einer
Gebietsgrenze (die Kurt-Schumacher-Straße liegt zu 52 % in Süd und zu 48 % in
Ost). Solche Straßen stehen in `beiraete` unter allen betroffenen Beiräten —
wer nach „Ost" filtert, soll sie sehen. Drei statistische Bezirke (04 Tal,
25 Stubenloh, 43 Forschungszentrum) liegen quer über Beiratsgrenzen; deshalb
läuft die Zuordnung über die Straßengeometrie und nicht über den Bezirk.

Stand: 871 Straßen eindeutig, 37 über eine Grenze, 6 ohne OSM-Geometrie.

## Offen

- **Aktualität der Beiratsgebiete.** Ob die Grenzen seit 2015 unverändert
  sind, lässt sich aus den veröffentlichten Daten nicht belegen. Dafür
  spricht, dass Zahl (13) und Zuschnitt der Ortsbeiratsgebiete exakt zur
  heutigen Satzung passen. Wer Gewissheit braucht, fragt bei Statistik und
  Stadtforschung nach einer aktuellen Fassung.
- **Satzung über Orts- und Stadtteilbeiräte (140.00)** fehlt in
  `recht/registry.json`; das auf erlangen.de verlinkte PDF liefert 404. Der
  Satzungstext ist aber über das Ratsinformationssystem erreichbar
  (Vorlage `kvonr=2133817`, Anlage „Satzungsentwurf").
