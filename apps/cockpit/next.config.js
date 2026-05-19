/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: [
    '@atlas/core',
    '@atlas/db',
    '@atlas/adapters-shared',
    '@atlas/intelligence-identity-resolution',
    '@atlas/intelligence-scoring',
    '@atlas/intelligence-classification',
    '@atlas/api-rest',
    '@atlas/api-graphql',
    '@atlas/api-ask-anything',
  ],
  experimental: {
    serverComponentsExternalPackages: ['pino'],
  },
};

module.exports = nextConfig;
