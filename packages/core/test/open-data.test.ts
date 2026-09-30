import { describe, expect, test } from 'vitest';
import { openProjectFileSchema, openProjectSchema, openProjectsFileSchema, parseProjectSettings } from '../src/index';

// The JSON data's schema: what a published project record can say. Every
// repo, link, and quote here is made up.

const settings = parseProjectSettings({ tags: ['help wanted'] });
if (!settings.ok) throw new Error('The sample settings are invalid.');

const base = 'https://site.example/sample-owner/sample-app';
const record = {
  repo: 'sample-owner/sample-app',
  status: 'approved',
  source: 'registered',
  policy: null,
  settings: settings.value,
  links: {
    page: base,
    markdown: `${base}.md`,
    json: `${base}.json`,
    live: `${base}/live.txt`,
    github: 'https://github.com/sample-owner/sample-app',
  },
};
const quote = { quote: 'Agent pull requests are welcome.', url: 'https://github.com/sample-owner/sample-app/blob/main/AI.md' };
const licence = { license: 'CC0-1.0', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/' };

describe('a published project record', () => {
  test('a registered project carries no policy, and one listed from its policy carries the quote and its link', () => {
    expect(openProjectSchema.safeParse(record).success).toBe(true);
    expect(openProjectSchema.safeParse({ ...record, source: 'policy', policy: quote }).success).toBe(true);
    expect(openProjectSchema.safeParse({ ...record, source: 'policy', policy: null }).success).toBe(false);
    expect(openProjectSchema.safeParse({ ...record, policy: quote }).success).toBe(false);
    expect(openProjectSchema.safeParse({ ...record, source: 'policy', policy: { url: quote.url } }).success).toBe(false);
  });

  test('only an approved or a paused project, the ones with a page, can be published', () => {
    expect(openProjectSchema.safeParse({ ...record, status: 'paused' }).success).toBe(true);
    for (const status of ['pending', 'rejected']) {
      expect(openProjectSchema.safeParse({ ...record, status }).success, status).toBe(false);
    }
  });

  test("a field the schema doesn't list, like the policy's tier or who added the project, fails the check", () => {
    expect(openProjectSchema.safeParse({ ...record, addedBy: 1001 }).success).toBe(false);
    expect(openProjectSchema.safeParse({ ...record, source: 'policy', policy: { ...quote, tier: 'invites_agents' } }).success).toBe(false);
  });

  test('each file says its licence is CC0', () => {
    expect(openProjectFileSchema.safeParse({ ...licence, project: record }).success).toBe(true);
    expect(openProjectFileSchema.safeParse({ ...licence, license: 'MIT', project: record }).success).toBe(false);
    expect(openProjectsFileSchema.safeParse({ ...licence, total: 1, projects: [record], next: null }).success).toBe(true);
    expect(openProjectsFileSchema.safeParse({ total: 1, projects: [record], next: null }).success).toBe(false);
  });
});
