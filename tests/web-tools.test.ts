import { describe, expect, it } from "vitest";

import {
  buildBrowserHeaders,
  classifyContentType,
  classifyImageResponse,
  decodeEntities,
  deriveReferer,
  describeBinaryResponse,
  extractPageMeta,
  extractScriptData,
  formatScriptData,
  htmlToMarkdown,
  htmlToText,
  isHtmlBody,
  isPrivateHost,
  sanitizeVisionError,
  stripNonContent,
  truncateForOutput,
  validateFetchUrl,
} from "@/lib/agent/web-tools";

describe("web-tools: deriveReferer", () => {
  it("returns the origin with a trailing slash for ordinary hosts", () => {
    expect(deriveReferer("https://example.com/images/34/25/x.jpg"))
      .toBe("https://example.com/");
  });
  it("strips asset/CDN subdomain prefixes so the parent site is the Referer", () => {
    // img4.gelbooru.com must send a gelbooru.com Referer, not its own origin,
    // otherwise the CDN returns an HTML stub instead of the image bytes.
    expect(deriveReferer("https://img4.gelbooru.com/images/34/25/x.jpg"))
      .toBe("https://gelbooru.com/");
    expect(deriveReferer("https://cdn.example.org/assets/a.png"))
      .toBe("https://example.org/");
    expect(deriveReferer("https://static.foo.test/pic.webp"))
      .toBe("https://foo.test/");
  });
  it("returns empty string for invalid urls", () => {
    expect(deriveReferer("not a url")).toBe("");
  });
});

describe("web-tools: buildBrowserHeaders", () => {
  it("includes User-Agent, Accept, Accept-Language and a Referer from the origin", () => {
    const h = buildBrowserHeaders("https://example.com/page");
    expect(h["User-Agent"]).toMatch(/Mozilla\/5.0/);
    expect(h["Accept"]).toContain("text/html");
    expect(h["Accept-Language"]).toMatch(/^en-US/);
    expect(h["Referer"]).toBe("https://example.com/");
  });
  it("allows overriding the referer and accept", () => {
    const h = buildBrowserHeaders("https://example.com/p", { referer: "https://ref.test/", accept: "*/*" });
    expect(h["Referer"]).toBe("https://ref.test/");
    expect(h["Accept"]).toBe("*/*");
  });
});

describe("web-tools: classifyContentType", () => {
  it("classifies html by content-type", () => {
    expect(classifyContentType("text/html; charset=utf-8", "https://x.test/p")).toBe("html");
  });
  it("classifies images by content-type and extension", () => {
    expect(classifyContentType("image/jpeg", "https://x.test/a.jpg")).toBe("image");
    expect(classifyContentType("application/octet-stream", "https://x.test/a.png")).toBe("image");
  });
  it("classifies pdf", () => {
    expect(classifyContentType("application/pdf", "https://x.test/a.pdf")).toBe("pdf");
    expect(classifyContentType(null, "https://x.test/report.pdf")).toBe("pdf");
  });
  it("classifies json and xml", () => {
    expect(classifyContentType("application/json", null)).toBe("json");
    expect(classifyContentType("text/xml", null)).toBe("xml");
  });
  it("falls back to binary for unknown octet-stream", () => {
    expect(classifyContentType("application/octet-stream", "https://x.test/a.bin")).toBe("binary");
  });
});

describe("web-tools: isHtmlBody", () => {
  it("true for html content-type", () => {
    expect(isHtmlBody("text/html", "https://x.test/")).toBe(true);
  });
  it("false for image content-type", () => {
    expect(isHtmlBody("image/jpeg", "https://x.test/a.jpg")).toBe(false);
  });
});

describe("web-tools: decodeEntities", () => {
  it("decodes named, decimal and hex entities", () => {
    expect(decodeEntities("Tom &amp; Jerry &lt;3 &#65; &#x41;")).toBe("Tom & Jerry <3 A A");
  });
  it("leaves unknown entities intact", () => {
    expect(decodeEntities("foo &doesnotexist; bar")).toBe("foo &doesnotexist; bar");
  });
  it("returns input unchanged when no entities present", () => {
    expect(decodeEntities("plain text")).toBe("plain text");
  });
});

