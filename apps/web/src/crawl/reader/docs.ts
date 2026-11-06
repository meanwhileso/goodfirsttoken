import { MAX_SOURCE_LINE, type DocsHash, type ModelReading as StoredReading } from '@goodfirsttoken/core';
import type { PolicyFile } from '../rules';
import type { ModelReading } from './reading';
import type { CheckedPointer } from './statements';
import { READER_VERSION } from './version';

// What the Worker keeps of a model reading, and the docs hash it keeps it
// for. The docs hash decides whether the model reads: the same docs, read
// with the same reader version, cost no model call. The reading is kept as
// the admin queue shows it, with the lines as the files have them, so the
// repo's files needn't be. The design is in docs/specs/model-policy-reader.md,
// under When the model reads.

/** Raised when what the docs hash covers changes. */
export const DOCS_HASH_VERSION = 1;

/** The most text the model reads for one repo, about 130,000 tokens. More gets no verdict. */
export const MAX_DOCS_BYTES = 400_000;

/**
 * The docs hash of what the crawler read: each file's path and exact text,
 * sorted by path, and whether there is a vouch file. It holds none of the
 * repo's text.
 */
export async function docsHash(files: readonly PolicyFile[], vouch: string | null): Promise<DocsHash> {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((file) => [file.path, file.text]);
  const content = JSON.stringify({ files: sorted, vouched: vouch !== null });
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content)));
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `docs-v${String(DOCS_HASH_VERSION)}:${hex}`;
}

/** How many bytes of text the files hold, in UTF-8. */
export function docsBytes(files: readonly PolicyFile[]): number {
  const encoder = new TextEncoder();
  return files.reduce((total, file) => total + encoder.encode(file.text).length, 0);
}

/** Lines as the file has them, each cut to MAX_SOURCE_LINE characters. */
function cutLines(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.length <= MAX_SOURCE_LINE ? line : `${line.slice(0, MAX_SOURCE_LINE - 1)}…`))
    .join('\n');
}

function pointerOf(pointer: CheckedPointer) {
  return { path: pointer.file.path, startLine: pointer.startLine, endLine: pointer.endLine, lines: cutLines(pointer.lines) };
}

/** A reading as the Worker keeps it, and the admin queue shows it, for the docs hash it was made for. */
export function storedReading(reading: ModelReading, hash: DocsHash): StoredReading {
  return {
    readerVersion: reading.readerVersion,
    docsHash: hash,
    tier: reading.tier,
    modelTier: reading.modelTier,
    agree: reading.agree,
    statements: reading.statements.map((statement) => ({
      ...pointerOf(statement),
      about: statement.about,
      label: statement.label === null ? null : statement.label.slice(0, MAX_SOURCE_LINE),
      value: statement.value === null ? null : statement.value.slice(0, MAX_SOURCE_LINE),
      why: statement.why,
    })),
    dropped: reading.dropped.length,
    steering: reading.steering.map(pointerOf),
    droppedSteering: reading.droppedSteering,
    summary: reading.summary,
  };
}

/** Whether a kept reading is one this reader would make of these docs, so the model needn't read them again. */
export function readsSame(kept: { docsHash: string; readerVersion: string } | null, hash: DocsHash): boolean {
  return kept !== null && kept.docsHash === hash && kept.readerVersion === READER_VERSION;
}
