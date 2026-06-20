/**
 * Standalone web_fetch test harness.
 *
 * Replicates the orchestrator's `web_fetch` pipeline using Node's native fetch
 * (instead of the Python sandbox) but reuses the exact pure helpers from
 * web-tools.ts: buildBrowserHeaders, validateFetchUrl, isPrivateHost,
 * extractPageMeta, stripNonContent, htmlToMarkdown, htmlToText,
 * isHtmlBody, classifyContentType, describeBinaryResponse, truncateForOutput.
 *
 * Usage:  npx tsx scripts/web-fetch-test.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

import {
  buildBrowserHeaders,
  classifyContentType,
  describeBinaryResponse,
  extractPageMeta,
  htmlToMarkdown,
  htmlToText,
  isHtmlBody,
  isPrivateHost,
  stripNonContent,
  truncateForOutput,
  validateFetchUrl,
  type FetchFormat,
} from "../src/lib/agent/web-tools";

const OUT_DIR = path.resolve(process.cwd(), "..", "temp");

type FetchResult = {
  url: string;
  ok: boolean;
  status?: number;
  contentType?: string;
  finalUrl?: string;
  size?: number;
  format: FetchFormat;
  kind?: ReturnType<typeof classifyContentType>;
  binary?: boolean;
  content: string;
  error?: string;
};

function meta(title: string, description: string): string {
  return title || description
    ? `# ${title}${description ? `\n> ${description}` : ""}\n\n`
    : "";
}

async function fetchOne(rawUrl: string, format: FetchFormat = "markdown"): Promise<FetchResult> {
  const validation = validateFetchUrl(rawUrl);
  if (!validation.ok) {
    return { url: rawUrl, ok: false, format, content: "", error: validation.error };
  }

  const headers = buildBrowserHeaders(rawUrl);
  try {
    const resp = await fetch(rawUrl, {
      method: "GET",
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(30000),
    });

    const finalUrl = resp.url || rawUrl;
    let finalHost = "";
    try { finalHost = new URL(finalUrl).hostname; } catch { /* ignore */ }
    if (isPrivateHost(finalHost)) {
      return {
        url: rawUrl, ok: false, format,
        error: `Blocked redirect to private/internal host: ${finalHost}`,
        content: "",
      };
    }

    const contentType = resp.headers.get("content-type") ?? "";
    const raw = Buffer.from(await resp.arrayBuffer());
    const size = raw.length;
    const kind = classifyContentType(contentType, finalUrl);

    if (!isHtmlBody(contentType, finalUrl)) {
      const desc = describeBinaryResponse({
        contentType: contentType || null,
        url: rawUrl,
        size,
        finalUrl,
      });
      return {
        url: rawUrl, ok: true, status: resp.status, contentType, finalUrl, size,
        format, kind, binary: true, content: desc,
      };
    }

    const charset = /charset=([^;]+)/i.exec(contentType)?.[1]?.trim() ?? "utf-8";
    let body: string;
    try {
      body = raw.toString(charset as BufferEncoding);
    } catch {
      body = raw.toString("utf-8");
    }

    const pageMeta = extractPageMeta(body);
    let content: string;
    if (format === "html") {
      content = truncateForOutput(stripNonContent(body));
    } else if (format === "markdown") {
      content = truncateForOutput(htmlToMarkdown(stripNonContent(body), finalUrl));
    } else if (format === "text") {
      content = truncateForOutput(htmlToText(body));
    } else {
      content = truncateForOutput(body);
    }

    return {
      url: rawUrl, ok: true, status: resp.status, contentType, finalUrl, size, format,
      kind, content: meta(pageMeta.title, pageMeta.description) + content,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { url: rawUrl, ok: false, format, content: "", error: `Fetch error: ${msg}` };
  }
}

async function main(): Promise<void> {
  const targets: Array<{ url: string; format: FetchFormat }> = [
    { url: "https://portal.neuralwatt.com/docs/api/models", format: "markdown" },
    { url: "https://gelbooru.com/index.php?page=post&s=list&tags=mind_control&pid=42", format: "markdown" },
    { url: "https://gelbooru.com/index.php?page=post&s=view&id=14314537&tags=mind_control", format: "markdown" },
  ];

  mkdirSync(OUT_DIR, { recursive: true });

  for (const t of targets) {
    process.stdout.write(`Fetching ${t.url} ... `);
    const res = await fetchOne(t.url, t.format);
    console.log(res.ok ? `OK (${res.status})` : `FAILED`);

    const parts: string[] = [];
    parts.push(`# web_fetch standalone test\n`);
    parts.push(`Generated: ${new Date().toISOString()}\n`);
    parts.push(`\n---\n\n## ${t.url}\n`);
    parts.push(`- URL: ${res.url}\n`);
    parts.push(`- Status: ${res.ok ? res.status : "fetch failed"}\n`);
    if (res.contentType) parts.push(`- Content-Type: \`${res.contentType}\`\n`);
    if (res.finalUrl && res.finalUrl !== res.url) parts.push(`- Final URL (post-redirect): ${res.finalUrl}\n`);
    if (res.size !== undefined) parts.push(`- Size: ${res.size} bytes\n`);
    parts.push(`- Format: ${res.format}\n`);
    if (res.kind) parts.push(`- Kind: ${res.kind}\n`);
    if (res.error) parts.push(`- Error: ${res.error}\n`);
    parts.push("\n### Content\n\n");
    if (!res.ok) {
      parts.push(`\n\`\`\`\n${res.error ?? "no content"}\n\`\`\`\n`);
    } else if (res.binary) {
      parts.push(`\n${res.content}\n`);
    } else {
      parts.push(`\n${res.content}\n`);
    }

    const slug = t.url
      .replace(/^https?:\/\//, "")
      .replace(/\?.*$/, "")
      .replace(/[^a-z0-9.-]+/gi, "_")
      .slice(0, 60);
    const hash = createHash("sha1").update(t.url).digest("hex").slice(0, 8);
    const outPath = path.join(OUT_DIR, `web-fetch-${slug}_${hash}.md`);
    writeFileSync(outPath, parts.join(""), "utf-8");
    console.log(`  -> ${outPath}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