describe("web-tools: stripNonContent", () => {
  it("removes script/style/noscript/template/svg/head and comments", () => {
    const html = `<head><title>t</title></head><body><!-- c --><script>alert(1)</script><style>x{}</style>
    <noscript>ns</noscript><template>t</template><svg></svg><p>hi</p></body>`;
    const out = stripNonContent(html);
    expect(out).not.toContain("alert(1)");
    expect(out).not.toContain("x{}");
    expect(out).not.toContain("ns");
    expect(out).not.toContain("<!-- c -->");
    expect(out).not.toContain("<title>t</title>");
    expect(out).toContain("<p>hi</p>");
  });
});

describe("web-tools: extractScriptData", () => {
  it("extracts application/json and ld+json scripts always", () => {
    const html = `
      <div id="app"></div>
      <script type="application/json">{"a":1,"b":[2,3]}</script>
      <script type="application/ld+json">{"@type":"Thing"}</script>
    `;
    const data = extractScriptData(html);
    expect(data).toHaveLength(2);
    expect(data[0]!.kind).toBe("json");
    expect(data[0]!.value).toContain('"a":1');
    expect(data[1]!.kind).toBe("ld-json");
    expect(data[1]!.value).toContain('Thing');
  });

  it("extracts JS object/array assignments (the CYOA storyData case)", () => {
    const html = `
      <div id="story-container"></div>
      <script>
        let storyData = {
          "title": "Hypnoworld",
          "initialStats": { "money": 25 }
        };
        function render() { console.log(storyData.title); }
      </script>
    `;
    const data = extractScriptData(html, { includeJsAssignments: true });
    expect(data.some((d) => d.name === "storyData" && d.kind === "js-assignment")).toBe(true);
    const sd = data.find((d) => d.name === "storyData")!;
    expect(sd.value).toContain("Hypnoworld");
    expect(sd.value.startsWith("{")).toBe(true);
    // Balanced extraction must include the closing brace, not the render() body.
    expect(sd.value.trim().endsWith("}")).toBe(true);
    expect(sd.value).not.toContain("function render");
  });

  it("skips js-assignments by default (avoids dumping app bundles)", () => {
    const html = `<script>let state = {"x":1};</script>`;
    expect(extractScriptData(html)).toHaveLength(0);
    expect(extractScriptData(html, { includeJsAssignments: true })).toHaveLength(1);
  });

  it("handles nested braces and strings without early-terminating", () => {
    const html = `<script>const cfg = {"a": "}{", "b": {"c": "}"}};</script>`;
    const data = extractScriptData(html, { includeJsAssignments: true });
    const v = data.find((d) => d.name === "cfg")!.value;
    // Must consume the full literal including the nested closing braces.
    expect(v).toBe(`{"a": "}{", "b": {"c": "}"}}`);
  });

  it("does not match == === => operators", () => {
    const html = `<script>
      let x = 1, y = 2;
      if (x == y) {}
      const arrow = () => ({});
      const good = {"keep": true};
    </script>`;
    const names = extractScriptData(html, { includeJsAssignments: true }).map((d) => d.name);
    expect(names).toContain("good");
    expect(names).not.toContain("arrow");
  });

  it("dedupes identical assignments", () => {
    const html = `<script>let d = {"k":1};</script><script>let d = {"k":1};</script>`;
    expect(extractScriptData(html, { includeJsAssignments: true })).toHaveLength(1);
  });

  it("ignores script-src-less and external-script detail doesn't crash", () => {
    const html = `<div>hi</div>`;
    expect(extractScriptData(html)).toEqual([]);
  });
});

describe("web-tools: formatScriptData", () => {
  it("renders an appendix with fenced blocks", () => {
    const out = formatScriptData([
      { name: "storyData", kind: "js-assignment", value: '{"a":1}' },
    ]);
    expect(out).toContain("Embedded data extracted from <script> tags");
    expect(out).toContain("### storyData (js-assignment)");
    expect(out).toContain('```');
    expect(out).toContain('{"a":1}');
  });
  it("returns empty string for no data", () => {
    expect(formatScriptData([])).toBe("");
  });
});

describe("web-tools: extractPageMeta", () => {
  it("extracts title and meta description", () => {
    const html = `<html><head><title>Hello World</title><meta name="description" content="A page"></head></html>`;
    expect(extractPageMeta(html)).toEqual({ title: "Hello World", description: "A page" });
  });
  it("returns empty strings when missing", () => {
    expect(extractPageMeta("<html></html>")).toEqual({ title: "", description: "" });
  });
});

