import { execSync } from 'node:child_process';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Which build this is, shown in the app so the user can tell an update arrived.
 * On GitHub Actions: the run number of the Pages workflow; locally: "dev".
 */
function buildInfo() {
  let sha = (process.env.GITHUB_SHA ?? '').slice(0, 7);
  if (!sha) {
    try {
      sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch {
      sha = '';
    }
  }
  return { number: process.env.GITHUB_RUN_NUMBER ?? 'dev', sha, time: new Date().toISOString() };
}

export default defineConfig({
  // Relative paths, so the built app works from any folder (for example a GitHub Pages project page).
  base: './',
  plugins: [react()],
  define: { __BUILD__: JSON.stringify(buildInfo()) },
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
});
