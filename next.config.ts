import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  distDir: process.env.REALWORLD_E2E_AUTH === undefined ? ".next" : ".next-e2e",
  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;
