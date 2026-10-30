<?php

namespace App\Infrastructure\Storage;

use Aws\S3\S3Client;

/**
 * MinIO through the S3 API (path-style, one bucket S3_BUCKET; Express infra/s3.ts). P4: the SDK's default checksums
 * (CRC32 on every upload, validation of every download) are switched to `when_required`. A per-worker singleton
 * (AppServiceProvider): the client holds no request state. Callers hold no DB slot around these calls (P61).
 */
final class ObjectStore
{
    private ?S3Client $client = null;

    public function bucket(): string
    {
        return (string) config('agrotrace.s3.bucket');
    }

    public function put(string $key, string $bytes, string $mime): void
    {
        $this->client()->putObject([
            'Bucket' => $this->bucket(),
            'Key' => $key,
            'Body' => $bytes,
            'ContentType' => $mime,
            'ContentLength' => strlen($bytes),
        ]);
    }

    public function get(string $key): string
    {
        $out = $this->client()->getObject(['Bucket' => $this->bucket(), 'Key' => $key]);

        return (string) $out['Body'];
    }

    private function client(): S3Client
    {
        return $this->client ??= new S3Client([
            'version' => 'latest',
            'region' => config('agrotrace.s3.region'),
            'endpoint' => config('agrotrace.s3.endpoint'),
            'use_path_style_endpoint' => true,
            'credentials' => ['key' => config('agrotrace.s3.key'), 'secret' => config('agrotrace.s3.secret')],
            'request_checksum_calculation' => 'when_required',
            'response_checksum_validation' => 'when_required',
            'http' => ['connect_timeout' => 5, 'timeout' => 30],
        ]);
    }
}
