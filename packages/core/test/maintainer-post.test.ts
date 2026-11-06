import { describe, expect, test } from 'vitest';
import { FuturePostTime, verifyMaintainerPost } from '../src/maintainer-post';
import { openPolicy } from '../src/open-data';
import { policyInputSchema, policySchema } from '../src/projects';

// A policy from a maintainer's post on X. The handles, logins, and links are
// made up.

const now = Date.UTC(2026, 10, 5, 12);
const iso = (time: number) => new Date(time).toISOString();
const post = {
  maintainerGitHubLogin: 'sample-maintainer',
  role: 'creator' as const,
  roleSourceUrl: 'https://github.com/sample-owner/sample-app/blob/main/README.md',
  identitySourceUrl: 'https://github.com/sample-maintainer',
  xHandle: 'sample_person',
  publishedAt: iso(now - 86_400_000),
  timePrecision: 'exact' as const,
  postKind: 'authored' as const,
  evidenceCheckedAt: iso(now),
};
const policy = {
  quote: 'Agent pull requests are welcome here.',
  url: 'https://x.com/sample_person/status/123456789',
  tier: 'invites_agents' as const,
  maintainerPost: post,
};

describe("a policy from a maintainer's post", () => {
  test('links to a numeric status URL on X by the handle the evidence names, in any case', () => {
    expect(policyInputSchema.safeParse(policy).success).toBe(true);
    expect(policyInputSchema.safeParse({ ...policy, url: 'https://twitter.com/Sample_Person/status/123456789' }).success).toBe(true);

    for (const url of [
      'https://x.com/someone_else/status/123456789',
      'https://x.com/sample_person',
      'https://github.com/sample-owner/sample-app/blob/main/CONTRIBUTING.md',
    ]) {
      const parsed = policyInputSchema.safeParse({ ...policy, url });
      expect(parsed.success, url).toBe(false);
      expect(parsed.error?.issues[0]?.path).toEqual(['url']);
    }
  });

  test('a policy from the docs needs no post, and links anywhere on https', () => {
    const docs = { quote: policy.quote, tier: policy.tier };
    expect(policyInputSchema.safeParse({ ...docs, url: 'https://github.com/sample-owner/sample-app/blob/main/CONTRIBUTING.md' }).success).toBe(true);
  });

  test('needs a role that speaks for the repo and a post in the person\'s own words', () => {
    expect(policyInputSchema.safeParse({ ...policy, maintainerPost: { ...post, role: 'unknown' } }).success).toBe(false);
    expect(policyInputSchema.safeParse({ ...policy, maintainerPost: { ...post, role: 'contributor' } }).success).toBe(false);
    expect(policyInputSchema.safeParse({ ...policy, maintainerPost: { ...post, postKind: 'repost' } }).success).toBe(false);
    expect(policyInputSchema.safeParse({ ...policy, maintainerPost: { ...post, postKind: 'quote' } }).success).toBe(true);
  });

  test('needs public https sources for the role and the X account', () => {
    for (const roleSourceUrl of ['http://github.com/sample-owner', 'https://user:pw@github.com/sample-owner', 'https://localhost/x']) {
      expect(policyInputSchema.safeParse({ ...policy, maintainerPost: { ...post, roleSourceUrl } }).success, roleSourceUrl).toBe(false);
    }
  });

  test('the server stamps the admin who checked it and writes its times in one form', () => {
    const saved = verifyMaintainerPost({ ...post, publishedAt: '2026-11-04T12:00:00Z' }, 1010, now);

    expect(saved).toMatchObject({ verifierGitHubId: 1010, publishedAt: '2026-11-04T12:00:00.000Z' });
    expect(policySchema.safeParse({ ...policy, maintainerPost: saved }).success).toBe(true);
    // A stored post without who checked it isn't one.
    expect(policySchema.safeParse(policy).success).toBe(false);
  });

  test('a time after the action is refused, and a date alone is the start of its UTC day', () => {
    expect(() => verifyMaintainerPost({ ...post, publishedAt: iso(now + 1), evidenceCheckedAt: iso(now + 1) }, 1010, now)).toThrow(FuturePostTime);
    expect(() => verifyMaintainerPost({ ...post, evidenceCheckedAt: iso(now + 1) }, 1010, now)).toThrow(FuturePostTime);
    expect(() => verifyMaintainerPost({ ...post, timePrecision: 'date', publishedAt: '2026-11-04T12:00:00.000Z' }, 1010, now)).toThrow();
    expect(verifyMaintainerPost({ ...post, timePrecision: 'date', publishedAt: '2026-11-04T00:00:00.000Z' }, 1010, now).publishedAt).toBe(
      '2026-11-04T00:00:00.000Z',
    );
  });

  test('a check made before the post was published is refused', () => {
    const parsed = policyInputSchema.safeParse({ ...policy, maintainerPost: { ...post, evidenceCheckedAt: iso(now - 2 * 86_400_000) } });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(['maintainerPost', 'evidenceCheckedAt']);
  });

  test('a link to a post on X needs the evidence for it', () => {
    const parsed = policyInputSchema.safeParse({ quote: policy.quote, url: policy.url, tier: policy.tier });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(['maintainerPost']);
  });

  test('what the site shows leaves out the admin who checked it and their note', () => {
    const saved = verifyMaintainerPost({ ...post, note: 'Checked the README by hand.' }, 1010, now);

    const shown = openPolicy({ ...policy, maintainerPost: saved });

    expect(shown).toEqual({
      quote: policy.quote,
      url: policy.url,
      maintainerPost: {
        xHandle: post.xHandle,
        maintainerGitHubLogin: post.maintainerGitHubLogin,
        role: post.role,
        roleSourceUrl: post.roleSourceUrl,
        identitySourceUrl: post.identitySourceUrl,
        publishedAt: post.publishedAt,
      },
    });
    expect(JSON.stringify(shown)).not.toMatch(/1010|Checked the README|evidenceCheckedAt/);
  });
});
