// Program.cs — Protokoll: Logging-Dienst Installation auf Fedora Linux VM
// Color: Tech Protocol — cool slate blue-gray, technical and professional

using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Wordprocessing;
using DW = DocumentFormat.OpenXml.Drawing.Wordprocessing;
using A = DocumentFormat.OpenXml.Drawing;
using PIC = DocumentFormat.OpenXml.Drawing.Pictures;

namespace Docx;

public class Program
{
    private static class Colors
    {
        public const string Primary = "3d5a80";
        public const string Secondary = "5c7a99";
        public const string Accent = "98b4c6";
        public const string Dark = "2b3a4e";
        public const string Mid = "4a5d70";
        public const string Light = "7a8fa0";
        public const string Border = "dce2e8";
        public const string TableHeader = "e8ecf0";
        public const string CodeBg = "f0f2f5";
    }

    private const int A4W = 11906;
    private const int A4H = 16838;
    private const long A4WE = 7560000L;
    private const long A4HE = 10692000L;

    private static uint _docPrId = 1;
    private static int _bookmarkId = 0;

    public static void Main(string[] args)
    {
        string outputFile = args.Length > 0 ? args[0] : "/mnt/agents/output/Protokoll_Logging_Dienst.docx";
        string bgDir = "/mnt/agents/output";
        string imgDir = "/mnt/agents/upload";

        using var doc = WordprocessingDocument.Create(outputFile, WordprocessingDocumentType.Document);
        var mainPart = doc.AddMainDocumentPart();
        mainPart.Document = new Document(new Body());
        var body = mainPart.Document.Body!;

        AddStyles(mainPart);
        AddNumbering(mainPart);

        var coverBgId = AddImage(mainPart, Path.Combine(bgDir, "cover_bg.png"));
        var backBgId = AddImage(mainPart, Path.Combine(bgDir, "backcover_bg.png"));

        AddCoverSection(body, coverBgId);
        AddTocSection(body);
        AddContentSection(doc, body, mainPart, bgDir, imgDir);
        AddBackcoverSection(body, backBgId);

        SetUpdateFieldsOnOpen(mainPart);
        doc.Save();
        Console.WriteLine($"Document generated: {outputFile}");
    }

    private static void AddStyles(MainDocumentPart mainPart)
    {
        var sp = mainPart.AddNewPart<StyleDefinitionsPart>();
        sp.Styles = new Styles();

        sp.Styles.Append(new Style(
            new StyleName { Val = "Normal" },
            new StyleParagraphProperties(
                new SpacingBetweenLines { After = "180", Line = "300", LineRule = LineSpacingRuleValues.Auto }),
            new StyleRunProperties(
                new RunFonts { Ascii = "Calibri", HighAnsi = "Calibri", EastAsia = "Microsoft YaHei" },
                new FontSize { Val = "22" },
                new Color { Val = Colors.Dark })
        ) { Type = StyleValues.Paragraph, StyleId = "Normal", Default = true });

        sp.Styles.Append(CreateHeadingStyle("Heading1", "heading 1", 0, "36", Colors.Primary, "480", "200"));
        sp.Styles.Append(CreateHeadingStyle("Heading2", "heading 2", 1, "28", Colors.Dark, "360", "140"));
        sp.Styles.Append(CreateHeadingStyle("Heading3", "heading 3", 2, "24", Colors.Mid, "240", "100"));

        sp.Styles.Append(new Style(
            new StyleName { Val = "Caption" }, new BasedOn { Val = "Normal" },
            new StyleParagraphProperties(
                new Justification { Val = JustificationValues.Center },
                new SpacingBetweenLines { Before = "60", After = "280" }),
            new StyleRunProperties(new Color { Val = Colors.Light }, new FontSize { Val = "20" }, new Italic())
        ) { Type = StyleValues.Paragraph, StyleId = "Caption" });

        sp.Styles.Append(new Style(
            new StyleName { Val = "Code" }, new BasedOn { Val = "Normal" },
            new StyleParagraphProperties(
                new Shading { Val = ShadingPatternValues.Clear, Fill = Colors.CodeBg },
                new SpacingBetweenLines { Before = "80", After = "80", Line = "260" },
                new Indentation { Left = "360", Right = "360" }),
            new StyleRunProperties(
                new RunFonts { Ascii = "Consolas", HighAnsi = "Consolas" },
                new FontSize { Val = "18" },
                new Color { Val = Colors.Dark })
        ) { Type = StyleValues.Paragraph, StyleId = "Code" });

        sp.Styles.Append(CreateTocStyle("TOC1", "toc 1", true, "0", "200"));
        sp.Styles.Append(CreateTocStyle("TOC2", "toc 2", false, "360", "60"));
        sp.Styles.Append(CreateTocStyle("TOC3", "toc 3", false, "720", "40"));
    }

    private static Style CreateHeadingStyle(string id, string name, int level, string fontSize, string color, string spaceBefore, string spaceAfter)
    {
        return new Style(
            new StyleName { Val = name }, new BasedOn { Val = "Normal" },
            new StyleParagraphProperties(
                new KeepNext(), new KeepLines(),
                new SpacingBetweenLines { Before = spaceBefore, After = spaceAfter },
                new OutlineLevel { Val = level }),
            new StyleRunProperties(
                new Bold(), new FontSize { Val = fontSize },
                new RunFonts { Ascii = "Calibri", HighAnsi = "Calibri", EastAsia = "Microsoft YaHei" },
                new Color { Val = color })
        ) { Type = StyleValues.Paragraph, StyleId = id };
    }

    private static Style CreateTocStyle(string id, string name, bool bold, string indent, string before)
    {
        var rpr = new StyleRunProperties(new Color { Val = bold ? Colors.Dark : Colors.Mid });
        if (bold) rpr.Append(new Bold());
        return new Style(
            new StyleName { Val = name }, new BasedOn { Val = "Normal" },
            new StyleParagraphProperties(
                new Tabs(new TabStop { Val = TabStopValues.Right, Leader = TabStopLeaderCharValues.Dot, Position = 9350 }),
                new SpacingBetweenLines { Before = before, After = "60" },
                new Indentation { Left = indent }),
            rpr
        ) { Type = StyleValues.Paragraph, StyleId = id };
    }

