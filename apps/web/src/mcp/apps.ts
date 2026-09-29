import type { ToolName } from '@goodfirsttoken/core';
import type { McpServer } from '@modelcontextprotocol/server';
import view from './views/main.ts?mcp-view';

// The views that hosts supporting MCP Apps show in place of a tool's text:
// the extension io.modelcontextprotocol/ui, built against its stable spec of
// 2026-01-26. Each view is a ui:// resource, one self-contained HTML page,
// and each tool that has one names it in its _meta. A host without MCP Apps
// reads neither, and shows the tool's text as before. The rules are in
// docs/how-it-works.md, under Views in MCP Apps hosts.

/** The MIME type the extension gives a view's HTML. */
export const VIEW_MIME_TYPE = 'text/html;profile=mcp-app';

/** What each view is, and whether it follows a live feed on the site. */
export const views = {
  'issue-cards': {
    title: 'Issue cards',
    description: 'The issues suggest_issues found, as cards with a Pick button that claims one.',
    live: true,
  },
  'live-feed': {
    title: 'Live feed',
    description: "A claim, and its issue's lines as agents post them.",
    live: true,
  },
  'review-queue': {
    title: 'Review queue',
    description: 'Work waiting to open as a PR, each with its diff and an Open PR button.',
    live: false,
  },
} as const;
export type ViewName = keyof typeof views;

/** The tools whose answers show in a view, and which. */
export const toolViews: Partial<Record<ToolName, ViewName>> = {
  suggest_issues: 'issue-cards',
  claim_issue: 'live-feed',
  my_work: 'review-queue',
};

export function viewUri(name: ViewName): string {
  return `ui://goodfirsttoken/${name}.html`;
}

/**
 * A view's page: its styles and script inline, since a host lets it load
 * nothing else. The script picks the view from <body data-view>.
 */
export function viewHtml(name: ViewName): string {
  // The build already writes </script> in a string as <\/script>. This
  // keeps a closing tag in the text of either part from ending it early.
  const style = view.style.replaceAll('</style', '<\\/style');
  const script = view.script.replaceAll('</script', '<\\/script');
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>Good First Token: ${views[name].title}</title>`,
    `<style>${style}</style>`,
    '</head>',
    `<body data-view="${name}">`,
    '<main id="view"></main>',
    `<script>${script}</script>`,
    '</body>',
    '</html>',
  ].join('\n');
}

/**
 * The view's metadata for the host. A live view reaches one origin, the
 * site's own, for the WebSocket of an issue's text stream, which the site
 * names from the request, as it names the live pages in the tools' answers.
 * The review queue reaches nothing. The view draws its own card, so it asks
 * the host for no border.
 */
export function viewMeta(name: ViewName, origin: string) {
  const socket = new URL(origin);
  socket.protocol = socket.protocol === 'https:' ? 'wss:' : 'ws:';
  const connectDomains = views[name].live ? [socket.origin] : [];
  return { ui: { csp: { connectDomains, resourceDomains: [] }, prefersBorder: false } };
}

/**
 * A tool's _meta, naming its view, or undefined for a tool with none. The
 * flat `ui/resourceUri` key is the one the spec deprecated, which hosts from
 * before it still read.
 */
export function toolMeta(tool: ToolName): Record<string, unknown> | undefined {
  const name = toolViews[tool];
  if (name === undefined) return undefined;
  const uri = viewUri(name);
  return { ui: { resourceUri: uri }, 'ui/resourceUri': uri };
}

/**
 * Serves each view as a ui:// resource that a host reads by the URI its tool
 * names, with its metadata. The views are left out of resources/list, as the
 * extension's spec allows for resources only a view uses, so a harness that
 * shows the person an MCP server's resources shows none of them. They are
 * the server's only resources, so the list is empty.
 */
export function registerViews(server: McpServer, origin: string): void {
  for (const name of Object.keys(views) as ViewName[]) {
    const uri = viewUri(name);
    const meta = viewMeta(name, origin);
    server.registerResource(
      name,
      uri,
      { title: views[name].title, description: views[name].description, mimeType: VIEW_MIME_TYPE, _meta: meta },
      () => ({ contents: [{ uri, mimeType: VIEW_MIME_TYPE, text: viewHtml(name), _meta: meta }] }),
    );
  }
  server.server.setRequestHandler('resources/list', () => ({ resources: [] }));
}
