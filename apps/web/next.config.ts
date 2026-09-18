import type { NextConfig } from 'next';
import path from 'node:path';

const nextConfig: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  reactStrictMode: true,
  allowedDevOrigins: ['127.0.0.1'],
  poweredByHeader: false,
  // Vercel empaqueta cada función con su propio trazado. `standalone` corresponde a la
  // imagen Docker y, si se fuerza allí, ambos empaquetadores compiten por los manifiestos.
  output: process.env.VERCEL ? undefined : 'standalone',
  outputFileTracingRoot: process.env.VERCEL
    ? undefined
    : path.resolve(import.meta.dirname, '../..'),
  experimental: { optimizePackageImports: ['lucide-react'] },
};

export default nextConfig;
