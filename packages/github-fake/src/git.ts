// Git objects for the fake: blobs, trees, and commits, kept by object ID in
// one store that every repo shares, the way a fork shares its parent's
// objects on GitHub. IDs are 40 hex characters like Git's, made with an FNV
// hash of the content, so they never match an object in a real repo.

import { own } from './own.ts';

export type Oid = string;

export interface Blob {
  type: 'blob';
  base64: string;
  size: number;
}

// A file's mode, as Git keeps it in a tree: a file, an executable file, a
// symbolic link, whose blob holds where it points, or a submodule, whose
// entry names a commit in another repo.
export type FileMode = '100644' | '100755' | '120000' | '160000';

export interface TreeEntry {
  name: string;
  // A submodule's entry is a commit, which the store doesn't have.
  type: 'blob' | 'tree' | 'commit';
  oid: Oid;
  // Only a file with a mode other than 100644 has one. State saved before
  // the fake kept modes has none.
  mode?: FileMode;
}

// A file in a tree, with its mode.
export interface FileEntry {
  oid: Oid;
  mode: FileMode;
}

// The mode GitHub gives an entry: 040000 for a folder.
export function entryMode(entry: TreeEntry): FileMode | '040000' {
  if (entry.type === 'tree') return '040000';
  return entry.mode ?? (entry.type === 'commit' ? '160000' : '100644');
}

export interface Tree {
  type: 'tree';
  entries: TreeEntry[];
}

export interface GitPerson {
  name: string;
  email: string;
  date: string;
  login: string | null;
}

export interface Commit {
  type: 'commit';
  tree: Oid;
  parents: Oid[];
  message: string;
  author: GitPerson;
  committer: GitPerson;
  signedByGitHub: boolean;
}

export type GitObject = Blob | Tree | Commit;
export type ObjectStore = Record<Oid, GitObject>;

// Five FNV-1a passes with different seeds give 160 bits, printed as 40 hex
// characters.
export function hashOid(text: string): Oid {
  let out = '';
  for (let seed = 0; seed < 5; seed++) {
    let h = (0x811c9dc5 ^ Math.imul(seed + 1, 0x9e3779b1)) >>> 0;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, '0');
  }
  return out;
}

const encoder = new TextEncoder();

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64.replace(/\s/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Text when the bytes are UTF-8 with no NUL byte, as Git's binary check does.
export function blobText(blob: Blob): string | null {
  const bytes = base64ToBytes(blob.base64);
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

// The ID a blob with this content has, whether or not it is stored.
export function blobOid(content: string | Uint8Array): Oid {
  const bytes = typeof content === 'string' ? encoder.encode(content) : content;
  return hashOid(`blob\0${bytesToBase64(bytes)}`);
}

export function writeBlob(store: ObjectStore, content: string | Uint8Array): Oid {
  const bytes = typeof content === 'string' ? encoder.encode(content) : content;
  const base64 = bytesToBase64(bytes);
  const oid = hashOid(`blob\0${base64}`);
  store[oid] = { type: 'blob', base64, size: bytes.length };
  return oid;
}

// Builds nested trees from a flat map of file path to blob ID, or to a
// file with its mode.
export function writeTree(store: ObjectStore, files: Map<string, Oid | FileEntry>): Oid {
  const here = new Map<string, TreeEntry>();
  const below = new Map<string, Map<string, Oid | FileEntry>>();
  for (const [path, file] of files) {
    const slash = path.indexOf('/');
    if (slash === -1) {
      const { oid, mode }: FileEntry = typeof file === 'string' ? { oid: file, mode: '100644' } : file;
      // A 100644 file keeps no mode, so a tree's ID is what it was before the fake kept modes.
      if (mode === '100644') here.set(path, { name: path, type: 'blob', oid });
      else here.set(path, { name: path, type: mode === '160000' ? 'commit' : 'blob', oid, mode });
      continue;
    }
    const dir = path.slice(0, slash);
    const sub = below.get(dir) ?? new Map<string, Oid | FileEntry>();
    sub.set(path.slice(slash + 1), file);
    below.set(dir, sub);
  }
  for (const [dir, sub] of below) here.set(dir, { name: dir, type: 'tree', oid: writeTree(store, sub) });
  const entries = [...here.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const oid = hashOid(`tree\0${JSON.stringify(entries)}`);
  store[oid] = { type: 'tree', entries };
  return oid;
}

export function readObject<T extends GitObject['type']>(
  store: ObjectStore,
  oid: Oid,
  type: T,
): Extract<GitObject, { type: T }> {
  const object = own(store, oid);
  if (object?.type !== type) throw new Error(`the fake has no ${type} ${oid}`);
  return object as Extract<GitObject, { type: T }>;
}

// Every file in a tree, by path, with a submodule left out.
export function listFiles(store: ObjectStore, treeOid: Oid, prefix = ''): Map<string, Oid> {
  const files = new Map<string, Oid>();
  for (const [path, file] of listEntries(store, treeOid, prefix)) {
    if (file.mode !== '160000') files.set(path, file.oid);
  }
  return files;
}

// Every file in a tree, by path, with its mode, a submodule included.
export function listEntries(store: ObjectStore, treeOid: Oid, prefix = ''): Map<string, FileEntry> {
  const files = new Map<string, FileEntry>();
  for (const entry of readObject(store, treeOid, 'tree').entries) {
    const path = prefix + entry.name;
    const mode = entryMode(entry);
    if (mode !== '040000') files.set(path, { oid: entry.oid, mode });
    else for (const [sub, file] of listEntries(store, entry.oid, `${path}/`)) files.set(sub, file);
  }
  return files;
}

// The object at a path in a tree. An empty path is the tree itself. A
// submodule's commit is in another repo, so a path to one finds nothing.
export function lookupPath(
  store: ObjectStore,
  treeOid: Oid,
  path: string,
): { oid: Oid; object: Blob | Tree } | null {
  let oid = treeOid;
  let object: Blob | Tree = readObject(store, treeOid, 'tree');
  for (const name of path.split('/').filter(Boolean)) {
    if (object.type !== 'tree') return null;
    const entry: TreeEntry | undefined = object.entries.find((e) => e.name === name);
    if (!entry || entry.type === 'commit') return null;
    oid = entry.oid;
    object = entry.type === 'blob' ? readObject(store, oid, 'blob') : readObject(store, oid, 'tree');
  }
  return { oid, object };
}

export function writeCommit(store: ObjectStore, commit: Omit<Commit, 'type'>): Oid {
  const oid = hashOid(`commit\0${JSON.stringify(commit)}`);
  store[oid] = { type: 'commit', ...commit };
  return oid;
}

// True when `ancestor` is `commit` or is reachable from it through parents.
export function isAncestor(store: ObjectStore, ancestor: Oid, commit: Oid): boolean {
  const seen = new Set<Oid>();
  const queue = [commit];
  while (queue.length > 0) {
    const oid = queue.pop() as Oid;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    queue.push(...readObject(store, oid, 'commit').parents);
  }
  return false;
}
