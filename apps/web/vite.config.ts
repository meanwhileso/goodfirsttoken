import { readdirSync, readFileSync } from 'node:fs';
import { cloudflare } from '@cloudflare/vite-plugin';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// Where pages load the built files from. With STATIC_ORIGIN set, like
// https://static.example.org, every built file's URL is on that origin: the
// scripts, the styles, the fonts they name, and each file in src/assets. A
// deploy sets it from its STATIC_ORIGIN setting, and the end-to-end tests set
// it to a stand-in for the static host. Unset, as in `pnpm dev`, the site
// serves them from its own origin.
function base(staticOrigin = ''): string {
  const value = staticOrigin.trim();
  if (!value) return '/';
  const url = URL.canParse(value) ? new URL(value) : null;
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.href !== `${url.origin}/`) {
    throw new Error('STATIC_ORIGIN has to be an origin with no path, like https://static.example.org.');
  }
  return url.href;
}

// Every file in src/assets goes into the build, named after its content like
// any file a page imports, whether a page links to it yet or not. So the
// static host has the launch video and its poster before the homepage (#23)
// shows them. A page that imports one gets the same file.
function everyAsset(dir: URL): Plugin {
  return {
    name: 'goodfirsttoken:every-asset',
    apply: 'build',
    applyToEnvironment: (environment) => environment.name === 'client',
    buildStart() {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        this.emitFile({
          type: 'asset',
          name: entry.name,
          originalFileName: `src/assets/${entry.name}`,
          source: readFileSync(new URL(entry.name, dir)),
        });
      }
    },
  };
}

export default defineConfig({
  base: base(process.env.STATIC_ORIGIN),
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  plugins: [
    cloudflare({ viteEnvironment: { name: 'ssr' } }),
    tanstackStart(),
    react(),
    everyAsset(new URL('./src/assets/', import.meta.url)),
  ],
});
