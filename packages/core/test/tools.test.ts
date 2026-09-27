import { z } from 'zod';
import { describe, expect, test } from 'vitest';
import {
  toolRefusal,
  toolResult,
  tools,
  validate,
  type ToolName,
  type ToolOutput,
  type Validated,
} from '../src/index';
import { samples } from './samples';

const names = Object.keys(tools) as ToolName[];
const repoName = samples.pause_project.output.repo;

function textOf(result: { content: { text: string }[] }): string {
  return result.content.map((c) => c.text).join('\n');
}

function problemFields(result: Validated<unknown>): string[] {
  return result.ok ? [] : result.problems.map((p) => p.field);
}

/** Every session, claim, and queue item ID anywhere in a result. */
function idsIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(idsIn);
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, inner]) =>
    ['sessionId', 'claimId', 'id'].includes(key) && typeof inner === 'string' ? [inner] : idsIn(inner),
  );
}

describe('the tool list', () => {
  test('every tool in the spec has a schema', () => {
    expect(names.sort()).toEqual(
      [
        'start_session',
        'suggest_issues',
        'claim_issue',
        'post_update',
        'submit_work',
        'release_claim',
        'my_work',
        'open_pr',
        'set_interests',
        'register_project',
        'update_project',
        'project_status',
        'pause_project',
        'admin_queue',
        'admin_decide',
        'admin_add_project',
        'admin_block_donor',
        'admin_pause_project',
        'admin_remove_project',
      ].sort(),
    );
  });

  test('only the admin tools are for admins', () => {
    const forAdmins = names.filter((name) => tools[name].audience === 'admin');
    expect(forAdmins.sort()).toEqual(names.filter((name) => name.startsWith('admin_')).sort());
  });

  // MCP declares a tool's inputSchema and outputSchema as JSON Schema objects.
  test.each(names)('the %s input is an object schema MCP can declare', (name) => {
    expect(z.toJSONSchema(tools[name].input, { io: 'input' })).toMatchObject({ type: 'object' });
  });

  test.each(names)('the %s output is an object schema MCP can declare', (name) => {
    expect(z.toJSONSchema(tools[name].output)).toMatchObject({ type: 'object' });
  });
});

describe('tool results', () => {
  test.each(names)('a %s result carries plain text next to its structured data', (name) => {
    const { output, mentions } = samples[name];
    const result = toolResult(name, output as never);
    // Defaults fill in what a sample leaves out, so every field it gives must come back as given.
    expect(result.structuredContent).toMatchObject(output);
    expect(result.content).toEqual([{ type: 'text', text: expect.any(String) as unknown }]);
    const text = textOf(result);
    for (const mention of mentions) expect(text).toContain(mention);
  });

  // Terminal harnesses show only the text, so an agent reads IDs from it.
  test.each(names)('every ID a later call needs appears in the %s text', (name) => {
    const result = toolResult(name, samples[name].output as never);
    const ids = idsIn(result.structuredContent);
    const text = textOf(result);
    for (const value of ids) expect(text, `${name} text`).toContain(value);
  });

  test('a result drops any field its schema does not list', () => {
    const result = toolResult('release_claim', {
      ...samples.release_claim.output,
      githubToken: 'not-sent',
    } as never);
    expect(result.structuredContent).not.toHaveProperty('githubToken');
    expect(JSON.stringify(result)).not.toContain('not-sent');
  });

  test('a result that breaks its tool schema is never sent', () => {
    expect(() => toolResult('release_claim', { claimId: 'c_1', issue: 'nope', state: 'released' })).toThrow();
    const four = Array.from({ length: 4 }, () => samples.suggest_issues.output.suggestions[0]);
    expect(() => toolResult('suggest_issues', { suggestions: four } as never)).toThrow();
  });

  test('a refusal is an error result whose text leads with its code', () => {
    const result = toolRefusal({ code: 'issue_full', message: 'All 3 slots on this issue are taken.' });
    expect(result.isError).toBe(true);
    expect(result).not.toHaveProperty('structuredContent');
    expect(textOf(result)).toBe('Refused (issue_full): All 3 slots on this issue are taken.');
  });
});

