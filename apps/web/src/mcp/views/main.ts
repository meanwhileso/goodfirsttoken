import '../../styles/tokens.css';
import '../../styles/base.css';
import '../../styles/components.css';
import './view.css';
import { connect, type HostContext, type Host, type ToolAnswer } from './bridge';
import { cardsTitle, renderCards } from './cards';
import { h } from './dom';
import { closeFeeds, renderClaim, type Claimed } from './live';
import { answerText, frame, isObject, notice } from './parts';
import { renderReview, reviewTitle } from './review';

// The script of every view MCP Apps hosts show. The page names its view in
// <body data-view>, as src/mcp/apps.ts serves it. The view waits for the
// answer of the tool call it shows, then draws it from the answer's
// structured content, the data the tool's text is written from, so the two
// agree. An answer with no data, or a refusal, shows its own text. The view
// draws the first input and answer the host sends. A host may send the
// input and answer of the view's own tool calls after them, like the Pick
// on a card, and the view shows those where the button was.

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
let hasInput = false;
let answered = false;
/** The host's context so far, since each change holds only what changed. */
let context: HostContext = {};

function show(title: string, ...parts: Node[]): void {
  root.replaceChildren(frame(title, ...parts));
}

function draw(answer: ToolAnswer): void {
  if (host === null) {
    // The answer came before the handshake finished.
    waiting = answer;
    return;
  }
  closeFeeds();
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
  applyTheme(context);
  show(TITLES[view], h('p', { class: 'view-quiet view-item' }, 'Waiting for the answer.'));
  try {
    host = await connect(
      {
        input: (args) => {
          if (hasInput) return;
          hasInput = true;
          sessionId = typeof args.sessionId === 'string' ? args.sessionId : null;
        },
        result: (answer) => {
          if (answered) return;
          answered = true;
          draw(answer);
        },
        cancelled: (reason) => {
          if (answered) return;
          answered = true;
          closeFeeds();
          show(TITLES[view], h('div', { class: 'view-item' }, notice(reason ? `The call was cancelled: ${reason}` : 'The call was cancelled.', 'note')));
        },
        context: (change) => {
          context = { ...context, ...change };
          applyTheme(context);
        },
        teardown: closeFeeds,
      },
      { name: 'Good First Token', version: '1.0.0' },
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    show(TITLES[view], h('div', { class: 'view-item' }, notice(`The host didn't start the view: ${reason}`, 'refused')));
    return;
  }
  if (waiting !== null) draw(waiting);
}

void main();
