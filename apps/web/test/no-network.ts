import { beforeEach, vi } from 'vitest';

// Every test starts with a fetch that refuses every URL, so nothing in a
// test reaches the network, the Anthropic API least of all. A test that
// needs GitHub or the Anthropic API stubs fetch with the fakes, as
// test/anthropic.ts and test/auth/helpers.ts do.
function refuse(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new Request(input, init).url;
  return Promise.reject(new TypeError(`A test refused ${url}. Nothing in a test reaches the network. Start a fake.`));
}

beforeEach(() => {
  vi.stubGlobal('fetch', refuse);
});
