import { describe, expect, it } from "vitest";

import {
  buildBrowserHeaders,
  classifyContentType,
  decodeEntities,
  deriveReferer,
  describeBinaryResponse,
  extractPageMeta,
  htmlToMarkdown,
  htmlToText,
  isHtmlBody,
  isPrivateHost,
  stripNonContent,
  truncateForOutput,
  validateFetchUrl,
} from "@/lib/agent/web-tools";

describe("web-tools: deriveReferer", () => {
  it("returns the origin with a trailing slash", () => {
    expect(deriveReferer("https://img4.gelbooru.com/images/34/25/x.jpg"))
      .toBe("https://img4.gelbooru.com/");
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
