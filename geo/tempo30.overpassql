// Tempo-30-Datenabruf für Erlangen (OpenStreetMap via Overpass-API)
//
// Grundlage: eine kuratierte overpass-turbo-Abfrage aus der AG Mobilität.
// Für den automatisierten Abruf angepasst — die Unterschiede zum Original:
//
//   1. Das Original setzte zwar `area[name="Erlangen"]`, filterte aber nie
//      damit (kein `(area.a)` an den Statements). Faktisch begrenzte allein
//      der Kartenausschnitt `{{bbox}}` das Ergebnis. Hier wird stattdessen
//      eine feste Bounding-Box über das Stadtgebiet gelegt (siehe unten) —
//      reproduzierbar und deutlich schneller als die Area-Auflösung.
//   2. `leisure=playgound` war ein Tippfehler und fand nichts → `playground`.
//   3. `{{bbox}}` und `{{style:…}}` sind overpass-turbo-Platzhalter und kein
//      Overpass-QL; das Einfärben übernimmt hier die Karte im Frontend.
//
// Die Box umfasst das Stadtgebiet großzügig (Dechsendorf im Nordwesten bis
// Tennenlohe im Süden) und greift damit über die Stadtgrenze hinaus. Das ist
// gewollt: Straßen an der Gemeindegrenze gehören zum Bild dazu.
//
// Bedeutung der Klassen im Frontend:
//   maxspeed=30              → Tempo 30
//   maxspeed=20              → Tempo 20
//   highway=living_street    → verkehrsberuhigter Bereich (Spielstraße)
//   maxspeed:conditional     → nur zeitweise begrenzt (z. B. vor Schulen)
//
// Die Einrichtungen (Schulen, Kitas, soziale Einrichtungen, Spielplätze) sind
// der Grund, warum Tempo 30 nach der StVO-Novelle leichter anzuordnen ist —
// deshalb werden sie mit erfasst und auf der Karte angezeigt.

[out:json][timeout:180][bbox:49.52,10.92,49.65,11.10];
(
  way["maxspeed"="30"];
  way["maxspeed"="20"];
  way["maxspeed:conditional"];
  way["highway"="living_street"];
);
out body geom;
