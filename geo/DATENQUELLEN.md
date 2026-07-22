# Programmierbare Datenquellen für Karte und Auswertung

Recherche vom **2026-07-22** für UVPA und SBR-Büchenbach. Ausgangspunkt war die
Frage, was es neben Overpass/OSM noch an frei programmierbaren Quellen gibt.

**Lesehilfe.** „geprüft" heißt: an diesem Tag selbst abgefragt, Statuscode und
CORS-Header gemessen, Lizenz aus der Quelle selbst gelesen (nicht aus zweiter
Hand). Alles andere ist ausdrücklich als offen markiert.

CORS wurde jeweils mit `Origin: https://erlangen-kommunal.github.io` gemessen —
das ist entscheidend, weil manche Dienste den Header nur bei gesetztem Origin
senden. Für reine Leaflet-Kachel-Layer (`<img>`) braucht es CORS übrigens nicht;
nötig wird es erst bei `fetch`/Canvas-Zugriff.

---

## Im Einsatz

| Quelle | Lizenz | CORS | Anmerkung |
|---|---|---|---|
| **Overpass API** (`overpass-api.de/api/interpreter`) | ODbL (OSM) | `*` | Tempo-30-Netz, Einrichtungen. Spiegel `kumi.systems`, `osm.ch` als Ausweichweg — der Hauptserver quittiert Last mit 504/429. |
| **basemap.de WMTS** (`sgx.geodatenzentrum.de`) | Datenlizenz Deutschland | Origin-Echo | Amtliche Grundkarte, grau und farbig. |
| **Stadt Erlangen Open Data** (`erlangen.de/aktuelles/opendata`) | dl-de/by-2.0 | — | Amtliches Straßenverzeichnis, statistische Bezirke, Beiratsgeometrie. Wird zur Bauzeit geholt, nicht zur Laufzeit. |
| **Bayerische Vermessungsverwaltung — DOP40** (`geoservices.bayern.de/od/wms/dop/v1/dop40`, Layer `by_dop40c`) | **CC BY 4.0**, kostenfrei | Origin-Echo | Luftbild 40 cm. Seit 2026-07-22 als Leaflet-WMS-Layer eingebunden. |
| **Bayerische Vermessungsverwaltung — ALKIS-Parzellarkarte** (`…/od/wms/alkis/v1/parzellarkarte`, Layer `by_alkis_parzellarkarte_umr_gelb`) | **CC BY 4.0**, kostenfrei | Origin-Echo | Flurstücksumringe, für große Maßstäbe gezeichnet (ab Zoom 16 sinnvoll). |

Beide Bayern-Dienste liefern **EPSG:3857** und sind damit ohne Umprojektion
Leaflet-tauglich. Lizenz und Gebührenfreiheit stehen im GetCapabilities-Dokument
unter `AccessConstraints` bzw. `Fees` — dort nachlesen, nicht anderswo.

Weitere Layer im selben Namensraum `…/od/wms/alkis/v1/`: `verwaltungsgrenzen`,
`tn` (tatsächliche Nutzung). Gleiches Muster, vermutlich gleiche Lizenz —
**nicht geprüft**.

---

## Geprüft und geeignet, noch nicht eingebaut

**OpenRailwayMap** — Schieneninfrastruktur aus OSM.
- Kacheln `https://a.tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png` → HTTP 200, `image/png`, CORS `*`
- API `https://api.openrailwaymap.org/v2/facility?q=Erlangen` → HTTP 200, JSON, CORS `*`
- Lizenz ODbL (OSM-Ableitung)
- Nützlich für Bahnthemen (StUB, Aurachtalbahn, Bahnübergänge), die im UVPA
  regelmäßig vorkommen. Als zusätzlicher Overlay-Layer einzubinden — die
  Mechanik dafür steht seit dem Kartenumbau bereit.

