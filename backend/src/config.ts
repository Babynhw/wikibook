import 'dotenv/config';
import { z } from 'zod';
import {
  APP_CONFIG_DEFAULTS,
  APP_CONFIG_ENV_OVERRIDES,
  type AppConfigKey,
} from './lib/app-config-defaults.js';
import type { PrismaClient } from './generated/prisma/client.js';

// Read before the schema is built so production can drop the dev-convenience
// defaults below. `isProduction` is derived from the parsed env further down and
// is not available yet at schema-construction time.
const inProduction = process.env.NODE_ENV === 'production';

/** Treats a blank environment value as unset — `.env.example` ships blanks. */
const blankToUndefined = (value: string | undefined) =>
  value && value.trim().length > 0 ? value : undefined;

/**
 * A credential with a local-development default that must never be deployed:
 * outside production the dev value applies, in production the variable is
 * required. `DATABASE_URL` and `REDIS_URL` are unconditionally required for the
 * same reason — a misconfiguration has to fail at startup, not silently boot on
 * a value that is published in `docker-compose.yml`.
 */
const devCredential = (devValue: string) =>
  inProduction ? z.string().min(1) : z.string().default(devValue);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('127.0.0.1'),

  // Validated as URLs, not just non-empty: a malformed REDIS_URL otherwise boots
  // fine and only surfaces as a warning the redis plugin swallows.
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  // Embeddings run on HuggingFace's serverless Inference API. `HF_BASE_URL`
  // carries the provider segment so it can be pointed at a dedicated Inference
  // Endpoint or a self-hosted TEI without touching the model name.
  HF_BASE_URL: z.string().url().default('https://router.huggingface.co/hf-inference'),
  // The Hub, not the inference router: `/health` validates the token here
  // (`/api/whoami-v2`) because that costs no inference quota, and `/health` is
  // unauthenticated and unrate-limited.
  HF_HUB_URL: z.string().url().default('https://huggingface.co'),
  // Optional *in the schema* for the same reason ANSWER_API_KEY is: `buildApp()`
  // has to work in tests, which stub `fetch` and never reach HuggingFace.
  // `hasEmbeddingProvider` is the gate `index.ts` checks before it boots.
  HF_API_KEY: z.string().optional().transform(blankToUndefined),
  // Must be a model with a live serverless inference provider on the Hub — most
  // models are not served. `nomic-embed-text` is one of them, which is why this
  // is an e5: 768 dimensions, multilingual, and live on `hf-inference`.
  EMBEDDING_MODEL: z.string().default('intfloat/multilingual-e5-base'),
  // Baked into the Prisma schema as vector(768); a mismatch must fail at startup.
  EMBEDDING_DIM: z.coerce.number().int().positive().default(768),
  // Asymmetric embedding models want a task prefix on every input and lose real
  // accuracy without one. These are the e5 family's; bge and nomic use their own
  // wording, and a symmetric model sets both blank. Blank is honoured rather than
  // normalised away — "no prefix" is a real configuration.
  //
  // Changing either invalidates every stored vector, exactly like a model swap:
  // re-embed with `pnpm reprocess:sources --all`.
  EMBEDDING_QUERY_PREFIX: z.string().default('query: '),
  EMBEDDING_PASSAGE_PREFIX: z.string().default('passage: '),

  SESSION_COOKIE_NAME: z.string().default('sid'),
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 30),
  PASSWORD_RESET_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60),
  // How long a space invite link stays valid. Operational, not a §5 product limit.
  INVITE_TTL_HOURS: z.coerce.number().int().positive().default(168),

  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  // MinIO here, any S3 API in deployment (wiki-docs/plan/phase-2-ingestion/design.md).
  // `S3_FORCE_PATH_STYLE` is deliberately parsed from a string: `z.coerce.boolean()`
  // reads "false" as true, which would silently break any S3 that needs virtual-host
  // addressing while pretending to work with MinIO.
  S3_ENDPOINT: z.string().url().default('http://localhost:9000'),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('wikibooklm'),
  S3_ACCESS_KEY_ID: devCredential('wikibooklm'),
  S3_SECRET_ACCESS_KEY: devCredential('wikibooklm-secret'),
  S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),

  // Worker concurrency and the web-fetch safety valves. These are env vars, not
  // AppConfig keys: they tune a network call and the ingest pipeline's resource
  // use, not a product limit the operator tunes per §5.
  INGEST_CONCURRENCY: z.coerce.number().int().positive().default(2),
  WEB_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  WEB_FETCH_MAX_BYTES: z.coerce.number().int().positive().default(2_000_000),
  // A leaked tab must not pin connections open: cap live SSE streams per user
  // (wiki-docs/plan/phase-2-ingestion/design.md "State changes are pushed over SSE").
  SSE_MAX_CONNECTIONS_PER_USER: z.coerce.number().int().positive().default(3),

  // The assistant (PRD §9). Credentials are optional *in the schema* so
  // `buildApp()` works in tests, which inject a scripted answer provider and
  // never reach a real API — `index.ts` refuses to start the server when the
  // selected provider is unusable, the same shape as the `hasEmailProvider`
  // gate. There is deliberately no dev default for a hosted provider's key: the
  // `devCredential()` pattern exists so compose's own published values work
  // locally, and there is no local value for somebody else's key.
  //
  // Blank is normalised to "absent" rather than rejected, because `.env.example`
  // ships the key blank and a schema error there would report "expected string
  // to have >=1 characters" instead of the actionable message `index.ts` prints.
  ANSWER_PROVIDER: z.enum(['anthropic', 'openai-compatible']).default('anthropic'),
  /** Set for OpenRouter's Anthropic Skin, Ollama, vLLM, LM Studio, or any proxy. */
  ANSWER_BASE_URL: z.string().optional().transform(blankToUndefined),
  ANSWER_API_KEY: z.string().optional().transform(blankToUndefined),
  /** Deprecated alias for ANSWER_API_KEY, so an existing `.env` keeps working. */
  ANTHROPIC_API_KEY: z.string().optional().transform(blankToUndefined),
  /**
   * OpenRouter's `require_parameters` routing guard, so the router only picks
   * providers that actually honour the requested `response_format`. On by
   * default: a loud 400 from a server that rejects the field is easier to
   * diagnose than a silent downgrade to unstructured prose.
   */
  ANSWER_PROVIDER_ROUTING: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  /**
   * Questions per minute per user. A safety valve on cost and on a slow upstream,
   * not a §5 product limit, so it lives here rather than in `AppConfig` — and it
   * is configurable because the test suite legitimately asks more questions in a
   * minute than a person ever would.
   */
  ANSWER_RATE_PER_MINUTE: z.coerce.number().int().positive().default(20),
  ANSWER_MODEL: z.string().default('claude-opus-5'),
  TITLE_MODEL: z.string().default('claude-haiku-4-5'),
  ANSWER_EFFORT: z.enum(['low', 'medium', 'high']).default('low'),
  // Bounds thinking *plus* answer text: a truncated answer arrives as
  // `stop_reason: 'max_tokens'` and is shown with a notice, not as an error.
  ANSWER_MAX_TOKENS: z.coerce.number().int().positive().default(16_000),
  ANSWER_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  // Engineering knobs on a query and a network call, not §5 product limits, so
  // they live here rather than in AppConfig (design "No new `AppConfig` key").
  /**
   * Byte ceiling on a notebook save. A server safety bound, not a §5 product
   * limit, so it lives here rather than in `AppConfig`; roughly a book chapter
   * with a citation in every paragraph fits in a quarter of it.
   */
  NOTEBOOK_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(2 * 1024 * 1024),
  /** Coalesce window for duplicate activity rows (e.g. `note.edited` within N minutes). */
  ACTIVITY_COALESCE_MINUTES: z.coerce.number().int().positive().default(10),
  // How long a notebook-editing heartbeat counts as "still editing" (client beats every 10 s).
  NOTEBOOK_PRESENCE_TTL_SECONDS: z.coerce.number().int().positive().default(30),
  RETRIEVAL_TOP_K: z.coerce.number().int().positive().default(12),
  RETRIEVAL_CANDIDATES: z.coerce.number().int().positive().default(40),
  MAX_HISTORY_TURNS: z.coerce.number().int().positive().default(6),
});