describe("web-tools: htmlToText", () => {
  it("strips tags and collapses whitespace", () => {
    const html = `<div><h1>Title</h1><p>One &amp; two</p><br><p>Three</p></div>`;
    const out = htmlToText(html);
    expect(out).toContain("Title");
    expect(out).toContain("One & two");
    expect(out).toContain("Three");
    expect(out).not.toContain("<");
  });
});

describe("web-tools: htmlToMarkdown", () => {
  it("converts headings, paragraphs, links, lists, bold, code", () => {
    const html = `
      <h1>Big</h1>
      <p>This is <strong>bold</strong> and <em>ital</em> with a <a href="/x">link</a>.</p>
      <ul><li>one</li><li>two</li></ul>
      <pre><code>code block</code></pre>
      <blockquote>quoted</blockquote>
    `;
    const md = htmlToMarkdown(html, "https://example.com/");
    expect(md).toContain("# Big");
    expect(md).toContain("**bold**");
    expect(md).toContain("*ital*");
    expect(md).toContain("[link](https://example.com/x)");
    expect(md).toContain("- one");
    expect(md).toContain("- two");
    expect(md).toContain("```");
    expect(md).toContain("> quoted");
  });

  it("renders images as ![alt](src) with resolved url", () => {
    const md = htmlToMarkdown(`<img src="/a.png" alt="pic">`, "https://example.com/");
    expect(md).toContain("![pic](https://example.com/a.png)");
  });

  it("escapes pipe characters inside table cells", () => {
    const md = htmlToMarkdown(`<table><tr><td>a|b</td><td>c</td></tr></table>`);
    expect(md).toContain("a\\|b");
    expect(md).toContain("---");
  });
});

describe("web-tools: describeBinaryResponse", () => {
  it("describes an image with bytes and suggests downloading", () => {
    const desc = describeBinaryResponse({ contentType: "image/jpeg", url: "https://x.test/a.jpg", size: 12345 });
    expect(desc).toContain("image");
    expect(desc).toContain("12345 bytes");
    expect(desc).toContain("curl");
  });
  it("notes a redirect", () => {
    const desc = describeBinaryResponse({
      contentType: "application/pdf",
      url: "https://x.test/a",
      size: 1,
      finalUrl: "https://x.test/real.pdf",
    });
    expect(desc).toContain("redirected to https://x.test/real.pdf");
  });
});

describe("web-tools: truncateForOutput", () => {
  it("returns input when under the limit", () => {
    expect(truncateForOutput("short", 100)).toBe("short");
  });
  it("truncates and appends a notice", () => {
    const big = "x".repeat(1000);
    const out = truncateForOutput(big, 100);
    expect(out.length).toBeLessThan(big.length);
    expect(out).toContain("truncated");
  });
});

describe("web-tools: isPrivateHost", () => {
  it("blocks loopback / private / link-local ranges", () => {
    expect(isPrivateHost("127.0.0.1")).toBe(true);
    expect(isPrivateHost("10.0.0.1")).toBe(true);
    expect(isPrivateHost("192.168.1.1")).toBe(true);
    expect(isPrivateHost("172.16.0.1")).toBe(true);
    expect(isPrivateHost("172.31.255.255")).toBe(true);
    expect(isPrivateHost("169.254.169.254")).toBe(true);
    expect(isPrivateHost("169.254.10.10")).toBe(true);
    expect(isPrivateHost("100.64.0.1")).toBe(true);
  });
  it("blocks IPv6 loopback / link-local / unique-local", () => {
    expect(isPrivateHost("::1")).toBe(true);
    expect(isPrivateHost("fe80::1")).toBe(true);
    expect(isPrivateHost("fd00::1")).toBe(true);
    expect(isPrivateHost("::ffff:169.254.169.254")).toBe(true);
  });
  it("blocks metadata + internal names", () => {
    expect(isPrivateHost("metadata.google.internal")).toBe(true);
    expect(isPrivateHost("foo.internal")).toBe(true);
    expect(isPrivateHost("bar.local")).toBe(true);
    expect(isPrivateHost("localhost")).toBe(true);
  });
  it("allows public hosts", () => {
    expect(isPrivateHost("example.com")).toBe(false);
    expect(isPrivateHost("8.8.8.8")).toBe(false);
    expect(isPrivateHost("1.1.1.1")).toBe(false);
    expect(isPrivateHost("172.32.0.1")).toBe(false);
  });
});

