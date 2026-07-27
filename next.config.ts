import type { NextConfig } from "next";

// Basic security response headers applied to every route. The CSP is kept
// deliberately permissive (it still sets frame-ancestors / object-src /
// base-uri / form-action / default-src) so it does not break model- and
// web-rendered markdown content; tighten it once the runtime requirements are
// confirmed.
//
// frame-ancestors 'self' (and X-Frame-Options SAMEORIGIN) rather than 'none'/
// DENY: the app frames its own inline file previews (HTML, PDF, ...) via
// same-origin <iframe src="/api/.../download?preview=1"> and
// <iframe src="/api/uploads/:id">. 'self' still blocks cross-origin framing
// (clickjacking protection intact) while letting the app's own previews load.
// Untrusted HTML previews are additionally sandboxed in the iframe itself.
function buildCsp(frameAncestors: string): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: http: https:",
    "font-src 'self' data: https:",
    "connect-src 'self' https: wss:",
    "media-src 'self' data: blob: https:",
    "frame-src 'self' blob: data: https:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${frameAncestors}`,
  ].join("; ");
}

const securityHeaders = [
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  { key: "Content-Security-Policy", value: buildCsp("'self'") },
];

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  serverExternalPackages: ["@napi-rs/canvas", "pdfjs-dist"],
  outputFileTracingExcludes: {
    "*": ["./data/**", "./node_modules/.cache/**"],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
