import type { NextConfig } from 'next';
import { readBackendUrl } from './src/lib/env';

/**
 * Same-origin REST proxy (T-31.1).
 *
 * The account session cookie is `SameSite=Lax` without a `domain` attribute, so
 * it is reliably sent only to the web origin. Proxying `/api/*` keeps the browser
 * on that origin in dev **and** production, and Next.js forwards request cookies
 * upstream plus `Set-Cookie` back to the browser.
 *
 * `BACKEND_URL` is server-only; it is read at config evaluation time and never
 * becomes a `NEXT_PUBLIC_*` value.
 */
const backendUrl = readBackendUrl();

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // `@skoriva/shared` exports TypeScript sources inside the workspace.
  transpilePackages: ['@skoriva/shared'],
  async rewrites() {
    return [
      {
        // `:path*` preserves the remainder exactly, so the backend still
        // receives `/api/...` (no prefix stripping, no double prefix).
        source: '/api/:path*',
        destination: `${backendUrl}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
