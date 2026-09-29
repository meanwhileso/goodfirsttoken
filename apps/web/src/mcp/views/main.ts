import '../../styles/tokens.css';
import '../../styles/base.css';
import '../../styles/components.css';
import './view.css';
import { connect, type HostContext, type Host, type ToolAnswer } from './bridge';
import { cardsTitle, renderCards } from './cards';
import { h } from './dom';
import { renderClaim, type Claimed } from './live';
import { answerText, frame, isObject, notice } from './parts';
import { renderReview, reviewTitle } from './review';

// The script of every view MCP Apps hosts show. The page names its view in
// <body data-view>, as src/mcp/apps.ts serves it. The view waits for the
// answer of the tool call it shows, then draws it from the answer's
// structured content, the data the tool's text is written from, so the two
// agree. An answer with no data, or a refusal, shows its own text.

type ViewName = 'issue-cards' | 'live-feed' | 'review-queue';

const TITLES: Record<ViewName, string> = {
  'issue-cards': 'tagged for outside help',
  'live-feed': 'your claim',
  'review-queue': 'review queue',
};

const root = document.getElementById('view') ?? document.body;
const view = (document.body.dataset.view ?? 'issue-cards') as ViewName;
let sessionId: string | null = null;
let host: Host | null = null;
let waiting: ToolAnswer | null = null;

function show(title: string, ...parts: Node[]): void {
  root.replaceChildren(frame(title, ...parts));
}

function draw(answer: ToolAnswer): void {
  if (host === null) {
    // The answer came before the handshake finished.
    waiting = answer;
    return;
  }
  const data = answer.data;
  if (answer.isError || !isObject(data)) {
    show(TITLES[view], h('div', { class: 'view-item' }, answer.isError ? notice(answer.text, 'refused') : answerText(answer.text)));
    return;
  }
  try {
    if (view === 'issue-cards') show(cardsTitle(data), ...renderCards(host, data, answer.text, sessionId));
    else if (view === 'live-feed') show(TITLES[view], renderClaim(host, data as Claimed));
    else show(reviewTitle(data), ...renderReview(host, data, answer.text));
  } catch {
    // Data the view can't draw still reads as the tool's text.
    show(TITLES[view], answerText(answer.text));
  }
}

/** Dark or light as the host says, or as the person's system does when it doesn't. */
function applyTheme(context: HostContext): void {
  const theme =
    context.theme === 'dark' || context.theme === 'light'
      ? context.theme
      : window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
  document.documentElement.dataset.theme = theme;
}

async function main(): Promise<void> {
  applyTheme({});
  show(TITLES[view], h('p', { class: 'view-quiet view-item' }, 'Waiting for the answer.'));
  host = await connect(
    {
      input: (args) => {
        sessionId = typeof args.sessionId === 'string' ? args.sessionId : null;
      },
      result: draw,
      cancelled: (reason) => {
        show(TITLES[view], h('div', { class: 'view-item' }, notice(reason ? `The call was cancelled: ${reason}` : 'The call was cancelled.', 'note')));
      },
      context: applyTheme,
    },
    { name: 'Good First Token', version: '1.0.0' },
  );
  if (waiting !== null) draw(waiting);
}

void main();
