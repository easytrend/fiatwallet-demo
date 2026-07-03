import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';

// Writes a unique timestamp to public/build-version.txt on every build.
// App.jsx polls this file to detect when a new deployment is live.
function buildVersionPlugin() {
  return {
    name: 'build-version-plugin',
    buildStart() {
      try {
        const timestamp = Date.now().toString();
        const publicDir = path.resolve(process.cwd(), 'public');
        if (!fs.existsSync(publicDir)) {
          fs.mkdirSync(publicDir, { recursive: true });
        }
        fs.writeFileSync(path.join(publicDir, 'build-version.txt'), timestamp);
      } catch (e) {
        console.warn('Could not write build version:', e);
      }
    }
  };
}

export default defineConfig({
  plugins: [react(), buildVersionPlugin()],
  optimizeDeps: {
    include: ['buffer'],
  },
  resolve: {
    alias: {
      buffer: 'buffer',
    },
  },
  define: {
    'process.env': {},
    global: 'globalThis',
  },
});