    private static void AddNumbering(MainDocumentPart mp)
    {
        var np = mp.AddNewPart<NumberingDefinitionsPart>();
        np.Numbering = new Numbering(
            new AbstractNum(new Level(
                new NumberingFormat { Val = NumberFormatValues.Decimal },
                new LevelText { Val = "%1." },
                new LevelJustification { Val = LevelJustificationValues.Left },
                new ParagraphProperties(new Indentation { Left = "720", Hanging = "360" })
            ) { LevelIndex = 0 }) { AbstractNumberId = 1 },
            new NumberingInstance(new AbstractNumId { Val = 1 }) { NumberID = 1 });
    }

    // ==================== COVER ====================
    private static void AddCoverSection(Body body, string coverBgId)
    {
        body.Append(new Paragraph(new Run(CreateFloatingBackground(coverBgId, _docPrId++, "CoverBg"))));
        body.Append(new Paragraph(new ParagraphProperties(new SpacingBetweenLines { Before = "5500" }), new Run()));

        body.Append(new Paragraph(
            new ParagraphProperties(
                new Justification { Val = JustificationValues.Left },
                new Indentation { Left = "1200", Right = "1200" },
                new SpacingBetweenLines { After = "200" }),
            new Run(new RunProperties(
                    new FontSize { Val = "72" }, new Bold(),
                    new Color { Val = Colors.Dark },
                    new Spacing { Val = 30 }),
                new Text("Protokoll"))));

        body.Append(new Paragraph(
            new ParagraphProperties(
                new Justification { Val = JustificationValues.Left },
                new Indentation { Left = "1200", Right = "1200" },
                new SpacingBetweenLines { After = "400" }),
            new Run(new RunProperties(
                    new FontSize { Val = "32" },
                    new Color { Val = Colors.Primary }),
                new Text("Installation und Konfiguration eines Logging-Dienstes"))));

        body.Append(new Paragraph(
            new ParagraphProperties(
                new Justification { Val = JustificationValues.Left },
                new Indentation { Left = "1200", Right = "1200" },
                new SpacingBetweenLines { After = "3000" }),
            new Run(new RunProperties(
                    new FontSize { Val = "22" },
                    new Color { Val = Colors.Mid }),
                new Text("Aufzeichnung und Analyse von Daemon-Ereignissen auf einer Fedora KDE Linux VM"))));

        body.Append(new Paragraph(
            new ParagraphProperties(new Indentation { Left = "1200" }),
            new Run(new RunProperties(new FontSize { Val = "20" }, new Color { Val = Colors.Light }),
                new Text("11. Mai 2026"))));

        body.Append(new Paragraph(new ParagraphProperties(new SectionProperties(
            new TitlePage(),
            new SectionType { Val = SectionMarkValues.NextPage },
            new PageSize { Width = (UInt32Value)(uint)A4W, Height = (UInt32Value)(uint)A4H },
            new PageMargin { Top = 0, Right = 0, Bottom = 0, Left = 0, Header = 0, Footer = 0 }))));
    }

    // ==================== TOC ====================
    private static void AddTocSection(Body body)
    {
        body.Append(CreateHeading1("Inhaltsverzeichnis", "_Toc000"));

        body.Append(new Paragraph(
            new ParagraphProperties(new SpacingBetweenLines { After = "300" }),
            new Run(new RunProperties(new Color { Val = Colors.Light }, new FontSize { Val = "18" }),
                new Text("Rechtsklick auf das Inhaltsverzeichnis und \"Felder aktualisieren\" w\u00e4hlen"))));

        body.Append(new Paragraph(
            new Run(new FieldChar { FieldCharType = FieldCharValues.Begin }),
            new Run(new FieldCode(" TOC \\o \"1-3\" \\h \\z \\u ") { Space = SpaceProcessingModeValues.Preserve }),
            new Run(new FieldChar { FieldCharType = FieldCharValues.Separate })));

        string[,] toc = {
            { "Einleitung", "1", "3" },
            { "Theoretische Grundlagen", "1", "4" },
            { "rsyslog", "2", "4" },
            { "systemd-journald", "2", "4" },
            { "logrotate", "2", "5" },
            { "Durchf\u00fchrung", "1", "6" },
            { "Schritt 1: Pr\u00fcfung des rsyslog-Dienstes", "2", "6" },
            { "Schritt 2: Pr\u00fcfung von systemd-journald", "2", "6" },
            { "Schritt 3: Analyse der Logrotate-Konfiguration", "2", "7" },
            { "Schritt 4: rsyslog-Konfiguration f\u00fcr Daemon-Logs", "2", "7" },
            { "Schritt 5: Logrotate-Konfiguration f\u00fcr Daemon-Logs", "2", "8" },
            { "Schritt 6: Neustart von rsyslog", "2", "8" },
            { "Schritt 7: Test der Konfiguration", "2", "9" },
            { "Schritt 8: Pr\u00fcfung der Logrotation", "2", "9" },
            { "Schritt 9: Analyse des Speicherverbrauchs", "2", "10" },
            { "Pers\u00f6nliche Erfahrungen", "1", "11" },
            { "Fazit", "1", "12" }
        };
        for (int i = 0; i < toc.GetLength(0); i++)
            body.Append(new Paragraph(
                new ParagraphProperties(new ParagraphStyleId { Val = $"TOC{toc[i, 1]}" }),
                new Run(new Text(toc[i, 0])), new Run(new TabChar()), new Run(new Text(toc[i, 2]))));

        body.Append(new Paragraph(new Run(new FieldChar { FieldCharType = FieldCharValues.End })));

        body.Append(new Paragraph(new ParagraphProperties(new SectionProperties(
            new SectionType { Val = SectionMarkValues.NextPage },
            new PageSize { Width = (UInt32Value)(uint)A4W, Height = (UInt32Value)(uint)A4H },
            new PageMargin { Top = 1800, Right = 1440, Bottom = 1440, Left = 1440, Header = 720, Footer = 720 }))));
    }


