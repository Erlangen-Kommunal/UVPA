using System.IO.Compression;
using System.Text;
using System.Xml.Linq;

namespace GraphBuilder;

/// <summary>
/// Textextraktion aus XLSX-Dateien.
///
/// Warum das hier steht: Das Ratsinformationssystem liefert einzelne Anlagen mit
/// der Endung <c>.pdf</c> aus, die in Wahrheit Excel-Arbeitsmappen sind (erkennbar
/// an der ZIP-Signatur <c>PK\x03\x04</c>). Betroffen sind Haushalts- und
/// Abstimmungslisten — also gerade Dokumente mit belastbarem Zahlenwerk. Ohne
/// diesen Weg blieben sie ohne Volltext und damit unauffindbar.
///
/// Bewusst schlank gehalten: nur <c>sharedStrings.xml</c> und die Zellwerte der
/// Arbeitsblätter, keine Formeln, keine Formatierung. Für die Volltextsuche
/// reicht das.
/// </summary>
public static class SheetText
{
    private static readonly XNamespace Ns =
        "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

    /// <summary>Prüft die Magic Bytes — ZIP-Signatur heißt hier: Office-Datei, kein PDF.</summary>
    public static bool IstZipContainer(string path)
    {
        try
        {
            using var fs = File.OpenRead(path);
            Span<byte> head = stackalloc byte[4];
            return fs.Read(head) == 4 && head[0] == 0x50 && head[1] == 0x4B
                   && head[2] == 0x03 && head[3] == 0x04;
        }
        catch { return false; }
    }

    /// <summary>
    /// Liefert (Text, Blattzahl). Blätter sind wie bei den PDF-Seiten mit '\f'
    /// getrennt, damit das Frontend sie gleich behandeln kann.
    /// </summary>
    public static (string Text, int Sheets) Extract(string path)
    {
        try
        {
            using var zip = ZipFile.OpenRead(path);

            // sharedStrings.xml hält die Texte; die Zellen verweisen per Index darauf.
            var shared = new List<string>();
            var sst = zip.GetEntry("xl/sharedStrings.xml");
            if (sst is not null)
            {
                using var s = sst.Open();
                foreach (var si in XDocument.Load(s).Root!.Elements(Ns + "si"))
                    shared.Add(string.Concat(si.Descendants(Ns + "t").Select(t => t.Value)));
            }

            var sb = new StringBuilder();
            var blaetter = 0;
            foreach (var entry in zip.Entries
                         .Where(e => e.FullName.StartsWith("xl/worksheets/sheet", StringComparison.Ordinal)
                                     && e.FullName.EndsWith(".xml", StringComparison.Ordinal))
                         .OrderBy(e => e.FullName, StringComparer.Ordinal))
            {
                blaetter++;
                if (sb.Length >= PdfText.MaxChars) continue;
                if (blaetter > 1) sb.Append('\f');

                using var s = entry.Open();
                foreach (var zeile in XDocument.Load(s).Descendants(Ns + "row"))
                {
                    var werte = new List<string>();
                    foreach (var c in zeile.Elements(Ns + "c"))
                    {
                        var v = c.Element(Ns + "v")?.Value;
                        // t="s" = Verweis in sharedStrings, t="inlineStr" = Text in der Zelle
                        var text = (string?)c.Attribute("t") switch
                        {
                            "s" when int.TryParse(v, out var i) && i >= 0 && i < shared.Count => shared[i],
                            "inlineStr" => string.Concat(c.Descendants(Ns + "t").Select(t => t.Value)),
                            _ => v,
                        };
                        if (!string.IsNullOrWhiteSpace(text)) werte.Add(text.Trim());
                    }
                    if (werte.Count > 0) sb.Append(string.Join(" | ", werte)).Append('\n');
                }
            }

            var txt = sb.Length > PdfText.MaxChars ? sb.ToString(0, PdfText.MaxChars) : sb.ToString();
            return (string.IsNullOrWhiteSpace(txt) ? "" : txt, blaetter);
        }
        catch
        {
            // Kein lesbares XLSX (z. B. DOCX oder beschädigt): Dokument bleibt ohne Volltext.
            return ("", 0);
        }
    }
}
