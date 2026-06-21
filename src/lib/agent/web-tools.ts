/**
 * Pure, side-effect-free helpers for the agent `web_fetch` / `web_search` tools.
 *
 * Everything here is unit-testable TypeScript (no network, no sandbox). The
 * orchestrator builds the request headers + Python fetch payload using these
 * helpers, and applies the HTML cleaning to whatever the sandbox returns, so
 * the *fetching* (which must run in the sandbox for network egress) is separated
 * from the *parsing/cleaning* (which is fully deterministic and tested here).
 */

export type FetchFormat = "html" | "text" | "markdown";

export type ClassifiedContentType =
  | "html"
  | "text"
  | "json"
  | "xml"
  | "image"
  | "audio"
  | "video"
  | "pdf"
  | "archive"
  | "binary";

/** Browser-like request headers so hosts that gatekeep by UA/Accept/Referer
 *  (e.g. image CDNs such as img4.gelbooru.com) serve the real asset. */
export function buildBrowserHeaders(
  url: string,
  opts: { referer?: string; accept?: string } = {},
): Record<string, string> {
  const referer = opts.referer ?? deriveReferer(url);
  const headers: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    Accept:
      opts.accept ??
      "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,image/avif,image/webp,*/*;q=0.7",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
  };
  if (referer) headers["Referer"] = referer;
  return headers;
}

/** Derive a sensible Referer from the request URL's origin.
 *
 *  For image-CDN subdomains (e.g. `img4.gelbooru.com`, `img2.danbooru.donmai.us`,
 *  `cdn.*`, `static.*`, `media.*`), the asset host typically rejects or
 *  down-serves requests that reference its own origin and expects a Referer
 *  from the parent site. So we strip the well-known asset subdomain prefix and
 *  use the apex domain's root as the Referer instead. */
export function deriveReferer(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname;
    // Asset/CDN subdomain prefixes whose parent site should be the Referer.
    const m = host.match(/^(?:img\d*|cdn|static|media|assets|images?|pics?)\.(.+)/i);
    if (m) {
      return `${u.protocol}//${m[1]}/`;
    }
    return `${u.protocol}//${u.host}/`;
  } catch {
    return "";
  }
}

export function classifyContentType(
  contentType: string | null | undefined,
  url: string | null | undefined,
): ClassifiedContentType {
  const ct = (contentType ?? "").toLowerCase().split(";")[0]!.trim();
  const path = (url ?? "").toLowerCase().split("?")[0]!;
  const ext = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1) : "";

  if (ct.startsWith("text/html") || ct.includes("xhtml")) return "html";
  if (ct.startsWith("text/plain")) return "text";
  if (ct === "application/json" || ct === "text/json") return "json";
  if (ct.includes("xml") || ext === "xml") return "xml";
  if (ct === "application/pdf" || ext === "pdf") return "pdf";
  if (ct.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico"].includes(ext)) return "image";
  if (ct.startsWith("audio/") || ["mp3", "wav", "ogg", "m4a", "flac"].includes(ext)) return "audio";
  if (ct.startsWith("video/") || ["mp4", "webm", "mov", "mkv", "avi"].includes(ext)) return "video";
  if (ct.includes("zip") || ["zip", "gz", "tar", "rar", "7z"].includes(ext)) return "archive";

  // Fallbacks by extension when content-type is generic / missing.
  if (["json"].includes(ext)) return "json";
  if (["html", "htm"].includes(ext)) return "html";
  if (["txt", "md", "csv", "log"].includes(ext)) return "text";

  if (!ct || ct === "application/octet-stream") return "binary";
  if (ct.startsWith("text/")) return "text";
  return "binary";
}

export function isHtmlBody(contentType: string | null | undefined, url: string | null | undefined): boolean {
  return classifyContentType(contentType, url) === "html";
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0",
  copy: "\u00a9", reg: "\u00ae", trade: "\u2122", hellip: "\u2026",
  mdash: "\u2014", ndash: "\u2013", lsquo: "\u2018", rsquo: "\u2019",
  ldquo: "\u201c", rdquo: "\u201d", laquo: "\u00ab", raquo: "\u00bb",
  deg: "\u00b0", euro: "\u20ac", pound: "\u00a3", cent: "\u00a2", yen: "\u00a5",
  para: "\u00b6", middot: "\u00b7", bull: "\u2022", dagger: "\u2020",
  nbsp2: "\u00a0",
};

