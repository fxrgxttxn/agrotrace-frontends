<?php

namespace App\Http\Problem;

/** contracts/openapi/schemas/common.yaml#/ProblemCode — exactly the contract's values (ProblemRendererTest pins it). */
enum ProblemCode: string
{
    case VALIDATION = 'VALIDATION';
    case UNAUTHORIZED = 'UNAUTHORIZED';
    case FORBIDDEN = 'FORBIDDEN';
    case NOT_FOUND = 'NOT_FOUND';
    case INVALID_TRANSITION = 'INVALID_TRANSITION';
    case VERSION_CONFLICT = 'VERSION_CONFLICT';
    case BUSINESS_RULE = 'BUSINESS_RULE';
    case FILE_TOO_LARGE = 'FILE_TOO_LARGE';
    case UNSUPPORTED_MEDIA_TYPE = 'UNSUPPORTED_MEDIA_TYPE';
    case RATE_LIMITED = 'RATE_LIMITED';
    case ACCOUNT_LOCKED = 'ACCOUNT_LOCKED';
    case INVALID_CREDENTIALS = 'INVALID_CREDENTIALS';
    case TWO_FACTOR_REQUIRED = 'TWO_FACTOR_REQUIRED';
    case INVALID_TWO_FACTOR_CODE = 'INVALID_TWO_FACTOR_CODE';
    case TOKEN_EXPIRED = 'TOKEN_EXPIRED';
    case IDEMPOTENCY_KEY_REUSED = 'IDEMPOTENCY_KEY_REUSED';
    case INVALID_IDEMPOTENCY_KEY = 'INVALID_IDEMPOTENCY_KEY';
    case CAPTCHA_FAILED = 'CAPTCHA_FAILED';
    case GRAPH_CYCLE = 'GRAPH_CYCLE';
    case BACKEND_UNAVAILABLE = 'BACKEND_UNAVAILABLE';
    case EXTERNAL_UNAVAILABLE = 'EXTERNAL_UNAVAILABLE';
    case INTERNAL = 'INTERNAL';
    case NO_LAB_AVAILABLE = 'NO_LAB_AVAILABLE';
    case IDEMPOTENCY_KEY_IN_PROGRESS = 'IDEMPOTENCY_KEY_IN_PROGRESS';
    case REFERENCE_IN_USE = 'REFERENCE_IN_USE';
    case METHOD_NOT_ALLOWED = 'METHOD_NOT_ALLOWED';

    /** `VERSION_CONFLICT` → `/problems/version-conflict`. */
    public function type(): string
    {
        return '/problems/'.str_replace('_', '-', strtolower($this->value));
    }

    /** For logs only; clients never rely on it (contract). The same titles as Express. */
    public function title(): string
    {
        return match ($this) {
            self::VALIDATION => 'Validation failed',
            self::UNAUTHORIZED => 'Unauthorized',
            self::FORBIDDEN => 'Forbidden',
            self::NOT_FOUND => 'Not found',
            self::INVALID_TRANSITION => 'Invalid status transition',
            self::VERSION_CONFLICT => 'Version conflict',
            self::BUSINESS_RULE => 'Business rule violated',
            self::FILE_TOO_LARGE => 'File too large',
            self::UNSUPPORTED_MEDIA_TYPE => 'Unsupported media type',
            self::RATE_LIMITED => 'Too many requests',
            self::ACCOUNT_LOCKED => 'Account locked',
            self::INVALID_CREDENTIALS => 'Invalid credentials',
            self::TWO_FACTOR_REQUIRED => 'Two-factor authentication required',
            self::INVALID_TWO_FACTOR_CODE => 'Invalid two-factor code',
            self::TOKEN_EXPIRED => 'Token expired',
            self::IDEMPOTENCY_KEY_REUSED => 'Idempotency key reused',
            self::INVALID_IDEMPOTENCY_KEY => 'Invalid idempotency key',
            self::CAPTCHA_FAILED => 'Captcha failed',
            self::GRAPH_CYCLE => 'Graph cycle',
            self::BACKEND_UNAVAILABLE => 'Backend unavailable',
            self::EXTERNAL_UNAVAILABLE => 'External service unavailable',
            self::INTERNAL => 'Internal server error',
            self::NO_LAB_AVAILABLE => 'No laboratory available',
            self::IDEMPOTENCY_KEY_IN_PROGRESS => 'Idempotency key in progress',
            self::REFERENCE_IN_USE => 'Reference in use',
            self::METHOD_NOT_ALLOWED => 'Method not allowed',
        };
    }
}
