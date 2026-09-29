import path from 'node:path';
import { build, type Plugin, type Rolldown } from 'vite';

// Builds the views MCP Apps hosts show (src/mcp/views/) for the Worker to
// serve as ui:// resources. A view is one HTML file with its script and
// styles inline, since a host loads it in a sandboxed frame that may load
// nothing else. So `import view from './views/main.ts?mcp-view'` gives the
// Worker the view's script and styles as strings: the entry and everything
// it imports, its CSS included, bundled and minified by Vite's own build.
// vite.config.ts and vitest.config.ts both use this plugin, so pnpm dev, the
// production build, and the tests serve the same view.

const QUERY = '?mcp-view';

/**
 * The most a view's script and styles may hold together, in bytes of UTF-8.
 * A host reads the page over MCP each time it shows the view, and may keep
 * it. They hold about 36 KB today.
 */
export const MAX_VIEW_BYTES = 64 * 1024;

/**
 * Why the built script and styles can't make a view, or null when they can.
 * A view's styles may name no file and import none: Vite writes a font or an
 * image the styles name into them as a data: URL, which a host's policy may
 * refuse, and which makes the page as big as the file.
 */
export function viewProblem(view: ViewBundle): string | null {
  if (/url\(/i.test(view.style)) return "its styles name a file with url(), which a view can't load";
  if (/@import/i.test(view.style)) return "its styles @import another stylesheet, which a view can't load";
  const bytes = new TextEncoder().encode(view.script + view.style).length;
  if (bytes > MAX_VIEW_BYTES) return `its script and styles hold ${String(bytes)} bytes, over the ${String(MAX_VIEW_BYTES)} a view may`;
  return null;
}

/** What a `?mcp-view` import gives. */
export interface ViewBundle {
  script: string;
  style: string;
}

export function mcpViews(): Plugin {
  return {
    name: 'goodfirsttoken:mcp-views',
    async load(id) {
      if (!id.endsWith(QUERY)) return null;
      const entry = id.slice(0, -QUERY.length);
      const built = await build({
        configFile: false,
        logLevel: 'silent',
        root: path.dirname(entry),
        publicDir: false,
        build: {
          write: false,
          lib: { entry, formats: ['iife'], name: 'goodFirstTokenView', fileName: 'view', cssFileName: 'view' },
          minify: true,
          target: 'es2022',
        },
      });
      const outputs = (Array.isArray(built) ? built : [built]) as Rolldown.RolldownOutput[];
      const files = outputs.flatMap((output) => output.output);
      const chunks = files.filter((file): file is Rolldown.OutputChunk => file.type === 'chunk');
      const assets = files.filter((file): file is Rolldown.OutputAsset => file.type === 'asset');
      const extra = assets.filter((asset) => !asset.fileName.endsWith('.css'));
      if (chunks.length !== 1 || extra.length > 0) {
        throw new Error(`${entry} has to build to one script and its styles, with no other file.`);
      }
      const [chunk] = chunks as [Rolldown.OutputChunk];
      for (const module of chunk.moduleIds) {
        if (path.isAbsolute(module)) this.addWatchFile(module);
      }
      const view: ViewBundle = {
        script: chunk.code,
        style: assets.map((asset) => String(asset.source)).join('\n'),
      };
      const problem = viewProblem(view);
      if (problem !== null) throw new Error(`${entry} can't be a view: ${problem}.`);
      return `export default ${JSON.stringify(view)};`;
    },
  };
}
