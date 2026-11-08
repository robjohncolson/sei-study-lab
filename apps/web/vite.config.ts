import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true, allowedHosts: ['127.0.0.1', 'localhost'], fs: { strict: true, allow: [fileURLToPath(new URL('.', import.meta.url)), fileURLToPath(new URL('../../packages/shared', import.meta.url)), fileURLToPath(new URL('../../node_modules', import.meta.url))], deny: ['**/runtime/**','**/.git/**','**/.env*','**/*.{pem,key,crt,sqlite,db}','**/*.{sqlite,db}-{wal,shm,journal}'] }, proxy: { '/api': { target: 'http://127.0.0.1:4317', changeOrigin: true } } },
  preview: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: { outDir: '../../dist/web', emptyOutDir: true, sourcemap: false },
});
