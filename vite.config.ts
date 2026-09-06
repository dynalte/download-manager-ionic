import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // Chemins relatifs : obligatoire pour le chargement file:// dans Electron.
  base: './',
  server: {
    port: 8100,
  },
  preview: {
    port: 8100,
  },
});
