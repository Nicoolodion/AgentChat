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

/** Derive a sensible Referer from the request URL's origin. */
export function deriveReferer(url: string): string {
  try {
    const u = new URL(url);
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