function parseEnv() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const env = parseEnv();

export type Env = z.infer<typeof envSchema>;

export const isProduction = env.NODE_ENV === 'production';

/**
 * No email provider is integrated yet (open decision, Phase 0 proposal), so
 * `/auth/forgot` writes the reset token to the server log. That is only
 * acceptable in development: `index.ts` refuses to boot in production while this
 * is false, so the stopgap cannot be deployed by accident.
 *
 * Flip to true — and delete the logging branch in `routes/auth.ts` — when a
 * provider lands.
 */
export const hasEmailProvider = false;

/**
 * Whether embeddings can be produced at all. HuggingFace's serverless Inference
 * API always authenticates, so unlike an OpenAI-compatible answer endpoint there
 * is no unauthenticated local case to keep a door open for — a missing token is a
 * misconfiguration, and `index.ts` refuses to boot rather than let every ingest
 * job fail one by one.
 */
export const hasEmbeddingProvider = env.HF_API_KEY !== undefined;

/** What to tell the operator to set when {@link hasEmbeddingProvider} is false. */
export const embeddingProviderHint =
  'HF_API_KEY is not set — create a token at https://huggingface.co/settings/tokens ' +
  'with the "Make calls to Inference Providers" permission';

/**
 * The credential for the selected provider.
 *
 * The deprecated `ANTHROPIC_API_KEY` alias is honoured **only for the `anthropic`
 * provider**. It is named for one provider but was being used for all of them, so
 * switching to `openai-compatible` while a stale Anthropic key sat in `.env` sent
 * that key as a bearer token to whatever `ANSWER_BASE_URL` pointed at — an
 * Anthropic credential handed to a third party by a config change alone.
 */
