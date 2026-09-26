import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

// The /design page shows every component in the design system with sample
// data. Its wall adds a sample line every 3.8 seconds.
const NEW_LINE_EVERY_MS = 3800;
const START = new Date('2026-09-26T14:00:00Z');

async function openDesign(page: Page) {
  await page.goto('/design');
  // The color values fill in on the client, so from here the page has
  // hydrated and its buttons respond.
  await expect(page.locator('.swatch').first()).toContainText('#');
}

// With the clock paused before the page loads, no timer fires until a test
// moves it, so the wall holds still.
async function openDesignPaused(page: Page) {
  await page.clock.install({ time: START });
  await page.clock.pauseAt(new Date(START.getTime() + 1000));
  await openDesign(page);
}

// Moves the paused clock until the next sample line arrives, and returns
// that line, found by its time so a later line can't take its place.
async function nextWallLine(page: Page) {
  await page.clock.runFor(NEW_LINE_EVERY_MS + 200);
  const newest = page.locator('.wall-line').first();
  await expect(newest).toHaveClass(/wall-line--new/);
  const time = await newest.locator('.wall-line__time').textContent();
  return page.locator('.wall-line').filter({ has: page.locator('.wall-line__time', { hasText: time ?? '' }) });
}

test.describe('the design page', () => {
  for (const width of [360, 390, 768, 1024, 1280]) {
    test(`fits the screen at ${String(width)}px and matches its screenshot`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openDesignPaused(page);
      await page.evaluate(() => document.fonts.ready);

      const [scrollWidth, innerWidth] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
      expect(scrollWidth).toBeLessThanOrEqual(innerWidth);

      // Chromium builds draw text a little differently. Full Chromium and the
      // headless shell of one build differ on up to 1.8% of this page's
      // pixels with no layout change, so up to 2% may differ here. A change
      // in page height always fails, and so does a shift of whole sections,
      // like a wider label column, which changes 3 to 4%.
      await expect(page).toHaveScreenshot(`design-${String(width)}.png`, {
        fullPage: true,
        animations: 'disabled',
        caret: 'hide',
        maxDiffPixelRatio: 0.02,
      });
    });
  }

  test('has no em or en dashes in its copy', async ({ page }) => {
    await openDesign(page);
    expect(await page.locator('body').innerText()).not.toMatch(/[\u2013\u2014]/);
  });
});

test('an element with hidden stays hidden, whatever display its class sets', async ({ page }) => {
  await openDesign(page);

  const result = await page.evaluate(() => {
    // Every class that a rule on its own gives a display value, including
    // rules inside media and container queries.
    const classes = new Set<string>();
    const collect = (rules: CSSRuleList) => {
      for (const rule of rules) {
        if (rule instanceof CSSStyleRule) {
          const display = rule.style.getPropertyValue('display');
          if (!display || display === 'none') continue;
          for (const selector of rule.selectorText.split(',')) {
            const match = /^\s*\.([\w-]+)\s*$/.exec(selector);
            if (match?.[1]) classes.add(match[1]);
          }
        } else if (rule instanceof CSSGroupingRule) {
          collect(rule.cssRules);
        }
      }
    };
    for (const sheet of document.styleSheets) collect(sheet.cssRules);

    const shown: string[] = [];
    for (const name of classes) {
      const el = document.createElement('div');
      el.className = name;
      el.hidden = true;
      document.body.append(el);
      if (getComputedStyle(el).display !== 'none') shown.push(name);
      el.remove();
    }
    return { checked: [...classes], shown };
  });

  expect(result.checked).toEqual(expect.arrayContaining(['btn', 'chip', 'cluster', 'stack', 'marker', 'wall-line']));
  expect(result.shown).toEqual([]);
});

