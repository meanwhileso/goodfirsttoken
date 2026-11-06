import type { RepoLabel } from '../rules';
import type { CheckedLabel, LabelStatement } from './requests';
import { parseLabelOutput, type LabelMeaning } from './schemas';
import type { CheckedStatement } from './statements';

// What the Worker makes of a label check. A label the model names that
// isn't one the Worker sent, compared without case, is dropped, and so is
// one whose evidence is a statement the Worker didn't send. A label keeps
// the repo's spelling and its open issue count, and counts once, with the
// first meaning the model gave it. A label the model leaves out means
// nothing for outside help. The design is in
// docs/specs/model-policy-reader.md, under The label check.

export interface LabelCheck {
  ready: RepoLabel[];
  keptForPeople: RepoLabel[];
  agentsOnly: RepoLabel[];
  /** How many of the model's labels were dropped. */
  dropped: number;
}

export type LabelCheckResult = { ok: true; check: LabelCheck } | { ok: false; reason: string };

/** A kept statement as the label check sends it, with its lines as the file has them. */
export function labelStatementOf(statement: CheckedStatement): LabelStatement {
  return { about: statement.about, label: statement.label, path: statement.file.path, startLine: statement.startLine, lines: statement.lines };
}

/** The label check of a model's JSON, for the labels and the number of statements the request sent. */
export function readLabelOutput(sent: readonly CheckedLabel[], statementsSent: number, json: unknown): LabelCheckResult {
  // A label named twice counts once, so the limit leaves room, and stops a runaway list.
  const parsed = parseLabelOutput(json, sent.length * 2 + 10);
  if (!parsed.ok) return parsed;
  const byName = new Map(sent.map((label) => [label.name.toLowerCase(), label]));
  const seen = new Set<string>();
  const out: Record<LabelMeaning, RepoLabel[]> = { readyForOutsideHelp: [], keptForPeople: [], agentsOnly: [] };
  let dropped = 0;
  for (const item of parsed.output.labels) {
    const label = byName.get(item.name.trim().toLowerCase());
    const statementOk =
      item.evidence !== 'statement' ? item.statement === null : item.statement !== null && item.statement >= 0 && item.statement < statementsSent;
    if (label === undefined || !statementOk) {
      dropped += 1;
      continue;
    }
    const key = label.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out[item.meaning].push({ name: label.name, openIssues: label.openIssues });
  }
  return { ok: true, check: { ready: out.readyForOutsideHelp, keptForPeople: out.keptForPeople, agentsOnly: out.agentsOnly, dropped } };
}
