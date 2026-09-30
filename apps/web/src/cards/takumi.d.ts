import type { CSSProperties } from 'react';

// The types of the parts of @takumi-rs/wasm the share cards use, which
// tsconfig.json points the package's name at. The package's own types
// widen React's CSSProperties for every file in the app, as a module
// augmentation, so the app keeps its own. Vite still bundles the package
// itself. The tests in test/cards/ draw and measure every card with it.

/** A box, a line of text, or an image, laid out with CSS. */
export type Node =
  | { type: 'container'; style?: CSSProperties; children?: Node[] }
  | { type: 'text'; text: string; style?: CSSProperties }
  | { type: 'image'; src: string; width?: number; height?: number; style?: CSSProperties };

export type ContainerNode = Extract<Node, { type: 'container' }>;

/** Where the renderer put a line of text, relative to its box. */
export interface MeasuredTextRun {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where the renderer put a box, with the translation of its transform in the last two places. */
export interface MeasuredNode {
  width: number;
  height: number;
  transform: [number, number, number, number, number, number];
  children: MeasuredNode[];
  runs: MeasuredTextRun[];
}

export interface RenderOptions {
  width: number;
  height: number;
  format?: 'png';
  images?: { src: string; data: Uint8Array }[];
}

export class Renderer {
  render(node: Node, options: RenderOptions): Promise<Uint8Array<ArrayBuffer>>;
  measure(node: Node, options: RenderOptions): Promise<MeasuredNode>;
  registerFont(font: { name: string; data: Uint8Array }): Promise<unknown>;
}

export function initSync(module: { module: WebAssembly.Module }): unknown;
