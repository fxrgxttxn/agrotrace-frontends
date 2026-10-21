<?php

namespace App\Http\Problem;

use App\Support\Json;
use RuntimeException;
use stdClass;

/**
 * An RFC 7807 problem (contract `Problem`) thrown anywhere in a request; Renderer sends it as is. `errors` maps a field
 * path (`items[0].field`, `_root` for the body itself — P7, P16, P19, P44) to i18n keys; `params` is always a JSON
 * object, also when empty.
 */
final class Problem extends RuntimeException
{
    /** The contract code (Exception::$code is the integer code of PHP and cannot be redeclared). */
    public readonly ProblemCode $problemCode;

    /**
     * @param  array<string, list<string>>|null  $errors
     * @param  array<string, mixed>|null  $params
     * @param  array<string, string>  $headers  extra response headers (`Allow`, `Retry-After`, …)
     */
    public function __construct(
        public readonly int $status,
        ProblemCode $code,
        public readonly ?array $errors = null,
        public readonly ?string $rule = null,
        public readonly ?array $params = null,
        public readonly array $headers = [],
        public readonly ?string $detail = null,
    ) {
        $this->problemCode = $code;
        parent::__construct($code->title());
    }

    /**
     * 400 VALIDATION with field errors.
     *
     * @param  array<string, list<string>>  $errors
     */
    public static function validation(array $errors): self
    {
        return new self(400, ProblemCode::VALIDATION, errors: $errors);
    }

    public function body(): stdClass
    {
        $body = new stdClass;
        $body->type = $this->problemCode->type();
        $body->title = $this->problemCode->title();
        $body->status = $this->status;
        $body->code = $this->problemCode->value;
        if ($this->detail !== null) {
            $body->detail = $this->detail;
        }
        if ($this->rule !== null) {
            $body->rule = $this->rule;
        }
        if ($this->params !== null) {
            $body->params = Json::obj($this->params);
        }
        if ($this->errors !== null) {
            $body->errors = Json::obj($this->errors);
        }

        return $body;
    }
}
