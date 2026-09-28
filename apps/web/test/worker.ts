import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import worker from '../src/server';

// How a test sends a request to the whole Worker: it calls the fetch of the
// Worker's default export itself, with the Worker's bindings. Requests
// through exports.default.fetch get slower one after another in a test file,
// as docs/architecture.md says under Tests.

/**
 * Sends a request to the Worker with a new execution context, waits for the
 * work the Worker handed to waitUntil, and gives back the response as the
 * Worker made it. The request comes in with its redirect mode set to manual,
 * as a request from the internet does, and a redirect comes back as it is.
 * Work handed to waitUntil that lasts as long as a stream would hold the
 * stream's response back.
 */
export async function workerFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  // The type of a request that reaches the Worker has the cf properties
  // Cloudflare adds. A test's request has none, as over
  // exports.default.fetch, and the Worker reads none.
  const request = new Request(input, { ...init, redirect: 'manual' }) as Parameters<typeof worker.fetch>[0];
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
