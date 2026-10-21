<?php

namespace App\Contract;

/** A request matched to a contract operation: its operationId, path template and decoded path parameters. */
final class RouteMatch
{
    /** @param  array<string, string>  $params */
    public function __construct(
        public readonly string $operationId,
        public readonly string $template,
        public readonly array $params,
    ) {}
}
