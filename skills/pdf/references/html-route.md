# HTML-to-PDF Route Reference

Generate professional PDFs from HTML using Playwright + Paged.js inside the sandbox.

## Complete HTML Template

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Document Title</title>
  <script src="https://unpkg.com/pagedjs/dist/paged.polyfill.js"></script>
  <style>
    /* === Page Setup === */
    @page {
      size: A4;
      margin: 2.5cm 2cm 2.5cm 2cm;

      @top-center {
        content: string(doc-title);
        font-size: 9pt;
        color: #666;
      }

      @bottom-center {
        content: counter(page);
        font-size: 9pt;
        color: #666;
      }
    }

    @page :first {
      margin-top: 0;
      @top-center { content: none; }
      @bottom-center { content: none; }
    }

    /* === Typography === */
    body {
      font-family: "Liberation Serif", Georgia, serif;
      font-size: 11pt;
      line-height: 1.6;
      color: #222;
    }

    h1 {
      string-set: doc-title content();
      font-size: 24pt;
      color: #1a1a1a;
      margin-top: 0;
      break-before: page;
    }

    h2 {
      font-size: 16pt;
      color: #333;
      margin-top: 1.5em;
    }

    h3 {
      font-size: 13pt;
      color: #444;
    }

    p {
      margin: 0.8em 0;
      text-align: justify;
    }

    code {
      font-family: "Liberation Mono", monospace;
      font-size: 9.5pt;
      background: #f4f4f4;
      padding: 0.1em 0.3em;
    }

    pre {
      background: #f4f4f4;
      padding: 1em;
      border-left: 3px solid #ccc;
      overflow-x: auto;
      font-size: 9pt;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      margin: 1em 0;
      font-size: 10pt;
    }

    th, td {
      border: 1px solid #ccc;
      padding: 0.4em 0.6em;
      text-align: left;
    }

    th {
      background: #f0f0f0;
      font-weight: bold;
    }

    /* === Cover Page === */
    .cover {
      page: cover;
      height: 100vh;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      text-align: center;
      background: linear-gradient(135deg, #f5f7fa 0%, #e4e8ec 100%);
    }

    @page cover {
      margin: 0;
      @top-center { content: none; }
      @bottom-center { content: none; }
    }

    .cover h1 {
      font-size: 32pt;
      margin-bottom: 0.3em;
    }

    .cover .subtitle {
      font-size: 14pt;
      color: #555;
      margin-bottom: 2em;
    }

    .cover .meta {
      font-size: 11pt;
      color: #666;
    }

    /* === Utilities === */
    .page-break {
      break-before: page;
    }

    .no-break {
      break-inside: avoid;
    }
  </style>
</head>
<body>
  <!-- Cover Page -->
  <div class="cover">
    <h1>Document Title</h1>
    <div class="subtitle">Subtitle or Description</div>
    <div class="meta">
      Author Name<br>
      Date: 2026-05-20
    </div>
  </div>

  <!-- Content -->
  <h1>Introduction</h1>
  <p>Your content here...</p>

  <h1 class="page-break">Chapter Two</h1>
  <p>More content...</p>
</body>
</html>
```

## CSS Print Tips

- Use `pt` units for font sizes in print documents
- `@page` rules control margins, headers, footers, and page size
- `break-before: page` forces a new page
- `break-inside: avoid` keeps elements together (good for tables, figures)
- `string-set` captures text for running headers
- Paged.js polyfill is required for `@page` margin boxes in Chromium

## Playwright Options

When calling `pdf_from_html`, these options are passed to Playwright:

- `format`: "A4" (default), "Letter", "A3", etc.
- `print_background`: true (required for colored backgrounds)
- `margin`: { top, right, bottom, left } in CSS units

## Common Issues

1. **Backgrounds not printing**: Ensure `print_background: true` is set
2. **Paged.js not applying**: The script tag must load before content renders; add a small delay if needed
3. **Fonts missing**: Use system fonts (Liberation, Noto) available in the sandbox
4. **Long tables breaking badly**: Add `break-inside: avoid` to `tr` elements