    // ==================== CONTENT ====================
    private static void AddContentSection(WordprocessingDocument doc, Body body, MainDocumentPart mainPart, string bgDir, string imgDir)
    {
        // Header
        var headerPart = mainPart.AddNewPart<HeaderPart>();
        var headerId = mainPart.GetIdOfPart(headerPart);
        var bodyBgPath = Path.Combine(bgDir, "body_bg.png");
        if (File.Exists(bodyBgPath))
        {
            var headerImagePart = headerPart.AddImagePart(ImagePartType.Png);
            using (var stream = new FileStream(bodyBgPath, FileMode.Open))
                headerImagePart.FeedData(stream);
            var headerImageId = headerPart.GetIdOfPart(headerImagePart);
            headerPart.Header = new Header(
                new Paragraph(new Run(CreateFloatingBackground(headerImageId, _docPrId++, "BodyBg"))),
                new Paragraph(
                    new ParagraphProperties(new Justification { Val = JustificationValues.Right }),
                    new Run(new RunProperties(new FontSize { Val = "18" }, new Color { Val = Colors.Light }),
                        new Text("Protokoll \u2014 Logging-Dienst Installation"))));
        }
        else
        {
            headerPart.Header = new Header(new Paragraph(
                new ParagraphProperties(new Justification { Val = JustificationValues.Right }),
                new Run(new RunProperties(new FontSize { Val = "18" }, new Color { Val = Colors.Light }),
                    new Text("Protokoll \u2014 Logging-Dienst Installation"))));
        }

        // Footer with page numbers
        var footerPart = mainPart.AddNewPart<FooterPart>();
        var footerId = mainPart.GetIdOfPart(footerPart);
        var fp = new Paragraph(new ParagraphProperties(new Justification { Val = JustificationValues.Center }));
        fp.Append(new Run(new RunProperties(new FontSize { Val = "18" }, new Color { Val = Colors.Light }),
            new FieldChar { FieldCharType = FieldCharValues.Begin }));
        fp.Append(new Run(new RunProperties(new FontSize { Val = "18" }, new Color { Val = Colors.Light }),
            new FieldCode(" PAGE ") { Space = SpaceProcessingModeValues.Preserve }));
        fp.Append(new Run(new RunProperties(new FontSize { Val = "18" }, new Color { Val = Colors.Light }),
            new FieldChar { FieldCharType = FieldCharValues.Separate }));
        fp.Append(new Run(new RunProperties(new FontSize { Val = "18" }, new Color { Val = Colors.Light }),
            new Text("1")));
        fp.Append(new Run(new RunProperties(new FontSize { Val = "18" }, new Color { Val = Colors.Light }),
            new FieldChar { FieldCharType = FieldCharValues.End }));
        fp.Append(new Run(new RunProperties(new FontSize { Val = "18" }, new Color { Val = Colors.Light }),
            new Text(" / ") { Space = SpaceProcessingModeValues.Preserve }));
        fp.Append(new Run(new RunProperties(new FontSize { Val = "18" }, new Color { Val = Colors.Light }),
            new FieldChar { FieldCharType = FieldCharValues.Begin }));
        fp.Append(new Run(new RunProperties(new FontSize { Val = "18" }, new Color { Val = Colors.Light }),
            new FieldCode(" NUMPAGES ") { Space = SpaceProcessingModeValues.Preserve }));
        fp.Append(new Run(new RunProperties(new FontSize { Val = "18" }, new Color { Val = Colors.Light }),
            new FieldChar { FieldCharType = FieldCharValues.Separate }));
        fp.Append(new Run(new RunProperties(new FontSize { Val = "18" }, new Color { Val = Colors.Light }),
            new Text("1")));
        fp.Append(new Run(new RunProperties(new FontSize { Val = "18" }, new Color { Val = Colors.Light }),
            new FieldChar { FieldCharType = FieldCharValues.End }));
        footerPart.Footer = new Footer(fp);

        // ===== EINLEITUNG =====
        body.Append(CreateHeading1("1 Einleitung", "_Toc001"));
        body.Append(CreateParagraph("Die vorliegende Dokumentation beschreibt die Installation und Konfiguration eines Logging-Dienstes auf einer bestehenden Fedora KDE Linux Virtual Machine, die \u00fcber QEMU/KVM betrieben wird. Ziel ist es, diverse Ereignisse von Daemons systematisch aufzuzeichnen und f\u00fcr eine sp\u00e4tere Analyse verf\u00fcgbar zu machen."));
        body.Append(CreateParagraph("Die Aufgabenstellung umfasst dabei folgende zentrale Aspekte:"));
        body.Append(CreateBulletParagraph("Installation und Konfiguration eines geeigneten Logging-Dienstes"));
        body.Append(CreateBulletParagraph("Beachtung von Speicherverbrauchs-Problematiken"));
        body.Append(CreateBulletParagraph("Versionierung der Log-Dateien (Logrotation)"));
        body.Append(CreateBulletParagraph("Erhaltung der Log-Dateien f\u00fcr eine gewisse Zeit vor der L\u00f6schung"));
        body.Append(CreateParagraph("Als Grundlage dient eine Fedora 43 KDE-Spin-Installation in einer virtuellen Maschine mit Standardkonfiguration. Alle Arbeitsschritte wurden am 11. Mai 2026 durchgef\u00fchrt und mit Screenshots dokumentiert."));

        // ===== THEORETISCHE GRUNDLAGEN =====
        body.Append(CreateHeading1("2 Theoretische Grundlagen", "_Toc002"));

        body.Append(CreateHeading2("2.1 rsyslog"));
        body.Append(CreateParagraph("rsyslog ist ein leistungsf\u00e4higer Syslog-Daemon, der unter den meisten Linux-Distributionen als Standard-Logging-Dienst eingesetzt wird. Er bietet gegen\u00fcber dem klassischen sysklogd erhebliche Verbesserungen:"));
        body.Append(CreateBulletParagraph("Zuverl\u00e4ssige \u00dcbertragung \u00fcber das TCP-Protokoll (RELP)"));
        body.Append(CreateBulletParagraph("Content-based Filtering f\u00fcr Log-Nachrichten"));
        body.Append(CreateBulletParagraph("Konfigurierbare Output-Formate"));
        body.Append(CreateBulletParagraph("Datenbank-Unterst\u00fctzung (MySQL, PostgreSQL)"));
        body.Append(CreateBulletParagraph("Queueing-Mechanismen zur Speicherverwaltung"));
        body.Append(CreateParagraph("Die Konfiguration erfolgt \u00fcber die Datei /etc/rsyslog.conf sowie zus\u00e4tzliche .conf-Dateien im Verzeichnis /etc/rsyslog.d/. Die Regel-Syntax folgt dem Muster \"Selektor Aktion\", wobei der Selektor aus Facility (Nachrichtenkategorie) und Priority (Schweregrad) besteht."));

        body.Append(CreateHeading2("2.2 systemd-journald"));
        body.Append(CreateParagraph("systemd-journald ist der systemeigene Logging-Dienst von systemd, der Log-Daten im Bin\u00e4rformat in einer strukturierten Datenbank speichert. Er erg\u00e4nzt rsyslog und bietet:"));
        body.Append(CreateBulletParagraph("Strukturierte Log-Eintr\u00e4ge mit Metadaten"));
        body.Append(CreateBulletParagraph("Leistungsstarke Abfragem\u00f6glichkeiten \u00fcber journalctl"));
        body.Append(CreateBulletParagraph("Integrierte Speicherverwaltung mit konfigurierbaren Limits"));
        body.Append(CreateBulletParagraph("Persistente oder fl\u00fcchtige Speicherung m\u00f6glich"));
        body.Append(CreateParagraph("F\u00fcr die Langzeitarchivierung werden die Journal-Daten typischerweise an rsyslog weitergeleitet, welches die Nachrichten in Textdateien schreibt."));

        body.Append(CreateHeading2("2.3 logrotate"));
        body.Append(CreateParagraph("logrotate ist ein Standard-Tool unter Linux zur Verwaltung von Log-Dateien. Es automatisiert die Rotation, Komprimierung und L\u00f6schung alter Log-Dateien. Die Hauptfunktionen sind:"));
        body.Append(CreateBulletParagraph("Zeit- oder gr\u00f6\u00dfenbasierte Rotation (daily, weekly, monthly, size)"));
        body.Append(CreateBulletParagraph("Automatische Komprimierung mit gzip"));
        body.Append(CreateBulletParagraph("Aufbewahrung einer konfigurierbaren Anzahl alter Versionen"));
        body.Append(CreateBulletParagraph("Ausf\u00fchren von Post-Rotate-Skripten (z.B. zum Neustart des Dienstes)"));
        body.Append(CreateParagraph("Die Konfiguration erfolgt zentral in /etc/logrotate.conf und zus\u00e4tzlich in separaten Dateien unter /etc/logrotate.d/. Dies erm\u00f6glicht eine modulare Verwaltung je Anwendung."));

        // ===== DURCHFUEHRUNG =====
        body.Append(CreateHeading1("3 Durchf\u00fchrung", "_Toc003"));
        body.Append(CreateParagraph("Die nachfolgenden Abschnitte dokumentieren die einzelnen Arbeitsschritte in chronologischer Reihenfolge, jeweils mit den verwendeten Kommandos, erwarteten Ergebnissen und visuellen Belegen."));

        // Schritt 1
        body.Append(CreateHeading2("3.1 Schritt 1: Pr\u00fcfung des rsyslog-Dienstes"));
        body.Append(CreateParagraph("Zun\u00e4chst wurde der Status des rsyslog-Dienstes \u00fcberpr\u00fcft, um sicherzustellen, dass der Logging-Dienst auf dem System aktiv und ordnungsgem\u00e4\u00df konfiguriert ist:"));
        body.Append(CreateCodeParagraph("$ systemctl status rsyslog"));
        body.Append(CreateParagraph("Die Ausgabe zeigt, dass der Dienst erfolgreich geladen und aktiv ist. Besonders hervorzuheben sind die folgenden Informationen:"));
        body.Append(CreateBulletParagraph("Status: active (running) seit Mon 2026-05-11 17:15:39 CEST"));
        body.Append(CreateBulletParagraph("Version: rsyslogd v8.2508.0-1.fc43"));
        body.Append(CreateBulletParagraph("Speicherverbrauch: 3.2M (peak: 3.9M)"));
        body.Append(CreateBulletParagraph("PID: 982"));
        AddInlineImage(body, mainPart, Path.Combine(imgDir, "1.png"), "Screenshot 1: rsyslog Status", 14);
        body.Append(CreateCaption("Abbildung 1: Statusabfrage des rsyslog-Dienstes"));

        // Schritt 2
        body.Append(CreateHeading2("3.2 Schritt 2: Pr\u00fcfung von systemd-journald"));
        body.Append(CreateParagraph("Parallel wurde der systemd-journald-Dienst \u00fcberpr\u00fcft, der als erg\u00e4nzende Log-Quelle fungiert:"));
        body.Append(CreateCodeParagraph("$ systemctl status systemd-journald"));
        body.Append(CreateParagraph("Der Dienst ist als static-Dienst konfiguriert (immer aktiv) und zeigt folgende Kennwerte:"));
        body.Append(CreateBulletParagraph("Status: active (running), Processing requests..."));
        body.Append(CreateBulletParagraph("Speicherverbrauch: 43.3M (peak: 43.8M) \u2014 deutlich h\u00f6her als rsyslog"));
        body.Append(CreateBulletParagraph("PID: 548"));
        body.Append(CreateParagraph("Der deutlich h\u00f6here Speicherverbrauch im Vergleich zu rsyslog resultiert aus der Bin\u00e4rformat-Speicherung und der umfangreicheren Metadaten-Verwaltung im Journal."));
        AddInlineImage(body, mainPart, Path.Combine(imgDir, "2.png"), "Screenshot 2: journald Status", 14);
        body.Append(CreateCaption("Abbildung 2: Statusabfrage des systemd-journald-Dienstes"));

        // Schritt 3
        body.Append(CreateHeading2("3.3 Schritt 3: Analyse der bestehenden Logrotate-Konfiguration"));
        body.Append(CreateParagraph("Vor der Erstellung eigener Konfigurationen wurde die bestehende Logrotate-Konfiguration f\u00fcr Syslog-Dateien analysiert:"));
        body.Append(CreateCodeParagraph("$ sudo nano /etc/logrotate.d/syslog"));
        body.Append(CreateParagraph("Die bestehende Konfiguration verwaltet folgende Log-Dateien:"));
        body.Append(CreateBulletParagraph("/var/log/cron, /var/log/maillog, /var/log/messages, /var/log/secure, /var/log/spooler"));
        body.Append(CreateParagraph("Die Konfigurationsparameter sind:"));
        body.Append(CreateBulletParagraph("weekly \u2014 w\u00f6chentliche Rotation"));
        body.Append(CreateBulletParagraph("rotate 4 \u2014 Aufbewahrung von 4 Backups"));
        body.Append(CreateBulletParagraph("compress \u2014 Komprimierung alter Dateien"));
        body.Append(CreateBulletParagraph("delaycompress \u2014 Komprimierung erst bei n\u00e4chster Rotation"));
        body.Append(CreateBulletParagraph("missingok \u2014 keine Fehler bei fehlender Datei"));
        body.Append(CreateBulletParagraph("sharedscripts \u2014 Postrotate-Skript nur einmal ausf\u00fchren"));
        body.Append(CreateBulletParagraph("postrotate-Skript: Sendet HUP-Signal an rsyslog"));
        AddInlineImage(body, mainPart, Path.Combine(imgDir, "3.png"), "Screenshot 3: Logrotate Syslog Config", 14);
        body.Append(CreateCaption("Abbildung 3: Bestehende Logrotate-Konfiguration f\u00fcr Syslog"));

        // Schritt 4
        body.Append(CreateHeading2("3.4 Schritt 4: rsyslog-Konfiguration f\u00fcr Daemon-Logs"));
        body.Append(CreateParagraph("Um Daemon-Nachrichten separat zu protokollieren, wurde eine neue rsyslog-Konfigurationsdatei erstellt:"));
        body.Append(CreateCodeParagraph("$ sudo nano /etc/rsyslog.d/daemon.conf"));
        body.Append(CreateParagraph("Die Konfigurationsdatei enth\u00e4lt folgende Einstellungen:"));
        body.Append(CreateCodeParagraph("# Alle Daemon-Nachrichten in eigene Datei\ndaemon.*\t\t\t\t/var/log/daemon.log\n\n# Speicherverbrauch begrenzen - Queue-Konfiguration\n$ActionQueueSizeMaxLines 10000\n$ActionQueueHighWaterMark 8000\n$ActionQueueLowWaterMark 2000"));
        body.Append(CreateParagraph("Die Queue-Konfiguration begrenzt den Speicherverbrauch von rsyslog:"));
        body.Append(CreateBulletParagraph("$ActionQueueSizeMaxLines 10000 \u2014 maximale Queue-Gr\u00f6\u00dfe von 10.000 Zeilen"));
        body.Append(CreateBulletParagraph("$ActionQueueHighWaterMark 8000 \u2014 Oberer Schwellenwert f\u00fcr Flusskontrolle"));
        body.Append(CreateBulletParagraph("$ActionQueueLowWaterMark 2000 \u2014 Unterer Schwellenwert zum Wiederaufnehmen"));
        body.Append(CreateParagraph("Diese Werte stellen sicher, dass rsyslog auch bei hohem Log-Aufkommen den Speicherverbrauch kontrolliert h\u00e4lt."));
        AddInlineImage(body, mainPart, Path.Combine(imgDir, "5.png"), "Screenshot 5: rsyslog Daemon Config", 14);
        body.Append(CreateCaption("Abbildung 4: rsyslog-Konfiguration f\u00fcr Daemon-Logging"));

        // Schritt 5
        body.Append(CreateHeading2("3.5 Schritt 5: Logrotate-Konfiguration f\u00fcr Daemon-Logs"));
        body.Append(CreateParagraph("F\u00fcr die neue Daemon-Logdatei wurde eine eigene Logrotate-Konfiguration erstellt:"));
        body.Append(CreateCodeParagraph("$ sudo nano /etc/logrotate.d/daemon-logs"));
        body.Append(CreateParagraph("Die Konfiguration enth\u00e4lt folgende Parameter:"));
        body.Append(CreateCodeParagraph("/var/log/daemon.log {\n    weekly\n    rotate 8\n    compress\n    delaycompress\n    maxsize 50M\n    missingok\n    notifempty\n    create 0640 root adm\n    postrotate\n        /usr/bin/systemctl kill -s HUP rsyslog.service 2>/dev/null || true\n    endscript\n}"));
        body.Append(CreateParagraph("Diese Konfiguration gew\u00e4hrleistet:"));
        body.Append(CreateBulletParagraph("rotate 8 \u2014 8 Wochen Aufbewahrungsdauer (Versionierung)"));
        body.Append(CreateBulletParagraph("maxsize 50M \u2014 fr\u00fchzeitige Rotation bei Erreichen der Maximalgr\u00f6\u00dfe"));
        body.Append(CreateBulletParagraph("notifempty \u2014 keine Rotation leerer Dateien"));
        body.Append(CreateBulletParagraph("create 0640 root adm \u2014 restriktive Dateiberechtigungen"));
        body.Append(CreateBulletParagraph("HUP-Signal an rsyslog nach der Rotation"));
        AddInlineImage(body, mainPart, Path.Combine(imgDir, "4.png"), "Screenshot 4: Logrotate Daemon Config", 14);
        body.Append(CreateCaption("Abbildung 5: Logrotate-Konfiguration f\u00fcr Daemon-Logs"));

        // Schritt 6
        body.Append(CreateHeading2("3.6 Schritt 6: Neustart von rsyslog"));
        body.Append(CreateParagraph("Nach der Konfigurations\u00e4nderung wurde der rsyslog-Dienst neu gestartet:"));
        body.Append(CreateCodeParagraph("$ sudo systemctl restart rsyslog\n$ sudo systemctl status rsyslog"));
        body.Append(CreateParagraph("Der Dienst startete erfolgreich mit der neuen Konfiguration. Auff\u00e4llig ist der reduzierte Speicherverbrauch von nur 1.1M (vorher 3.2M), was auf die effizientere Queue-Konfiguration zur\u00fcckzuf\u00fchren ist."));
        AddInlineImage(body, mainPart, Path.Combine(imgDir, "6.png"), "Screenshot 6: rsyslog Restart", 14);
        body.Append(CreateCaption("Abbildung 6: Neustart und Status von rsyslog"));

        // Schritt 7
        body.Append(CreateHeading2("3.7 Schritt 7: Test der Konfiguration"));
        body.Append(CreateParagraph("Zur Verifizierung der Konfiguration wurden drei Testnachrichten mit dem logger-Befehl gesendet:"));
        body.Append(CreateCodeParagraph("$ logger -p daemon.info \"Test: Daemon-Logging funktioniert\"\n$ logger -p daemon.warning \"Test: Daemon-Warnung\"\n$ logger -p daemon.err \"Test: Daemon-Fehler\""));
        body.Append(CreateParagraph("Anschlie\u00dfend wurde die Logdatei \u00fcberpr\u00fcft. Die Nachrichten wurden erfolgreich in /var/log/daemon.log geschrieben, wie die Zeitstempel und die Inhalte belegen."));
        AddInlineImage(body, mainPart, Path.Combine(imgDir, "7.png"), "Screenshot 7: Logger Test", 14);
        body.Append(CreateCaption("Abbildung 7: Testnachrichten mit dem logger-Befehl"));
        AddInlineImage(body, mainPart, Path.Combine(imgDir, "8.png"), "Screenshot 8: Daemon Log", 14);
        body.Append(CreateCaption("Abbildung 8: Ausgabe der Daemon-Logdatei"));

        // Schritt 8
        body.Append(CreateHeading2("3.8 Schritt 8: Pr\u00fcfung der Logrotation"));
        body.Append(CreateParagraph("Die Logrotate-Konfiguration wurde im Debug-Modus getestet:"));
        body.Append(CreateCodeParagraph("$ sudo logrotate -d /etc/logrotate.conf"));
        body.Append(CreateParagraph("Die Ausgabe best\u00e4tigt die korrekte Verarbeitung der Konfiguration:"));
        body.Append(CreateBulletParagraph("18 Logs werden insgesamt verwaltet"));
        body.Append(CreateBulletParagraph("rotating pattern: /var/log/daemon.log weekly (8 rotations)"));
        body.Append(CreateBulletParagraph("maxsize 50M wird ber\u00fccksichtigt"));
        body.Append(CreateParagraph("Die Debug-Ausgabe zeigt, dass die Konfiguration syntaktisch korrekt ist und die Rotationsregeln wie erwartet angewendet werden."));
        AddInlineImage(body, mainPart, Path.Combine(imgDir, "9.png"), "Screenshot 9: Logrotate Debug", 14);
        body.Append(CreateCaption("Abbildung 9: Debug-Ausgabe von logrotate"));

        // Schritt 9
        body.Append(CreateHeading2("3.9 Schritt 9: Analyse des Speicherverbrauchs"));
        body.Append(CreateParagraph("Zum Abschluss wurde der tats\u00e4chliche Speicherverbrauch der Log-Verzeichnisse analysiert:"));
        body.Append(CreateCodeParagraph("$ sudo du -sh /var/log/\n$ sudo du -sh /var/log/daemon.log*"));
        body.Append(CreateParagraph("Ergebnisse:"));
        body.Append(CreateBulletParagraph("Gesamtgr\u00f6\u00dfe /var/log: 43M"));
        body.Append(CreateBulletParagraph("Aktuelle Daemon-Log: 12K"));
        body.Append(CreateBulletParagraph("Rotierte Daemon-Log: 36K"));
        body.Append(CreateParagraph("Zus\u00e4tzlich wurde der Speicherverbrauch des systemd-journals \u00fcberpr\u00fcft:"));
        body.Append(CreateCodeParagraph("$ journalctl --disk-usage"));
        body.Append(CreateParagraph("Die Journals belegen 32.5M im Dateisystem. Im Vergleich dazu ist der Platzbedarf der textbasierten rsyslog-Logs deutlich geringer, was die Komplementarit\u00e4t beider Systeme unterstreicht."));
        AddInlineImage(body, mainPart, Path.Combine(imgDir, "10.png"), "Screenshot 10: Disk Usage", 14);
        body.Append(CreateCaption("Abbildung 10: Speicherverbrauch der Log-Verzeichnisse"));
        AddInlineImage(body, mainPart, Path.Combine(imgDir, "11.png"), "Screenshot 11: Journal Size", 14);
        body.Append(CreateCaption("Abbildung 11: Speicherverbrauch des systemd-journals"));

        // ===== PERSOENLICHE ERFAHRUNGEN =====
        body.Append(CreateHeading1("4 Pers\u00f6nliche Erfahrungen", "_Toc004"));
        body.Append(CreateParagraph("Die Durchf\u00fchrung dieser Aufgabe bot mehrere wertvolle Einblicke in die Praxis des Linux-Systemmanagements. Die Arbeit mit rsyslog und logrotate erwies sich als intuitiv, sobald die grundlegenden Konzepte verstanden waren."));
        body.Append(CreateParagraph("Besonders hilfreich war die Erkenntnis, wie wichtig die Queue-Konfiguration in rsyslog ist. Ohne diese Begrenzungen kann der Dienst unter Last erhebliche Speichermengen allozieren. Die Konfiguration von $ActionQueueSizeMaxLines und der Watermark-Werte bietet einen effektiven Schutz gegen Speicher\u00fcberlastung."));
        body.Append(CreateParagraph("Die Integration von logrotate erwies sich als ebenso wichtig. Die M\u00f6glichkeit, sowohl zeit- als auch gr\u00f6\u00dfenbasierte Rotation zu kombinieren (maxsize 50M zusammen mit weekly), stellt sicher, dass Log-Dateien nicht unkontrolliert wachsen. Die compress-Option reduziert den Speicherbedarf alter Logs drastisch."));
        body.Append(CreateParagraph("Ein interessanter Aspekt war der Vergleich zwischen rsyslog und systemd-journald. W\u00e4hrend journald mit 43.3M deutlich mehr Speicher ben\u00f6tigt, bietet es komfortablere Abfragem\u00f6glichkeiten. Die Kombination beider Systeme \u2014 journald f\u00fcr die aktuelle Analyse und rsyslog f\u00fcr die Langzeitarchivierung \u2014 stellt einen pragmatischen Kompromiss dar."));
        body.Append(CreateParagraph("Die Verwendung von Fedora KDE in einer QEMU/KVM-VM erwies sich als stabil und f\u00fcr diese Aufgabe vollkommen ausreichend. Die Standardinstallation enthielt bereits alle ben\u00f6tigten Pakete (rsyslog, logrotate), was den Konfigurationsaufwand minimierte."));

        // ===== FAZIT =====
        body.Append(CreateHeading1("5 Fazit", "_Toc005"));
        body.Append(CreateParagraph("Die Aufgabe wurde erfolgreich abgeschlossen. Auf der Fedora Linux VM wurde ein Logging-Dienst eingerichtet, der Daemon-Ereignisse systematisch aufzeichnet und f\u00fcr die sp\u00e4tere Analyse bereitstellt."));
        body.Append(CreateParagraph("Zusammenfassend wurden folgende Komponenten konfiguriert:"));
        body.Append(CreateBulletParagraph("rsyslog mit dedizierter Daemon-Logdatei (/var/log/daemon.log)"));
        body.Append(CreateBulletParagraph("Speicherverbrauchs-Begrenzung durch Queue-Konfiguration"));
        body.Append(CreateBulletParagraph("Logrotate mit 8-w\u00f6chiger Aufbewahrungsdauer und Komprimierung"));
        body.Append(CreateBulletParagraph("Zusatzbeschr\u00e4nkung durch maxsize 50M"));
        body.Append(CreateParagraph("Die Implementierung ber\u00fccksichtigt alle in der Aufgabenstellung genannten Anforderungen: Speicherverbrauchs-Problematik, Versionierung der Logs und zeitgesteuerte Aufbewahrung vor der L\u00f6schung. Das System ist produktiv einsatzbereit und skaliert auch bei h\u00f6herem Log-Aufkommen stabil."));

        // Content section break
        body.Append(new Paragraph(new ParagraphProperties(new SectionProperties(
            new HeaderReference { Type = HeaderFooterValues.Default, Id = headerId },
            new FooterReference { Type = HeaderFooterValues.Default, Id = footerId },
            new PageSize { Width = (UInt32Value)(uint)A4W, Height = (UInt32Value)(uint)A4H },
            new PageMargin { Top = 1800, Right = 1440, Bottom = 1440, Left = 1440, Header = 720, Footer = 720 }))));
    }