export function decodeEntities(input: string): string {
  if (!input.includes("&")) return input;
  return input.replace(/&#(\d+);/g, (_, d) => safeFromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeFromCodePoint(parseInt(h, 16)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]+);/g, (_, name) => NAMED_ENTITIES[name] ?? `&${name};`);
}

function safeFromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/** Strip <script>/<style>/<noscript>/<template>/<svg>/<head> blocks and HTML
 *  comments from raw HTML before conversion. */
export function stripNonContent(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, "")
    .replace(/<template\b[\s\S]*?<\/template>/gi, "")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, "")
    .replace(/<head\b[\s\S]*?<\/head>/gi, "");
}

// ── Embedded <script> data extraction ────────────────────────────────────────
//
// Many pages (SPAs, JS-driven CYOAs, Next.js apps, ...) render their content
// from an inline JSON / JS-object literal embedded in a <script> tag, e.g.
//   <script type="application/json">{"a":1}</script>
//   <script type="application/ld+json">{...}</script>
//   <script>let storyData = { ...big object... }; function render(){...}</script>
// `stripNonContent` deletes all of that, leaving an empty shell (e.g. a bare
// `<div id="app"></div>`), so the model can't see the page's actual data and
// must fall back to many `shell`/`ipython` curl+regex calls. `extractScriptData`
// pulls those data payloads back out so `web_fetch` can surface them.

export type ExtractedScriptDatum = {
  /** Human label: "<json>", "<json-ld>", or the variable name (e.g. "storyData"). */
  name: string;
  /** Origin category of the extracted literal. */
  kind: "json" | "ld-json" | "js-assignment";
  /** The raw literal text (already entity-decoded). */
  value: string;
};

const MAX_EXTRACTED_PER_ITEM = 60_000;
const MAX_EXTRACTED_TOTAL = 90_000;
const MIN_JS_ASSIGNMENT_VALUE = 4;

/** Given the index of an opening `{` or `[`, return the slice through its
 *  matching close, accounting for JS strings and line + block comments.
 *  Returns null if no matching close is found. */
function balancedSlice(text: string, open: number): string | null {
  const openCh = text[open];
  if (openCh !== "{" && openCh !== "[") return null;
  const closeCh = openCh === "{" ? "}" : "]";
  // Quote chars compared by code to avoid parser ambiguity with backtick.
  const QUOTE_CODES = new Set([0x22, 0x27, 0x60]); // " ' `
  let depth = 0;
  let i = open;
  let inStr: number | null = null;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (inStr !== null) {
      if (c === 0x5c) { i += 2; continue; } // backslash escape
      if (c === inStr) inStr = null;
      i += 1;
      continue;
    }
    if (QUOTE_CODES.has(c)) { inStr = c; i += 1; continue; }
    if (c === 0x2f && text.charCodeAt(i + 1) === 0x2f) { // // line comment
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl + 1;
      continue;
    }
    if (c === 0x2f && text.charCodeAt(i + 1) === 0x2a) { // /* comment
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    if (c === openCh.charCodeAt(0)) depth++;
    else if (c === closeCh.charCodeAt(0)) {
      depth--;
      if (depth === 0) return text.slice(open, i + 1);
    }
    i += 1;
  }
  return null;
}

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

/** Collect the inline JSON / data-object payloads embedded in <script> tags.
 *
 *  - `<script type="application/json">` / `application/ld+json` → always
 *    included (structured data, compact).
 *  - Inline JS assignments of the form `var|let|const NAME = {…}` /
 *    `window.NAME = {…}` / `NAME = {…}` (and array literals) → only included
 *    when `opts.includeJsAssignments` is true, since these can be large app
 *    bundles. Callers should enable this when the visible (non-script) body is
 *    thin, i.e. the page is JS-driven and its real content lives in script
 *    data.
 *
 *  Returns at most a handful of deduplicated, size-capped entries. */
