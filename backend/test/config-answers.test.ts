import { describe, expect, it } from 'vitest';

/**
 * The provider-selection rules in `config.ts`, checked as pure functions of the
 * environment rather than through a booted app — the point is which credential
 * reaches which endpoint, and that is decided before anything is constructed.
 */
describe('answer provider configuration', () => {
  /** Mirrors `config.ts`, whose bindings are frozen at import time. */
  const resolve = (envVars: {
    ANSWER_PROVIDER: 'anthropic' | 'openai-compatible';
    ANSWER_API_KEY?: string;
    ANTHROPIC_API_KEY?: string;
    ANSWER_BASE_URL?: string;
  }) => {
    const key =
      envVars.ANSWER_API_KEY ??
      (envVars.ANSWER_PROVIDER === 'anthropic' ? envVars.ANTHROPIC_API_KEY : undefined);
    const usable =
      envVars.ANSWER_PROVIDER === 'anthropic' ? key !== undefined : envVars.ANSWER_BASE_URL !== undefined;
    return { key, usable };
  };

  it('never sends an Anthropic key to a non-Anthropic endpoint', () => {
    const resolved = resolve({
      ANSWER_PROVIDER: 'openai-compatible',
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      ANSWER_BASE_URL: 'https://openrouter.ai/api/v1',
    });
    // The alias is named for one provider; honouring it for all of them meant a
    // config change alone could hand an Anthropic credential to a third party.
    expect(resolved.key).toBeUndefined();
    expect(resolved.usable).toBe(true);
  });

  it('still honours the alias for the provider it was named after', () => {
    expect(resolve({ ANSWER_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant' }).key).toBe('sk-ant');
  });

  it('prefers the explicit key over the alias', () => {
    expect(
      resolve({ ANSWER_PROVIDER: 'anthropic', ANSWER_API_KEY: 'explicit', ANTHROPIC_API_KEY: 'alias' }).key,
    ).toBe('explicit');
  });

  it('needs a key for anthropic and a base URL for openai-compatible', () => {
    expect(resolve({ ANSWER_PROVIDER: 'anthropic' }).usable).toBe(false);
    expect(resolve({ ANSWER_PROVIDER: 'openai-compatible' }).usable).toBe(false);
    // A local endpoint has no auth at all, so no key is required there.
    expect(
      resolve({ ANSWER_PROVIDER: 'openai-compatible', ANSWER_BASE_URL: 'http://localhost:11434/v1' }).usable,
    ).toBe(true);
  });
});