test('every token in brand/design.md is a CSS variable with the same value', async ({ page }) => {
  const tokens = frontMatter(await readFile(new URL('../../../brand/design.md', import.meta.url), 'utf8'));
  const group = (name: string): Tree => {
    const node = tokens[name];
    if (typeof node !== 'object') throw new Error(`brand/design.md has no ${name} tokens`);
    return node;
  };
  const value = (node: string | Tree | undefined): string | undefined => (typeof node === 'string' ? node : undefined);
  const values = (name: string) => Object.entries(group(name)).map(([key, node]) => [key, value(node) ?? ''] as const);

  // Each check sets one CSS property from the variable on one probe and from
  // the value in design.md on another, and compares what the browser computes.
  const checks: { variable: string; property: string; expected: string }[] = [];
  for (const [name, expected] of values('colors')) checks.push({ variable: `--${name}`, property: 'color', expected });
  for (const [name, expected] of values('rounded')) checks.push({ variable: `--r-${name}`, property: 'border-top-left-radius', expected });
  for (const [name, expected] of values('spacing')) checks.push({ variable: `--space-${name}`, property: 'width', expected });
  const elevation = group('elevation');
  checks.push({ variable: '--shadow-window', property: 'box-shadow', expected: value(elevation.window) ?? '' });
  checks.push({ variable: '--focus', property: 'box-shadow', expected: value(elevation.focus) ?? '' });

  const fonts: { variable: string; family: string; size?: string; weight?: string; lineHeight?: string; tracking?: string }[] = [];
  for (const [name, spec] of Object.entries(group('typography'))) {
    if (typeof spec !== 'object') continue;
    const family = value(spec.fontFamily) ?? '';
    if (name.startsWith('family-')) {
      fonts.push({ variable: name === 'family-sans' ? '--font-sans' : '--font-mono', family });
      continue;
    }
    fonts.push({
      variable: `--${name}`,
      family,
      size: value(spec.fontSize),
      weight: value(spec.fontWeight),
      lineHeight: value(spec.lineHeight),
      tracking: value(spec.letterSpacing),
    });
  }
  expect(checks.length).toBeGreaterThan(40);
  expect(fonts.length).toBeGreaterThan(10);

  await openDesign(page);
  const mismatches = await page.evaluate(
    ({ checks, fonts }) => {
      const probe = (css: Record<string, string>) => {
        const el = document.createElement('div');
        for (const [property, value] of Object.entries(css)) el.style.setProperty(property, value);
        document.body.append(el);
        const style = getComputedStyle(el);
        const read = (property: string) => style.getPropertyValue(property);
        return { read, done: () => { el.remove(); } };
      };
      const out: string[] = [];
      for (const { variable, property, expected } of checks) {
        const a = probe({ [property]: `var(${variable})` });
        const b = probe({ [property]: expected });
        if (a.read(property) !== b.read(property)) out.push(`${variable}: ${a.read(property)} is not ${expected}`);
        a.done();
        b.done();
      }
      const firstFamily = (value: string) => value.split(',')[0]?.trim().replaceAll(/["']/g, '') ?? '';
      for (const font of fonts) {
        if (!font.size) {
          const a = probe({ 'font-family': `var(${font.variable})` });
          if (firstFamily(a.read('font-family')) !== font.family) out.push(`${font.variable}: not ${font.family} first`);
          a.done();
          continue;
        }
        const a = probe({ font: `var(${font.variable})` });
        const b = probe({ 'font-size': font.size, 'font-weight': font.weight ?? '', 'line-height': font.lineHeight ?? '' });
        for (const property of ['font-size', 'font-weight', ...(font.lineHeight ? ['line-height'] : [])]) {
          if (a.read(property) !== b.read(property)) out.push(`${font.variable} ${property}: ${a.read(property)} is not ${b.read(property)}`);
        }
        if (firstFamily(a.read('font-family')) !== font.family) out.push(`${font.variable}: not ${font.family} first`);
        a.done();
        b.done();
        if (font.tracking) {
          const c = probe({ 'font-size': '100px', 'letter-spacing': `var(${font.variable}-tracking)` });
          const d = probe({ 'font-size': '100px', 'letter-spacing': font.tracking });
          if (c.read('letter-spacing') !== d.read('letter-spacing')) out.push(`${font.variable}-tracking is not ${font.tracking}`);
          c.done();
          d.done();
        }
      }
      return out;
    },
    { checks, fonts },
  );
  expect(mismatches).toEqual([]);
});

test('a page view loads Geist and Geist Mono from the site itself, and nothing from anywhere else', async ({ page, baseURL }) => {
  const origins = new Set<string>();
  page.on('request', (request) => {
    const { protocol, origin } = new URL(request.url());
    if (protocol !== 'data:') origins.add(origin);
  });
  await openDesign(page);
  await page.evaluate(() => document.fonts.ready);

  expect([...origins]).toEqual([new URL(baseURL ?? '').origin]);
  const loaded = await page.evaluate(() =>
    [...document.fonts].filter((font) => font.status === 'loaded').map((font) => font.family.replaceAll('"', '')),
  );
  expect(loaded).toEqual(expect.arrayContaining(['Geist', 'Geist Mono']));
});

test.describe('the wall', () => {
  test('types out its newest line, then shows it in full', async ({ page }) => {
    await openDesignPaused(page);
    const newest = await nextWallLine(page);
    const text = newest.locator('.wall-line__text');

    // The clock is paused, so the line has only just started typing.
    await expect(newest.locator('.cursor')).toHaveCount(1);
    const typedSoFar = (await text.textContent()) ?? '';

    await page.clock.resume();
    await expect(newest.locator('.cursor')).toHaveCount(0);
    const full = (await text.textContent()) ?? '';
    expect(full.length).toBeGreaterThan(typedSoFar.length);
    expect(full.startsWith(typedSoFar)).toBe(true);
  });

  test('makes each older line dimmer than the one above it', async ({ page }) => {
    await openDesignPaused(page);
    const opacities = await page
      .locator('.wall-line')
      .evaluateAll((lines) => lines.map((line) => Number(getComputedStyle(line).opacity)));

    expect(opacities.length).toBeGreaterThan(2);
    for (let i = 1; i < opacities.length; i++) {
      expect(opacities[i]).toBeLessThan(opacities[i - 1] ?? 0);
    }
  });

  test('under reduced motion, shows its newest line in full at once, without moving it', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openDesignPaused(page);
    const newest = await nextWallLine(page);
    const text = newest.locator('.wall-line__text');

    await expect(newest.locator('.cursor')).toHaveCount(0);
    const atOnce = (await text.textContent()) ?? '';
    expect(atOnce).not.toBe('');
    expect(await newest.evaluate((line) => getComputedStyle(line).animationName)).toBe('none');

    // Long after typing would have finished, the text is the same.
    await page.clock.resume();
    await page.waitForTimeout(1500);
    await expect(text).toHaveText(atOnce);
  });
});

test.describe('the prompt', () => {
  test('its copy button puts exactly what the box shows on the clipboard, and says copied in place', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openDesign(page);
    const prompt = page.locator('.prompt').first();
    const button = prompt.getByRole('button');

    await button.click();

    await expect(button).toHaveText('copied');
    const shown = await prompt.locator('.prompt__text').textContent();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(shown);
    await expect(button).toHaveText('copy');
  });

  test('its copy button says select it when the browser refuses to copy', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator.clipboard, 'writeText', {
        value: () => Promise.reject(new Error('Refused by the test')),
      });
    });
    await openDesign(page);
    const button = page.locator('.prompt').first().getByRole('button');

    await button.click();

    await expect(button).toHaveText('select it');
  });

  test('each open-in link opens its harness with the prompt filled in', async ({ page }) => {
    await openDesign(page);
    const prompt = await page.locator('.prompt__text').first().textContent();
    const link = async (name: string) => new URL((await page.locator('.open-in').getByRole('link', { name }).getAttribute('href')) ?? '');

    const claude = await link('claude code');
    expect(`${claude.protocol}//${claude.host}${claude.pathname}`).toBe('claude://code/new');
    expect(claude.searchParams.get('q')).toBe(prompt);

    const codex = await link('codex');
    expect(`${codex.protocol}//${codex.host}${codex.pathname}`).toBe('codex://new');
    expect(codex.searchParams.get('prompt')).toBe(prompt);

    const cursor = await link('cursor');
    expect(`${cursor.protocol}//${cursor.host}${cursor.pathname}`).toBe('cursor://anysphere.cursor-deeplink/prompt');
    expect(cursor.searchParams.get('text')).toBe(prompt);
  });

  test('the t3 code button copies the prompt before it opens T3 Code, which takes no prompt', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    // Paused, so the page never leaves for T3 Code during the test.
    await openDesignPaused(page);
    const prompt = await page.locator('.prompt__text').first().textContent();

    await page.locator('.open-in').getByRole('button', { name: 't3 code' }).click();

    await expect(page.locator('.open-in').getByRole('status')).toHaveText('Prompt copied. Opening T3 Code, paste it in.');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(prompt);
  });
});

