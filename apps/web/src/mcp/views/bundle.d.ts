// A view's script and styles, as scripts/mcp-views.ts builds them.
declare module '*?mcp-view' {
  const view: { script: string; style: string };
  export default view;
}
