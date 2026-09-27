import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudflare } from '@cloudflare/vite-plugin';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// Where pages load the built files from. With STATIC_ORIGIN set, like
// https://static.example.org, every built file's URL is on that origin: the
// scripts, the styles, the fonts they name, and each file in src/assets. A
// deploy sets it from its STATIC_ORIGIN setting, which
// scripts/deploy-config.mjs has already held to https on a hostname of its
// own. The end-to-end tests set it to a stand-in for the static host on
// http. Unset, as in `pnpm dev`, the site serves them from its own origin.
function base(staticOrigin = ''): string {
  const value = staticOrigin.trim();
  if (!value) return '/';
  const url = URL.canParse(value) ? new URL(value) : null;
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.href !== `${url.origin}/`) {
    throw new Error('STATIC_ORIGIN has to be an origin with no path, like https://static.example.org.');
  }
  return url.href;
}

// Each file directly in src/assets goes into the build, named after its
// content like any file a page imports, whether a page links to it yet or
// not. A page that imports one with ?url, like the homepage's launch video,
// gets the same file. Hidden files, like a .DS_Store, stay out, and so do folders under
// it, whose files go in only when a page imports them.
function everyAsset(dir: string): Plugin {
  return {
    name: 'goodfirsttoken:every-asset',
    apply: 'build',
    applyToEnvironment: (environment) => environment.name === 'client',
    buildStart() {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || entry.name.startsWith('.')) continue;
        this.emitFile({
          type: 'asset',
          name: entry.name,
          originalFileName: `src/assets/${entry.name}`,
          source: readFileSync(path.join(dir, entry.name)),
        });
      }
    },
  };
}

// Where the local D1, Durable Objects, KV, and queues keep their data. By
// default .wrangler/state, which `pnpm dev` uses. The end-to-end tests set
// LOCAL_STATE_DIR to a folder of their own (playwright.config.ts), so data
// seeded into `pnpm dev` never reaches them. scripts/migrate-local.mjs reads
// the same setting.
function localState(dir = ''): true | { path: string } {
  return dir.trim() ? { path: dir.trim() } : true;
}

export default defineConfig({
  base: base(process.env.STATIC_ORIGIN),
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  plugins: [
    cloudflare({ viteEnvironment: { name: 'ssr' }, persistState: localState(process.env.LOCAL_STATE_DIR) }),
    tanstackStart(),
    react(),
    everyAsset(fileURLToPath(new URL('./src/assets/', import.meta.url))),
  ],
});