describe("web-tools: validateFetchUrl", () => {
  it("accepts public http(s) urls", () => {
    expect(validateFetchUrl("https://example.com/p").ok).toBe(true);
    expect(validateFetchUrl("http://example.com").ok).toBe(true);
  });
  it("rejects non-http schemes", () => {
    const r = validateFetchUrl("file:///etc/passwd");
    expect(r.ok).toBe(false);
  });
  it("rejects private hosts", () => {
    expect(validateFetchUrl("http://127.0.0.1/admin").ok).toBe(false);
    expect(validateFetchUrl("http://169.254.169.254/latest/meta-data/").ok).toBe(false);
    expect(validateFetchUrl("http://metadata.google.internal/").ok).toBe(false);
  });
  it("rejects malformed urls", () => {
    expect(validateFetchUrl("not a url").ok).toBe(false);
  });
});

describe("web-tools: classifyImageResponse", () => {
  it("classifies a real answer as ok", () => {
    const txt = "A fox-girl reclines on a dark surface. Text reads おじさんのスリーパーだけで大丈夫だよ.";
    expect(classifyImageResponse(txt)).toBe("ok");
  });
  it("classifies empty as empty", () => {
    expect(classifyImageResponse("")).toBe("empty");
    expect(classifyImageResponse("   \n  ")).toBe("empty");
  });
  it("classifies 'no image attached' non-answers", () => {
    expect(classifyImageResponse("I don't see any image attached.")).toBe("no-image");
    expect(classifyImageResponse("No image was provided.")).toBe("no-image");
  });
  it("classifies the exact refusal from the transcript as refusal", () => {
    // Verbatim safety non-answer observed in production.
    const refusal =
      "I can't provide a detailed description, coordinates, or transcription for this image. " +
      "It appears to depict sexual content involving a minor-like character, which I won't assist with in any form.\n\n" +
      "If you have concerns about this type of material, you can report it to:\n- NCMEC CyberTipline";
    expect(classifyImageResponse(refusal)).toBe("refusal");
  });
  it("classifies generic refusals", () => {
    expect(classifyImageResponse("I'm sorry, but I can't assist with that request.")).toBe("refusal");
    expect(classifyImageResponse("I am unable to analyze this image.")).toBe("refusal");
    expect(classifyImageResponse("This content appears to depict explicit material.")).toBe("refusal");
  });
  it("does not false-positive on legitimate description text", () => {
    // Must not flag a real description just because it mentions 'safety' or
    // 'minor' in a non-refusal context, e.g. describing a safety pin or a
    // minor character. (Kept conservative: these are ok.)
    expect(classifyImageResponse("The character wears a helmet for safety.")).toBe("ok");
  });
});

describe("web-tools: sanitizeVisionError", () => {
  it("collapses a giant 404 HTML page into a short, context-safe message", () => {
    // Verbatim shape of the production failure: OpenAI-SDK error message
    // = "<status> <body>" where the body is the provider's Next.js 404 page.
    const html404 =
      "404 <!DOCTYPE html><html lang=\"en\"><head><meta charSet=\"utf-8\"/>" +
      "<title>404 | This page could not be found.</title>" +
      "<link rel=\"stylesheet\" href=\"/_next/static/css/10534ac409e0d126.css\"/></head>" +
      "<body><div>404</div></body></html>";
    const out = sanitizeVisionError(html404, "neuralwatt:vision-1");
    expect(out.length).toBeLessThan(160);
    expect(out).toContain("HTTP 404");
    expect(out).toContain("neuralwatt:vision-1");
    expect(out).not.toContain("<html");
    expect(out).not.toContain("<!DOCTYPE");
    expect(out).not.toContain("_next");
  });
  it("reports a likely-wrong base URL / model id for HTML error pages", () => {
    const out = sanitizeVisionError("404 <!DOCTYPE html><html><head></head><body></body></html>");
    expect(out).toMatch(/base URL or model id is likely wrong/i);
  });
  it("handles bare status + JSON error text", () => {
    const out = sanitizeVisionError("429 {\"error\":{\"message\":\"Too many requests\"}}", "m1");
    expect(out).toContain("HTTP 429");
    expect(out).toContain("Too many requests");
    expect(out).not.toContain("{");
  });
  it("passes through short plain errors", () => {
    const out = sanitizeVisionError("connection reset", "m1");
    expect(out).toContain("connection reset");
    expect(out).toContain("m1");
  });
  it("truncates very long non-html errors", () => {
    const long = "x".repeat(5000);
    const out = sanitizeVisionError(long, "m1");
    expect(out.length).toBeLessThan(400);
  });
});