describe('what each result says', () => {
  test('a post that came too soon tells the agent how long to wait', () => {
    const text = textOf(
      toolResult('post_update', { ...samples.post_update.output, posted: false, waitSeconds: 7 }),
    );
    expect(text).toContain('Not posted');
    expect(text).toContain('Wait 7s');
  });

  test('a claimant hears about a PR on the issue with their update', () => {
    const pr = { repo: 'meanwhileso/goodfirsttoken', number: 960, url: 'https://github.com/meanwhileso/goodfirsttoken/pull/960' };
    const text = textOf(toolResult('post_update', { ...samples.post_update.output, prOnIssue: pr }));
    expect(text).toContain(pr.url);
  });

  test('work sent to the review queue says why and where the diff is', () => {
    const output = { ...samples.submit_work.output, state: 'awaiting_review' as const, pr: null, reviewReason: 'workflow_files' as const };
    const text = textOf(toolResult('submit_work', output));
    expect(text).toContain('review queue because the change touches CI workflow files');
    expect(text).toContain(output.branch.url);
  });

  test('a claim on a project that wants a person-written description tells the agent to ask the donor for it', () => {
    const output = samples.claim_issue.output;
    const text = textOf(
      toolResult('claim_issue', {
        ...output,
        project: { ...output.project, settings: { ...output.project.settings, personWrittenDescription: true } },
      }),
    );
    expect(text).toContain('Ask the donor to write the PR description, and pass it to open_pr word for word.');
  });

  test('a saved registration says it waits for an admin, and names the label it created', () => {
    const saved = { ...samples.register_project.output, saved: true, status: 'pending' as const, createdLabels: ['goodfirsttoken'] };
    const text = textOf(toolResult('register_project', saved));
    expect(text).toContain('Status: pending. A Good First Token admin reviews it before agents can claim its issues.');
    expect(text).toContain(`Created 1 label in ${repoName}: goodfirsttoken.`);
    expect(text).not.toContain('Nothing is saved yet');
  });

  test('a created label is named with the repo it went into: the issue repo, or the code repo when there is none', () => {
    const settings = { ...samples.register_project.output.settings, issueRepo: 'sample-owner/sample-issues' };
    const register = { ...samples.register_project.output, saved: true, status: 'pending' as const, createdLabels: ['goodfirsttoken'] };
    const update = samples.update_project.output;

    expect(textOf(toolResult('register_project', { ...register, settings }))).toContain(
      'Created 1 label in sample-owner/sample-issues: goodfirsttoken.',
    );
    expect(textOf(toolResult('update_project', { ...update, settings }))).toContain(
      'Created 1 label in sample-owner/sample-issues: goodfirsttoken.',
    );
    expect(textOf(toolResult('update_project', update))).toContain(`Created 1 label in ${update.repo}: goodfirsttoken.`);
  });

  test('registering a repo listed from its AI policy says the settings apply now, with no wait for an admin', () => {
    const saved = { ...samples.register_project.output, saved: true, status: 'approved' as const };
    const text = textOf(toolResult('register_project', saved));
    expect(text).toContain('Status: approved. Your settings replace the ones it was listed with, and apply now.');
    expect(text).not.toContain('admin reviews');
  });

  test('taking over a paused listing says the settings wait for the pause to lift', () => {
    const saved = { ...samples.register_project.output, saved: true, status: 'paused' as const };
    const text = textOf(toolResult('register_project', saved));
    expect(text).toContain('Status: paused. Your settings replace the ones it was listed with. Agents get no new claims on it until the pause is lifted.');
    expect(text).not.toContain('apply now');
  });

  test("a pause says who can lift it, and a call that changed nothing says so", () => {
    const pause = (output: Partial<ToolOutput<'pause_project'>>) =>
      textOf(toolResult('pause_project', { ...samples.pause_project.output, ...output }));

    expect(pause({})).toBe(
      `Paused ${repoName}. Agents get no new claims on it until you resume it with pause_project and paused: false.`,
    );
    expect(pause({ changed: false, resumableBy: 'admins' })).toBe(
      `${repoName} was already paused. Agents get no new claims on it until one of Good First Token's admins resumes it.`,
    );
    expect(pause({ changed: false })).toContain('was already paused.');
    expect(pause({ status: 'approved', changed: true, resumableBy: null })).toBe(`Resumed ${repoName}. Status: approved.`);
    expect(pause({ status: 'pending', changed: false, resumableBy: null })).toBe(
      `${repoName} isn't paused, so nothing changed. Status: pending.`,
    );
  });

  test('a crawler find in the queue shows its suggested settings with the rest at their defaults, and says when no tags were suggested', () => {
    const [candidate] = samples.admin_queue.output.items;
    if (candidate === undefined) throw new Error('missing sample');
    const text = textOf(toolResult('admin_queue', { items: [{ ...candidate, settings: { prMode: 'automatic' } }] }));
    expect(text).toContain('suggested settings, the rest at their defaults:');
    expect(text).toMatch(/Tags +none/);
    expect(text).toMatch(/PR mode +automatic/);
    expect(text).toMatch(/Claims per issue +3/);
  });

  test("a rejection says who sees its reason: a registration's maintainers, and no one for a crawler find", () => {
    const decide = (kind: 'registration' | 'candidate') =>
      textOf(toolResult('admin_decide', { repo: repoName, kind, status: 'rejected' }));
    expect(decide('registration')).toBe(`Rejected ${repoName}. Its maintainers see the reason with project_status.`);
    expect(decide('candidate')).toBe(`Rejected the crawler find ${repoName}. It leaves the queue.`);
  });

  test('an admin pause that changed nothing says so', () => {
    const pause = (output: Partial<ToolOutput<'admin_pause_project'>>) =>
      textOf(toolResult('admin_pause_project', { ...samples.admin_pause_project.output, ...output }));
    expect(pause({ changed: false })).toBe(`${repoName} was already paused by an admin, with that reason. Nothing changed.`);
    expect(pause({ status: 'approved', changed: true })).toBe(`Resumed ${repoName}. Status: approved.`);
    expect(pause({ status: 'approved', changed: false })).toBe(`${repoName} isn't paused, so nothing changed. Status: approved.`);
  });

  test('an empty suggestion list says so', () => {
    expect(textOf(toolResult('suggest_issues', { suggestions: [] }))).toBe('No eligible issues right now.');
  });
});

