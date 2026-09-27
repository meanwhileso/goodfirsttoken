import { readFile } from 'node:fs/promises';
import type { Locator, Page } from '@playwright/test';
import { SAMPLE_COMMAND, SAMPLE_EVENTS, SAMPLE_PROMPT } from '../src/design/samples';
import { expect, test } from './fixtures';
import { STATIC_HOST } from './hosts';

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

declare global {
  // Installed in the page by installContrast.
  var contrastOnPage: (el: Element) => number;
  var contrastOn: (color: string, over: Element) => number;
}

// Adds two WCAG contrast helpers to the page. contrastOnPage(el) is the
// contrast of el's text on what is painted behind it, with the opacity of
// every element above it applied. contrastOn(color, el) is a color's
// contrast on what is painted behind el.
async function installContrast(page: Page) {
  await page.evaluate(() => {
    type Rgba = [number, number, number, number];
    const parse = (color: string): Rgba => {
      const parts = (/rgba?\(([^)]+)\)/.exec(color)?.[1] ?? '').split(/[\s,/]+/).filter(Boolean).map(Number);
      return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1];
    };
    const over = (top: Rgba, bottom: Rgba): Rgba => [
      top[0] * top[3] + bottom[0] * (1 - top[3]),
      top[1] * top[3] + bottom[1] * (1 - top[3]),
      top[2] * top[3] + bottom[2] * (1 - top[3]),
      1,
    ];
    // Every background from the page down to el, painted in order.
    const backdrop = (el: Element): Rgba => {
      const chain: Element[] = [];
      for (let e: Element | null = el; e; e = e.parentElement) chain.unshift(e);
      return chain.reduce<Rgba>((color, e) => over(parse(getComputedStyle(e).backgroundColor), color), [255, 255, 255, 1]);
    };
    const luminance = (color: Rgba) => {
      const [r = 0, g = 0, b = 0] = color.slice(0, 3).map((c) => {
        const v = c / 255;
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a: Rgba, b: Rgba) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
      return (hi + 0.05) / (lo + 0.05);
    };
    globalThis.contrastOn = (color, el) => ratio(over(parse(color), backdrop(el)), backdrop(el));
    globalThis.contrastOnPage = (el) => {
      let opacity = 1;
      for (let e: Element | null = el; e; e = e.parentElement) opacity *= Number(getComputedStyle(e).opacity);
      const [r, g, b, a] = parse(getComputedStyle(el).color);
      const behind = backdrop(el);
      return ratio(over([r, g, b, a * opacity], behind), behind);
    };
  });
}

