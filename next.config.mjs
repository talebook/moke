const appPlatform = process.env['NEXT_PUBLIC_APP_PLATFORM'];
const isDev = process.env['NODE_ENV'] === 'development';
const exportOutput = appPlatform !== 'web' && !isDev;

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: exportOutput ? 'export' : undefined,
  images: {
    unoptimized: true,
  },
  devIndicators: false,
  reactStrictMode: true,
  transpilePackages: isDev ? [] : ['foliate-js'],
  async rewrites() {
    return [
      {
        source: '/reader/:ids',
        destination: '/reader?ids=:ids',
      },
    ];
  },
};

export default nextConfig;