describe('tool inputs', () => {
  test('a release needs a public reason', () => {
    expect(problemFields(validate(tools.release_claim.input, { claimId: 'c_1' }))).toEqual(['reason']);
    expect(problemFields(validate(tools.release_claim.input, { claimId: 'c_1', reason: '  ' }))).toEqual([
      'reason',
    ]);
  });

  test('an update is at most 200 characters', () => {
    const post = (text: string) => validate(tools.post_update.input, { claimId: 'c_1', text });
    expect(post('x'.repeat(200)).ok).toBe(true);
    expect(problemFields(post('x'.repeat(201)))).toEqual(['text']);
  });

  test('an update with tabs or line breaks is posted as one line', () => {
    const result = validate(tools.post_update.input, {
      claimId: 'c_1',
      text: 'tests: 3 failing\n\tall in the lock screen\r\n',
    });
    expect(result.ok && result.value.text).toBe('tests: 3 failing all in the lock screen');
  });

  test('an issue in a repo named . or .. is rejected', () => {
    const claim = (issue: string) => validate(tools.claim_issue.input, { sessionId: 's_1', issue });
    expect(problemFields(claim('octo/..#1'))).toEqual(['issue']);
    expect(problemFields(claim('octo/.#1'))).toEqual(['issue']);
    expect(claim('octo/.github#1').ok).toBe(true);
  });

  const submit = (paths: string[]) =>
    validate(tools.submit_work.input, {
      claimId: 'c_1',
      files: paths.map((path) => ({ path, content: 'x' })),
      summary: 'Adds the NDJSON formatter.',
      checks: 'pnpm test',
      agent: 'claude-code',
      model: 'claude-opus-5-5',
    });

  test('a submit writes only inside the repo', () => {
    expect(submit(['src/index.ts', 'docs/how-it-works.md', '.github/workflows/ci.yml']).ok).toBe(true);
    for (const path of ['/etc/passwd', '../outside.ts', 'src/../../outside.ts', '.git/config', 'src\\index.ts', 'src//index.ts', '']) {
      expect(problemFields(submit([path])), path).toEqual(['files[0].path']);
    }
  });

  test('a submit lists each file once', () => {
    expect(problemFields(submit(['src/a.ts', 'src/a.ts']))).toEqual(['files']);
  });

  test('a submit can not list a file and a path under it', () => {
    expect(problemFields(submit(['src', 'src/a.ts']))).toEqual(['files']);
    expect(problemFields(submit(['src/a.ts', 'src']))).toEqual(['files']);
    expect(submit(['src/a.ts', 'src/ab.ts', 'srcs/a.ts']).ok).toBe(true);
  });

  test('a submit can not list two paths that differ only in case', () => {
    expect(problemFields(submit(['README.md', 'readme.md']))).toEqual(['files']);
    expect(problemFields(submit(['Src/a.ts', 'src/a.ts/b.ts']))).toEqual(['files']);
  });

  test('a rejection needs a reason', () => {
    expect(problemFields(validate(tools.admin_decide.input, { id: 'q_1', decision: 'reject' }))).toEqual(['reason']);
    expect(validate(tools.admin_decide.input, { id: 'q_1', decision: 'approve' }).ok).toBe(true);
  });

  test("an admin approving a crawler find can set its policy tier", () => {
    const decide = (tier: string) => validate(tools.admin_decide.input, { id: 'q_1', decision: 'approve', tier });
    expect(decide('invites_agents').ok).toBe(true);
    expect(problemFields(decide('bans_agents'))).toEqual(['tier']);
  });

  test('a crawler find can be approved with only the settings the admin changed', () => {
    const decide = (settings: unknown) =>
      validate(tools.admin_decide.input, { id: 'cand_1', decision: 'approve', settings });
    expect(decide({ tags: ['ready for help'] }).ok).toBe(true);
    expect(decide({}).ok).toBe(true);
    expect(problemFields(decide({ claimsPerIssue: 0 }))).toEqual(['settings.claimsPerIssue']);
  });

  test('an admin pause needs a reason', () => {
    const repo = 'meanwhileso/goodfirsttoken';
    expect(problemFields(validate(tools.admin_pause_project.input, { repo }))).toEqual(['reason']);
    expect(validate(tools.admin_pause_project.input, { repo, paused: false }).ok).toBe(true);
  });

  // The MCP SDK checks a tool's input through the schema's standard
  // validate, and reports each issue's message as it is.
  test('an unknown setting sent to a tool is named in the message the MCP SDK reports', async () => {
    const messages = async (name: 'update_project' | 'register_project', settings: unknown) => {
      const result = await tools[name].input['~standard'].validate({ repo: 'sample-owner/sample-app', settings });
      return 'issues' in result ? (result.issues ?? []).map((issue) => issue.message).join('\n') : '';
    };

    expect(await messages('update_project', { claimsPerIsue: 2 })).toContain('claimsPerIsue');
    expect(await messages('register_project', { tags: ['help wanted'], disclosure: { trailer: null, prBody: 'x', extra: 1 } })).toContain(
      'extra',
    );
    expect(await messages('update_project', 'automatic')).toBe('must be an object of settings');
  });

  test('a settings change through update_project names the setting that failed', () => {
    const result = validate(tools.update_project.input, {
      repo: 'meanwhileso/goodfirsttoken',
      settings: { claimsPerIssue: 0, prMode: 'yolo' },
    });
    expect(problemFields(result).sort()).toEqual(['settings.claimsPerIssue', 'settings.prMode']);
  });
});
