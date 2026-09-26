// Git objects for the fake: blobs, trees, and commits, kept by object ID in
// one store that every repo shares, the way a fork shares its parent's
// objects on GitHub. IDs are 40 hex characters like Git's, from a fast hash
// of the content. They are not Git's SHA-1, so they never match a real repo.

export type Oid = string;

export interface Blob {
  type: 'blob';
  base64: string;
  size: number;
}

export interface TreeEntry {
  name: string;
  type: 'blob' | 'tree';
  oid: Oid;
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

export function writeBlob(store: ObjectStore, content: string | Uint8Array): Oid {
  const bytes = typeof content === 'string' ? encoder.encode(content) : content;
  const base64 = bytesToBase64(bytes);
  const oid = hashOid(`blob\0${base64}`);
  store[oid] = { type: 'blob', base64, size: bytes.length };
  return oid;
}

// Builds nested trees from a flat map of file path to blob ID.
export function writeTree(store: ObjectStore, files: Map<string, Oid>): Oid {
  const here = new Map<string, TreeEntry>();
  const below = new Map<string, Map<string, Oid>>();
  for (const [path, oid] of files) {
    const slash = path.indexOf('/');
    if (slash === -1) {
      here.set(path, { name: path, type: 'blob', oid });
      continue;
    }
    const dir = path.slice(0, slash);
    const sub = below.get(dir) ?? new Map<string, Oid>();
    sub.set(path.slice(slash + 1), oid);
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
  const object = store[oid];
  if (object?.type !== type) throw new Error(`the fake has no ${type} ${oid}`);
  return object as Extract<GitObject, { type: T }>;
}

// Every file in a tree, by path.
export function listFiles(store: ObjectStore, treeOid: Oid, prefix = ''): Map<string, Oid> {
  const files = new Map<string, Oid>();
  for (const entry of readObject(store, treeOid, 'tree').entries) {
    const path = prefix + entry.name;
    if (entry.type === 'blob') files.set(path, entry.oid);
    else for (const [sub, oid] of listFiles(store, entry.oid, `${path}/`)) files.set(sub, oid);
  }
  return files;
}

// The object at a path in a tree. An empty path is the tree itself.
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
    if (!entry) return null;
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
