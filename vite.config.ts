/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  test: {
    include: ['src/**/*.test.ts'],
  },
  server: {
    proxy: {
      // 本地 Node 和风代理（需另开 `cd server && npm run dev`）
      '/api/qweather': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
      // 本地等价于 Cloudflare Pages Function `/api/typhoon/*` 代理
      '/api/typhoon': {
        target: 'https://typhoon.slt.zj.gov.cn',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/typhoon/, '/Api'),
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/maplibre-gl')) return 'maplibre-gl';
          if (id.includes('node_modules/three')) return 'three';
        },
      },
    },
  },
});
