import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@napi-rs/canvas", "pdfjs-dist"],
  outputFileTracingExcludes: {
    "*": ["./data/**", "./node_modules/.cache/**"],
  },
};

export default nextConfig;
