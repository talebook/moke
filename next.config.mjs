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
  experimental: {
    turbopackFileSystemCacheForDev: true,
    turbopackFileSystemCacheForBuild: true,
    turbopackMemoryLimit: 8192, // MB — use more RAM for fewer GC pauses
  },
  // In dev mode, proxy /readest/* to readest's dev server (port 3001) so the
  // reader window loads through the same origin and avoids Tauri remote-URL
  // permission issues.
  async rewrites() {
    if (isDev) {
      return [
        {
          source: '/readest/:path*',
          destination: 'http://localhost:3001/readest/:path*',
        },
      ];
    }
    return [];
  },
};

export default nextConfig;
