---
skill: pdf
description: "Generate PDF documents from HTML using Playwright + Paged.js. Supports cover pages, headers/footers, page numbers, and styled print layouts."
routes:
  - name: HTML-to-PDF
    condition: "User wants a formatted PDF report, documentation, or book"
    reference: "references/html-route.md"
dependencies:
  - name: "playwright"
    check: "npx playwright --version"
  - name: "nodejs"
    check: "node --version"
quality_standards:
  - "Use Paged.js for pagination control"
  - "Include @page CSS rules for margins"
  - "Cover page with title, date, and author"
  - "Headers and footers with page numbers"
  - "Print-optimized typography"
---

# PDF Skill

## Routing

**HTML-to-PDF** (`references/html-route.md`) — The default and recommended route.

Generate a well-structured HTML file with CSS print styling, then convert to PDF using the sandbox's `pdf_from_html` tool (which uses Playwright + Paged.js).

## File Structure

```
pdf/
├── SKILL.md                       ← This file (routing + rules)
├── references/
│   └── html-route.md              → HTML-to-PDF patterns and examples
├── scripts/
│   └── html_to_pdf.js             → Playwright conversion script
└── assets/
    └── templates/
        ├── cover-styles/          → Sample cover page CSS
        └── DNS_AdGuard_Dokumentation.html  → Production example
```

## Workflow

1. Read `references/html-route.md` for the full pattern guide
2. Create an HTML file in the workspace `output/` directory
3. Add Paged.js and `@page` CSS rules
4. Call `pdf_from_html` tool to convert
5. Verify the output PDF

## Quality Standards

- **Paged.js integration**: Include `<script src="https://unpkg.com/pagedjs/dist/paged.polyfill.js"></script>` for automatic pagination
- **@page rules**: Define paper size, margins, and bleed areas
- **Cover page**: First page should be visually distinct (larger title, subtitle, date)
- **Print typography**: Use pt units, avoid viewport-relative sizing
- **Color**: Ensure grayscale readability; avoid pure black backgrounds
- **Page breaks**: Use `break-before: page` for major sections

## Example Quick Start

Create `output/report.html`:

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Report</title>
  <script src="https://unpkg.com/pagedjs/dist/paged.polyfill.js"></script>
  <style>
    @page { size: A4; margin: 2cm; }
    @page :first { margin-top: 0; }
    body { font-family: Georgia, serif; line-height: 1.6; }
    h1 { break-before: page; }
  </style>
</head>
<body>
  <h1>Title</h1>
  <p>Content...</p>
</body>
</html>
```

Then call `pdf_from_html` with `html_path: "output/report.html"` and `output_path: "output/report.pdf"`.
