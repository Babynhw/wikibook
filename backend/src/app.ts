import Fastify, { type FastifyInstance, type FastifyRequest, type RouteOptions } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { env, isProduction } from './config.js';
import prismaPlugin from './plugins/prisma.js';
import redisPlugin from './plugins/redis.js';
import queuesPlugin from './plugins/queues.js';
import eventsPlugin from './plugins/events.js';
import answersPlugin from './plugins/answers.js';
import errorHandlerPlugin from './plugins/error-handler.js';
import sessionPlugin from './plugins/session.js';
import healthRoutes from './routes/health.js';
import authRoutes from './routes/auth.js';
import spaceRoutes from './routes/spaces.js';
import sourcesRoutes from './routes/sources.js';
import citationsRoutes from './routes/citations.js';
import conversationsRoutes from './routes/conversations.js';
import eventsRoutes from './routes/events.js';
import notesRoutes from './routes/notes.js';
import notebookRoutes from './routes/notebook.js';
import activityRoutes from './routes/activity.js';
import membersRoutes from './routes/members.js';

/**
 * Log paths that must never reach a log line (PRD §17). Fastify's default `req`
 * serialiser already drops the body; these cover a handler that logs
 * `{ body }` or `{ headers }` itself, and the session cookie on any object.
 */
/** Body fields the routes accept that carry user content or credentials; `email` is PII. */
const REDACTED_BODY_FIELDS = ['content', 'contentRich', 'text', 'title', 'question', 'password', 'token', 'email'];
export const REDACT_PATHS = [
  ...REDACTED_BODY_FIELDS.flatMap((field) => [`body.${field}`, `req.body.${field}`]),
  'req.headers.cookie',
  'req.headers.authorization',
  'headers.cookie',
  'headers.authorization',
];

/**
 * URL shapes whose path carries a credential rather than an identifier. A space
 * invite *is* its token (shared-spaces-v1: the link is the secret), and Fastify
 * logs `req.url` on every request — so without this the token lands in the log,
 * which REQ-280 forbids as squarely as a password would be.
 *
 * `redact` cannot express this: pino's paths address object keys, and the secret
 * here is a substring of one value.
 */
const SECRET_URL_SEGMENTS: RegExp[] = [/^(\/invites\/)[^/?#]+/];

/** The logged form of a URL: identifiers kept, credentials replaced. */
export function scrubUrl(url: string): string {
  return SECRET_URL_SEGMENTS.reduce((scrubbed, pattern) => scrubbed.replace(pattern, '$1[Redacted]'), url);
}

export interface BuildAppOptions {
  /** Where pino writes. Tests pass a capturing stream; production uses stdout. */
  loggerStream?: NodeJS.WritableStream;
  /** Called for every route as it registers — lets a test read the route table. */
  onRoute?: (route: RouteOptions) => void;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const redact = { paths: REDACT_PATHS, censor: '[Redacted]' };
  // Replaces Fastify's default `req` serialiser, which logs the raw URL. Same
  // fields it emits, with {@link scrubUrl} over the one that can carry a secret.
  const serializers = {
    req(request: FastifyRequest) {
      return {
        method: request.method,
        url: scrubUrl(request.url),
        host: request.host,
        remoteAddress: request.ip,
      };
    },
  };
  const app = Fastify({
    logger: options.loggerStream
      ? { level: 'info', redact, serializers, stream: options.loggerStream }
      : isProduction
        ? { level: 'info', redact, serializers }
        : {
            level: 'info',
            redact,
            serializers,
            transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
          },
    trustProxy: isProduction,
  }).withTypeProvider<ZodTypeProvider>();

  if (options.onRoute) app.addHook('onRoute', options.onRoute);

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(errorHandlerPlugin);

  // Nothing is served as HTML, so CSP has nothing to protect; the value here is
  // nosniff / frame-deny / HSTS on a cookie-authenticated API.
  await app.register(helmet, { contentSecurityPolicy: false });

  // The Vite dev server proxies /api, so requests are same-origin in dev; CORS is
  // the fallback for running the SPA against the API directly.
  await app.register(cors, { origin: env.CORS_ORIGIN, credentials: true });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: false,
    max: 100,
    timeWindow: '1 minute',
  });

  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(sessionPlugin);
  await app.register(queuesPlugin);
  await app.register(eventsPlugin);
  await app.register(answersPlugin);

  // `fileSize` here is only a DoS ceiling; the real cap (pdf_max_bytes) is
  // enforced inside `storage.putObject` while streaming, so a client-controlled
  // Content-Length can never bypass it.
  await app.register(multipart, {
    limits: { files: 1, fileSize: 256 * 1024 * 1024 },
  });

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(spaceRoutes);
  await app.register(sourcesRoutes);
  await app.register(citationsRoutes);
  await app.register(conversationsRoutes);
  await app.register(eventsRoutes);
  await app.register(notesRoutes);
  await app.register(notebookRoutes);
  await app.register(activityRoutes);
  await app.register(membersRoutes);

  return app;
}