export function extractScriptData(
  html: string,
  opts: { includeJsAssignments?: boolean } = {},
): ExtractedScriptDatum[] {
  const out: ExtractedScriptDatum[] = [];
  const seen = new Set<string>();

  // Matches `storyData = {`, `window.__NEXT_DATA__ = [`, `const foo = {`, etc.
  // Negative-lookbehind on `=`,`<`,`>`,`!` avoids `==`/`===`/`=>`/`>=`/`<=`/`!=`.
  const assignRe =
    /(?<![=<>!])(?:\b(?:const|let|var)\s+)?(?:window\.)?([A-Za-z_$][\w$]*)\s*=\s*(?=[{\[])/g;

  const push = (name: string, kind: ExtractedScriptDatum["kind"], value: string, key: string): void => {
    if (seen.has(key)) return;
    seen.add(key);
    let v = value;
    if (v.length > MAX_EXTRACTED_PER_ITEM) {
      v = `${v.slice(0, MAX_EXTRACTED_PER_ITEM)}\n// [...truncated ${v.length - MAX_EXTRACTED_PER_ITEM} chars]`;
    }
    out.push({ name, kind, value: v });
  };

  let m: RegExpExecArray | null;
  while ((m = SCRIPT_RE.exec(html)) !== null) {
    if (totalExtracted(out) >= MAX_EXTRACTED_TOTAL) return out;
    const attrs = m[1] ?? "";
    const inner = decodeEntities(m[2] ?? "").trim();
    if (!inner) continue;
    const typeMatch = attrs.match(/\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const type = (typeMatch?.[1] ?? typeMatch?.[2] ?? typeMatch?.[3] ?? "").toLowerCase();

    if (type === "application/json" || type === "application/ld+json") {
      push(
        type === "application/ld+json" ? "<json-ld>" : "<json>",
        type === "application/ld+json" ? "ld-json" : "json",
        inner,
        `${type}:${inner.slice(0, 64)}`,
      );
      continue;
    }

    if (!opts.includeJsAssignments) continue;

    // Scan this script's source for top-level object/array assignments.
    assignRe.lastIndex = 0;
    let am: RegExpExecArray | null;
    while ((am = assignRe.exec(inner)) !== null) {
      const name = am[1]!;
      // The `{` / `[` is right after the matched `=` (skipping whitespace).
      let eqEnd = am.index + am[0].length;
      while (eqEnd < inner.length && /\s/.test(inner[eqEnd]!)) eqEnd++;
      const slice = balancedSlice(inner, eqEnd);
      if (!slice) continue;
      if (slice.length < MIN_JS_ASSIGNMENT_VALUE) continue;
      push(name, "js-assignment", slice, `${name}:${slice.slice(0, 64)}`);
      if (totalExtracted(out) >= MAX_EXTRACTED_TOTAL) return out;
    }
  }
  return out;
}

function totalExtracted(data: ExtractedScriptDatum[]): number {
  let n = 0;
  for (const d of data) n += d.value.length;
  return n;
}

/** Render extracted script data as a delimited Markdown appendix. */
export function formatScriptData(data: ExtractedScriptDatum[]): string {
  if (!data.length) return "";
  const blocks = data.map((d) => `### ${d.name} (${d.kind})\n\n\`\`\`\n${d.value}\n\`\`\``);
  return `\n\n---\n## Embedded data extracted from <script> tags\n\nThe visible page body is JS-driven/empty; this structured/inline data was pulled out of the page's <script> tags.\n\n${blocks.join("\n\n")}`;
}

function attr(re: RegExp, tag: string): string | null {
  const m = tag.match(re);
  return m ? decodeEntities(m[1] ?? "") : null;
}

const HREF_RE = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const SRC_RE = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const ALT_RE = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

function resolveUrl(raw: string | null, baseUrl: string | null): string | null {
  if (!raw) return null;
  try {
    return new URL(raw, baseUrl ?? undefined).toString();
  } catch {
    return raw;
  }
}

/** Convert (already stripped) HTML to lightweight Markdown. */
export function htmlToMarkdown(html: string, baseUrl: string | null = null): string {
  let s = html;

  // Block-level structural elements first.
  // Headings
  for (let i = 6; i >= 1; i--) {
    const re = new RegExp(`<h${i}\\b[^>]*>([\\s\\S]*?)</h${i}>`, "gi");
    s = s.replace(re, (_, inner) => `\n\n${"#".repeat(i)} ${flattenInline(inner, baseUrl)}\n\n`);
  }
  // Paragraphs
  s = s.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (_, inner) => `\n\n${flattenInline(inner, baseUrl)}\n\n`);
  // Lists
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, inner) => `\n- ${flattenInline(inner, baseUrl)}`);
  s = s.replace(/<\/?(ul|ol)\b[^>]*>/gi, "\n");
  // Blockquotes
  s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, inner) =>
    `\n\n${flattenInline(inner, baseUrl).split("\n").map((l) => `> ${l}`).join("\n")}\n\n`);
  // Pre / code blocks
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner) => `\n\n\`\`\`\n${stripTags(inner)}\n\`\`\`\n\n`);
  // Horizontal rules
  s = s.replace(/<hr\b[^>]*\/?>/gi, "\n\n---\n\n");
  // Line breaks
  s = s.replace(/<br\s*\/?>/gi, "\n");
  // Tables -> pipe tables (best-effort)
  s = convertTables(s, baseUrl);

  // Now flatten any remaining inline tags (also handles <a>, <strong>, etc.
  // that weren't captured above because they appear in headings/etc.).
  s = flattenInline(s, baseUrl);

  // Strip any leftover tags.
  s = stripTags(s);

  // Decode entities and normalize whitespace.
  s = decodeEntities(s);
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ");
  return s.trim();
}

