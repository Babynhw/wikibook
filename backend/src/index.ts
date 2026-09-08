import { buildApp } from './app.js';
import { assertEmbeddingDimension, EmbeddingError } from './lib/embeddings.js';
import {
  answerProviderHint,
  embeddingProviderHint,
  env,
  hasAnswerProvider,
  hasEmbeddingProvider,
  hasEmailProvider,
  isProduction,
  loadLimits,
} from './config.js';

// The assistant is the product (PRD §9), so a server with no answer provider is
// not a degraded server — it cannot answer a single question. Fail here with
// something actionable rather than on the user's first question.
if (!hasAnswerProvider) {
  console.error(
    `Refusing to start: the assistant could not answer anything (PRD §9). ` +
      `ANSWER_PROVIDER is "${env.ANSWER_PROVIDER}" and ${answerProviderHint}. ` +
      'Set it in backend/.env — there is deliberately no local default for a ' +
      "hosted provider's key.",
  );
  process.exit(1);
}

// `/auth/forgot` writes the reset token to the log while no email provider is
// integrated. Refusing to boot is what keeps that stopgap out of production —
// failing here beats discovering it on the first reset request.
if (isProduction && !hasEmailProvider) {
  console.error(
    'Refusing to start in production: no email provider is configured, so password ' +
      'reset tokens would be written to the server log. Wire up a provider and set ' +
      '`hasEmailProvider` in src/config.ts.',
  );
  process.exit(1);
}

const app = await buildApp();

process.on('unhandledRejection', (reason) => {
  app.log.fatal({ err: reason }, 'unhandled rejection');
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  app.log.fatal({ err: error }, 'uncaught exception');
  process.exit(1);
});

const limits = await loadLimits(app.prisma);
app.log.info({ limits }, 'runtime limits loaded (PRD §5)');

// The vector dimension is baked into the schema as vector(768): a model whose
// dimension disagrees must stop the server, not write unusable rows, and neither
// must a rejected HuggingFace token. A HuggingFace that is merely unreachable is
// a warning — /health reports it as degraded.
if (!hasEmbeddingProvider) {
  app.log.fatal(`embeddings are not configured: ${embeddingProviderHint}`);
  await app.close();
  process.exit(1);
}

try {
  const dimension = await assertEmbeddingDimension();
  app.log.info(
    { model: env.EMBEDDING_MODEL, dimension },
    'embedding model verified',
  );
} catch (error) {
  const fatal =
    error instanceof EmbeddingError &&
    (error.code === 'dimension_mismatch' || error.code === 'unauthorized');
  if (fatal) {
    app.log.fatal({ err: error }, 'embedding configuration is unusable');
    await app.close();
    process.exit(1);
  }
  app.log.warn(
    { err: error },
    `embedding service unavailable — could not reach ${env.HF_BASE_URL} for model ` +
      `"${env.EMBEDDING_MODEL}"`,
  );
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info({ signal }, 'shutting down');
    void app.close().then(() => process.exit(0));
  });
}

try {
  await app.listen({ port: env.PORT, host: env.HOST });
} catch (error) {
  app.log.fatal({ err: error }, 'failed to start');
  process.exit(1);
}
