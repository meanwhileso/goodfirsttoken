import type { Client } from '@modelcontextprotocol/client';
import type { FrameLocator, Page } from '@playwright/test';

// A stand-in for a host that supports MCP Apps, for the views' browser
// tests. It does what the extension's spec (2026-01-26) asks of a host: it
// loads a view's HTML in a sandboxed frame, under the Content Security
// Policy the spec builds from the view's declared domains, answers
// ui/initialize, sends the tool call's input and answer, and passes the
// view's tool calls on. Here they go to the test, which answers them, or
// passes them to the MCP server with the donor's agent. It records every
// message the view sends.

export const VIEW_URIS = {
  'issue-cards': 'ui://goodfirsttoken/issue-cards.html',
  'live-feed': 'ui://goodfirsttoken/live-feed.html',
  'review-queue': 'ui://goodfirsttoken/review-queue.html',
} as const;
export type ViewName = keyof typeof VIEW_URIS;

export interface View {
  html: string;
  mimeType: string | undefined;
  csp: { connectDomains?: string[]; resourceDomains?: string[] };
}

/** Each view, read from the MCP server by an agent, as a host reads it. */
export async function readViews(client: Client): Promise<Record<ViewName, View>> {
  const read = async (uri: string): Promise<View> => {
    const [content] = (await client.readResource({ uri })).contents;
    if (content === undefined) throw new Error(`${uri} has no contents.`);
    const meta = content._meta as { ui?: { csp?: View['csp'] } } | undefined;
    return { html: 'text' in content ? content.text : '', mimeType: content.mimeType, csp: meta?.ui?.csp ?? {} };
  };
  return {
    'issue-cards': await read(VIEW_URIS['issue-cards']),
    'live-feed': await read(VIEW_URIS['live-feed']),
    'review-queue': await read(VIEW_URIS['review-queue']),
  };
}

/** The policy a host sets from a view's declared domains, as the spec's example builds it. */
export function hostCsp(csp: View['csp']): string {
  const resources = (csp.resourceDomains ?? []).join(' ');
  return [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline' ${resources}`,
    `style-src 'self' 'unsafe-inline' ${resources}`,
    `connect-src 'self' ${(csp.connectDomains ?? []).join(' ')}`,
    `img-src 'self' data: ${resources}`,
    `font-src 'self' ${resources}`,
    `media-src 'self' data: ${resources}`,
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
  ].join('; ');
}

export interface Message {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
}

export interface OpenedView {
  frame: FrameLocator;
  /** Every message the view sent the host, in order. */
  messages(): Promise<Message[]>;
  /** What the browser logged about the Content Security Policy. */
  violations: string[];
}

interface HostSetup {
  html: string;
  csp: string;
  input: Record<string, unknown>;
  result: unknown;
  theme: 'light' | 'dark';
}

/**
 * Opens `view` in a page as a host would, with the call's input and answer.
 * `callTool` answers each tools/call the view makes, with an MCP
 * CallToolResult.
 */
export async function openView(
  page: Page,
  view: View,
  {
    input,
    result,
    theme = 'light',
    callTool = () => Promise.reject(new Error('This test answers no tool call.')),
  }: {
    input: Record<string, unknown>;
    result: unknown;
    theme?: 'light' | 'dark';
    callTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  },
): Promise<OpenedView> {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (/Content Security Policy/i.test(message.text())) violations.push(message.text());
  });
  await page.exposeFunction('hostCallTool', callTool);
  await page.setContent('<!doctype html><html><head><title>Host</title></head><body></body></html>');
  const setup: HostSetup = { html: view.html, csp: hostCsp(view.csp), input, result, theme };
  await page.evaluate((host: HostSetup) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('title', 'Good First Token view');
    frame.style.cssText = 'width: 640px; height: 200px; border: 0; display: block;';
    // A host sets the policy on the frame's document, before anything in it runs.
    frame.srcdoc = host.html.replace('<head>', `<head>\n<meta http-equiv="Content-Security-Policy" content="${host.csp}">`);
    const recorded: unknown[] = [];
    (window as unknown as { hostMessages: unknown[] }).hostMessages = recorded;
    const call = (window as unknown as { hostCallTool: (name: string, args: unknown) => Promise<unknown> }).hostCallTool;
    const send = (message: Record<string, unknown>) => frame.contentWindow?.postMessage({ jsonrpc: '2.0', ...message }, '*');
    window.addEventListener('message', (event) => {
      if (event.source !== frame.contentWindow) return;
      const message = event.data as { id?: number; method?: string; params?: Record<string, unknown> };
      recorded.push(message);
      const reply = (result: unknown) => { send({ id: message.id, result }); };
      switch (message.method) {
        case 'ui/initialize':
          reply({
            protocolVersion: '2026-01-26',
            hostInfo: { name: 'Good First Token e2e host', version: '1.0.0' },
            hostCapabilities: { openLinks: {}, serverTools: {}, message: { text: {} }, updateModelContext: { text: {} } },
            hostContext: { theme: host.theme, displayMode: 'inline', containerDimensions: { maxHeight: 6000 } },
          });
          break;
        case 'ui/notifications/initialized':
          send({ method: 'ui/notifications/tool-input', params: { arguments: host.input } });
          send({ method: 'ui/notifications/tool-result', params: host.result });
          break;
        case 'ui/notifications/size-changed':
          if (typeof message.params?.height === 'number') frame.style.height = `${String(message.params.height)}px`;
          break;
        case 'tools/call':
          void call(String(message.params?.name), message.params?.arguments ?? {}).then(
            (result) => { reply(result); },
            (error: unknown) => { send({ id: message.id, error: { code: -32000, message: String(error) } }); },
          );
          break;
        case 'ui/open-link':
        case 'ui/message':
        case 'ui/update-model-context':
          reply({});
          break;
      }
    });
    document.body.append(frame);
  }, setup);
  return {
    frame: page.frameLocator('iframe'),
    messages: () => page.evaluate(() => (window as unknown as { hostMessages: Message[] }).hostMessages),
    violations,
  };
}

/** The messages the view sent with this method. */
export function sent(messages: Message[], method: string): Message[] {
  return messages.filter((message) => message.method === method);
}
