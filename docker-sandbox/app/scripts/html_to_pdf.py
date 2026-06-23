#!/usr/bin/env python3
"""HTML to PDF conversion using Python Playwright (sync API).

Replaces the former Node.js html_to_pdf.js, which required the Node
`playwright` npm package that was never installed (only the Python
`playwright` pip package + its browsers are present in the image). By using
the Python package we reuse the already-downloaded Chromium at
$PLAYWRIGHT_BROWSERS_PATH and avoid a second install step.

Usage:
    python html_to_pdf.py <input.html> <output.pdf> [options_json]

Prints a single JSON line on success: {"success": true, "output_path": ...,
"size": ...}. Exits non-zero (with a message on stderr) on failure.
"""
import json
import os
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright


def convert(input_path: str, output_path: str, options: dict) -> None:
    if not Path(input_path).is_file():
        raise FileNotFoundError(f"Input file not found: {input_path}")

    pdf_options = {
        "path": output_path,
        "format": options.get("format") or "A4",
        "print_background": options.get("print_background", True),
        "margin": options.get("margin") or {
            "top": "2cm",
            "right": "2cm",
            "bottom": "2cm",
            "left": "2cm",
        },
        "prefer_css_page_size": True,
        "display_header_footer": False,
    }

    file_url = "file://" + str(Path(input_path).resolve())

    with sync_playwright() as p:
        # --no-sandbox: the dropped subprocess has no CAP_SYS_ADMIN, so the
        # Chromium sandbox would refuse to start.
        browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
        try:
            page = browser.new_page()
            page.goto(file_url, wait_until="networkidle", timeout=60000)

            has_paged_js = page.evaluate(
                "() => typeof window.PagedPolyfill !== 'undefined' || "
                "document.querySelectorAll('.pagedjs_page').length > 0"
            )
            if has_paged_js:
                try:
                    page.wait_for_function(
                        "() => document.querySelectorAll('.pagedjs_page').length > 0",
                        timeout=60000,
                    )
                except Exception:
                    pass
                page.wait_for_timeout(2000)

            # Let any late fonts/images settle.
            page.wait_for_timeout(1000)
            page.pdf(**pdf_options)
        finally:
            browser.close()

    size = Path(output_path).stat().st_size
    print(json.dumps({"success": True, "output_path": output_path, "size": size}))


def main() -> int:
    if len(sys.argv) < 3:
        print("Usage: html_to_pdf.py <input.html> <output.pdf> [options_json]",
              file=sys.stderr)
        return 1

    input_path = sys.argv[1]
    output_path = sys.argv[2]
    options: dict = {}
    if len(sys.argv) > 3:
        try:
            options = json.loads(sys.argv[3])
        except Exception as e:
            print(f"Invalid options JSON: {e}", file=sys.stderr)
            return 1

    try:
        convert(input_path, output_path, options)
    except Exception as e:
        print(f"Conversion failed: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
