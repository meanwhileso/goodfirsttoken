import { z } from 'zod';
import { describe, expect, test } from 'vitest';
import {
  toolRefusal,
  toolResult,
  tools,
  validate,
  type ToolName,
  type Validated,
} from '../src/index';
import { samples } from './samples';

const names = Object.keys(tools) as ToolName[];

function textOf(result: { content: { text: string }[] }): string {
  return result.content.map((c) => c.text).join('\n');
}

function problemFields(result: Validated<unknown>): string[] {
  return result.ok ? [] : result.problems.map((p) => p.field);
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
    expect(result.structuredContent).toEqual(tools[name].output.parse(output));
    expect(result.content).toEqual([{ type: 'text', text: expect.any(String) as unknown }]);
    const text = textOf(result);
    for (const mention of mentions) expect(text).toContain(mention);
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
    const pr = { repo: 'meanwhileso/goodfirsttoken', number: 60, url: 'https://github.com/meanwhileso/goodfirsttoken/pull/60' };
    const text = textOf(toolResult('post_update', { ...samples.post_update.output, prOnIssue: pr }));
    expect(text).toContain(pr.url);
  });

  test('work sent to the review queue says why and where the diff is', () => {
    const output = { ...samples.submit_work.output, state: 'awaiting_review' as const, pr: null, reviewReason: 'workflow_files' as const };
    const text = textOf(toolResult('submit_work', output));
    expect(text).toContain('review queue because the change touches CI workflow files');
    expect(text).toContain(output.branch.url);
  });

  test('a claim on a project that wants a person-written description tells the agent not to draft it', () => {
    const output = samples.claim_issue.output;
    const text = textOf(
      toolResult('claim_issue', {
        ...output,
        project: { ...output.project, settings: { ...output.project.settings, personWrittenDescription: true } },
      }),
    );
    expect(text).toContain('The donor writes the PR description. Do not draft it.');
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

  test('an update is one short line of at most 200 characters', () => {
    const post = (text: string) => validate(tools.post_update.input, { claimId: 'c_1', text });
    expect(post('x'.repeat(200)).ok).toBe(true);
    expect(problemFields(post('x'.repeat(201)))).toEqual(['text']);
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

  test('a rejection needs a reason', () => {
    expect(problemFields(validate(tools.admin_decide.input, { id: 'q_1', decision: 'reject' }))).toEqual(['reason']);
    expect(validate(tools.admin_decide.input, { id: 'q_1', decision: 'approve' }).ok).toBe(true);
  });

  test('an admin pause needs a reason', () => {
    const repo = 'meanwhileso/goodfirsttoken';
    expect(problemFields(validate(tools.admin_pause_project.input, { repo }))).toEqual(['reason']);
    expect(validate(tools.admin_pause_project.input, { repo, paused: false }).ok).toBe(true);
  });

  test('a settings change through update_project names the setting that failed', () => {
    const result = validate(tools.update_project.input, {
      repo: 'meanwhileso/goodfirsttoken',
      settings: { claimsPerIssue: 0, prMode: 'yolo' },
    });
    expect(problemFields(result).sort()).toEqual(['settings.claimsPerIssue', 'settings.prMode']);
  });
});
