<?php

namespace App\Http;

use Symfony\Component\HttpFoundation\ResponseHeaderBag;

/**
 * Response headers whose `Cache-Control` is byte for byte what the application set (the contract fixes the values:
 * `no-store`, `private, max-age=0, must-revalidate`, `public, max-age=86400`): Symfony would sort the directives and
 * append `private` to any value without public/private/s-maxage. Responses that set a Cache-Control are built with
 * this bag (Responses::make); cookies are kept as the objects they are (RefreshCookie serializes itself).
 */
final class ExactHeaders extends ResponseHeaderBag
{
    private ?string $rawCacheControl = null;

    /** @param  array<string, string|list<string>>  $headers */
    public function __construct(array $headers = [])
    {
        parent::__construct($headers);
    }

    /** Converts another bag; its Cache-Control directives are re-serialized (in Symfony's order). */
    public static function from(ResponseHeaderBag $headers): self
    {
        $directives = $headers->cacheControl;
        $bag = new self($headers->allPreserveCaseWithoutCookies());
        foreach ($headers->getCookies() as $cookie) {
            $bag->setCookie($cookie);
        }
        $bag->cacheControl = $directives;
        $bag->headers['cache-control'] = [$bag->getCacheControlHeader()];

        return $bag;
    }

    public function set(string $key, string|array|null $values, bool $replace = true): void
    {
        if (strtolower($key) === 'cache-control') {
            $this->rawCacheControl = is_array($values) ? implode(', ', $values) : $values;
            if ($this->rawCacheControl === '') {
                $this->rawCacheControl = null;
            }
        }
        parent::set($key, $values, $replace);
    }

    public function remove(string $key): void
    {
        if (strtolower($key) === 'cache-control') {
            $this->rawCacheControl = null;
        }
        parent::remove($key);
    }

    protected function computeCacheControlValue(): string
    {
        if ($this->rawCacheControl !== null) {
            return $this->rawCacheControl;
        }

        return $this->cacheControl === [] ? parent::computeCacheControlValue() : $this->getCacheControlHeader();
    }
}
