import type { NextConfig } from 'next';
import { fileURLToPath } from 'node:url';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@smartdesk/contracts'],
  turbopack: {
    // The linked contracts package sits beside the frontend rather than beneath it.
    root: fileURLToPath(new URL('..', import.meta.url)),
  },
};

export default nextConfig;
