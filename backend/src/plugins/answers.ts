import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { answerApiKey, env } from '../config.js';
import type { AnswerProvider } from '../lib/answer-provider.js';
import { createAnthropicProvider } from '../lib/anthropic-provider.js';
import { createOpenAiCompatibleProvider } from '../lib/openai-provider.js';

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * The assistant's answer provider, or null when no credential is configured.
     *
     * Credentials decide which providers *exist*; configuration only decides
     * which are offered (wiki-docs/plan/phase-4-assistant/design.md). `index.ts`
     * refuses to start the server when this is null, so in practice only the
     * test suite — which replaces it with a scripted provider — and a
     * half-configured dev checkout ever see the null, and the ask route answers
     * a §16 assistant failure rather than a 500.
     */
    answerProvider: AnswerProvider | null;
  }
}

/**
 * Builds the provider named by configuration, or null when it is unusable.
 *
 * Both tiers land on the same port, so nothing downstream branches on which one
 * is selected — if a route or `answers.ts` ever needed to, the port would be the
 * wrong shape (wiki-docs/plan/assistant-provider-tiers/design.md).
 */
function buildProvider(): AnswerProvider | null {
  if (env.ANSWER_PROVIDER === 'openai-compatible') {
    // The key is optional here: a local Ollama, vLLM, or LM Studio has no auth.
    if (!env.ANSWER_BASE_URL) return null;
    return createOpenAiCompatibleProvider({
      baseURL: env.ANSWER_BASE_URL,
      apiKey: answerApiKey,
      // The wire spelling of the token budget is a property of the endpoint, so
      // it is bound here — the adapter reads configuration only through its
      // constructor options (openai-provider.ts `maxTokensParam`).
      maxTokensParam: env.ANSWER_MAX_TOKENS_PARAM,
    });
  }
  if (!answerApiKey) return null;
  // A base URL here is OpenRouter's Anthropic Skin, or any Anthropic-shaped proxy.
  return createAnthropicProvider(answerApiKey, env.ANSWER_BASE_URL);
}

export default fp(async function answersPlugin(app: FastifyInstance) {
  const provider = buildProvider();

  // A plain decorated property, not a getter: a test replaces it wholesale
  // between `buildApp()` and `ready()`.
  app.decorate('answerProvider', provider);
});
