import { describe, expect, test } from 'vitest';
import { checkTrigger, takesTrigger, triggerKeyOf, TRIGGER_HARNESSES } from '../src/index';

// The trigger a wake can have in Claude Code's cloud scheduled tasks, Grok
// Bot, and Cursor Automations (docs/specs/follow-through.md, under Waking a
// run when a follow-up comes): /me saves one only when its URL fits the
// harness's pattern. The routine and automation IDs here are made up.

const CLAUDE = 'https://api.anthropic.com/v1/claude_code/routines/trig_01ABCdef234/fire';
const CURSOR = 'https://api2.cursor.sh/automations/webhook/sample-automation-1';

describe('the URL a trigger takes', () => {
  test('a Claude Code cloud scheduled task takes its API trigger, and gives its host', () => {
    expect(checkTrigger('claude-code-cloud', CLAUDE)).toEqual({ ok: true, url: CLAUDE, host: 'api.anthropic.com' });
  });

  test('Grok Bot and Cursor Automations take their webhook', () => {
    expect(checkTrigger('grok-bot', CURSOR)).toMatchObject({ ok: true, host: 'api2.cursor.sh' });
    expect(checkTrigger('cursor-automations', CURSOR)).toMatchObject({ ok: true, host: 'api2.cursor.sh' });
  });

  test('a URL is checked with spaces around it left out, and its host in any case', () => {
    expect(checkTrigger('claude-code-cloud', `  ${CLAUDE.replace('api.anthropic.com', 'API.Anthropic.com')} \n`)).toEqual({
      ok: true,
      url: CLAUDE,
      host: 'api.anthropic.com',
    });
  });

  test('a URL over plain HTTP is refused', () => {
    expect(checkTrigger('claude-code-cloud', CLAUDE.replace('https:', 'http:')).ok).toBe(false);
  });

  test("another harness's URL, or another host, is refused", () => {
    expect(checkTrigger('claude-code-cloud', CURSOR).ok).toBe(false);
    expect(checkTrigger('cursor-automations', CLAUDE).ok).toBe(false);
    expect(checkTrigger('claude-code-cloud', CLAUDE.replace('api.anthropic.com', 'api.anthropic.com.example.net')).ok).toBe(false);
    expect(checkTrigger('claude-code-cloud', CLAUDE.replace('api.anthropic.com', 'evil.example')).ok).toBe(false);
  });

  test('a path beyond the pattern, a port, a name and password, a query, or a fragment is refused', () => {
    for (const url of [
      CLAUDE.replace('/fire', '/fire/more'),
      CLAUDE.replace('/fire', '/run'),
      CLAUDE.replace('/routines/trig_01ABCdef234', '/routines/trig_01ABC%2F..%2Fx'),
      CLAUDE.replace('api.anthropic.com', 'api.anthropic.com:8443'),
      CLAUDE.replace('https://', 'https://someone:secret@'),
      `${CLAUDE}?then=https://evil.example`,
      `${CLAUDE}#x`,
      'not a url',
      '',
    ]) {
      expect(checkTrigger('claude-code-cloud', url).ok, url).toBe(false);
    }
  });

  test('a harness that takes no trigger takes no URL', () => {
    expect(checkTrigger('claude-code-desktop', CLAUDE).ok).toBe(false);
    expect(takesTrigger('claude-code-desktop')).toBe(false);
    expect(Object.keys(TRIGGER_HARNESSES).sort()).toEqual(['claude-code-cloud', 'cursor-automations', 'grok-bot']);
  });

  test('a refusal says what the harness takes, in words for the donor', () => {
    const refused = checkTrigger('claude-code-cloud', CURSOR);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.problem).toContain('https://api.anthropic.com/v1/claude_code/routines/');
  });
});

describe('the key a trigger takes', () => {
  test('a key pasted with its header or Bearer before it is the key alone', () => {
    expect(triggerKeyOf('sk-ant-oat01-abcDEF_123')).toBe('sk-ant-oat01-abcDEF_123');
    expect(triggerKeyOf(' Bearer crsr_abc123 ')).toBe('crsr_abc123');
    expect(triggerKeyOf('Authorization: Bearer crsr_abc123')).toBe('crsr_abc123');
  });

  test('an empty key, a key with spaces or control characters inside, or a key too long for a header is none', () => {
    expect(triggerKeyOf('')).toBeNull();
    expect(triggerKeyOf('Bearer ')).toBeNull();
    expect(triggerKeyOf('two words')).toBeNull();
    expect(triggerKeyOf('line\nbreak')).toBeNull();
    expect(triggerKeyOf('k'.repeat(1025))).toBeNull();
  });
});
