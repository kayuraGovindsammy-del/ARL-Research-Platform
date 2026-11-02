/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The MQTT singleton lives on `globalThis`, and the ingestion pipeline is
  // started from `instrumentation.ts` when the Node.js server boots.
  experimental: {
    instrumentationHook: true,
    serverComponentsExternalPackages: ["mqtt", "@prisma/client"],
  },
  eslint: {
    // Linting is run explicitly via `npm run lint`; do not fail production builds.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
