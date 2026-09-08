/**
 * Runtime-configurable limits (PRD §5). Defaults are seeded into the AppConfig
 * table; operators change them there without a code change. Environment
 * variables override the table for local development (see config.ts).
 */
export const APP_CONFIG_DEFAULTS = {
  /** 25 MiB. */
  pdf_max_bytes: 26_214_400,
  pdf_max_pages: 200,
  manual_max_chars: 100_000,
  sources_per_space: 50,
  /** Members per space, the owner included (plan/shared-spaces-v1). */
  members_per_space: 5,
  /**
   * The owner's "Audience & style" note (plan/space-audience-style).
   *
   * Unlike `nameSchema`'s 120 and `objectiveSchema`'s 2000 — deliberately
   * constants, because they are shape limits — this cap does enforcement work:
   * it is the one control in that design that does not depend on the model
   * cooperating. Short enough for "Vietnamese, secondary-school level"; too
   * short to restate the answer rules.
   */
  audience_instruction_max_chars: 300,
} as const;

export type AppConfigKey = keyof typeof APP_CONFIG_DEFAULTS;

export const APP_CONFIG_ENV_OVERRIDES: Record<AppConfigKey, string> = {
  pdf_max_bytes: 'PDF_MAX_BYTES',
  pdf_max_pages: 'PDF_MAX_PAGES',
  manual_max_chars: 'MANUAL_MAX_CHARS',
  sources_per_space: 'SOURCES_PER_SPACE',
  members_per_space: 'MEMBERS_PER_SPACE',
  audience_instruction_max_chars: 'AUDIENCE_INSTRUCTION_MAX_CHARS',
};