function flattenInline(html: string, baseUrl: string | null = null): string {
  let s = html;
  // Links
  s = s.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (full, _attrs, inner) => {
    const href = attr(HREF_RE, full);
    const url = resolveUrl(href, baseUrl);
    const text = flattenInline(inner, baseUrl).trim();
    if (!text) return "";
    if (url && url !== "#" && !/^javascript:/i.test(url)) return `[${text}](${url})`;
    return text;
  });
  // Images — render as ![alt](src)
  s = s.replace(/<img\b([^>]*)\/?>/gi, (full) => {
    const src = resolveUrl(attr(SRC_RE, full), baseUrl);
    const alt = attr(ALT_RE, full) ?? "";
    return src ? `![${alt}](${src})` : "";
  });
  // Bold
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _t, inner) => `**${flattenInline(inner, baseUrl)}**`);
  // Italic
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _t, inner) => `*${flattenInline(inner, baseUrl)}*`);
  // Inline code
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, inner) => `\`${stripTags(inner).trim()}\``);
  // Spans / etc left as-is; they'll be stripped below.
  return s;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

function convertTables(html: string, baseUrl: string | null = null): string {
  return html.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_, table) => {
    const rows: string[][] = [];
    const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let rm: RegExpExecArray | null;
    while ((rm = rowRe.exec(table)) !== null) {
      const cells: string[] = [];
      const cellRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
      let cm: RegExpExecArray | null;
      while ((cm = cellRe.exec(rm[1]!)) !== null) {
        cells.push(flattenInline(cm[1]!, baseUrl).replace(/\|/g, "\\|").replace(/\s+/g, " ").trim());
      }
      if (cells.length) rows.push(cells);
    }
    if (!rows.length) return "";
    const width = Math.max(...rows.map((r) => r.length));
    for (const r of rows) while (r.length < width) r.push("");
    const header = `| ${rows[0]!.join(" | ")} |`;
    const sep = `| ${rows[0]!.map(() => "---").join(" | ")} |`;
    const body = rows.slice(1).map((r) => `| ${r.join(" | ")} |`).join("\n");
    return `\n\n${header}\n${sep}${body ? "\n" + body : ""}\n\n`;
  });
}

