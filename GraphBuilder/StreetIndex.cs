using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace GraphBuilder;

/// <summary>Ein Eintrag aus dem amtlichen Straßenverzeichnis (geo/strassen.json).</summary>
public sealed class StreetRecord
{
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("schluessel")] public string Schluessel { get; set; } = "";
    [JsonPropertyName("bezirke")] public List<Bezirk> Bezirke { get; set; } = [];
}

public sealed class Bezirk
{
    [JsonPropertyName("nr")] public string Nr { get; set; } = "";
    [JsonPropertyName("name")] public string Name { get; set; } = "";

    public override string ToString() => $"{Nr} {Name}";
}

public sealed class StreetDirectory
{
    [JsonPropertyName("stand")] public string Stand { get; set; } = "";
    [JsonPropertyName("bezirke")] public List<Bezirk> Bezirke { get; set; } = [];
    [JsonPropertyName("strassen")] public List<StreetRecord> Strassen { get; set; } = [];
}

/// <summary>
/// Findet Erlanger Straßennamen im Volltext — Namensautorität ist das amtliche
/// Straßenverzeichnis der Stadt (geo/strassen.json), nicht OpenStreetMap.
///
/// Gesucht wird über Wort-n-Gramme statt per Teilstring: „Am Anger“ darf nicht
/// in „Am Angerweg“ anschlagen und „Siedlung“ ist gar kein Straßenname. Der
/// längste Name im Verzeichnis hat vier Wörter („An der Weißen Marter“),
/// entsprechend weit wird das Fenster aufgezogen.
/// </summary>
public sealed partial class StreetIndex
{
    // Wort = beginnt mit einem Buchstaben, darf Ziffern, Punkt und Bindestrich
    // enthalten ("Werner-von-Siemens-Straße", "St. Johann").
    [GeneratedRegex(@"[A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß0-9.\-]*")]
    private static partial Regex TokenRegex();

    // Briefkopf-Erkennung: direkt hinter dem Straßennamen folgen Hausnummer und
    // Postleitzahl ("Rathausplatz 1 91052 Erlangen"). Solche Fundstellen sind
    // die Absenderadresse der Stadt oder einer Fraktion und kein Sachbezug —
    // ohne diesen Filter führte allein „Rathausplatz“ 571 Dokumente statt 192.
    [GeneratedRegex(@"^[\s,]*\d{1,3}\s*[a-zA-Z]?[\s,]*9\d{4}\b")]
    private static partial Regex AddressTailRegex();

    private const int AddressLookahead = 16;

    private readonly Dictionary<string, StreetRecord> _byName;
    private readonly HashSet<string> _firstWords;
    private readonly int _maxWords;

    public string Stand { get; }
    public IReadOnlyCollection<StreetRecord> Streets => _byName.Values;

    private StreetIndex(StreetDirectory dir)
    {
        Stand = dir.Stand;
        _byName = new Dictionary<string, StreetRecord>(StringComparer.Ordinal);
        foreach (var s in dir.Strassen)
        {
            var name = Normalize(s.Name);
            if (name.Length == 0)
                continue;
            // Normalisierte Schreibweise zurückschreiben: Knoten-IDs, streets-Tabelle
            // und die OSM-Namen auf der Karte müssen zeichengenau zusammenpassen.
            s.Name = name;
            _byName[name] = s;
        }
        // Nur wenn das aktuelle Wort ein Straßenname beginnen kann, wird
        // überhaupt ein n-Gramm gebaut — das spart den Großteil der Arbeit.
        _firstWords = [.. _byName.Keys.Select(n => n.Split(' ')[0])];
        _maxWords = _byName.Keys.Max(n => n.Count(c => c == ' ') + 1);
    }

    /// <summary>Lädt geo/strassen.json; null, wenn die Datei fehlt (Abruf noch nicht gelaufen).</summary>
    public static StreetIndex? Load(string repoRoot)
    {
        var path = Path.Combine(repoRoot, "geo", "strassen.json");
        if (!File.Exists(path))
        {
            Console.WriteLine($"Hinweis: {path} nicht gefunden — Straßen-Verknüpfung übersprungen " +
                              "(tools/fetch_geodata.py erzeugt die Datei).");
            return null;
        }
        var dir = JsonSerializer.Deserialize<StreetDirectory>(File.ReadAllText(path, Encoding.UTF8));
        return dir is { Strassen.Count: > 0 } ? new StreetIndex(dir) : null;
    }

    private static string Normalize(string s) => s.Normalize(NormalizationForm.FormC).Trim();

    /// <summary>
    /// Alle im Text genannten Straßen (dedupliziert). Absenderadressen in
    /// Briefköpfen zählen nicht mit.
    /// </summary>
    public HashSet<string> Find(string text)
    {
        var found = new HashSet<string>(StringComparer.Ordinal);
        if (string.IsNullOrEmpty(text))
            return found;

        var tokens = TokenRegex().Matches(text);
        var words = new string[tokens.Count];
        for (var i = 0; i < tokens.Count; i++)
            words[i] = tokens[i].Value;

        var sb = new StringBuilder(64);
        for (var i = 0; i < words.Length; i++)
        {
            if (!_firstWords.Contains(words[i]))
                continue;
            sb.Clear();
            for (var n = 0; n < _maxWords && i + n < words.Length; n++)
            {
                if (n > 0)
                    sb.Append(' ');
                sb.Append(words[i + n]);
                var candidate = sb.ToString();
                if (!_byName.ContainsKey(candidate))
                    continue;

                var last = tokens[i + n];
                var tailStart = last.Index + last.Length;
                var tailLength = Math.Min(AddressLookahead, text.Length - tailStart);
                if (tailLength > 0 &&
                    AddressTailRegex().IsMatch(text.AsSpan(tailStart, tailLength).ToString()))
                    continue;  // Briefkopf, kein Sachbezug

                found.Add(candidate);
            }
        }
        return found;
    }
}
