const appPlatform = process.env['NEXT_PUBLIC_APP_PLATFORM'];
const isDev = process.env['NODE_ENV'] === 'development';
const exportOutput = appPlatform !== 'web' && !isDev;

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: exportOutput ? 'export' : undefined,
  // CI and local device smoke tests access the dev server through the
  // loopback IP. Next 16 blocks dev assets from that origin unless it is
  // explicitly trusted, which would leave client-only startup gates stuck at
  // their server-rendered loading state.
  allowedDevOrigins: ['127.0.0.1'],
  images: {
    unoptimized: true,
  },
  devIndicators: false,
  reactStrictMode: true,
  experimental: {
    turbopackFileSystemCacheForDev: true,
    turbopackFileSystemCacheForBuild: true,
    turbopackMemoryLimit: 4096, // MB — use more RAM for fewer GC pauses
  },
  // In dev mode, proxy /readest/* to readest's dev server (port 3001) so the
  // reader window loads through the same origin and avoids Tauri remote-URL
  // permission issues.
  async rewrites() {
    if (isDev) {
      return [
        // The packaged frontend uses `reader.html`; Next's dev server exposes
        // the equivalent App Router page as `/reader`.
        {
          source: '/readest/reader.html',
          destination: 'http://localhost:3001/readest/reader',
        },
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
