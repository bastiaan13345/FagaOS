/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: 'standalone',
  typedRoutes: false,
  transpilePackages: [
    '@fagaos/workspace-shell',
    '@fagaos/ui-read-model',
    '@fagaos/onboarding',
  ],
};

export default nextConfig;
