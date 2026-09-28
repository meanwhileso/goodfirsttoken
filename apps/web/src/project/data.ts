import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { PAGE_STATUS_HEADER } from '../mcp/paths';
import { loadProject, loadProjectsList, type ProjectPageResult, type ProjectsListResult } from './load';

export type { ListedProject, MergedRow, ProjectIssueRow, ProjectPage, ProjectPageResult, ProjectsListResult } from './load';

export interface ProjectPath {
  owner: string;
  repo: string;
}

function isProjectPath(value: unknown): value is ProjectPath {
  if (typeof value !== 'object' || value === null) return false;
  const path = value as Record<string, unknown>;
  return ['owner', 'repo'].every((key) => typeof path[key] === 'string');
}

// Each runs on the server when its page loads, and when someone navigates to
// it. Neither reads a cookie or sets one. When the database can't answer,
// the page says so with 503, which src/server.ts sets from
// PAGE_STATUS_HEADER. The project page's route answers a page that doesn't
// exist with 404.

export const getProjectsList = createServerFn({ method: 'GET' }).handler(async (): Promise<ProjectsListResult> => {
  const list = await loadProjectsList();
  if (list.state === 'unavailable') setResponseHeader(PAGE_STATUS_HEADER, '503');
  return list;
});

export const getProjectPage = createServerFn({ method: 'GET' })
  .validator((path: unknown): ProjectPath => (isProjectPath(path) ? path : { owner: '', repo: '' }))
  .handler(async ({ data }): Promise<ProjectPageResult> => {
    const page = await loadProject(getRequest(), data.owner, data.repo);
    if (page.state === 'unavailable') setResponseHeader(PAGE_STATUS_HEADER, '503');
    return page;
  });