    // ==================== BACKCOVER ====================
    private static void AddBackcoverSection(Body body, string backBgId)
    {
        body.Append(new Paragraph(new Run(CreateFloatingBackground(backBgId, _docPrId++, "BackBg"))));

        body.Append(new Paragraph(
            new ParagraphProperties(new SpacingBetweenLines { Before = "6000" },
                new Justification { Val = JustificationValues.Center }),
            new Run(new RunProperties(new FontSize { Val = "44" }, new Bold(),
                new Color { Val = Colors.Primary }),
                new Text("Protokoll"))));

        body.Append(new Paragraph(
            new ParagraphProperties(new SpacingBetweenLines { Before = "300" },
                new Justification { Val = JustificationValues.Center }),
            new Run(new RunProperties(new FontSize { Val = "22" }, new Color { Val = Colors.Mid }),
                new Text("Logging-Dienst Installation & Konfiguration"))));

        body.Append(new Paragraph(
            new ParagraphProperties(new SpacingBetweenLines { Before = "400" },
                new Justification { Val = JustificationValues.Center }),
            new Run(new RunProperties(new FontSize { Val = "18" }, new Color { Val = Colors.Light }),
                new Text("Fedora KDE Linux VM \u00b7 QEMU/KVM"))));

        body.Append(new Paragraph(
            new ParagraphProperties(new SpacingBetweenLines { Before = "200" },
                new Justification { Val = JustificationValues.Center }),
            new Run(new RunProperties(new FontSize { Val = "16" }, new Color { Val = Colors.Light }),
                new Text("11. Mai 2026"))));

        body.Append(new SectionProperties(
            new PageSize { Width = (UInt32Value)(uint)A4W, Height = (UInt32Value)(uint)A4H },
            new PageMargin { Top = 0, Right = 0, Bottom = 0, Left = 0, Header = 0, Footer = 0 }));
    }

