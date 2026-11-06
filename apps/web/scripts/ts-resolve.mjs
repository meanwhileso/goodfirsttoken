// Lets Node run the Worker's TypeScript as it is: its imports leave out the
// `.ts` extension, as Vite and the Workers runtime allow, and Node's own
// resolver needs it. Node strips the types itself. Load it with
// `node --import ./apps/web/scripts/ts-resolve.mjs`.

import { registerHooks } from 'node:module';

const EXTENSIONS = ['.ts', '.tsx', '/index.ts'];

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const relative = specifier.startsWith('./') || specifier.startsWith('../');
      const missing = error?.code === 'ERR_MODULE_NOT_FOUND' || error?.code === 'ERR_UNSUPPORTED_DIR_IMPORT';
      if (!relative || !missing || /\.[cm]?[jt]sx?$/.test(specifier)) throw error;
      for (const extension of EXTENSIONS) {
        try {
          return nextResolve(`${specifier}${extension}`, context);
        } catch {
          // Try the next one.
        }
      }
      throw error;
    }
  },
});
