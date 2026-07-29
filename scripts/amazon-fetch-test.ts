/**
 * Ad-hoc test: fetch an Amazon product page using the web_fetch pipeline
 * helpers and dump intermediate stages (raw HTML, stripped, markdown) to files
 * for inspection.
 *
 * Usage:  node --experimental-strip-types scripts/amazon-fetch-test.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import {
  buildBrowserHeaders,
  classifyContentType,
  extractPageMeta,
  extractScriptData,
  formatScriptData,
  htmlToMarkdown,
  htmlToText,
  isHtmlBody,
  stripNonContent,
  truncateForOutput,
  validateFetchUrl,
} from "../src/lib/agent/web-tools";

const OUT_DIR = path.resolve(process.cwd(), "..", "temp", "amazon");

const AMAZON_URL =
  "https://www.amazon.de/Magnesium-Apothekerglas-Tagesportion-Fertigung-laborgepr%C3%BCft/dp/B0DT1MXW1G";

function meta(title: string, description: string): string {
  return title || description
    ? `# ${title}${description ? `\n> ${description}` : ""}\n\n`
    : "";
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  console.log("Validating URL...");
  const validation = validateFetchUrl(AMAZON_URL);
  if (!validation.ok) {
    console.error("Validation failed:", validation.error);
    process.exit(1);
  }

  const headers = buildBrowserHeaders(AMAZON_URL);  console.log("Fetching...");
  const resp = await fetch(AMAZON_URL, {
    method: "GET",
    headers: { ...headers, "Accept-Language": "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7" },
    redirect: "follow",
    signal: AbortSignal.timeout(30000),
  });

  const finalUrl = resp.url || AMAZON_URL;
  const contentType = resp.headers.get("content-type") ?? "";
  const raw = Buffer.from(await resp.arrayBuffer());
  const charset = /charset=([^;]+)/i.exec(contentType)?.[1]?.trim() ?? "utf-8";
  let body: string;
  try { body = raw.toString(charset as BufferEncoding); } catch { body = raw.toString("utf-8"); }

  const pageMeta = extractPageMeta(body);
  const visibleText = htmlToText(body).replace(/\s+/g, " ").trim();

  // Dump stages
  writeFileSync(path.join(OUT_DIR, "01-raw.html"), body, "utf-8");
  writeFileSync(path.join(OUT_DIR, "02-stripped.html"), stripNonContent(body), "utf-8");
  writeFileSync(path.join(OUT_DIR, "03-markdown.md"), htmlToMarkdown(stripNonContent(body), finalUrl), "utf-8");
  writeFileSync(path.join(OUT_DIR, "04-text.txt"), htmlToText(body), "utf-8");

  const md = truncateForOutput(meta(pageMeta.title, pageMeta.description) + htmlToMarkdown(stripNonContent(body), finalUrl));
  writeFileSync(path.join(OUT_DIR, "05-final.md"), md, "utf-8");

  const scriptData = extractScriptData(body, { includeJsAssignments: visibleText.length < 3000 });
  if (scriptData.length > 0) {
    const withData = truncateForOutput(md + formatScriptData(scriptData), 100_000);
    writeFileSync(path.join(OUT_DIR, "06-with-script-data.md"), withData, "utf-8");
  }

  console.log(`Status: ${resp.status}`);
  console.log(`Content-Type: '${contentType}'`);
  console.log(`Final URL: ${finalUrl}`);
  console.log(`Size: ${raw.length} bytes`);
  console.log(`Kind: ${classifyContentType(contentType, finalUrl, body)}`);
  console.log(`isHtmlBody: ${isHtmlBody(contentType, finalUrl, body)}`);
  console.log(`Title: ${pageMeta.title}`);
  console.log(`Description: ${pageMeta.description}`);
  console.log(`Visible text length: ${visibleText.length}`);
  console.log(`Script data entries: ${scriptData.length}`);
  console.log(`Output directory: ${OUT_DIR}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