    // ==================== FACTORY HELPERS ====================
    private static Paragraph CreateHeading1(string text, string bookmarkName)
    {
        int id = ++_bookmarkId;
        return new Paragraph(
            new ParagraphProperties(new ParagraphStyleId { Val = "Heading1" }),
            new BookmarkStart { Id = id.ToString(), Name = bookmarkName },
            new Run(new Text(text)),
            new BookmarkEnd { Id = id.ToString() });
    }

    private static Paragraph CreateHeading2(string text)
    {
        return new Paragraph(
            new ParagraphProperties(new ParagraphStyleId { Val = "Heading2" }),
            new Run(new Text(text)));
    }

    private static Paragraph CreateHeading3(string text)
    {
        return new Paragraph(
            new ParagraphProperties(new ParagraphStyleId { Val = "Heading3" }),
            new Run(new Text(text)));
    }

    private static Paragraph CreateParagraph(string text)
    {
        return new Paragraph(new Run(new Text(text)));
    }

    private static Paragraph CreateBulletParagraph(string text)
    {
        return new Paragraph(
            new ParagraphProperties(
                new NumberingProperties(new NumberingLevelReference { Val = 0 }, new NumberingId { Val = 1 })),
            new Run(new Text(text)));
    }

    private static Paragraph CreateCodeParagraph(string text)
    {
        return new Paragraph(
            new ParagraphProperties(new ParagraphStyleId { Val = "Code" }),
            new Run(new Text(text)));
    }

