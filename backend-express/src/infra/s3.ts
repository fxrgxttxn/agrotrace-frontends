/** MinIO through the S3 API (path-style, single bucket S3_BUCKET). */
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import type { Config } from '../config.js';

export interface S3 {
  client: S3Client;
  bucket: string;
  /** HeadBucket — used by /health/ready. */
  ping(signal: AbortSignal): Promise<void>;
}

export function createS3(
  config: Pick<Config, 'S3_ENDPOINT' | 'S3_ACCESS_KEY' | 'S3_SECRET_KEY' | 'S3_BUCKET' | 'S3_REGION'>,
): S3 {
  const client = new S3Client({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    forcePathStyle: true,
    credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY },
    maxAttempts: 1,
  });
  return {
    client,
    bucket: config.S3_BUCKET,
    async ping(signal) {
      await client.send(new HeadBucketCommand({ Bucket: config.S3_BUCKET }), { abortSignal: signal });
    },
  };
}
