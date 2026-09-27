// Where local development and the Playwright tests find the GitHub fake.
// apps/web/wrangler.jsonc points the Worker at these URLs. The API is under
// /api, the way GitHub Enterprise lays it out, so one port stands in for
// both github.com and api.github.com.

export const LOCAL_PORT = 8944;
export const LOCAL_WEB_URL = `http://127.0.0.1:${String(LOCAL_PORT)}`;
export const LOCAL_API_URL = `${LOCAL_WEB_URL}/api`;