    private static Paragraph CreateCaption(string text)
    {
        return new Paragraph(
            new ParagraphProperties(new ParagraphStyleId { Val = "Caption" }),
            new Run(new Text(text)));
    }

    // ==================== IMAGE HELPERS ====================
    private static string AddImage(MainDocumentPart mp, string path)
    {
        var ip = mp.AddImagePart(ImagePartType.Png);
        using var fs = new FileStream(path, FileMode.Open);
        ip.FeedData(fs); return mp.GetIdOfPart(ip);
    }

    private static Drawing CreateFloatingBackground(string imgId, uint prId, string name)
    {
        return new Drawing(new DW.Anchor(
            new DW.SimplePosition { X = 0, Y = 0 },
            new DW.HorizontalPosition(new DW.PositionOffset("0")) { RelativeFrom = DW.HorizontalRelativePositionValues.Page },
            new DW.VerticalPosition(new DW.PositionOffset("0")) { RelativeFrom = DW.VerticalRelativePositionValues.Page },
            new DW.Extent { Cx = A4WE, Cy = A4HE },
            new DW.EffectExtent { LeftEdge = 0, TopEdge = 0, RightEdge = 0, BottomEdge = 0 },
            new DW.WrapNone(),
            new DW.DocProperties { Id = prId, Name = name },
            new DW.NonVisualGraphicFrameDrawingProperties(new A.GraphicFrameLocks { NoChangeAspect = true }),
            new A.Graphic(new A.GraphicData(
                new PIC.Picture(
                    new PIC.NonVisualPictureProperties(
                        new PIC.NonVisualDrawingProperties { Id = 0, Name = $"{name}.png" },
                        new PIC.NonVisualPictureDrawingProperties()),
                    new PIC.BlipFill(new A.Blip { Embed = imgId }, new A.Stretch(new A.FillRectangle())),
                    new PIC.ShapeProperties(
                        new A.Transform2D(new A.Offset { X = 0, Y = 0 }, new A.Extents { Cx = A4WE, Cy = A4HE }),
                        new A.PresetGeometry { Preset = A.ShapeTypeValues.Rectangle })))
            { Uri = "http://schemas.openxmlformats.org/drawingml/2006/picture" }))
        { DistanceFromTop = 0, DistanceFromBottom = 0, DistanceFromLeft = 0, DistanceFromRight = 0,
          SimplePos = false, RelativeHeight = 251658240, BehindDoc = true,
          Locked = false, LayoutInCell = true, AllowOverlap = true });
    }