/** Extract a plain-text representation of HTML (for `format: "text"`). */
export function htmlToText(html: string): string {
  const stripped = stripNonContent(html);
  let s = stripped
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|footer|nav|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  return s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/** Pull <title> and meta description from raw HTML for context. */
export function extractPageMeta(html: string): { title: string; description: string } {
  let title = "";
  let description = "";
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) title = decodeEntities(stripTags(titleMatch[1]!)).trim();
  const descMatch = html.match(/<meta\b[^>]*name\s*=\s*["']?description["']?[^>]*content\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
  if (descMatch) description = decodeEntities(descMatch[1] ?? descMatch[2] ?? "").trim();
  return { title: title.slice(0, 300), description: description.slice(0, 500) };
}

/** Describe a non-text/binary response so the model knows what it got. */
export function describeBinaryResponse(input: {
  contentType: string | null;
  url: string;
  size: number;
  finalUrl?: string;
}): string {
  const kind = classifyContentType(input.contentType, input.url);
  const ct = input.contentType ?? "unknown";
  const redirected = input.finalUrl && input.finalUrl !== input.url ? ` (redirected to ${input.finalUrl})` : "";
  return (
    `URL ${input.url}${redirected} returned a ${kind} resource (${ct}, ${input.size} bytes).\n` +
    `This is not HTML/text content and cannot be inlined. If you need the actual bytes, ` +
    `download the file with the \`shell\` or \`ipython\` tool (e.g. \`curl -L -o file <url>\`) ` +
    `using a browser User-Agent and Referer header, then read it with the appropriate tool.`
  );
}

export function truncateForOutput(text: string, max = 50000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[...truncated ${text.length - max} chars]`;
}

// ── SSRF protection ──────────────────────────────────────────────────────────

/** Hostnames that must never be fetched (cloud metadata + common local names). */
const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
  "169.254.169.254", // AWS/GCP/Azure IMDS
  "metadata.aws.internal",
]);

/** True if a literal hostname/IP points at a private/loopback/link-local target. */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "").trim();
  if (!h) return true;
  if (BLOCKED_HOSTS.has(h)) return true;
  if (h.endsWith(".internal") || h.endsWith(".local") || h.endsWith(".localhost")) return true;

  // IPv4 literal
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local / metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  // IPv6 literal — block loopback, link-local, unique-local, unspecified.
  if (h === "::1" || h === "::") return true;
  if (h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("::ffff:")) {
    // ::ffff: mapped IPv4 — check the embedded v4.
    const mapped = h.match(/:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mapped) return isPrivateHost(mapped[1]!);
    return true;
  }
  return false;
}

export type UrlValidation = { ok: true; url: URL } | { ok: false; error: string };

/**
 * Validate a URL the model asked us to fetch. Rejects non-http(s) schemes and
 * any host that resolves (lexically) to a private/loopback/link-local target.
 * NOTE: a lexical check does not defeat DNS-rebinding; the sandbox fetcher
 * also re-checks the *final* (post-redirect) host against the same denylist.
 */
export function validateFetchUrl(raw: string): UrlValidation {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: "Invalid URL" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, error: `Blocked scheme: ${u.protocol}` };
  }
  if (isPrivateHost(u.hostname)) {
    return { ok: false, error: `Blocked host (private/loopback/internal): ${u.hostname}` };
  }
  return { ok: true, url: u };
}

// ── Vision response classification & error sanitization ──────────────────────

export type VisionResponseStatus = "ok" | "no-image" | "refusal" | "empty";

/** Patterns for "I don't see an image" style non-answers. */
const NO_IMAGE_PATTERNS = [
  /no image (was |is )?(attached|provided|uploaded|found|included|visible)/i,
  /did not (attach|upload|provide|include) (an? |the )?image/i,
  /please (provide|upload|share|attach) (the |an? )?image/i,
  /i (cannot|can't|am unable to) (see|describe|view|analyze) (the |an? |any )?image/i,
  /i don'?t see (any |an? )?image/i,
  /no image (available|present|shown|displayed)/i,
  /image (is )?missing|missing image/i,
  /forgot (to )?(attach|upload|include|provide)/i,
];

/** Refusal / safety non-answers. A single model's safety filter must not be
 *  trusted as the final result — the orchestrator retries the next candidate.
 *  Patterns are kept specific to avoid false-positives on real descriptions
 *  that merely mention "safety", "minor", etc. in a non-rejecting context. */
const REFUSAL_PATTERNS = [
  /\bi (can'??not|can'?t|won'?t|am (?:un)?able to|will not)\b[^.]{0,80}?\b(assist|help|provide|describe|analyze|transcribe|fulfill|complete|participate|engage|comply|process|generate|create)\b/i,
  /\bi (?:am )?(?:not able|unable) to (?:see|describe|analyze|view|process|provide)\b/i,
  /\b(refuse|decline) (to|to help|to assist|to provide)\b/i,
  /(?:content|image|material) (?:depicts|appears to depict|involves|contains) (?:sexual(?:ized)?|explicit|minor|underage|csam|child)/i,
  /report (?:it )?to\b/i,
  /cybertipline|tips\.fbi\.gov|ncmec/i,
  /\b(minor|underage|child(?:ren)?)\S{0,30}(?:-like)?\s+character/i,
  /against (?:my )?(?:guidelines|policies|safety policy)/i,
  /i'?m not (?:able|allowed|permitted) to/i,
  /(?:not|cannot) (?:assist|help) (?:with|in) (?:this|that|any)/i,
];

/** Classify a vision-model response so refusals/no-image/empty answers are
 *  retried on the next candidate model instead of returned as ground truth. */
export function classifyImageResponse(text: string): VisionResponseStatus {
  const t = (text ?? "").trim();
  if (t.length === 0) return "empty";
  if (NO_IMAGE_PATTERNS.some((p) => p.test(text))) return "no-image";
  if (REFUSAL_PATTERNS.some((p) => p.test(text))) return "refusal";
  return "ok";
}

/** Turn a raw vision-API error (which may contain a full HTML 404/500 page, a
 *  JSON error blob, or a huge payload) into a short, agent-context-safe
 *  message. Extracts the HTTP status and the embedded error message when
 *  possible. */
export function sanitizeVisionError(raw: string, modelId?: string): string {
  const prefix = modelId ? `vision model '${modelId}'` : "vision model";
  const s = raw ?? "";

  // Leading "404 <!DOCTYPE..." or "429 {...}" style OpenAI-SDK messages.
  const m = s.match(/^\s*(\d{3})\b\s*([\s\S]*)?/);
  const status = m?.[1] ?? null;
  const rest = (m?.[2] ?? s).trim();

  const looksHtml = /<html|<!doctype html|<head|<body/i.test(rest || s);
  if (looksHtml) {
    const body = rest || s;
    const title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
    const hint = title ? ` (HTML page: "${title.slice(0, 80)}")` : " (HTML error page returned, not a JSON API response)";
    return `${prefix}: HTTP ${status ?? "error"}${hint} — provider base URL or model id is likely wrong`;
  }

  // JSON error blob, e.g. {"error":{"message":"Too many requests","type":...}}.
  if (rest.startsWith("{") || rest.startsWith("[")) {
    let message = "";
    try {
      const obj = JSON.parse(rest);
      message =
        (obj?.error?.message as string | undefined) ??
        (obj?.message as string | undefined) ??
        (obj?.detail as string | undefined) ??
        (typeof obj?.error === "string" ? obj.error : "") ??
        "";
    } catch {
      /* fall through to plain cleanup */
    }
    if (message) {
      return `${prefix}: ${status ? `HTTP ${status}: ` : ""}${String(message).slice(0, 300)}`;
    }
  }

  // Strip HTML tags + collapse whitespace for any other payload, then cap.
  const cleaned = (rest || s).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const truncated = cleaned.slice(0, 300);
  return `${prefix}: ${status ? `HTTP ${status}: ` : ""}${truncated}`;
}