**VGN Open Data** — Fahrplandaten des Verkehrsverbunds.
- `https://www.vgn.de/opendata/GTFS.zip` → HTTP 200, 14,6 MB, kein Schlüssel, keine Registrierung
- Lizenz laut `Nutzungsbedingungen.txt` Ziffer 5(3): **CC BY-SA 3.0 DE**,
  kommerziell und nicht kommerziell
- **Wichtig: ausdrücklich nur Soll-Fahrplandaten.** Der VGN veröffentlicht hier
  keine Echtzeit- oder Verspätungsdaten.
- Achtung Copyleft: CC BY-SA verlangt Weitergabe abgeleiteter Daten unter
  gleichen Bedingungen — vor einer Verknüpfung mit anders lizenzierten Daten
  prüfen.
- Die richtige Adresse ist `www.vgn.de/opendata/`. **`opendata.vgn.de` existiert
  nicht** (DNS-Fehler) — diese Fehlannahme kostet sonst Zeit.

---

## Geprüft, aber mit Einschränkung

**gtfs.de** — deutschlandweite GTFS-Aggregation (Fern-, Regional-, Nahverkehr).
Erreichbar (HTTP 200). Die Basisversion ist kostenfrei, aber **zeitlich
begrenzt gültig**, erweiterte Fassungen sind kostenpflichtig; eine ausdrückliche
Lizenzangabe nennt die Seite nicht. Für den VGN-Raum ist die VGN-Quelle oben
klarer lizenziert und damit vorzuziehen.

**Zensus 2022 Atlas** (`atlas.zensus2022.de`) — kleinräumige Bevölkerungsdaten
im 100-m-Raster. Erreichbar, aber **ohne CORS-Header**: aus dem Browser heraus
nicht direkt abrufbar. Das ist kein Ausschlussgrund — das Projekt holt Geodaten
ohnehin zur Bauzeit über `tools/fetch_geodata.py` und legt sie ins Repo. Lizenz
noch offen.

**Bayerisches Landesamt für Statistik, Genesis**
(`statistikdaten.bayern.de/genesis/online`) — erreichbar. Genesis hat
üblicherweise eine SOAP/REST-Schnittstelle, teils mit Registrierung. Weder
Schnittstelle noch Lizenz geprüft.

---

## Gesucht und nicht gefunden

**Verspätungsdaten ESTW/VAG.** Für die Erlanger Stadtwerke bzw. die VAG ist
**keine offene Echtzeit- oder Verspätungsschnittstelle auffindbar**. Der VGN
schließt Echtzeitdaten in seinem Open-Data-Angebot ausdrücklich aus (siehe oben).
Wer das weiterverfolgen will, muss direkt bei ESTW/VGN anfragen; auf gut Glück
implementieren lohnt nicht.

**ALKIS-Flurkarte mit Beschriftung.** Nur die Parzellarkarte ist im
OpenData-Namensraum (`/od/`) gefunden worden. Die vollständige Flurkarte liegt
unter `/pro/` und ist damit vermutlich zugangsbeschränkt — nicht geprüft.

---

## Sackgassen, die man sich sparen kann

- **`atlas.bayern.de` einbetten** geht nicht: `X-Frame-Options: DENY`. Der
  BayernAtlas ist ausschließlich als Deeplink brauchbar. Die darunterliegenden
  WMS-Dienste sind dagegen frei einbettbar — sie sind der richtige Weg.
- **`opendata.vgn.de`** und **`open.erlangen.de`** existieren beide nicht (DNS).
- **Overpass ohne `Origin`-Header testen**: dann fehlen die CORS-Header in der
  Antwort, obwohl der Dienst CORS beherrscht. `curl` ohne Origin führt hier in
  die Irre.
- **Geratene WMS-Pfade** bei `geoservices.bayern.de`: `alkis/v1/alkis`,
  `alkis/v1/flurstueck`, `alkis/v1/adv` liefern HTTP 500, `dfk/v1/dfk`,
  `inspire/cp/v1/cp` liefern 404. Der Namensraum ist `/od/wms/<thema>/v1/<name>`
  mit einem *sprechenden* Namen (`parzellarkarte`, `verwaltungsgrenzen`, `tn`).
