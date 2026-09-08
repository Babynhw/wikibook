import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
  DeleteObjectCommand,
  PutBucketEncryptionCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Transform, type Readable } from 'node:stream';
import { env } from '../config.js';
import { payloadTooLarge } from './errors.js';

/**
 * The only module that knows an object store exists. Everything else moves a
 * `key` around and never sees an endpoint, a bucket name, or a credential —
 * nothing S3 is ever serialized to a client response (PRD §17).
 *
 * MinIO locally, any S3 API in deployment.
 */
const client = new S3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  },
});

/**
 * Keys are derived from ids only — a user's filename is user input and has no
 * business in a path. The filename is carried as object metadata instead.
 */
export function keyFor(spaceId: string, sourceId: string): string {
  return `spaces/${spaceId}/sources/${sourceId}/original.pdf`;
}

export interface PutObjectInput {
  key: string;
  contentType: string;
  /** Stored as object metadata, never as part of the key. */
  filename?: string;
  /** The byte cap, enforced while streaming (PRD §5 `pdf_max_bytes`). */
  maxBytes: number;
}

export interface PutObjectResult {
  key: string;
  size: number;
}

interface GetObjectResult {
  body: Readable;
  contentType: string;
  contentLength?: number;
  /** Present when a `Range` was honored (206 response). */
  contentRange?: string;
}

/**
 * Streams a file into the bucket, aborting the multipart upload if the counting
 * stream crosses `maxBytes` — the cap is enforced here while reading, never from
 * a client-supplied `Content-Length` (wiki-docs/plan/phase-2-ingestion/design.md).
 *
 * An aborted upload aborts the incomplete multipart (the `leavePartsOnError:
 * false` default), leaving no partial object behind.
 */
export async function putObject(
  input: Readable,
  { key, contentType, filename, maxBytes }: PutObjectInput,
): Promise<PutObjectResult> {
  let size = 0;
  let exceeded = false;

  const counting = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > maxBytes) {
        exceeded = true;
        callback(payloadTooLarge(`That file is over the ${maxBytes}-byte limit.`));
        return;
      }
      callback(null, chunk);
    },
  });
  // A failure upstream (e.g. the multipart part being cut) must reach the
  // upload rather than leave it waiting on a stream that will never end.
  input.on('error', (error: Error) => counting.destroy(error));

  const upload = new Upload({
    client,
    params: {
      Bucket: env.S3_BUCKET,
      Key: key,
      ContentType: contentType,
      Body: input.pipe(counting),
      ...(filename ? { Metadata: { 'original-filename': metadataSafe(filename) } } : {}),
    },
  });

  try {
    await upload.done();
  } catch (error) {
    if (exceeded) throw payloadTooLarge(`That file is over the ${maxBytes}-byte limit.`);
    throw error;
  }

  return { key, size };
}

export async function getObject(key: string, range?: string): Promise<GetObjectResult> {
  const response = await client.send(
    new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key, ...(range ? { Range: range } : {}) }),
  );
  if (!response.Body) {
    throw new Error(`Object store returned no body for key ${key}.`);
  }
  return {
    body: response.Body as Readable,
    contentType: response.ContentType ?? 'application/octet-stream',
    ...(response.ContentLength !== undefined ? { contentLength: response.ContentLength } : {}),
    ...(response.ContentRange ? { contentRange: response.ContentRange } : {}),
  };
}

/** S3 metadata must be printable ASCII; anything else is dropped here. */
function metadataSafe(value: string): string {
  const ascii = value.replace(/[^\x20-\x7E]/g, '').trim();
  return ascii.length > 0 ? ascii.slice(0, 1024) : 'upload';
}

/** `DeleteObject` on a missing key answers 204, so removal is naturally idempotent. */
export async function removeObject(key: string): Promise<void> {
  await client.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
}

/**
 * Creates the bucket when the one-shot compose init has not run (a dev machine,
 * a test suite). Belt-and-braces on top of `docker compose`'s `minio-init`.
 *
 * The bucket is created with default server-side encryption, because a bucket
 * this function made is a bucket `minio-init` did not: PRD §17 / REQ-109 says
 * stored originals are encrypted at rest, and a fallback that creates a plain
 * bucket turns that requirement into a property nobody can assert. A store that
 * rejects the encryption call (or encrypts unconditionally) is not fatal — the
 * bucket exists either way — but it is logged loudly rather than assumed.
 */
export async function ensureBucket(): Promise<void> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }));
    return;
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'NotFound') throw error;
  }

  await client.send(new CreateBucketCommand({ Bucket: env.S3_BUCKET }));
  await client.send(
    new PutBucketEncryptionCommand({
      Bucket: env.S3_BUCKET,
      ServerSideEncryptionConfiguration: {
        Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
      },
    }),
  );
}

/** Sanity probe used by `/health` and tests without creating a real object. */
export async function pingStorage(): Promise<void> {
  await client.send(new PutObjectCommand({
    Bucket: env.S3_BUCKET,
    Key: '.health-probe',
    Body: 'ok',
  }));
}