import type { NextConfig } from "next";
import path from "node:path";
const api = (process.env.COLAG_API_URL || "http://127.0.0.1:4310").replace(/\/$/, "");
const config: NextConfig = {
  devIndicators: false,
  distDir: process.env.NODE_ENV === "development" ? ".next-dev" : ".next",
  outputFileTracingRoot: path.resolve("../.."),
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${api}/api/:path*`,
      },
    ];
  },
};
export default config;
