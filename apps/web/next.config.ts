import type { NextConfig } from 'next';
import path from 'node:path';

const nextConfig: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  reactStrictMode: true,
  allowedDevOrigins: ['127.0.0.1'],
  poweredByHeader: false,
  output: 'standalone',
  outputFileTracingRoot: path.resolve(import.meta.dirname, '../..'),
  experimental: { optimizePackageImports: ['lucide-react'] },
};

export default nextConfig;
