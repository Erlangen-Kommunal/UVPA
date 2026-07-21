// Einrichtungen, in deren Umfeld Tempo 30 nach § 45 Abs. 9 StVO leichter
// anzuordnen ist: Schulen, Kindergärten, soziale Einrichtungen, Spielplätze.
//
// Übernommen aus der kuratierten overpass-turbo-Abfrage der AG Mobilität;
// `leisure=playgound` war dort ein Tippfehler und lieferte nichts — hier
// korrigiert zu `playground`.
//
// `out center` genügt: für die Karte reicht je Einrichtung ein Punkt, die
// Gebäudeumrisse tragen nichts zur Aussage bei und wären ein Vielfaches an
// Datenvolumen.

[out:json][timeout:180][bbox:49.52,10.92,49.65,11.10];
(
  nwr["amenity"="social_facility"];
  nwr["amenity"="kindergarten"];
  nwr["amenity"="school"];
  nwr["leisure"="playground"];
);
out center tags;
