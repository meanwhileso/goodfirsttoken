import { z } from 'zod';
import { count, httpsUrl, repoName, trimmedText, webUrl } from './primitives';
import { MAX_POLICY_QUOTE, projectSettingsSchema, projectSourceSchema } from './projects';

// The projects' settings as the site publishes them, at /projects.json and
// /<owner>/<repo>.json, under CC0. Each file carries its licence. A project
// is in them exactly when it has a page on the site.

/** The licence the JSON data is published under, as an SPDX ID. */
export const OPEN_DATA_LICENSE = 'CC0-1.0';
/** Where the licence's words are. */
export const OPEN_DATA_LICENSE_URL = 'https://creativecommons.org/publicdomain/zero/1.0/';

/** How many projects one page of /projects.json holds at most. */
export const PROJECTS_JSON_PAGE = 500;

const licence = {
  license: z.literal(OPEN_DATA_LICENSE),
  licenseUrl: z.literal(OPEN_DATA_LICENSE_URL),
};

/**
 * One project as the JSON data publishes it: its repo, its status, how it
 * got in, its settings, and where its page, markdown, JSON, and live stream
 * are. A project listed from its AI policy carries the quote and its link.
 * A registered project carries none.
 */
export const openProjectSchema = z
  .strictObject({
    repo: repoName,
    /** A paused project takes no new claims until it resumes. */
    status: z.enum(['approved', 'paused']),
    source: projectSourceSchema,
    policy: z.strictObject({ quote: trimmedText(MAX_POLICY_QUOTE), url: httpsUrl }).nullable(),
    settings: projectSettingsSchema,
    links: z.strictObject({
      page: webUrl,
      markdown: webUrl,
      json: webUrl,
      live: webUrl,
      github: httpsUrl,
    }),
  })
  .refine((project) => (project.source === 'policy') === (project.policy !== null), {
    message: 'a project listed from its policy carries the quote and link, and a registered one carries none',
    path: ['policy'],
  });
export type OpenProject = z.infer<typeof openProjectSchema>;

/**
 * /projects.json: one page of the projects with a page on the site, by repo.
 * `total` counts them all, and `next` is the link to the next page, or null
 * on the last.
 */
export const openProjectsFileSchema = z.strictObject({
  ...licence,
  total: count,
  projects: z.array(openProjectSchema).max(PROJECTS_JSON_PAGE),
  next: webUrl.nullable(),
});
export type OpenProjectsFile = z.infer<typeof openProjectsFileSchema>;

/** /<owner>/<repo>.json: one project. */
export const openProjectFileSchema = z.strictObject({
  ...licence,
  project: openProjectSchema,
});
export type OpenProjectFile = z.infer<typeof openProjectFileSchema>;
