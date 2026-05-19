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
  webpack: (config) => {
    // Workspace packages compile to ESM (`"type": "module"`) and use the
    // mandatory `.js` extension on intra-package imports. Webpack's default
    // resolver doesn't transparently swap `.js` for the corresponding `.ts`
    // file, so the cockpit fails to resolve e.g. `./client.js` in
    // `@atlas/db`. The `extensionAlias` hint tells webpack to try `.ts` /
    // `.tsx` before the literal `.js` file (which doesn't exist in source).
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
};

module.exports = nextConfig;
