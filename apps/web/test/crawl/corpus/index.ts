import { BAN_CASES } from './bans';
import type { PolicyCase } from './cases';
import { FORM_CASES } from './forms';
import { MODEL_CASES } from './model';
import { SETTINGS_POLICY_CASES } from './settings';
import { HELD_OUT_CASES, WELCOMING_CASES } from './welcoming';

export * from './cases';
export { REAL_REPOS, type RealRepo } from './real-repos';

/** Every case with its text in this repo, for the eval. The real repos are fetched when it runs. */
export const CASES: PolicyCase[] = [
  ...BAN_CASES,
  ...WELCOMING_CASES,
  ...HELD_OUT_CASES,
  ...FORM_CASES,
  ...SETTINGS_POLICY_CASES,
  ...MODEL_CASES,
];