    private static void AddInlineImage(Body body, MainDocumentPart mainPart, string imagePath, string altText, int maxWidthCm = 15)
    {
        if (!File.Exists(imagePath)) { Console.Error.WriteLine($"WARNING: Image not found: {imagePath}"); return; }
        var imagePart = mainPart.AddImagePart(ImagePartType.Png);
        byte[] imageBytes = File.ReadAllBytes(imagePath);
        using (var ms = new MemoryStream(imageBytes)) imagePart.FeedData(ms);
        var imageId = mainPart.GetIdOfPart(imagePart);

        int imgWidth, imgHeight;
        using (var ms = new MemoryStream(imageBytes))
        {
            ms.Seek(16, SeekOrigin.Begin);
            byte[] wb = new byte[4], hb = new byte[4];
            ms.Read(wb, 0, 4); ms.Read(hb, 0, 4);
            if (BitConverter.IsLittleEndian) { Array.Reverse(wb); Array.Reverse(hb); }
            imgWidth = BitConverter.ToInt32(wb, 0);
            imgHeight = BitConverter.ToInt32(hb, 0);
        }

        long maxWidthEmu = maxWidthCm * 360000L;
        long cx = maxWidthEmu;
        long cy = (long)(cx * ((double)imgHeight / imgWidth));
        var id = _docPrId++;
        body.Append(new Paragraph(
            new ParagraphProperties(new KeepNext(), new Justification { Val = JustificationValues.Center },
                new SpacingBetweenLines { Before = "200", After = "80" }),
            new Run(new Drawing(new DW.Inline(
                new DW.Extent { Cx = cx, Cy = cy },
                new DW.EffectExtent { LeftEdge = 0, TopEdge = 0, RightEdge = 0, BottomEdge = 0 },
                new DW.DocProperties { Id = id, Name = altText },
                new DW.NonVisualGraphicFrameDrawingProperties(new A.GraphicFrameLocks { NoChangeAspect = true }),
                new A.Graphic(new A.GraphicData(
                    new PIC.Picture(
                        new PIC.NonVisualPictureProperties(
                            new PIC.NonVisualDrawingProperties { Id = 0, Name = $"{altText}.png" },
                            new PIC.NonVisualPictureDrawingProperties()),
                        new PIC.BlipFill(new A.Blip { Embed = imageId }, new A.Stretch(new A.FillRectangle())),
                        new PIC.ShapeProperties(
                            new A.Transform2D(new A.Offset { X = 0, Y = 0 }, new A.Extents { Cx = cx, Cy = cy }),
                            new A.PresetGeometry { Preset = A.ShapeTypeValues.Rectangle })))
                { Uri = "http://schemas.openxmlformats.org/drawingml/2006/picture" }))
            { DistanceFromTop = 0, DistanceFromBottom = 0, DistanceFromLeft = 0, DistanceFromRight = 0 }))));
    }

    // ==================== SETTINGS ====================
    private static void SetUpdateFieldsOnOpen(MainDocumentPart mp)
    {
        var sp = mp.DocumentSettingsPart ?? mp.AddNewPart<DocumentSettingsPart>();
        sp.Settings = new Settings(new UpdateFieldsOnOpen { Val = true }, new DisplayBackgroundShape());
    }
}