export const answerApiKey =
  env.ANSWER_API_KEY ?? (env.ANSWER_PROVIDER === 'anthropic' ? env.ANTHROPIC_API_KEY : undefined);

/**
 * Whether the *selected* provider is usable (PRD §9). Credentials decide which
 * providers exist; configuration only decides which is offered.
 *
 * The two providers need different things, so this is not one variable check:
 *
 * - `anthropic` needs a key. The hosted API and OpenRouter's Anthropic Skin both
 *   authenticate, and there is no unauthenticated Claude endpoint.
 * - `openai-compatible` needs a base URL, and the key is **optional**: a local
 *   Ollama, vLLM, or LM Studio has no auth at all, and demanding a placeholder
 *   would be a lie the operator has to keep maintaining. A hosted endpoint that
 *   wants a key and gets none fails on the first question as a §16 assistant
 *   failure, the same path any provider outage takes.
 */
export const hasAnswerProvider =
  env.ANSWER_PROVIDER === 'anthropic'
    ? answerApiKey !== undefined
    : env.ANSWER_BASE_URL !== undefined;

/** What to tell the operator to set when {@link hasAnswerProvider} is false. */
export const answerProviderHint =
  env.ANSWER_PROVIDER === 'anthropic'
    ? 'ANSWER_API_KEY is not set (ANTHROPIC_API_KEY is accepted as a deprecated alias)'
    : 'ANSWER_BASE_URL is not set — an OpenAI-compatible endpoint needs one, e.g. ' +
      'http://localhost:11434/v1 for Ollama or https://openrouter.ai/api/v1';

/**
 * Runtime limits (PRD §5), read from the AppConfig table with an in-process
 * cache. Environment variables win over the table so a developer can tighten a
 * limit locally; the table wins over the compiled-in defaults.
 */
export type AppLimits = Record<AppConfigKey, number>;

const CACHE_TTL_MS = 30_000;

let cache: { limits: AppLimits; loadedAt: number } | null = null;
// Concurrent misses share one query rather than each firing their own. The TTL
// expires for everybody at once, so without this every reader stampedes the
// table together every 30 seconds.
let inflight: Promise<AppLimits> | null = null;

function fromEnvOverride(key: AppConfigKey): number | null {
  const raw = process.env[APP_CONFIG_ENV_OVERRIDES[key]];
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export async function loadLimits(prisma: PrismaClient, force = false): Promise<AppLimits> {
  if (!force && cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) {
    return cache.limits;
  }
  if (!force && inflight) return inflight;

  inflight = (async () => {
    const rows = await prisma.appConfig.findMany();
    const stored = new Map(rows.map((row) => [row.key, row.value]));

    const limits = Object.fromEntries(
      (Object.keys(APP_CONFIG_DEFAULTS) as AppConfigKey[]).map((key) => {
        const override = fromEnvOverride(key);
        if (override !== null) return [key, override];

        const raw = stored.get(key);
        const parsed = raw === undefined ? Number.NaN : Number(raw);
        return [key, Number.isFinite(parsed) && parsed > 0 ? parsed : APP_CONFIG_DEFAULTS[key]];
      }),
    ) as AppLimits;

    cache = { limits, loadedAt: Date.now() };
    return limits;
  })().finally(() => {
    inflight = null;
  });

  return inflight;
}

/**
 * Drops the cache so the next read picks up a changed AppConfig row.
 *
 * @remarks No consumer yet — the AppConfig admin route that needs it does not
 * exist in Phase 0. Kept because a limit changed in the table is otherwise
 * invisible for up to {@link CACHE_TTL_MS}.
 */
export function invalidateLimitsCache(): void {
  cache = null;
}
