#!/usr/bin/env node
/**
 * HTML to PDF conversion using Playwright
 * Usage: node html_to_pdf.js <input.html> <output.pdf> [options_json]
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

async function convertHtmlToPdf(inputPath, outputPath, options = {}) {
  if (!fs.existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();

    // Load HTML file
    const fileUrl = 'file://' + path.resolve(inputPath);
    await page.goto(fileUrl, { waitUntil: 'networkidle', timeout: 60000 });

    // Wait for Paged.js to finish pagination if present
    const hasPagedJs = await page.evaluate(() => {
      return typeof window.PagedPolyfill !== 'undefined' ||
             document.querySelectorAll('.pagedjs_page').length > 0;
    });

    if (hasPagedJs) {
      // Wait for pagedjs pages to be generated
      await page.waitForFunction(() => {
        return document.querySelectorAll('.pagedjs_page').length > 0;
      }, { timeout: 60000 });
      // Give it a bit more time to stabilize
      await page.waitForTimeout(2000);
    }

    // Wait for any images/fonts to load
    await page.waitForTimeout(1000);

    const pdfOptions = {
      path: outputPath,
      format: options.format || 'A4',
      printBackground: options.print_background !== false,
      margin: options.margin || {
        top: '2cm',
        right: '2cm',
        bottom: '2cm',
        left: '2cm',
      },
      preferCSSPageSize: true,
      displayHeaderFooter: false,
    };

    await page.pdf(pdfOptions);

    const stats = fs.statSync(outputPath);
    console.log(JSON.stringify({
      success: true,
      output_path: outputPath,
      size: stats.size,
    }));
  } catch (error) {
    console.error(`Conversion failed: ${error.message}`);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

// CLI entrypoint
const inputPath = process.argv[2];
const outputPath = process.argv[3];
let options = {};

if (process.argv[4]) {
  try {
    options = JSON.parse(process.argv[4]);
  } catch (e) {
    console.error('Invalid options JSON:', e.message);
    process.exit(1);
  }
}

if (!inputPath || !outputPath) {
  console.error('Usage: node html_to_pdf.js <input.html> <output.pdf> [options_json]');
  process.exit(1);
}

convertHtmlToPdf(inputPath, outputPath, options);
