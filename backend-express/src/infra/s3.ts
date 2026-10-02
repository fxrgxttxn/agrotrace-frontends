/**
 * MinIO through the S3 API (path-style, single bucket S3_BUCKET). Checksums (P4): the AWS SDK v3 defaults
 * (`WHEN_SUPPORTED`: CRC32 on every upload, validation of every download) are switched to `WHEN_REQUIRED`, and
 * DeleteObjects carries `Content-MD5`, which MinIO requires (it rejects the SDK's CRC32 with `MissingContentMD5`).
 */
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Config } from '../config.js';

export interface S3 {
  client: S3Client;
  bucket: string;
  /** HeadBucket — used by /health/ready. */
  ping(signal: AbortSignal): Promise<void>;
  /** PutObject of a whole buffer (uploads are at most a few MiB and already in memory). */
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** GetObject as a stream (downloads go through the backend, FR-FILE-03). */
  get(key: string, signal?: AbortSignal): Promise<Readable>;
}

/** Adds `Content-MD5` of the serialized body to every DeleteObjects request (build step, before signing). */
export function withDeleteObjectsContentMd5<T extends S3Client>(client: T): T {
  client.middlewareStack.add(
    (next, context) => async (args) => {
      const req = args.request as { headers?: Record<string, string>; body?: unknown };
      if (
        context.commandName === 'DeleteObjectsCommand' &&
        req.headers &&
        (typeof req.body === 'string' || req.body instanceof Uint8Array)
      )
        req.headers['content-md5'] = createHash('md5').update(req.body).digest('base64');
      return next(args);
    },
    { step: 'build', name: 'agrotraceDeleteObjectsContentMd5', priority: 'low' },
  );
  return client;
}

export function createS3(
  config: Pick<Config, 'S3_ENDPOINT' | 'S3_ACCESS_KEY' | 'S3_SECRET_KEY' | 'S3_BUCKET' | 'S3_REGION'>,
): S3 {
  const client = withDeleteObjectsContentMd5(
    new S3Client({
      endpoint: config.S3_ENDPOINT,
      region: config.S3_REGION,
      forcePathStyle: true,
      credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    }),
  );
  const bucket = config.S3_BUCKET;
  return {
    client,
    bucket,
    async ping(signal) {
      await client.send(new HeadBucketCommand({ Bucket: bucket }), { abortSignal: signal });
    },
    async put(key, body, contentType) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          ContentLength: body.length,
        }),
      );
    },
    async get(key, signal) {
      const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), {
        abortSignal: signal,
      });
      if (!out.Body) throw new Error(`S3 object ${key} has no body`);
      return out.Body as Readable;
    },
  };
}
