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
          // An image or a font the styles named would be a file of its
          // own, which a host would have to let the view load. None is
          // inlined, so the check below stops the build at one.
          assetsInlineLimit: 0,
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
      return `export default ${JSON.stringify(view)};`;
    },
  };
}
