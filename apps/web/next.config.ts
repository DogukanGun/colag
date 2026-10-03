import type { NextConfig } from "next";
import path from "node:path";
const config: NextConfig = {
  devIndicators: false,
  distDir: process.env.NODE_ENV === "development" ? ".next-dev" : ".next",
  outputFileTracingRoot: path.resolve("../.."),
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: "http://127.0.0.1:4310/api/:path*",
      },
    ];
  },
};
export default config;