test.describe('the design page', () => {
  for (const width of [360, 390, 768, 1024, 1280]) {
    test(`fits the screen at ${String(width)}px and matches its screenshot`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openDesignPaused(page);
      await page.evaluate(() => document.fonts.ready);

      const [scrollWidth, innerWidth] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
      expect(scrollWidth).toBeLessThanOrEqual(innerWidth);

      // The baselines come from the Playwright build CI runs. Other Chromium
      // builds draw text a little differently, and at phone widths that can
      // wrap a line and change the page height. Up to 2% of pixels may
      // differ, for antialiasing. A change in page height always fails, and
      // so does a shift of whole sections, like a wider label column, which
      // changes 3 to 4%.
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

  const result = await page.evaluate(async () => {
    // Every style rule in every stylesheet, including rules nested in media,
    // container, and supports queries. The stylesheets come from the static
    // host, another origin, so the page can't read their rules. Each one is
    // fetched again and read from a copy.
    const rules: CSSStyleRule[] = [];
    const walk = (list: CSSRuleList) => {
      for (const rule of list) {
        if (rule instanceof CSSStyleRule) rules.push(rule);
        if (rule instanceof CSSGroupingRule || rule instanceof CSSStyleRule) walk(rule.cssRules);
      }
    };
    const readable = async (sheet: CSSStyleSheet) => {
      if (!sheet.href) return sheet;
      const copy = new CSSStyleSheet();
      copy.replaceSync(await (await fetch(sheet.href)).text());
      return copy;
    };
    for (const sheet of await Promise.all([...document.styleSheets].map(readable))) walk(sheet.cssRules);

    // The hidden rule wins over any class because it is !important. Only
    // another !important display could beat it.
    const hiddenRule = rules.filter((rule) => rule.selectorText === '[hidden]').map((rule) => ({
      display: rule.style.getPropertyValue('display'),
      priority: rule.style.getPropertyPriority('display'),
    }));
    const rivals = rules
      .filter((rule) => rule.selectorText !== '[hidden]' && rule.style.getPropertyPriority('display') === 'important')
      .map((rule) => rule.selectorText);

    // And a probe for each class a rule of its own gives a display value.
    const classes = new Set<string>();
    for (const rule of rules) {
      const display = rule.style.getPropertyValue('display');
      if (!display || display === 'none') continue;
      for (const selector of rule.selectorText.split(',')) {
        const match = /^\s*\.([\w-]+)\s*$/.exec(selector);
        if (match?.[1]) classes.add(match[1]);
      }
    }
    const shown: string[] = [];
    for (const name of classes) {
      const el = document.createElement('div');
      el.className = name;
      el.hidden = true;
      document.body.append(el);
      if (getComputedStyle(el).display !== 'none') shown.push(name);
      el.remove();
    }
    return { hiddenRule, rivals, checked: [...classes], shown };
  });

  expect(result.hiddenRule).toEqual([{ display: 'none', priority: 'important' }]);
  expect(result.rivals).toEqual([]);
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
  for (const [name, expected] of values('elevation')) {
    checks.push({ variable: name === 'focus' ? '--focus' : `--shadow-${name}`, property: 'box-shadow', expected });
  }

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

test('every component in brand/design.md looks the way its YAML says', async ({ page }) => {
  const tokens = frontMatter(await readFile(new URL('../../../brand/design.md', import.meta.url), 'utf8'));
  const components = tokens.components;
  if (typeof components !== 'object') throw new Error('brand/design.md has no components');

  // A value like "{colors.ink}" points at another token.
  const resolve = (ref: string | Tree | undefined): string | Tree | undefined => {
    const match = typeof ref === 'string' ? /^\{([\w-]+)\.([\w-]+)\}$/.exec(ref) : null;
    if (!match) return ref;
    const group = tokens[match[1] ?? ''];
    return typeof group === 'object' ? group[match[2] ?? ''] : undefined;
  };
  const text = (ref: string | Tree | undefined) => {
    const resolved = resolve(ref);
    return typeof resolved === 'string' ? resolved : undefined;
  };

  // Where each component is on /design, and which part carries each key.
  const where: Record<string, Record<string, string>> = {
    'button-primary': { '*': '.btn--primary' },
    'button-secondary': { '*': '.btn:not(.btn--primary):not(.btn--danger):not(.btn--sm):not([disabled])' },
    'button-danger': { '*': '.btn--danger' },
    'logo-chip': { '*': '.site-nav .logo-chip' },
    tag: { '*': '.tag' },
    'prompt-box': { '*': '.prompt:not(.prompt--sm)' },
    marker: { '*': '.marker:not(.marker--live):not(.marker--label)' },
    badge: {
      '*': '.badge__rule',
      rounded: '.badge',
      valueBackground: '.badge__value',
      valueColor: '.badge__value',
    },
  };
  const css: Record<string, string> = {
    backgroundColor: 'background-color',
    keyBackground: 'background-color',
    valueBackground: 'background-color',
    textColor: 'color',
    keyColor: 'color',
    valueColor: 'color',
    borderColor: 'border-top-color',
    rounded: 'border-top-left-radius',
    height: 'height',
    padding: 'padding',
    fontFamily: 'font-family',
    fontSize: 'font-size',
    fontWeight: 'font-weight',
    lineHeight: 'line-height',
  };

  const checks: { component: string; selector: string; property: string; expected: string }[] = [];
  for (const [component, spec] of Object.entries(components)) {
    const place = where[component];
    if (!place || typeof spec !== 'object') continue;
    const add = (key: string, expected: string | undefined) => {
      const property = css[key];
      if (property && expected !== undefined) {
        checks.push({ component, selector: place[key] ?? place['*'] ?? '', property, expected });
      }
    };
    for (const [key, ref] of Object.entries(spec)) {
      if (key === 'typography') {
        const type = resolve(ref);
        if (typeof type !== 'object') continue;
        for (const [typeKey, typeValue] of Object.entries(type)) add(typeKey, text(typeValue));
      } else {
        add(key, text(ref));
      }
    }
  }
  // Every component on the page, with every key the list above knows.
  expect(new Set(checks.map((check) => check.component)).size).toBe(Object.keys(where).length);

  await openDesign(page);
  const mismatches = await page.evaluate((checks) => {
    const out: string[] = [];
    for (const { component, selector, property, expected } of checks) {
      const el = document.querySelector(selector);
      if (!el) {
        out.push(`${component}: nothing matches ${selector}`);
        continue;
      }
      const actual = getComputedStyle(el);
      if (property === 'font-family') {
        const first = actual.fontFamily.split(',')[0]?.trim().replaceAll(/["']/g, '');
        if (first !== expected) out.push(`${component} font-family: ${String(first)} is not ${expected}`);
        continue;
      }
      // A probe with the same font size turns the YAML value into what the
      // browser computes, so rem, unitless line heights, and hex compare.
      const probe = document.createElement('div');
      probe.style.fontSize = actual.fontSize;
      probe.style.setProperty(property, expected);
      document.body.append(probe);
      const wanted = getComputedStyle(probe);
      const longhands = property === 'padding' ? ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'] : [property];
      for (const longhand of longhands) {
        if (actual.getPropertyValue(longhand) !== wanted.getPropertyValue(longhand)) {
          out.push(`${component} ${longhand}: ${actual.getPropertyValue(longhand)} is not ${wanted.getPropertyValue(longhand)}`);
        }
      }
      probe.remove();
    }
    return out;
  }, checks);
  expect(mismatches).toEqual([]);
});

test("a page view loads Geist and Geist Mono from the site's static host, and nothing from any other site", async ({
  page,
  baseURL,
}) => {
  const origins = new Set<string>();
  const fonts: string[] = [];
  page.on('request', (request) => {
    const { protocol, origin } = new URL(request.url());
    if (protocol !== 'data:') origins.add(origin);
    if (request.resourceType() === 'font') fonts.push(origin);
  });
  await openDesign(page);
  await page.evaluate(() => document.fonts.ready);

  expect([...origins].sort()).toEqual([new URL(baseURL ?? '').origin, STATIC_HOST].sort());
  expect([...new Set(fonts)]).toEqual([STATIC_HOST]);
  const loaded = await page.evaluate(() =>
    [...document.fonts].filter((font) => font.status === 'loaded').map((font) => font.family.replaceAll('"', '')),
  );
  expect(loaded).toEqual(expect.arrayContaining(['Geist', 'Geist Mono']));
});

test.describe('the wall', () => {
  // The first line to arrive is the first sample event.
  const firstArrival = SAMPLE_EVENTS[0]?.text ?? '';

  test('types out its newest line, then shows it in full', async ({ page }) => {
    await openDesignPaused(page);
    const newest = await nextWallLine(page);
    const text = newest.locator('.wall-line__text');

    // The clock is paused, so the line has only just started typing.
    await expect(newest.locator('.cursor')).toHaveCount(1);
    const typedSoFar = (await text.textContent()) ?? '';
    expect(typedSoFar.length).toBeLessThan(firstArrival.length);

    await page.clock.resume();
    await expect(newest.locator('.cursor')).toHaveCount(0);
    await expect(text).toHaveText(firstArrival);
  });

  test('rises in a line that arrives, and only that line', async ({ page }) => {
    await openDesignPaused(page);
    for (const line of await page.locator('.wall-line').all()) {
      expect(await line.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
    }

    const newest = await nextWallLine(page);

    expect(await newest.evaluate((el) => getComputedStyle(el).animationName)).toBe('rise');
  });

  test('fades each older line, but never below text-faint', async ({ page }) => {
    await openDesignPaused(page);
    await installContrast(page);
    const ratios = await page.locator('.wall-line__text').evaluateAll((texts) => texts.map((text) => contrastOnPage(text)));
    const faint = await page.evaluate(() => {
      const probe = document.createElement('p');
      probe.style.color = 'var(--text-faint)';
      probe.textContent = 'x';
      document.querySelector('main')?.append(probe);
      const ratio = contrastOnPage(probe);
      probe.remove();
      return ratio;
    });

    expect(ratios.length).toBeGreaterThan(2);
    for (let i = 1; i < ratios.length; i++) {
      expect(ratios[i]).toBeLessThanOrEqual(ratios[i - 1] ?? 0);
    }
    expect(ratios.at(-1)).toBeLessThan(ratios[0] ?? 0);
    for (const ratio of ratios) expect(ratio).toBeGreaterThanOrEqual(faint - 0.01);
  });

  test('under reduced motion, shows its newest line in full at once, and nothing on the page moves', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openDesignPaused(page);
    const newest = await nextWallLine(page);

    await expect(newest.locator('.cursor')).toHaveCount(0);
    await expect(newest.locator('.wall-line__text')).toHaveText(firstArrival);
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  });
});

test.describe('the prompt', () => {
  test("the prompt's copy button puts the prompt on the clipboard, and says copied in place", async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openDesign(page);
    const button = page.getByRole('button', { name: 'Copy prompt' });

    await button.click();

    await expect(button).toHaveText('copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(SAMPLE_PROMPT);
    await expect(page.locator('.prompt__text').first()).toHaveText(SAMPLE_PROMPT);
    await expect(button).toHaveText('copy');
  });

  test("a command's copy button puts its full form on the clipboard, even when the box shows a shorter one", async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openDesign(page);
    const button = page.getByRole('button', { name: 'Copy command' });

    await button.click();

    await expect(button).toHaveText('copied');
    await expect(page.locator('.prompt--shell .prompt__text')).toHaveText(SAMPLE_COMMAND.shown);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(SAMPLE_COMMAND.copied);
  });

  test('its copy button says select it when the browser refuses to copy', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator.clipboard, 'writeText', {
        value: () => Promise.reject(new Error('Refused by the test')),
      });
    });
    await openDesign(page);
    const button = page.getByRole('button', { name: 'Copy prompt' });

    await button.click();

    await expect(button).toHaveText('select it');
  });

  test('each open-in link opens its harness with the prompt filled in', async ({ page }) => {
    await openDesign(page);
    const link = async (name: string) => new URL((await page.locator('.open-in').getByRole('link', { name }).getAttribute('href')) ?? '');

    const claude = await link('claude code');
    expect(`${claude.protocol}//${claude.host}${claude.pathname}`).toBe('claude://code/new');
    expect(claude.searchParams.get('q')).toBe(SAMPLE_PROMPT);

    const codex = await link('codex');
    expect(`${codex.protocol}//${codex.host}${codex.pathname}`).toBe('codex://new');
    expect(codex.searchParams.get('prompt')).toBe(SAMPLE_PROMPT);

    const cursor = await link('cursor');
    expect(`${cursor.protocol}//${cursor.host}${cursor.pathname}`).toBe('cursor://anysphere.cursor-deeplink/prompt');
    expect(cursor.searchParams.get('text')).toBe(SAMPLE_PROMPT);
  });

  test('the t3 code button copies the prompt before it opens T3 Code, which takes no prompt', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    // Paused, so the page never leaves for T3 Code during the test.
    await openDesignPaused(page);

    await page.locator('.open-in').getByRole('button', { name: 't3 code' }).click();

    await expect(page.locator('.open-in').getByRole('status')).toHaveText('Prompt copied. Opening T3 Code, paste it in.');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(SAMPLE_PROMPT);
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

  test('opens its phone menu with no script running', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 800 } });
    const page = await context.newPage();
    await page.goto('/design');
    const nav = page.getByRole('navigation', { name: 'Primary' });
    const live = nav.getByRole('link', { name: 'live' });

    await expect(live).toBeHidden();
    await nav.locator('.site-nav__menu').click();
    await expect(live).toBeVisible();
    await context.close();
  });

  test('folds at the same width the page gutter narrows, even with a scrollbar taking room', async ({ page }) => {
    // A classic 15px scrollbar leaves the page 875px wide in an 890px
    // window. Headless Chromium hides scrollbars, so the page is narrowed
    // the same way by hand.
    await page.setViewportSize({ width: 890, height: 800 });
    await openDesign(page);
    await page.addStyleTag({ content: 'body { width: 875px; }' });
    const nav = page.getByRole('navigation', { name: 'Primary' });

    await expect(nav.locator('.site-nav__menu')).toBeVisible();
    await expect(page.locator('main')).toHaveCSS('padding-left', '20px');
    await expect(nav).toHaveCSS('padding-left', '20px');
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

test('tabs show one panel at a time, and the arrow keys, Home, and End move between them', async ({ page }) => {
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

  await page.keyboard.press('Home');
  await expect(tabs.nth(0)).toBeFocused();
  await expect(shownPanel).toHaveAccessibleName('this week');

  await page.keyboard.press('End');
  await expect(tabs.nth(2)).toBeFocused();
  await expect(shownPanel).toHaveAccessibleName('by agent');

  await tabs.nth(1).click();
  await expect(shownPanel).toHaveAccessibleName('all time');
});

test('a toggle chip shows whether it is pressed, and pressing one lets go of the other', async ({ page }) => {
  await openDesign(page);
  const group = page.getByRole('group', { name: 'Show merged PRs from' });
  const week = group.getByRole('button', { name: 'this week' });
  const all = group.getByRole('button', { name: 'all time' });

  await expect(week).toHaveAttribute('aria-pressed', 'true');
  await expect(all).toHaveAttribute('aria-pressed', 'false');
  await expect(week).toHaveCSS('background-color', 'rgb(14, 17, 22)');

  await all.click();

  await expect(all).toHaveAttribute('aria-pressed', 'true');
  await expect(week).toHaveAttribute('aria-pressed', 'false');
  await expect(all).toHaveCSS('background-color', 'rgb(14, 17, 22)');
  await expect(week).not.toHaveCSS('background-color', 'rgb(14, 17, 22)');
});

test.describe('accessibility', () => {
  test('all text has at least 4.5:1 contrast on its background, or 3:1 when large', async ({ page }) => {
    await openDesignPaused(page);
    await installContrast(page);
    const failures = await page.evaluate(() => {
      const out: string[] = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const seen = new Set<Element>();
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const el = node.parentElement;
        const text = node.textContent?.trim() ?? '';
        if (!el || seen.has(el) || !text) continue;
        seen.add(el);
        // A project's label takes its color from GitHub, and its text is
        // whichever of white or ink reads better. WCAG exempts disabled
        // controls. Visually hidden text has no color to read.
        if (el.closest('.tag, [disabled], .visually-hidden')) continue;
        if (!el.checkVisibility({ visibilityProperty: true })) continue;
        const style = getComputedStyle(el);
        const size = parseFloat(style.fontSize);
        const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
        const ratio = contrastOnPage(el);
        if (ratio < (large ? 3 : 4.5)) out.push(`${text.slice(0, 40)}: ${ratio.toFixed(2)}`);
      }
      return out;
    });
    expect(failures).toEqual([]);
  });

  test('the focus ring has at least 3:1 contrast on paper and on the dark prompt', async ({ page }) => {
    await openDesign(page);
    await installContrast(page);
    const ringContrast = async (target: Locator) => {
      await page.keyboard.press('Tab');
      await target.focus();
      return target.evaluate((el) => {
        if (!el.matches(':focus-visible')) return 0;
        // The outermost ring is the last shadow, and it meets the backdrop.
        const colors = getComputedStyle(el).boxShadow.match(/rgba?\([^)]+\)/g) ?? [];
        return contrastOn(colors.at(-1) ?? '', el.parentElement ?? document.body);
      });
    };

    expect(await ringContrast(page.getByRole('link', { name: 'Good First Token home' }).first())).toBeGreaterThanOrEqual(3);
    expect(await ringContrast(page.getByRole('button', { name: 'Copy prompt' }))).toBeGreaterThanOrEqual(3);
  });

  test('the copy buttons are named for what they copy, and every button and link has a name', async ({ page }) => {
    await openDesign(page);

    await expect(page.getByRole('button', { name: 'Copy prompt', exact: true })).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Copy command', exact: true })).toHaveCount(1);
    for (const control of [...(await page.getByRole('button').all()), ...(await page.getByRole('link').all())]) {
      await expect(control).toHaveAccessibleName(/\S/);
    }
  });

  test('numbers and ranked names read with spaces between their parts', async ({ page }) => {
    await openDesign(page);

    await expect(page.locator('.stat-line')).toMatchAriaSnapshot('- paragraph: 3 tagged 2 working now 14 merged');
    await expect(page.locator('.ranks').first()).toMatchAriaSnapshot(`
      - list:
        - listitem: 1 @priya claude-code 10
        - listitem: 2 @kenji codex 7
    `);
  });
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