test.describe('the nav', () => {
  test('on a narrow screen folds its links into a menu that the menu button opens', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await openDesign(page);
    const nav = page.getByRole('navigation', { name: 'Primary' });
    const live = nav.getByRole('link', { name: 'live' });

    await expect(live).toBeHidden();
    await nav.locator('.site-nav__menu').click();
    await expect(live).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Good First Token on GitHub' })).toBeVisible();
  });

  test('on a wide screen shows every link and no menu button', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openDesign(page);
    const nav = page.getByRole('navigation', { name: 'Primary' });

    for (const name of ['live', 'leaderboard', 'projects', 'maintainers', 'Good First Token on GitHub']) {
      await expect(nav.getByRole('link', { name })).toBeVisible();
    }
    await expect(nav.locator('.site-nav__menu')).toBeHidden();
  });

  test('marks the current page and shows the signed-in person in place of the GitHub mark', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openDesign(page);
    const nav = page.getByRole('navigation', { name: 'Signed-in nav example' });

    await expect(nav.getByRole('link', { name: '@priya' })).toHaveAttribute('aria-current', 'page');
    await expect(nav.getByRole('link', { name: 'Good First Token on GitHub' })).toHaveCount(0);
    await expect(nav.locator('[aria-current]')).toHaveCount(1);
  });
});

