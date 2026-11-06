// The model reader's version and the settings of every call it makes. The
// design is in docs/specs/model-policy-reader.md, under The model call. A
// new model, prompt, or output schema is a new reader version, and a new
// eval run before the reader may decide anything.

/** The model, written once, here. */
export const MODEL = 'claude-opus-5-5';

/** Which prompts the reader sends. Raise it with any change to a prompt. */
export const PROMPT_VERSION = 6;

/** Which output schemas the reader asks for. Raise it with any change to a schema. */
export const SCHEMA_VERSION = 1;

/** The model, the prompt, and the output schema, as a reading keeps them. */
export const READER_VERSION = `${MODEL}/p${String(PROMPT_VERSION)}/s${String(SCHEMA_VERSION)}`;

/** Effort for each call. Opus 5.5 defaults to medium, so every call sets it. */
export const EFFORT = { policy: 'high', check: 'high', labels: 'medium' } as const;

/** The most tokens each call may write, thinking included. */
export const MAX_TOKENS = { policy: 32_000, check: 32_000, labels: 16_000 } as const;

/** The most statements a reading may make. */
export const MAX_STATEMENTS = 60;
/** The most lines one statement may span. */
export const MAX_STATEMENT_LINES = 20;
/** The most steering lines a reading may report. */
export const MAX_STEERING = 20;
/** The most findings a check reading may report. */
export const MAX_FINDINGS = 40;
/** The longest note the model writes about one statement, finding, or label. Longer notes are cut. */
export const MAX_WHY = 300;
/** The longest summary the model writes for the admin. Longer summaries are cut. */
export const MAX_SUMMARY = 500;
/** The most labels a label check sends, the most open issues first, before the labels a statement names. */
export const MAX_LABELS_SENT = 300;
