import type { NextConfig } from "next";

// Report-only CSP lets us observe violations without breaking the app.
// Migrate to Content-Security-Policy once the report-uri stream is clean.
//
// Notes on directive choices:
// - script-src 'unsafe-inline': required for Next.js hydration inline scripts.
// - connect-src *.vercel-insights.com: Vercel Web Analytics beacon endpoint.
// - img-src cards.scryfall.io: card images loaded directly by the browser.
const CSP_REPORT_ONLY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://cards.scryfall.io",
  "font-src 'self'",
  "connect-src 'self' https://*.vercel-insights.com",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  distDir: process.env.E2E_TEST ? ".next-e2e" : ".next",
  headers: async () => [
    {
      source: "/(.*)",
      headers: [
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        { key: "Content-Security-Policy-Report-Only", value: CSP_REPORT_ONLY },
      ],
    },
  ],
};

export default nextConfig;