test('tabs show one panel at a time, and the arrow keys move between them', async ({ page }) => {
  await openDesign(page);
  const tabs = page.getByRole('tablist', { name: 'Leaderboard view' }).getByRole('tab');
  const shownPanel = page.getByRole('tabpanel');

  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect(shownPanel).toHaveCount(1);
  await expect(shownPanel).toHaveAccessibleName('this week');

  await tabs.nth(0).focus();
  await page.keyboard.press('ArrowRight');
  await expect(tabs.nth(1)).toBeFocused();
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(shownPanel).toHaveCount(1);
  await expect(shownPanel).toHaveAccessibleName('all time');

  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(tabs.nth(2)).toBeFocused();
  await expect(shownPanel).toHaveAccessibleName('by agent');

  await tabs.nth(0).click();
  await expect(shownPanel).toHaveAccessibleName('this week');
});

test('a project label keeps its GitHub color, with white or ink text, whichever reads better on it', async ({ page }) => {
  await openDesign(page);

  const dark = page.locator('.tag', { hasText: 'help wanted' });
  await expect(dark).toHaveCSS('background-color', 'rgb(0, 134, 114)');
  await expect(dark).toHaveCSS('color', 'rgb(255, 255, 255)');

  const light = page.locator('.tag', { hasText: 'ready' });
  await expect(light).toHaveCSS('background-color', 'rgb(226, 68, 192)');
  await expect(light).toHaveCSS('color', 'rgb(14, 17, 22)');
});

type Tree = { [key: string]: string | Tree };

// Reads the YAML front matter of a markdown file. It handles what
// brand/design.md uses: keys and values on one line, nested by two spaces.
function frontMatter(markdown: string): Tree {
  const yaml = /^---\n([\s\S]*?)\n---/.exec(markdown)?.[1] ?? '';
  const root: Tree = {};
  const stack: { indent: number; node: Tree }[] = [{ indent: -1, node: root }];
  for (const line of yaml.split('\n')) {
    const match = /^( *)"?([\w-]+)"?:\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, spaces = '', key = '', raw = ''] = match;
    while ((stack.at(-1)?.indent ?? -1) >= spaces.length) stack.pop();
    const parent = stack.at(-1)?.node ?? root;
    const value = raw.trim().replace(/^"(.*)"$/, '$1');
    if (value === '') {
      const child: Tree = {};
      parent[key] = child;
      stack.push({ indent: spaces.length, node: child });
    } else {
      parent[key] = value;
    }
  }
  return root;
}
