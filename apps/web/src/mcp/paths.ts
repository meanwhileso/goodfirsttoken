// Where the MCP server and its OAuth routes answer. Pages import these too,
// so this module imports nothing.

export const MCP_PATH = '/mcp';
export const AUTHORIZE_PATH = '/oauth/authorize';
export const TOKEN_PATH = '/oauth/token';
export const REGISTER_PATH = '/oauth/register';

/**
 * The status a page answers with, set by its server function, like the page
 * at AUTHORIZE_PATH's (src/mcp/consent.ts) and an issue page's
 * (src/issue/data.ts). src/server.ts sets the status from it and removes it,
 * so it never leaves the Worker.
 */
export const PAGE_STATUS_HEADER = 'x-gft-page-status';
