// Builds a view's elements. Text from GitHub and from other people, like an
// issue title, a label, or a line an agent posted, only ever goes into the
// page as a text node, so markup in it shows as the characters it is. No
// view sets innerHTML, and no attribute here runs script.

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, string | number | boolean | null | undefined>;

/** An element with these attributes and children. Strings become text nodes. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs | null = null,
  ...children: (Child | readonly Child[])[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    // Handlers go on with addEventListener. An attribute that would run script is refused.
    if (/^on/i.test(name)) throw new Error(`A view never sets ${name} as an attribute.`);
    element.setAttribute(name, value === true ? '' : String(value));
  }
  append(element, children);
  return element;
}

/** Adds the children, strings as text nodes. */
export function append(parent: Node, children: readonly (Child | readonly Child[])[]): void {
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** The hosts that may take http, the ones on this machine, as in local development. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * A web page a view may open: an https URL, or an http one on this machine.
 * Anything else, like a javascript: or data: URL, is null, and a view shows
 * its text alone.
 */
export function webLink(url: unknown): string | null {
  if (typeof url !== 'string' || !URL.canParse(url)) return null;
  const parsed = new URL(url);
  if (parsed.protocol === 'https:') return parsed.href;
  return parsed.protocol === 'http:' && LOCAL_HOSTS.has(parsed.hostname) ? parsed.href : null;
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>): SVGElementTagNameMap[K] {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
  return element;
}

/** The ring-and-dot token, as LogoChip in src/components draws it. */
export function tokenMark(): SVGSVGElement {
  const mark = svg('svg', { viewBox: '0 0 36 36', 'aria-hidden': 'true', focusable: 'false' });
  mark.appendChild(svg('circle', { cx: '18', cy: '18', r: '14', fill: 'none', stroke: 'currentColor', 'stroke-width': '4' }));
  mark.appendChild(svg('circle', { cx: '18', cy: '18', r: '6', fill: 'currentColor' }));
  return mark;
}
