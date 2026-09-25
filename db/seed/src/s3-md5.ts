/**
 * P4: MinIO requires `Content-MD5` on a multi-object DeleteObjects (S3 made it optional once a flexible checksum is
 * sent; MinIO did not). AWS SDK v3 ≥ 3.729 sends `x-amz-checksum-crc32` there instead of MD5, even with
 * requestChecksumCalculation WHEN_REQUIRED, so this build-step middleware adds `Content-MD5` of the serialized body to
 * every DeleteObjects request (before signing). Same helper in backend-express/src/infra/s3.ts.
 */
import { createHash } from 'node:crypto';
import type { S3Client } from '@aws-sdk/client-s3';

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
