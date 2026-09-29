// A view's side of MCP Apps, the extension io.modelcontextprotocol/ui, as
// its stable spec of 2026-01-26 sets it out: JSON-RPC 2.0 over postMessage
// with the host that framed the view. The host stands between the view and
// the MCP server, and calls tools with the donor's own connection. The view
// holds no token and reaches no API itself. The extension's SDK does the
// same in its App class, which brings zod and the MCP SDK with it, so the
// view speaks the few messages it needs itself.

/** The version of the extension's spec the views speak. */
export const APPS_PROTOCOL_VERSION = '2026-01-26';

/** A tool's answer, as a view reads it. */
export interface ToolAnswer {
  /** A refusal, or an error the host or the server gave. */
  isError: boolean;
  /** The answer's text, which a terminal harness shows. */
  text: string;
  /** The answer's structured content, or null when it has none. */
  data: unknown;
}

/** What the host says about itself, as far as a view uses it. */
export interface HostContext {
  theme?: unknown;
}

export interface Handlers {
  /** The arguments of the tool call the view shows. */
  input(args: Record<string, unknown>): void;
  /** The answer of the tool call the view shows. */
  result(answer: ToolAnswer): void;
  /** The tool call was cancelled before it answered. */
  cancelled(reason: string): void;
  /** The host's context when the view starts, then each change to it, which holds only the fields that changed. */
  context(context: HostContext): void;
  /** The host is about to take the view down. */
  teardown(): void;
}

export interface Host {
  /** Calls one of the server's tools through the host. */
  callTool(name: string, args: Record<string, unknown>): Promise<ToolAnswer>;
  /** Asks the host to open a link. Throws when the host refuses. */
  openLink(url: string): Promise<void>;
  /** Puts a message from the person into the conversation, which the agent answers. Throws when the host refuses. */
  message(text: string): Promise<void>;
  /** Tells the agent something for its next turn, without a message. Throws when the host refuses. */
  updateContext(text: string): Promise<void>;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A CallToolResult as a view reads it. Text parts are joined with line breaks. */
export function answerOf(result: unknown): ToolAnswer {
  if (!isObject(result)) return { isError: true, text: 'The host sent no answer.', data: null };
  const content = Array.isArray(result.content) ? (result.content as unknown[]) : [];
  const text = content
    .filter((part): part is Json => isObject(part) && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n');
  return {
    isError: result.isError === true,
    text,
    data: isObject(result.structuredContent) ? result.structuredContent : null,
  };
}

/**
 * Connects to the host: `ui/initialize`, then `ui/notifications/initialized`.
 * Then the host sends the tool call's input and answer, which go to the
 * handlers. Only messages from the frame's parent count. The view reports
 * its size as it changes, so the host can fit the frame to it.
 */
export async function connect(handlers: Handlers, appInfo: { name: string; version: string }): Promise<Host> {
  let next = 1;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const send = (message: Json) => {
    // A sandboxed view can't know its host's origin, so it posts to any, and takes messages from its parent window alone.
    window.parent.postMessage({ jsonrpc: '2.0', ...message }, '*'); // nosemgrep: javascript.browser.security.wildcard-postmessage-configuration.wildcard-postmessage-configuration
  };
  const request = (method: string, params: Json): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = next++;
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    });
  const notify = (method: string, params?: Json) => { send(params === undefined ? { method } : { method, params }); };
  // A host can refuse with an error, or with a result that says isError.
  const ask = async (method: string, params: Json): Promise<void> => {
    const result = await request(method, params);
    if (isObject(result) && result.isError === true) throw new Error(`The host refused ${method}.`);
  };

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || !isObject(event.data) || event.data.jsonrpc !== '2.0') return;
    const message = event.data;
    const method = typeof message.method === 'string' ? message.method : null;
    const params = isObject(message.params) ? message.params : {};
    if (method === null) {
      // An answer to one of the view's requests.
      const waiting = typeof message.id === 'number' ? pending.get(message.id) : undefined;
      if (!waiting || typeof message.id !== 'number') return;
      pending.delete(message.id);
      if (isObject(message.error)) {
        waiting.reject(new Error(typeof message.error.message === 'string' ? message.error.message : 'The host refused.'));
      } else {
        waiting.resolve(message.result);
      }
      return;
    }
    if ('id' in message) {
      // The host asks something of the view. It closes the view after
      // ui/resource-teardown, and checks it is there with ping.
      if (method === 'ui/resource-teardown') handlers.teardown();
      if (method === 'ui/resource-teardown' || method === 'ping') send({ id: message.id, result: {} });
      else send({ id: message.id, error: { code: -32601, message: `The view doesn't answer ${method}.` } });
      return;
    }
    if (method === 'ui/notifications/tool-input') {
      handlers.input(isObject(params.arguments) ? params.arguments : {});
    } else if (method === 'ui/notifications/tool-result') {
      handlers.result(answerOf(params));
    } else if (method === 'ui/notifications/tool-cancelled') {
      handlers.cancelled(typeof params.reason === 'string' ? params.reason : '');
    } else if (method === 'ui/notifications/host-context-changed') {
      handlers.context(params);
    }
  });

  const initialized = await request('ui/initialize', {
    appInfo,
    appCapabilities: { availableDisplayModes: ['inline'] },
    protocolVersion: APPS_PROTOCOL_VERSION,
  });
  if (isObject(initialized) && isObject(initialized.hostContext)) handlers.context(initialized.hostContext);
  notify('ui/notifications/initialized');
  reportSize((size) => { notify('ui/notifications/size-changed', size); });

  return {
    callTool: async (name, args) => {
      try {
        return answerOf(await request('tools/call', { name, arguments: args }));
      } catch (error) {
        return { isError: true, text: error instanceof Error ? error.message : String(error), data: null };
      }
    },
    openLink: (url) => ask('ui/open-link', { url }),
    message: (text) => ask('ui/message', { role: 'user', content: [{ type: 'text', text }] }),
    updateContext: (text) => ask('ui/update-model-context', { content: [{ type: 'text', text }] }),
  };
}

/**
 * Sends the view's size whenever it changes, once a frame at most: the
 * window's width, and the height of everything in it.
 */
function reportSize(send: (size: { width: number; height: number }) => void): void {
  let scheduled = false;
  let last = { width: 0, height: 0 };
  const measure = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const html = document.documentElement;
      const height = html.style.height;
      html.style.height = 'max-content';
      const size = { width: Math.ceil(window.innerWidth), height: Math.ceil(html.getBoundingClientRect().height) };
      html.style.height = height;
      if (size.width === last.width && size.height === last.height) return;
      last = size;
      send(size);
    });
  };
  measure();
  const observer = new ResizeObserver(measure);
  observer.observe(document.documentElement);
  observer.observe(document.body);
}
