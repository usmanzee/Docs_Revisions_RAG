import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The dev server proxies /api to the backend rather than enabling wide-open
 * CORS. That keeps the browser on one origin, which is also how the app would
 * be served in production behind a reverse proxy.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiPort = env.API_PORT ?? '3000';
  const webPort = Number(env.WEB_PORT ?? 5173);

  return {
    plugins: [react()],
    server: {
      port: webPort,
      strictPort: false,
      proxy: {
        '/api': {
          target: `http://localhost:${apiPort}`,
          changeOrigin: true,
          // Server-Sent Events must not be buffered by the proxy.
          configure: (proxy) => {
            proxy.on('proxyRes', (proxyRes) => {
              if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
                proxyRes.headers['cache-control'] = 'no-cache, no-transform';
              }
            });
          },
        },
      },
    },
    build: { outDir: 'dist', sourcemap: true },
  };
});
