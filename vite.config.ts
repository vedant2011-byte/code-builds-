import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const page = (name: string) => fileURLToPath(new URL(`./${name}`, import.meta.url));

/**
 * The Worker serves clean URLs in production; mirror that in `vite dev` so both
 * environments use the same addresses.
 */
const cleanUrls: Plugin = {
  name: 'code-builts-clean-urls',
  configureServer(server) {
    server.middlewares.use((request, _response, next) => {
      if (!request.url) return next();
      const [pathname, search] = request.url.split('?');
      const suffix = search ? `?${search}` : '';
      if (pathname === '/the-letter' || pathname === '/the-letter/') {
        request.url = `/the-letter.html${suffix}`;
      } else if (pathname === '/admin' || pathname.startsWith('/admin/')) {
        request.url = `/admin.html${suffix}`;
      }
      next();
    });
  },
};

export default defineConfig({
  plugins: [cleanUrls],
  build: {
    target: 'es2020',
    assetsInlineLimit: 2048,
    rollupOptions: {
      input: {
        main: page('index.html'),
        letter: page('the-letter.html'),
        admin: page('admin.html'),
      },
    },
  },
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: false,
      },
    },
  },
});
