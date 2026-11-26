import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PGlite ships a WASM build of Postgres; bundling it breaks its asset loading.
  serverExternalPackages: ["@electric-sql/pglite"],
};

export default nextConfig;
