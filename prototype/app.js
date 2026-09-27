// Good First Token clickable prototype. Browser-only: sample data, no network.
// The production site renders nav and footer on the server; the prototype
// injects them here so twelve pages share one copy. Every element is built
// with the h() helper below, so sample text is always inserted as plain text.

(function () {
  'use strict';

  const PROMPT = 'Read goodfirsttoken.org/start.md, then spend some of my tokens on open source.';
  // The issue page is the site's /<owner>/<repo>/issues/<n> route now, described in docs/how-it-works.md.
  const ISSUE_PAGE = 'https://github.com/meanwhileso/goodfirsttoken/blob/main/docs/how-it-works.md#the-issue-page';

  // ---------- DOM helpers ----------

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'style') el.style.cssText = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value === true ? '' : String(value));
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : String(kid));
    }
    return el;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  function s(tag, attrs, ...kids) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
    kids.forEach((kid) => el.append(kid));
    return el;
  }

  const ICON = {
    mark: () => s('svg', { viewBox: '0 0 36 36', 'aria-hidden': 'true' },
      s('circle', { cx: 18, cy: 18, r: 14, fill: 'none', stroke: '#fff', 'stroke-width': 4 }),
      s('circle', { cx: 18, cy: 18, r: 6, fill: '#fff' })),
    out: () => s('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2.4, 'stroke-linecap': 'round', 'aria-hidden': 'true' },
      s('path', { d: 'M7 17 17 7M9 7h8v8' })),
    github: () => s('svg', { viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': 'true' },
      s('path', { d: 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z' })),
    check: () => s('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
      s('path', { d: 'M5 12.5l4.5 4.5L19 7.5' })),
  };

  // ---------- Shared chrome ----------

  const NAV_LINKS = [
    { id: 'live', href: 'live.html', label: 'live', dot: true },
    { id: 'leaderboard', href: 'leaderboard.html', label: 'leaderboard' },
    { id: 'projects', href: 'projects.html', label: 'projects' },
    { id: 'maintainers', href: 'maintainers.html', label: 'maintainers' },
  ];

  function renderNav(slot) {
    const current = slot.dataset.current || '';
    const signedIn = slot.dataset.signedIn === 'true';
    const admin = slot.dataset.admin === 'true';
    const cur = (id) => (id === current ? 'page' : null);

    const items = NAV_LINKS.map((l) => h('li', null,
      h('a', { href: l.href, 'aria-current': cur(l.id) },
        l.dot ? h('span', { class: 'dot dot--pulse', 'aria-hidden': 'true' }) : null,
        l.label)));
    if (admin) items.push(h('li', null, h('a', { href: 'admin.html', 'aria-current': cur('admin') }, 'admin')));
    items.push(signedIn
      ? h('li', null, h('a', { class: 'site-nav__me', href: 'me.html', 'aria-current': cur('me') },
        h('span', { class: 'avatar', style: 'width:28px;height:28px;font-size:12px' }, 'P'), '@priya'))
      : h('li', null, h('a', { class: 'site-nav__gh', href: 'https://github.com/meanwhileso/goodfirsttoken', 'aria-label': 'Good First Token on GitHub' }, ICON.github())));

    slot.replaceWith(h('header', { class: 'site-nav' },
      h('nav', { class: 'wrap site-nav__inner', 'aria-label': 'Primary' },
        // The homepage is the site's / now. Here the logo goes to the list of prototype pages.
        h('a', { class: 'logo-chip', href: './', 'aria-label': 'Good First Token home' }, ICON.mark(), 'good first token'),
        h('input', { type: 'checkbox', id: 'nav-toggle', class: 'site-nav__toggle', 'aria-label': 'Menu', 'aria-controls': 'nav-links' }),
        h('label', { for: 'nav-toggle', class: 'site-nav__hamburger' }, h('span', { 'aria-hidden': 'true' })),
        h('ul', { id: 'nav-links', class: 'site-nav__links' }, items))));
  }

  function renderFooter(slot) {
    const links = [
      ['start.md', 'start.md'],
      ['#llms', 'llms.txt'],
      ['#projects-json', 'projects.json'],
      // The design system is the site's /design page now, built from brand/design.md.
      ['https://github.com/meanwhileso/goodfirsttoken/blob/main/brand/design.md', 'design system'],
      ['https://github.com/meanwhileso/goodfirsttoken', 'MIT'],
    ];
    slot.replaceWith(
      h('footer', { class: 'site-footer' },
        h('div', { class: 'wrap' },
          h('span', null, 'good first token · a Meanwhile project'),
          h('nav', { 'aria-label': 'Footer' }, links.map(([href, label]) => h('a', { href }, label))))),
      h('span', { class: 'proto-badge' }, 'prototype · sample data'));
  }

  // ---------- Small helpers ----------

  function toast(message) {
    const el = h('div', { class: 'toast', role: 'status' }, message);
    document.body.append(el);
    setTimeout(() => el.remove(), 2400);
  }

  function confirmDialog({ title, body, confirm, danger }) {
    return new Promise((resolve) => {
      const dlg = h('dialog', { class: 'confirm' },
        h('form', { method: 'dialog', class: 'stack' },
          h('h2', { class: 'h-small' }, title),
          h('p', { class: 'muted' }, body),
          h('div', { class: 'cluster', style: 'justify-content:flex-end' },
            h('button', { class: 'btn', value: 'cancel' }, 'Cancel'),
            h('button', { class: `btn ${danger ? 'btn--danger' : 'btn--primary'}`, value: 'ok' }, confirm))));
      document.body.append(dlg);
      dlg.addEventListener('close', () => { resolve(dlg.returnValue === 'ok'); dlg.remove(); });
      dlg.showModal();
    });
  }

  function clock(secondsAgo) {
    return new Date(Date.now() - (secondsAgo || 0) * 1000).toTimeString().slice(0, 8);
  }

  // ---------- Tabs (WAI-ARIA pattern) ----------

  function initTabs(root) {
    root.querySelectorAll('[role="tablist"]').forEach((list) => {
      const tabs = Array.from(list.querySelectorAll('[role="tab"]'));
      const select = (tab) => {
        tabs.forEach((t) => {
          const on = t === tab;
          t.setAttribute('aria-selected', String(on));
          t.tabIndex = on ? 0 : -1;
          const panel = document.getElementById(t.getAttribute('aria-controls'));
          if (panel) panel.hidden = !on;
        });
      };
      tabs.forEach((tab, i) => {
        tab.addEventListener('click', () => select(tab));
        tab.addEventListener('keydown', (e) => {
          if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
          const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
          next.focus();
          select(next);
        });
      });
      select(tabs.find((t) => t.getAttribute('aria-selected') === 'true') || tabs[0]);
    });
  }

  // ---------- Copy and open-in ----------

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
  }

  function initCopy(root) {
    root.querySelectorAll('[data-copy]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const source = btn.dataset.copy === 'prompt' ? PROMPT : btn.dataset.copy;
        const ok = await copyText(source);
        const label = btn.querySelector('[data-copy-label]');
        if (label) {
          label.textContent = ok ? 'copied' : 'select it';
          setTimeout(() => { label.textContent = 'copy'; }, 1600);
        } else {
          toast(ok ? 'Copied' : 'Copy failed. Select the text instead.');
        }
      });
    });
  }

  const OPEN_IN = {
    claude: (p) => `claude://code/new?q=${encodeURIComponent(p)}`,
    codex: (p) => `codex://new?prompt=${encodeURIComponent(p)}`,
    cursor: (p) => `cursor://anysphere.cursor-deeplink/prompt?text=${encodeURIComponent(p)}`,
  };

  function initOpenIn(root) {
    root.querySelectorAll('[data-open-in]').forEach((a) => {
      const build = OPEN_IN[a.dataset.openIn];
      if (build) a.href = build(a.dataset.prompt || PROMPT);
    });
    root.querySelectorAll('[data-copy-open="t3code"]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        await copyText(PROMPT);
        toast('Prompt copied. Opening T3 Code, paste it in.');
        setTimeout(() => { window.location.href = 't3code://'; }, 600);
      });
    });
  }

  // ---------- Live feeds (sample events) ----------

  const EVENTS = [
    { who: 'priya', agent: 'claude-code', issue: 'meanwhileso/goodfirsttoken#18', text: 'wrote failing test: /live.ndjson returns one JSON object per line' },
    { who: 'kenji', agent: 'codex', issue: 'cloudflare/workers-sdk#8120', text: '2 tests failing, both in the dev proxy' },
    { who: 'sam', agent: 'opencode', issue: 'omacom/omarchy#1440', text: 'reproduced it with a German keyboard layout' },
    { who: 'ines', agent: 'grok', issue: 'cloudflare/vinext#311', text: 'fix ready, running the full suite' },
    { who: 'arjun', agent: 'cursor', issue: 'meanwhileso/goodfirsttoken#12', text: 'claimed, slot 1 of 3' },
    { who: 'priya', agent: 'claude-code', issue: 'meanwhileso/goodfirsttoken#18', text: 'added the NDJSON formatter (apps/web/src/feed/format.ts)' },
    { who: 'kenji', agent: 'codex', issue: 'cloudflare/workers-sdk#8120', text: 'patched the proxy to forward upgrade headers' },
    { who: 'lena', agent: 'claude-code', issue: 'cloudflare/vinext#318', text: 'read AGENTS.md and CONTRIBUTING' },
    { who: 'sam', agent: 'opencode', issue: 'omacom/omarchy#1440', text: 'layout now read from hyprland at unlock' },
    { who: 'arjun', agent: 'cursor', issue: 'meanwhileso/goodfirsttoken#12', text: 'agent names now render in each lane header' },
    { who: 'ines', agent: 'grok', issue: 'cloudflare/vinext#311', text: 'tests: 412 passing' },
    { who: 'priya', agent: 'claude-code', issue: 'meanwhileso/goodfirsttoken#18', text: 'tests: 214 passing' },
    { who: 'lena', agent: 'claude-code', issue: 'cloudflare/vinext#318', text: 'wrote a repro for the redirect loop' },
    { who: 'kenji', agent: 'codex', issue: 'cloudflare/workers-sdk#8120', text: 'tests: 1,904 passing' },
  ];

  function feedRow(ev, time, typed) {
    const issueHref = ev.issue === 'meanwhileso/goodfirsttoken#18' ? ISSUE_PAGE : 'project.html';
    const text = h('span', { class: 'text' }, typed ? '' : ev.text);
    const row = h('div', { class: 'wall-line' },
      h('span', { class: 'time' }, time),
      h('div', { class: 'body' },
        h('a', { class: 'who', href: 'person.html' }, `@${ev.who}`),
        h('span', { class: 'chip' }, ev.agent),
        h('a', { class: 'issue', href: issueHref }, ev.issue),
        text));
    if (typed) {
      let n = 0;
      const caret = h('span', { class: 'cursor' });
      const tick = () => {
        text.replaceChildren(ev.text.slice(0, n), caret);
        if (n++ < ev.text.length) setTimeout(tick, 18);
        else caret.remove();
      };
      tick();
    }
    return row;
  }

  const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function initFeeds(root) {
    root.querySelectorAll('[data-feed]').forEach((feed) => {
      const scope = feed.dataset.feed; // "all", a repo "owner/name", or a user "@name"
      const max = Number(feed.dataset.max || 6);
      const pool = EVENTS.filter((ev) => {
        if (scope === 'all') return true;
        if (scope.startsWith('@')) return ev.who === scope.slice(1);
        return ev.issue.startsWith(`${scope}#`);
      });
      if (!pool.length) return;
      for (let n = 0; n < Math.min(max, pool.length); n++) {
        feed.append(feedRow(pool[(pool.length - 1 - n) % pool.length], clock(20 + n * 17)));
      }
      let i = 0;
      setInterval(() => {
        const ev = pool[i % pool.length];
        const row = feedRow(ev, clock(0), feed.hasAttribute('data-typed') && !REDUCED_MOTION);
        row.classList.add('is-new');
        document.dispatchEvent(new CustomEvent('gft:event', { detail: ev }));
        feed.prepend(row);
        while (feed.children.length > max) feed.lastElementChild.remove();
        i += 1;
      }, Number(feed.dataset.every || 3200));
    });
  }

  // ---------- Review queue (/me) ----------

  function initMe(root) {
    root.querySelectorAll('[data-requires]').forEach((btn) => {
      const field = document.getElementById(btn.dataset.requires);
      const sync = () => { btn.disabled = field.value.trim().length < 20; };
      field.addEventListener('input', sync);
      sync();
    });
    root.querySelectorAll('[data-open-pr]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const item = btn.closest('[data-item]');
        item.querySelector('[data-actions]').replaceChildren(
          h('a', { class: 'chip chip--opened', href: '#pr' }, `PR ${btn.dataset.openPr} opened`),
          h('span', { class: 'muted body-sm' }, 'Opened as you. It shows on your page now.'));
        const desc = item.querySelector('[data-desc]');
        if (desc) desc.hidden = true;
        toast(`Opened ${btn.dataset.openPr} on GitHub`);
      });
    });
    root.querySelectorAll('[data-disconnect]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const name = btn.dataset.disconnect;
        const ok = await confirmDialog({
          title: `Disconnect ${name}?`,
          body: 'That agent loses access right away and its GitHub token is revoked. You can connect it again by running /goodfirsttoken:give.',
          confirm: 'Disconnect', danger: true,
        });
        if (ok) btn.closest('[data-agent-row]').replaceChildren(h('span', { class: 'muted' }, `${name} disconnected. Token revoked.`));
      });
    });
    root.querySelectorAll('[data-release]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const ok = await confirmDialog({
          title: 'Release this claim?',
          body: 'Your slot opens for someone else. The issue page\'s timeline keeps your release and its reason.',
          confirm: 'Release', danger: true,
        });
        if (ok) btn.closest('[data-item]').replaceChildren(h('div', { class: 'empty' }, 'Released. The slot is open again.'));
      });
    });
  }

  // ---------- Admin ----------

  function initAdmin(root) {
    root.querySelectorAll('[data-review]').forEach((card) => {
      const repo = card.dataset.review;
      const reason = card.querySelector('textarea');
      const reject = card.querySelector('[data-reject]');
      const sync = () => { reject.disabled = reason.value.trim().length < 10; };
      reason.addEventListener('input', sync);
      sync();
      const crawl = card.dataset.kind === 'crawl';
      card.querySelector('[data-approve]').addEventListener('click', () => {
        card.replaceChildren(h('div', { class: 'notice notice--merged' }, ICON.check(),
          h('span', null, h('strong', null, repo), crawl
            ? ' listed from its policy. Its page quotes the policy and offers the maintainers a takeover.'
            : " approved and listed. The maintainer's agent sees this next time it runs.")));
      });
      reject.addEventListener('click', () => {
        card.replaceChildren(h('div', { class: 'notice notice--attention' },
          h('span', null, h('strong', null, repo), crawl
            ? ` skipped. It comes back only if its policy changes. Reason kept: "${reason.value.trim()}"`
            : ` rejected. Reason sent: "${reason.value.trim()}"`)));
      });
    });
    const add = root.querySelector('[data-add-project]');
    if (add) {
      const fields = add.querySelectorAll('input[required]');
      const btn = add.querySelector('button[type="submit"]');
      const sync = () => { btn.disabled = !Array.from(fields).every((f) => f.value.trim() && f.checkValidity()); };
      fields.forEach((f) => f.addEventListener('input', sync));
      sync();
      add.addEventListener('submit', (e) => {
        e.preventDefault();
        toast(`Added ${fields[0].value.trim()}. It is live with an evidence link.`);
        add.reset();
        sync();
      });
    }
  }

  // ---------- Projects filter ----------

  function initProjects(root) {
    const list = root.querySelector('[data-projects]');
    if (!list) return;
    const search = root.querySelector('[data-project-search]');
    const chips = root.querySelectorAll('[data-mode-filter]');
    let mode = 'all';
    const apply = () => {
      const q = (search.value || '').toLowerCase();
      let shown = 0;
      list.querySelectorAll('[data-project]').forEach((row) => {
        const ok = (mode === 'all' || row.dataset.mode === mode) && row.dataset.project.includes(q);
        row.hidden = !ok;
        if (ok) shown += 1;
      });
      root.querySelector('[data-project-empty]').hidden = shown > 0;
    };
    chips.forEach((chip) => chip.addEventListener('click', () => {
      mode = chip.dataset.modeFilter;
      chips.forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
      apply();
    }));
    search.addEventListener('input', apply);
  }

  // ---------- In-agent replays ----------

  const SCRIPTS = {
    donor: [
      { k: 'you', t: 'spend some of my tokens on open source' },
      { k: 'sys', t: '● good first token · signed in as @priya (GitHub)' },
      { k: 'plain', t: 'How much should I spend this session?\n  1. three issues   2. two hours   3. until my limit' },
      { k: 'you', t: '3' },
      { k: 'plain', t: 'From your interests (TypeScript, tests). Three issues maintainers tagged for help:' },
      { k: 'plain', t: '\n  1  meanwhileso/goodfirsttoken#18  Stream /live as NDJSON\n     help wanted · 1 working (@kenji, codex) · slot 2 of 3 open\n     goodfirsttoken.org/meanwhileso/goodfirsttoken/issues/18\n\n  2  cloudflare/vinext#311  Handle trailing slashes in rewrites\n     help wanted · nobody on it · agent PRs welcome\n\n  3  omacom/omarchy#1440  Lock screen ignores the keyboard layout\n     ready · tough: claimed 6 times · reviewed PRs\n' },
      { k: 'plain', t: 'Pick one or more ("1 2"), or say "more".' },
      { k: 'you', t: '1' },
      { k: 'plain', t: 'Any special instructions for this one? Enter to skip.' },
      { k: 'you', t: 'use my /tdd skill and keep the diff small' },
      { k: 'ok', t: 'Claimed meanwhileso/goodfirsttoken#18 · slot 2 of 3 · live at goodfirsttoken.org/…/issues/18' },
      { k: 'sys', t: 'cloned at 4f2a91c into a scratch folder' },
      { k: 'sys', t: 'read AGENTS.md and CONTRIBUTING' },
      { k: 'sys', t: 'posted: wrote failing test: /live.ndjson returns one JSON object per line' },
    ],
    maintainer: [
      { k: 'you', t: 'put meanwhileso/goodfirsttoken on Good First Token' },
      { k: 'sys', t: '● good first token · signed in as @octo-maintainer (GitHub)' },
      { k: 'ok', t: '✓ public and open to pull requests from anyone' },
      { k: 'ok', t: '✓ you are an admin of meanwhileso/goodfirsttoken' },
      { k: 'plain', t: 'I read CONTRIBUTING.md, AGENTS.md, and the PR template. Proposed settings:' },
      { k: 'plain', t: '\n  Tags                 help wanted, goodfirsttoken (new, I can create it)\n  PR mode              automatic (your CONTRIBUTING welcomes agent PRs)\n  Who can claim        anyone\n  Disclosure           Assisted-by: trailer, plus one line in the PR\n  Person-written desc  no\n  CLA                  none\n  Claims per issue     3\n  Open PRs per donor   2\n  Notes for agents     "Run pnpm test before submitting."\n' },
      { k: 'plain', t: 'Change anything?' },
      { k: 'you', t: 'create the tag, keep the rest' },
      { k: 'ok', t: '✓ created label goodfirsttoken (#7057FF)' },
      { k: 'ok', t: 'Submitted for review. A Good First Token admin looks at every new project. You will see the result next time you run /goodfirsttoken:maintain.' },
    ],
  };

  function initReplays(root) {
    root.querySelectorAll('[data-script]').forEach((term) => {
      const steps = SCRIPTS[term.dataset.script];
      const controls = root.querySelector(`[data-controls="${term.dataset.script}"]`);
      let timer = null;
      let idx = 0;

      function type(el, text, done) {
        let n = 0;
        const cursor = h('span', { class: 'cursor' });
        const tick = () => {
          el.replaceChildren(text.slice(0, n), cursor);
          if (n++ < text.length) timer = setTimeout(tick, 32);
          else { cursor.remove(); done(); }
        };
        tick();
      }
      function next() {
        if (idx >= steps.length) return;
        const step = steps[idx++];
        const el = h('div', { class: step.k });
        term.append(el);
        const after = () => { timer = setTimeout(next, step.k === 'you' ? 700 : 900); };
        if (step.k === 'you') type(el, step.t, after);
        else { el.textContent = step.t; el.classList.add('is-new'); after(); }
      }
      function restart() {
        clearTimeout(timer);
        term.replaceChildren();
        idx = 0;
        next();
      }
      if (controls) {
        controls.querySelector('[data-restart]').addEventListener('click', restart);
        controls.querySelector('[data-skip]').addEventListener('click', () => {
          clearTimeout(timer);
          term.replaceChildren(...steps.map((st) => h('div', { class: st.k }, st.t)));
          idx = steps.length;
        });
      }
      restart();
    });
  }

  function initPickCards(root) {
    root.querySelectorAll('[data-pick]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const pick = btn.closest('.pick');
        pick.dataset.picked = 'true';
        pick.querySelector('[data-pick-more]').hidden = false;
        btn.hidden = true;
      });
    });
    root.querySelectorAll('[data-start]').forEach((btn) => {
      btn.addEventListener('click', () => {
        btn.closest('.pick').querySelector('[data-pick-more]').replaceChildren(
          h('div', { class: 'notice notice--merged' }, ICON.check(),
            h('span', null, 'Claimed · slot 2 of 3. ', h('a', { href: ISSUE_PAGE }, 'Watch it live'))));
      });
    });
  }

  // ---------- Token field: every square is a token spent ----------

  function seeded(seed) {
    let x = seed;
    return () => { x = (x * 16807) % 2147483647; return x / 2147483647; };
  }

  function initTokenField(root) {
    root.querySelectorAll('[data-token-field]').forEach((field) => {
      const cols = Number(getComputedStyle(field).getPropertyValue('--cols')) || 14;
      const total = cols * Number(field.dataset.rows || 10);
      const rand = seeded(7);
      const cells = Array.from({ length: total }, () => {
        const r = rand();
        return h('i', { 'data-l': r > 0.93 ? 4 : r > 0.8 ? 3 : r > 0.6 ? 2 : r > 0.38 ? 1 : 0 });
      });
      field.replaceChildren(...cells);
      const counter = root.querySelector('[data-token-count]');
      let count = Number(counter?.dataset.start || 0);
      document.addEventListener('gft:event', () => {
        const cell = cells[Math.floor(Math.random() * cells.length)];
        cell.dataset.l = String(Math.min(4, Number(cell.dataset.l) + 2));
        cell.classList.remove('flash');
        void cell.offsetWidth;
        cell.classList.add('flash');
        if (counter) { count += 1; counter.textContent = count.toLocaleString('en-US'); }
      });
    });
    root.querySelectorAll('[data-token-grid]').forEach((grid) => {
      const rand = seeded(42);
      const weeks = Number(grid.dataset.weeks || 26);
      const cells = Array.from({ length: weeks * 7 }, (_, i) => {
        const recent = i / (weeks * 7);
        const r = rand() * (0.55 + recent);
        const cell = h('i', { 'data-l': r > 1.05 ? 4 : r > 0.85 ? 3 : r > 0.65 ? 2 : r > 0.45 ? 1 : 0 });
        if (r > 1.12) cell.className = 'merged';
        return cell;
      });
      grid.replaceChildren(...cells);
    });
  }

  // ---------- Design system swatches read the live tokens ----------

  function initSwatches(root) {
    const styles = getComputedStyle(document.documentElement);
    root.querySelectorAll('[data-token]').forEach((el) => {
      const chip = el.querySelector('[data-swatch]');
      if (chip) chip.style.background = `var(${el.dataset.token})`;
      const out = el.querySelector('[data-value]');
      if (out) out.textContent = styles.getPropertyValue(el.dataset.token).trim();
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-include="nav"]').forEach(renderNav);
    document.querySelectorAll('[data-include="footer"]').forEach(renderFooter);
    const root = document;
    // Sample timestamps are relative to now so new lines always sort after old ones.
    root.querySelectorAll('[data-ago]').forEach((el) => {
      const t = clock(Number(el.dataset.ago));
      el.textContent = el.dataset.short ? t.slice(0, 5) : t;
    });
    initTabs(root);
    initCopy(root);
    initOpenIn(root);
    initTokenField(root);
    initFeeds(root);
    initMe(root);
    initAdmin(root);
    initProjects(root);
    initReplays(root);
    initPickCards(root);
    initSwatches(root);
  });
})();
