import type { PolicyFile } from '../rules';
import { parseCheckOutput, type FindingKind } from './schemas';
import { Files, type CheckedPointer, type PointerFailure } from './statements';

// What the Worker makes of the check reading for a requested repo: a second
// call, with a prompt of its own, that looks only for reasons not to list
// the repo at once. Each finding is checked against the files like a
// statement. Any that checks out sends the repo to an admin, and so does
// one that fails its check, since a reason the model saw but misquoted is
// still a reason to have a person look. The design is in
// docs/specs/model-policy-reader.md, under Requested repos.

export interface CheckReading {
  findings: (CheckedPointer & { kind: FindingKind; why: string })[];
  dropped: { kind: FindingKind; failure: PointerFailure | 'file kind' }[];
  /** True when the check found nothing, kept or dropped, so it lets the repo be listed at once. */
  clears: boolean;
  summary: string;
}

export type CheckResult = { ok: true; check: CheckReading } | { ok: false; reason: string };

/** The check reading of a model's JSON, for the files it read, or why its output fails. A failed output clears nothing. */
export function readCheckOutput(files: readonly PolicyFile[], json: unknown): CheckResult {
  const parsed = parseCheckOutput(json);
  if (!parsed.ok) return parsed;
  const sent = new Files(files);
  const findings: CheckReading['findings'] = [];
  const dropped: CheckReading['dropped'] = [];
  for (const finding of parsed.output.findings) {
    const checked = sent.check(finding);
    if (!checked.ok) dropped.push({ kind: finding.kind, failure: checked.failure });
    else if (finding.kind === 'canary' && checked.pointer.file.kind !== 'agents' && checked.pointer.file.kind !== 'claude') {
      dropped.push({ kind: finding.kind, failure: 'file kind' });
    } else findings.push({ ...checked.pointer, kind: finding.kind, why: finding.why });
  }
  return { ok: true, check: { findings, dropped, clears: findings.length === 0 && dropped.length === 0, summary: parsed.output.summary } };
}
