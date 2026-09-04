import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  devIndicators: false,
  poweredByHeader: false,
  serverExternalPackages: ['@libsql/client'],
  typescript: { ignoreBuildErrors: false },
}

export default nextConfig
