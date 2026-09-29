import type { Client } from '@modelcontextprotocol/client';
import type { FrameLocator, Page } from '@playwright/test';

// A stand-in for a host that supports MCP Apps, for the views' browser
// tests. It does what the extension's spec (2026-01-26) asks of a host: it
// loads a view's HTML in a sandboxed frame, under the Content Security
// Policy the spec builds from the view's declared domains, answers
// ui/initialize, sends the tool call's input and answer, and passes the
// view's tool calls on. Here they go to the test, which answers them, or
// passes them to the MCP server with the donor's agent. It records every
// message the view sends, can send the view more, and can refuse what the
// view asks, as a host may.

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

/** Each view, read from the MCP server by an agent by its URI, as a host reads it. */
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
  result?: unknown;
  error?: unknown;
}

/** What a host can ask of a view, or refuse it. */
export type Refusable = 'ui/initialize' | 'ui/open-link' | 'ui/message' | 'ui/update-model-context';

/**
 * How the host refuses: with a JSON-RPC error, or with a result that says
 * `isError: true`, which the spec's result types allow.
 */
export type Refusal = 'error' | 'isError';

export interface OpenedView {
  frame: FrameLocator;
  /** Every message the view sent the host, in order. */
  messages(): Promise<Message[]>;
  /** Sends the view a message from the host, as a JSON-RPC notification. */
  send(message: Message): Promise<void>;
  /** Sends the view a message from another frame on the page, beside it, which a view has to ignore. */
  forge(message: Message): Promise<void>;
  /** What the browser logged about the Content Security Policy. */
  violations: string[];
}

interface HostSetup {
  html: string;
  csp: string;
  input: Record<string, unknown>;
  result: unknown;
  theme: 'light' | 'dark';
  refuse: Partial<Record<Refusable, Refusal>>;
}

const FRAME = 'iframe[title="Good First Token view"]';

/**
 * Opens `view` in a page as a host would, with the call's input and answer.
 * `callTool` answers each tools/call the view makes, with an MCP
 * CallToolResult. `refuse` names what the host refuses, and how.
 */
export async function openView(
  page: Page,
  view: View,
  {
    input,
    result,
    theme = 'light',
    refuse = {},
    callTool = () => Promise.reject(new Error('This test answers no tool call.')),
  }: {
    input: Record<string, unknown>;
    result: unknown;
    theme?: 'light' | 'dark';
    refuse?: Partial<Record<Refusable, Refusal>>;
    callTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  },
): Promise<OpenedView> {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (/Content Security Policy/i.test(message.text())) violations.push(message.text());
  });
  await page.exposeFunction('hostCallTool', callTool);
  await page.setContent('<!doctype html><html><head><title>Host</title></head><body></body></html>');
  const setup: HostSetup = { html: view.html, csp: hostCsp(view.csp), input, result, theme, refuse };
  await page.evaluate((host: HostSetup) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('title', 'Good First Token view');
    frame.style.cssText = 'width: 640px; height: 200px; border: 0; display: block;';
    // A host sets the policy on the frame's document, before anything in it runs.
    frame.srcdoc = host.html.replace('<head>', `<head>\n<meta http-equiv="Content-Security-Policy" content="${host.csp}">`);
    const recorded: unknown[] = [];
    const hosted = window as unknown as {
      hostMessages: unknown[];
      hostSend: (message: Record<string, unknown>) => void;
      hostCallTool: (name: string, args: unknown) => Promise<unknown>;
    };
    hosted.hostMessages = recorded;
    const send = (message: Record<string, unknown>) => {
      // The view's sandboxed frame has no origin to name, so the host posts to any.
      frame.contentWindow?.postMessage({ jsonrpc: '2.0', ...message }, '*'); // nosemgrep: javascript.browser.security.wildcard-postmessage-configuration.wildcard-postmessage-configuration
    };
    hosted.hostSend = send;
    window.addEventListener('message', (event) => {
      if (event.source !== frame.contentWindow) return;
      const message = event.data as { id?: number; method?: string; params?: Record<string, unknown> };
      recorded.push(message);
      const reply = (result: unknown) => { send({ id: message.id, result }); };
      const refusal = message.method === undefined ? undefined : host.refuse[message.method as Refusable];
      if (refusal === 'error') {
        send({ id: message.id, error: { code: -32000, message: `The host refused ${String(message.method)}.` } });
        return;
      }
      if (refusal === 'isError') {
        reply({ isError: true });
        return;
      }
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
          void hosted.hostCallTool(String(message.params?.name), message.params?.arguments ?? {}).then(
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
    frame: page.frameLocator(FRAME),
    messages: () => page.evaluate(() => (window as unknown as { hostMessages: Message[] }).hostMessages),
    send: (message) => page.evaluate((m) => { (window as unknown as { hostSend: (m: Message) => void }).hostSend(m); }, message),
    forge: (message) =>
      page.evaluate((json) => {
        // A frame beside the view, on the same page, posts to it as the host would.
        const sibling = document.createElement('iframe');
        sibling.setAttribute('sandbox', 'allow-scripts');
        sibling.setAttribute('title', 'Another frame');
        const post = `parent.frames[0].postMessage(${json}, '*');`;
        sibling.srcdoc = `<!doctype html><script>${post}</script>`;
        document.body.append(sibling);
      }, JSON.stringify({ jsonrpc: '2.0', ...message }).replaceAll('<', '\\u003c')),
    violations,
  };
}

/** The messages the view sent with this method. */
export function sent(messages: Message[], method: string): Message[] {
  return messages.filter((message) => message.method === method);
}

/** The WCAG contrast of an element's text on its background, where the background is the first one set on it or an ancestor. */
export async function contrastOf(frame: FrameLocator, selector: string): Promise<{ text: string; background: string; ratio: number }> {
  return frame.locator(selector).first().evaluate((element) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (context === null) throw new Error('No canvas.');
    // Any CSS color, color-mix() and color() included, as sRGB bytes and alpha.
    const rgba = (color: string): [number, number, number, number] => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = '#000';
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a];
    };
    const luminance = ([r, g, b]: number[]) => {
      const [lr = 0, lg = 0, lb = 0] = [r ?? 0, g ?? 0, b ?? 0].map((c) => {
        const s = c / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
    };
    let node: Element | null = element;
    let background = 'rgba(0, 0, 0, 0)';
    while (node !== null) {
      const color = getComputedStyle(node).backgroundColor;
      if (rgba(color)[3] > 0) {
        background = color;
        break;
      }
      node = node.parentElement;
    }
    const text = getComputedStyle(element).color;
    const [a, b] = [luminance(rgba(text)), luminance(rgba(background))].sort((x, y) => y - x) as [number, number];
    return { text: rgba(text).join(','), background: rgba(background).join(','), ratio: (a + 0.05) / (b + 0.05) };
  });
}
