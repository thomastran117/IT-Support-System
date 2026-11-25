import type { NextConfig } from 'next';
import { fileURLToPath } from 'node:url';

const development = process.env.NODE_ENV === 'development';

function apiOrigin() {
  try {
    return new URL(process.env.NEXT_PUBLIC_API_URL ?? '').origin;
  } catch {
    return undefined;
  }
}

/**
 * The browser may only load this app's own assets and call the configured API origin. Next's
 * hydration bootstrap and the theme initialiser in the root layout are inline scripts, so scripts
 * keep 'unsafe-inline' (a nonce-based policy would require dynamic rendering of every page).
 * Development adds 'unsafe-eval' and WebSocket access for React Refresh and hot reloading.
 */
function contentSecurityPolicy(api = apiOrigin(), dev = development) {
  const connect = ["'self'", api, dev && 'ws:', dev && 'wss:'].filter(Boolean).join(' ');
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connect}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

const securityHeaders = [
  { key: 'Content-Security-Policy', value: contentSecurityPolicy() },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@smartdesk/contracts'],
  turbopack: {
    // The linked contracts package sits beside the frontend rather than beneath it.
    root: fileURLToPath(new URL('..', import.meta.url)),
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
