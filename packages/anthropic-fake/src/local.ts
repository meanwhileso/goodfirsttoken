// Where local development finds the Anthropic fake. apps/web/wrangler.jsonc
// points the Worker's ANTHROPIC_API_URL here. The GitHub fake is on the port
// before it.

export const LOCAL_PORT = 8945;
export const LOCAL_URL = `http://127.0.0.1:${String(LOCAL_PORT)}`;
