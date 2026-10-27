<?php

namespace App\Contract;

use RuntimeException;

/**
 * The bundled contract (contracts/openapi.yaml → one JSON document, the same redocly bundle tests/api validate
 * against): Swagger UI serves its text, ContractGate matches request paths against its templates, the operation
 * middleware reads x-roles, x-rate-limit, … from it. A container singleton warmed once per Octane worker.
 *
 * Path matching is on the raw request path (before `?`, never decoded first): literal segments are compared exactly
 * (case-sensitive), a `{param}` takes one non-empty segment; an empty segment (`//`, a trailing `/`) matches nothing.
 * Among several matching templates the one with a literal segment earlier wins (`/users/me` before `/users/{id}`).
 */
final class Contract
{
    public const PREFIX = '/api/v1';

    private const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'];

    /** @var array<string, mixed> */
    private array $doc;

    /** @var list<array{template: string, segments: list<string>, params: list<bool>, methods: array<string, string>}> */
    private array $routes = [];

    /** @var array<string, array<string, mixed>> operationId → operation (with `method` and `path` added) */
    private array $operations = [];

    public function __construct(private readonly string $raw)
    {
        $doc = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
        if (! is_array($doc) || ! isset($doc['paths']) || ! is_array($doc['paths'])) {
            throw new RuntimeException('the bundled contract has no paths');
        }
        $this->doc = $doc;
        foreach ($doc['paths'] as $template => $item) {
            $segments = explode('/', substr((string) $template, 1));
            $methods = [];
            foreach ($item as $method => $op) {
                if (in_array($method, self::METHODS, true) && is_array($op)) {
                    $methods[strtoupper($method)] = (string) $op['operationId'];
                    $this->operations[(string) $op['operationId']] = $op + [
                        'method' => strtoupper($method),
                        'path' => (string) $template,
                    ];
                }
            }
            $this->routes[] = [
                'template' => (string) $template,
                'segments' => $segments,
                'params' => array_map(fn (string $s) => (bool) preg_match('/^\{[^\/}]+\}$/D', $s), $segments),
                'methods' => $methods,
            ];
        }
    }

    public static function fromFile(string $path): self
    {
        $raw = @file_get_contents($path);
        if ($raw === false) {
            throw new RuntimeException("bundled contract not found: {$path}");
        }

        return new self($raw);
    }

    /** The configured bundle: CONTRACT_PATH, else the image copy, else contracts/dist/openapi.json of the repository. */
    public static function defaultPath(?string $configured = null): string
    {
        if ($configured !== null && $configured !== '') {
            return $configured;
        }
        $image = dirname(__DIR__, 2).'/resources/contract/openapi.json';

        return is_file($image) ? $image : dirname(__DIR__, 3).'/contracts/dist/openapi.json';
    }

    /** The bundle as served at /api/v1/docs/openapi.json. */
    public function raw(): string
    {
        return $this->raw;
    }

    /** @return array<string, mixed> */
    public function doc(): array
    {
        return $this->doc;
    }

    /**
     * The operation the contract declares for this method on this raw path (`/api/v1/…`, no query string); null when
     * the path is not a contract path, the method is not declared for it, or a path parameter is not a well-formed
     * percent-encoded UTF-8 segment.
     */
    public function match(string $method, string $rawPath): ?RouteMatch
    {
        $method = strtoupper($method);
        foreach ($this->candidates($rawPath) as [$route, $segments]) {
            if (! isset($route['methods'][$method])) {
                continue;
            }
            $params = [];
            foreach ($route['params'] as $i => $isParam) {
                if (! $isParam) {
                    continue;
                }
                $value = self::decodeSegment($segments[$i]);
                if ($value === null) {
                    return null;
                }
                $params[substr($route['segments'][$i], 1, -1)] = $value;
            }

            return new RouteMatch($route['methods'][$method], $route['template'], $params);
        }

        return null;
    }

    /**
     * The contract path template (without `/api/v1`) this raw path matches — the most specific one, as ContractGate
     * routes it (`/api/v1/batches/<id>` → `/batches/{id}`, `/users/me` before `/users/{id}`), whatever the method; null
     * when no template matches (the `route` label `unmatched` of the metrics, P54).
     */
    public function templateFor(string $rawPath): ?string
    {
        return $this->candidates($rawPath)[0][0]['template'] ?? null;
    }

    /**
     * The methods the contract declares for this raw path, upper case, in contract order (the `Allow` of a 405, P3);
     * null when no contract template matches the path.
     *
     * @return list<string>|null
     */
    public function methodsFor(string $rawPath): ?array
    {
        $candidates = $this->candidates($rawPath);
        if ($candidates === []) {
            return null;
        }
        // Union in document order (as Express's method guard): templates in `paths` order, methods in item order.
        usort($candidates, fn ($a, $b) => $a[2] <=> $b[2]);
        $out = [];
        foreach ($candidates as [$route]) {
            foreach (array_keys($route['methods']) as $m) {
                if (! in_array($m, $out, true)) {
                    $out[] = $m;
                }
            }
        }

        return $out;
    }

    /**
     * The operation object (x-extensions, parameters, responses, …) plus `method` and `path`.
     *
     * @return array<string, mixed>
     */
    public function operation(string $operationId): array
    {
        if (! isset($this->operations[$operationId])) {
            throw new RuntimeException("the contract has no operation {$operationId}");
        }

        return $this->operations[$operationId];
    }

    /** @return list<string> */
    public function operationIds(): array
    {
        return array_keys($this->operations);
    }

    /**
     * Matching templates, most specific first, with the raw segments and the template's index in `paths`.
     *
     * @return list<array{0: array{template: string, segments: list<string>, params: list<bool>, methods: array<string, string>}, 1: list<string>, 2: int}>
     */
    private function candidates(string $rawPath): array
    {
        if (! str_starts_with($rawPath, self::PREFIX.'/')) {
            return [];
        }
        $segments = explode('/', substr($rawPath, strlen(self::PREFIX) + 1));
        foreach ($segments as $s) {
            if ($s === '') {
                return [];
            }
        }
        $out = [];
        foreach ($this->routes as $index => $route) {
            if (count($route['segments']) !== count($segments)) {
                continue;
            }
            foreach ($route['segments'] as $i => $literal) {
                if (! $route['params'][$i] && $literal !== $segments[$i]) {
                    continue 2;
                }
            }
            $out[] = [$route, $segments, $index];
        }
        // A literal segment beats a parameter at the first position where two templates differ.
        usort($out, function ($a, $b) {
            foreach ($a[0]['params'] as $i => $aParam) {
                $bParam = $b[0]['params'][$i];
                if ($aParam !== $bParam) {
                    return $aParam ? 1 : -1;
                }
            }

            return $a[2] <=> $b[2];
        });

        return $out;
    }

    /**
     * decodeURIComponent of one raw path segment: null for a malformed `%`-escape or bytes that are not UTF-8 (Express
     * answers both with 404, fix round 1 I2).
     */
    public static function decodeSegment(string $raw): ?string
    {
        if (preg_match('/%(?![0-9A-Fa-f]{2})/', $raw)) {
            return null;
        }
        $decoded = rawurldecode($raw);

        return mb_check_encoding($decoded, 'UTF-8') ? $decoded : null;
    }
}
