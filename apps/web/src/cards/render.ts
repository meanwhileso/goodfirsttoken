import { initSync, Renderer, type MeasuredNode } from '@takumi-rs/wasm';
import takumiWasm from '@takumi-rs/wasm/auto';
import geistMonoData from '../fonts/GeistMono-Variable.woff2?inline';
import geistData from '../fonts/Geist-Variable.woff2?inline';
import { CARD_HEIGHT, CARD_IMAGES, CARD_WIDTH, type Card } from './cards';

// Draws a share card (./cards.ts) as a PNG, with Takumi, a layout and
// drawing engine in Rust built to WebAssembly, which runs in the Worker. The
// fonts are the site's own Geist and Geist Mono files, built into the
// Worker, so a card reads no font from anywhere at render time.
// docs/architecture.md, under Share cards, says why Takumi.

/** A font file built in as a data: URL, as bytes. */
function fontBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

let ready: Promise<Renderer> | null = null;

/**
 * The one renderer this Worker's isolate draws with, made on the first card
 * it draws, with the fonts registered. A failed start is tried again next
 * time.
 */
function renderer(): Promise<Renderer> {
  ready ??= (async () => {
    initSync({ module: takumiWasm });
    const made = new Renderer();
    await made.registerFont({ name: 'Geist', data: fontBytes(geistData) });
    await made.registerFont({ name: 'Geist Mono', data: fontBytes(geistMonoData) });
    return made;
  })().catch((error: unknown) => {
    ready = null;
    throw error;
  });
  return ready;
}

const encoder = new TextEncoder();

function options() {
  return {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    images: Object.entries(CARD_IMAGES).map(([src, svg]) => ({ src, data: encoder.encode(svg) })),
  };
}

/** The card as a PNG, 1200 by 630. */
export async function renderCard(card: Card): Promise<Uint8Array<ArrayBuffer>> {
  return (await renderer()).render(card.node, { ...options(), format: 'png' });
}

/**
 * Where the renderer puts each box and each line of text on the card, in
 * pixels, as it lays the card out to draw it.
 */
export async function measureCard(card: Card): Promise<MeasuredNode> {
  return (await renderer()).measure(card.node, options());
}
