import fp from 'fastify-plugin';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from 'fastify-type-provider-zod';
import { AppError } from '../lib/errors.js';

interface ErrorBody {
  error: { code: string; message: string; fields?: Record<string, string> };
}

const GENERIC_MESSAGE =
  'Something went wrong on our side. Please try again — if it keeps happening, the problem is logged.';

/**
 * Single exit point for errors: every response is a JSON envelope the frontend
 * can render directly. Stack traces, SQL, and provider messages stay in the
 * server log (PRD §16).
 */
export default fp(async function errorHandlerPlugin(app: FastifyInstance) {
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      const fields: Record<string, string> = {};
      for (const issue of error.validation) {
        const path = issue.instancePath?.replace(/^\//, '');
        if (path) fields[path] = issue.message ?? 'Invalid value.';
      }
      request.log.info({ fields }, 'request validation failed');
      return reply.status(400).send({
        error: {
          code: 'validation_failed',
          message: 'Please check the highlighted fields and try again.',
          ...(Object.keys(fields).length > 0 ? { fields } : {}),
        },
      } satisfies ErrorBody);
    }

    if (isResponseSerializationError(error)) {
      request.log.error({ err: error }, 'response serialization failed');
      return reply.status(500).send({
        error: { code: 'internal_error', message: GENERIC_MESSAGE },
      } satisfies ErrorBody);
    }

    if (error instanceof AppError) {
      request.log.info({ code: error.code, statusCode: error.statusCode }, error.message);
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.fields ? { fields: error.fields } : {}),
        },
      } satisfies ErrorBody);
    }

    // Rate limiter and other Fastify errors carry a usable statusCode.
    const statusCode = error.statusCode ?? 500;
    if (statusCode < 500) {
      request.log.info({ err: error }, 'client error');
      return reply.status(statusCode).send({
        error: {
          code: error.code ?? 'bad_request',
          message: error.message || 'That request could not be completed.',
        },
      } satisfies ErrorBody);
    }

    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({
      error: { code: 'internal_error', message: GENERIC_MESSAGE },
    } satisfies ErrorBody);
  });

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    return reply.status(404).send({
      error: { code: 'not_found', message: 'We could not find that.' },
    } satisfies ErrorBody);
  });
});
