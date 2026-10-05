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
