// The files a repo's docs are read from, for a maintainer's proposal
// (src/projects/repo.ts) and for the policy crawler (src/crawl/) alike. The
// rules are in docs/how-it-works.md, under Registering a project.

/** A file read from the repo's default branch. */
export interface RepoFile {
  /** The path in the repo, like `.github/CONTRIBUTING.md`. */
  path: string;
  text: string;
}

export type DocKind = 'contributing' | 'aiPolicy' | 'agents' | 'prTemplate';

/** The files a proposal reads. Each is null when the repo has none. */
export type RepoDocs = Record<DocKind, RepoFile | null>;

/**
 * The folders the files are looked for in, in order, each with the name its
 * listing goes by in a GraphQL query.
 */
export const DOC_FOLDERS = [
  { path: '', alias: 'root' },
  { path: '.github', alias: 'dotGithub' },
  { path: 'docs', alias: 'docs' },
] as const;

export type DocFolder = (typeof DOC_FOLDERS)[number]['path'];

/** Where each file is looked for, in order, and the names it goes by, without case. */
export const DOC_FILES: Record<DocKind, { folders: readonly DocFolder[]; name: RegExp }> = {
  contributing: { folders: ['', '.github', 'docs'], name: /^contributing(\.(md|markdown|rst|txt|adoc))?$/i },
  aiPolicy: { folders: ['', '.github', 'docs'], name: /^ai[-_]?policy(\.(md|markdown|rst|txt))?$/i },
  agents: { folders: [''], name: /^agents\.md$/i },
  prTemplate: { folders: ['', '.github', 'docs'], name: /^pull_request_template(\.(md|markdown|txt))?$/i },
};

/** Files larger than this are left unread. */
export const MAX_DOC_BYTES = 100_000;

/** An entry in a folder listing, as GitHub's GraphQL `Tree` gives it. */
export interface TreeEntry {
  name: string;
  type: string;
  size: number;
}

/** The GraphQL fields that list the folders the files are looked for in. */
export function docFolderFields(): string {
  return DOC_FOLDERS.map(
    ({ path, alias }) => `${alias}: object(expression: "HEAD:${path}") { ... on Tree { entries { name type size } } }`,
  ).join('\n');
}

/** A file in the listing that is small enough to read, by the first name that matches. */
export function readableFile(entries: readonly TreeEntry[] | undefined, name: RegExp): TreeEntry | undefined {
  return entries?.find((e) => e.type === 'blob' && name.test(e.name) && e.size <= MAX_DOC_BYTES);
}

/**
 * The path of each file the listings hold: the first whose name matches,
 * looking in the root, then `.github/`, then `docs/`, skipping a file over
 * the size limit. `listing` gives a folder's entries by its alias.
 */
export function findDocs(listing: (alias: string) => readonly TreeEntry[] | undefined): Partial<Record<DocKind, string>> {
  const paths: Partial<Record<DocKind, string>> = {};
  for (const [kind, { folders, name }] of Object.entries(DOC_FILES) as [DocKind, (typeof DOC_FILES)[DocKind]][]) {
    for (const folder of folders) {
      const alias = DOC_FOLDERS.find((f) => f.path === folder)?.alias ?? '';
      const entry = readableFile(listing(alias), name);
      if (entry) {
        paths[kind] = folder ? `${folder}/${entry.name}` : entry.name;
        break;
      }
    }
  }
  return paths;
}
