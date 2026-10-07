import { describe, expect, test } from 'vitest';
import { crawlPriorityInputSchema, crawlPrioritySchema, qualifyCrawlPriority, verifyCrawlPriority } from '../src/crawl-priority';

const DAY = 86_400_000;
const now = Date.UTC(2026, 9, 7, 12);
const iso = (time: number) => new Date(time).toISOString();
const input = {
  stars: 10000, public: true, archived: false, pushedAt: iso(now - 30 * DAY), metadataCheckedAt: iso(now - 30 * DAY),
  maintainerGitHubLogin: 'sample-maintainer', role: 'maintainer' as const, roleSourceUrl: 'https://github.com/sample-owner/sample-app/blob/main/MAINTAINERS.md',
  identitySourceUrl: 'https://github.com/sample-maintainer', xHandle: 'sample_person', postUrl: 'https://x.com/sample_person/status/123456789',
  publishedAt: iso(now - 90 * DAY), timePrecision: 'exact' as const, postKind: 'authored' as const, evidenceCheckedAt: iso(now - 30 * DAY),
};

describe('crawl priority evidence', () => {
  test('10,000 stars and the exact 30 and 90 day boundaries qualify', () => {
    const saved = verifyCrawlPriority(input, 1010, now);
    expect(saved.verifierGitHubId).toBe(1010);
    expect(qualifyCrawlPriority(saved, now).qualifies).toBe(true);
    expect(qualifyCrawlPriority(saved, now + 1).qualifies).toBe(false);
    expect(qualifyCrawlPriority({ ...saved, stars: 9999 }, now).qualifies).toBe(false);
  });

  test.each(['public', 'archived', 'role', 'postKind'] as const)('%s must establish eligibility', (field) => {
    const saved = verifyCrawlPriority(input, 1010, now);
    const value = { public: false, archived: true, role: 'unknown', postKind: 'repost' }[field];
    expect(qualifyCrawlPriority({ ...saved, [field]: value }, now).qualifies).toBe(false);
  });

  test('a quote with own words qualifies, and unknown activity stays ordinary', () => {
    expect(qualifyCrawlPriority(verifyCrawlPriority({ ...input, postKind: 'quote' }, 1010, now), now).qualifies).toBe(true);
    expect(qualifyCrawlPriority(null, now).qualifies).toBe(false);
    expect(qualifyCrawlPriority(verifyCrawlPriority({ ...input, postKind: 'unknown' }, 1010, now), now).qualifies).toBe(false);
  });

  test('checking an old pinned post again does not renew its publication time', () => {
    const saved = verifyCrawlPriority({ ...input, publishedAt: iso(now - 90 * DAY - 1), evidenceCheckedAt: iso(now) }, 1010, now);
    expect(qualifyCrawlPriority(saved, now).reasons).toContain('post_old');
  });

  test('date precision uses UTC midnight and expires from that time', () => {
    const midnight = Date.UTC(2026, 6, 9);
    const saved = verifyCrawlPriority({ ...input, publishedAt: iso(midnight), timePrecision: 'date', pushedAt: iso(midnight + 90 * DAY), metadataCheckedAt: iso(midnight + 90 * DAY), evidenceCheckedAt: iso(midnight + 90 * DAY) }, 1010, now);
    expect(qualifyCrawlPriority(saved, midnight + 90 * DAY).qualifies).toBe(true);
    expect(qualifyCrawlPriority(saved, midnight + 90 * DAY + 1).qualifies).toBe(false);
    expect(crawlPriorityInputSchema.safeParse({ ...input, timePrecision: 'date' }).success).toBe(false);
  });

  test.each(['publishedAt', 'metadataCheckedAt', 'evidenceCheckedAt', 'pushedAt'] as const)('future %s is refused against the action clock', (field) => {
    expect(() => verifyCrawlPriority({ ...input, [field]: iso(now + 1) }, 1010, now)).toThrow();
  });

  test('submillisecond times cannot be rounded down across the action clock', () => {
    expect(() => verifyCrawlPriority({ ...input, publishedAt: '2026-10-07T12:00:00.000001Z' }, 1010, now)).toThrow();
  });

  test.each([
    'http://example.org/person', 'https://user:pass@example.org/person', 'https://localhost/person',
    'https://127.0.0.1/person', 'https://[::1]/person', 'https://10.0.0.1/person', 'https://example.local/person',
    'https://0x7f.0.0.1/person',
    'https://example.org:8080/person', 'javascript:alert(1)', 'https://example.org/' + 'a'.repeat(2048),
  ])('unsafe or unbounded source URL %s is refused', (roleSourceUrl) => {
    expect(crawlPriorityInputSchema.safeParse({ ...input, roleSourceUrl }).success).toBe(false);
  });

  test.each(['https://x.com/another_person/status/123', 'https://x.com/sample_person/status/abc', 'https://example.org/sample_person/status/123', 'https://x.com/sample_person/status/123/photo/1'])('a post must name its author and a numeric status ID: %s', (postUrl) => {
    expect(crawlPriorityInputSchema.safeParse({ ...input, postUrl }).success).toBe(false);
  });

  test('inputs reject forged verifier IDs, extra fields, and unbounded notes', () => {
    expect(crawlPriorityInputSchema.safeParse({ ...input, verifierGitHubId: 9001 }).success).toBe(false);
    expect(crawlPriorityInputSchema.safeParse({ ...input, roleVerified: true }).success).toBe(false);
    expect(crawlPriorityInputSchema.safeParse({ ...input, note: 'a'.repeat(501) }).success).toBe(false);
    expect(crawlPrioritySchema.safeParse(input).success).toBe(false);
  });

  test('malformed publication and check dates fail validation without throwing', () => {
    expect(crawlPriorityInputSchema.safeParse({ ...input, publishedAt: 'yesterday', timePrecision: 'date' }).success).toBe(false);
    expect(crawlPriorityInputSchema.safeParse({ ...input, metadataCheckedAt: 'not a date' }).success).toBe(false);
  });
});
