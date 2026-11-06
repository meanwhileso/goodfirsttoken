import { createAnthropicFake, type AnthropicFake } from '@goodfirsttoken/anthropic-fake';
import type { GitHubFake } from '@goodfirsttoken/github-fake';
import { env } from 'cloudflare:workers';
import { vi } from 'vitest';

// The Anthropic fake for the Worker's tests, at the URL vitest.config.ts
// gives the Worker, taking only the test-only key it gives. Nothing in a
// test calls the real API.

/** A fresh Anthropic fake that takes the Worker's test key, at its URL. */
export function createTestAnthropic(): AnthropicFake {
  return createAnthropicFake({ url: env.ANTHROPIC_API_URL, apiKey: env.ANTHROPIC_API_KEY });
}

/**
 * A fetch that sends each call to the fake whose URLs it is under, and
 * throws for any other, so a call to another host fails the test.
 */
export function fakeNetwork(fakes: { anthropic: AnthropicFake; github?: GitHubFake }): typeof fetch {
  return async (input, init) => {
    const url = new Request(input, init).url;
    const anthropic = new URL(fakes.anthropic.url);
    if (new URL(url).origin === anthropic.origin && url.startsWith(fakes.anthropic.url)) return fakes.anthropic.fetch(input, init);
    if (fakes.github) return fakes.github.fetch(input, init);
    throw new TypeError(`A test refused ${url}. Nothing in a test reaches the network.`);
  };
}

/** A fresh Anthropic fake, beside the GitHub fake when one is given, standing in for the global fetch. */
export function startAnthropic(github?: GitHubFake): AnthropicFake {
  const anthropic = createTestAnthropic();
  vi.stubGlobal('fetch', fakeNetwork({ anthropic, github }));
  return anthropic;
}
