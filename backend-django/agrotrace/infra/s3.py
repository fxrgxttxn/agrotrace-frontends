"""
MinIO (S3) client: path-style addressing on S3_ENDPOINT, checksums only when required (P4: MinIO of the stand and the
other implementations' objects carry no flexible checksums). One client per process (boto3 clients are thread-safe).
"""

from __future__ import annotations

import threading

import boto3
from botocore.config import Config as BotoConfig

from agrotrace.core import config

_lock = threading.Lock()
_client = None


def client(timeout_s: float = 10.0):
    global _client
    if _client is None:
        with _lock:
            if _client is None:
                c = config.get()
                _client = boto3.client(
                    "s3",
                    endpoint_url=c.S3_ENDPOINT,
                    aws_access_key_id=c.S3_ACCESS_KEY,
                    aws_secret_access_key=c.S3_SECRET_KEY,
                    region_name=c.S3_REGION,
                    config=BotoConfig(
                        s3={"addressing_style": "path"},
                        connect_timeout=timeout_s,
                        read_timeout=timeout_s,
                        retries={"max_attempts": 1, "mode": "standard"},
                        request_checksum_calculation="when_required",
                        response_checksum_validation="when_required",
                    ),
                )
    return _client


def ping() -> None:
    """HEAD of the bucket (health/ready)."""
    client().head_bucket(Bucket=config.get().S3_BUCKET)
