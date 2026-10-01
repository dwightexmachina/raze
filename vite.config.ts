import { defineConfig } from 'vite';

export default defineConfig({
  // relative base so the build works on a GitHub Pages project page
  // (https://dwightexmachina.github.io/raze/) and anywhere else
  base: './',
  build: {
    rollupOptions: {
      output: {
        // vendor chunks cache independently of game-code changes
        manualChunks: {
          three: ['three'],
          rapier: ['@dimforge/rapier3d-compat'],
        },
      },
    },
  },
});
