/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  test: {
    include: ['src/**/*.test.ts'],
  },
  server: {
    // 本地等价于 Cloudflare Pages Function `/api/typhoon/*` 代理
    proxy: {
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
