import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages などサブパス配信でも動くように相対パスで出力する
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    port: 5173,
  },
});
