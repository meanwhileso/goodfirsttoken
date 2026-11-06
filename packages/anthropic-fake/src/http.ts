// The Anthropic API's error bodies and the status that goes with each kind.
// https://platform.claude.com/docs/en/api/errors

export const ERROR_STATUS = {
  invalid_request_error: 400,
  authentication_error: 401,
  billing_error: 402,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  timeout_error: 504,
  overloaded_error: 529,
} as const;

export type ErrorType = keyof typeof ERROR_STATUS;

const TYPE_OF_STATUS = new Map<number, ErrorType>(
  Object.entries(ERROR_STATUS).map(([type, status]) => [status, type as ErrorType]),
);

/** The kind of error the API sends with a status. */
export function errorTypeOf(status: number): ErrorType {
  return TYPE_OF_STATUS.get(status) ?? (status >= 500 ? 'api_error' : 'invalid_request_error');
}

export interface ApiError {
  type: ErrorType;
  message: string;
}

const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** A random ID like the API's, such as msg_ and 24 letters and digits. */
export function newId(prefix: string): string {
  let id = '';
  while (id.length < 24) {
    for (const byte of crypto.getRandomValues(new Uint8Array(24))) {
      const char = ALPHANUMERIC[byte & 63];
      if (char !== undefined && id.length < 24) id += char;
    }
  }
  return `${prefix}${id}`;
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'request-id': newId('req_'), ...headers },
  });
}

/** An error the way the API sends one. A 429 says when to try again. */
export function errorResponse(status: number, error: Partial<ApiError> = {}): Response {
  const type = error.type ?? errorTypeOf(status);
  const message = error.message ?? defaultMessage(type);
  const requestId = newId('req_');
  const headers: Record<string, string> = { 'request-id': requestId };
  if (status === 429) headers['retry-after'] = '30';
  if (status === 529 || type === 'overloaded_error') headers['x-should-retry'] = 'true';
  return json({ type: 'error', error: { type, message }, request_id: requestId }, status, headers);
}

function defaultMessage(type: ErrorType): string {
  switch (type) {
    case 'authentication_error':
      return 'invalid x-api-key';
    case 'permission_error':
      return 'Your API key does not have permission to use the specified resource.';
    case 'not_found_error':
      return 'Not found';
    case 'rate_limit_error':
      return 'Number of requests has exceeded your rate limit.';
    case 'overloaded_error':
      return 'Overloaded';
    case 'billing_error':
      return 'Your credit balance is too low to access the Anthropic API.';
    case 'request_too_large':
      return 'Request exceeds the maximum allowed number of bytes.';
    case 'api_error':
      return 'Internal server error';
    case 'timeout_error':
      return 'Request timed out';
    case 'invalid_request_error':
      return 'Invalid request';
  }
}
