import {
  OPEN_DATA_LICENSE,
  OPEN_DATA_LICENSE_URL,
  openProjectFileSchema,
  openProjectsFileSchema,
  PROJECTS_JSON_PAGE,
  repoName,
  validate,
  type OpenProject,
  type OpenProjectFile,
  type OpenProjectsFile,
  type ProjectRecord,
} from '@goodfirsttoken/core';
import { env } from 'cloudflare:workers';
import { getProject, listProjectsWithPage } from '../db';
import { repoFromPath } from '../issue/path';
import { hasPage } from '../project/shown';
import { markdownPath } from './head';

// The JSON data: every project with a page, with its settings, under CC0, at
// /projects.json, a page of them at a time, and one project at
// /<owner>/<repo>.json. A project is in them exactly when it has a page
// (hasPage in src/project/shown.ts, and HAS_PAGE in src/db/waiting.ts):
// approved or paused, not delisted, and off the do-not-list. Each file is
// checked against its schema in packages/core before it goes out.

/** One project as the JSON data gives it. */
export function openProject(origin: string, project: ProjectRecord): OpenProject {
  const page = `${origin}/${project.repo}`;
  return {
    repo: project.repo,
    status: project.status === 'paused' ? 'paused' : 'approved',
    source: project.source,
    // The page shows the quote and its link, and nothing else of the policy.
    policy: project.source === 'policy' && project.policy ? { quote: project.policy.quote, url: project.policy.url } : null,
    settings: project.settings,
    links: {
      page,
      markdown: `${origin}${markdownPath(`/${project.repo}`)}`,
      json: `${page}.json`,
      live: `${page}/live.txt`,
      github: `https://github.com/${project.repo}`,
    },
  };
}

export type ProjectsFileResult =
  | { state: 'ready'; file: OpenProjectsFile }
  /** `after` isn't a repo. */
  | { state: 'bad_after' }
  | { state: 'unavailable' };

/**
 * A page of /projects.json: the projects with a page whose repo comes after
 * `after`, by repo, `size` of them at most.
 */
export async function loadProjectsFile(
  origin: string,
  after: string | null,
  size = PROJECTS_JSON_PAGE,
): Promise<ProjectsFileResult> {
  if (after !== null && !validate(repoName, after).ok) return { state: 'bad_after' };
  try {
    // One more than a page, to tell whether another page follows.
    const read = await listProjectsWithPage(env.DB, { ...(after === null ? {} : { after }), limit: size + 1 });
    const { total } = read;
    const projects = read.projects.slice(0, size);
    const last = projects.at(-1);
    // The next page's link starts after this page's last repo.
    const next =
      read.projects.length > size && last ? `${origin}/projects.json?after=${encodeURIComponent(last.repo)}` : null;
    const file = openProjectsFileSchema.parse({
      license: OPEN_DATA_LICENSE,
      licenseUrl: OPEN_DATA_LICENSE_URL,
      total,
      projects: projects.map((project) => openProject(origin, project)),
      next,
    });
    return { state: 'ready', file };
  } catch (error) {
    console.warn('/projects.json could not be read.', error);
    return { state: 'unavailable' };
  }
}

export type ProjectFileResult = { state: 'ready'; file: OpenProjectFile } | { state: 'not_found' } | { state: 'unavailable' };

/** /<owner>/<repo>.json: the project, when it has a page, by the project page's own rule. */
export async function loadProjectFile(origin: string, owner: string, name: string): Promise<ProjectFileResult> {
  const asked = repoFromPath(owner, name);
  if (asked === null) return { state: 'not_found' };
  try {
    const project = await getProject(env.DB, asked);
    if (project === null || !(await hasPage(env.DB, project))) return { state: 'not_found' };
    const file = openProjectFileSchema.parse({
      license: OPEN_DATA_LICENSE,
      licenseUrl: OPEN_DATA_LICENSE_URL,
      project: openProject(origin, project),
    });
    return { state: 'ready', file };
  } catch (error) {
    console.warn(`/${asked}.json could not be read.`, error);
    return { state: 'unavailable' };
  }
}
