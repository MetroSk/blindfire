import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The client lives in /client. BASE_PATH lets GitHub Pages serve it from /<repo>/.
export default defineConfig({
  root: 'client',
  base: process.env.BASE_PATH || '/',
  plugins: [react()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
  test: {
    root: '.',
    include: ['tests/**/*.test.ts'],
  },
} as any);
