<?php

namespace App\Http\Validation\Z;

use Closure;

/** ZodEffects: a refinement (runs unless the inner schema aborted) or a transform (only on a valid inner value). */
final class Effects extends Schema
{
    private function __construct(
        private readonly Schema $inner,
        private readonly string $kind,
        private readonly Closure $fn,
    ) {}

    public static function refinement(Schema $inner, callable $check): self
    {
        return new self($inner, 'refine', Closure::fromCallable($check));
    }

    public static function transformation(Schema $inner, callable $fn): self
    {
        return new self($inner, 'transform', Closure::fromCallable($fn));
    }

    public function run(mixed $value, array $path, Issues $issues): array
    {
        [$status, $out] = $this->inner->run($value, $path, $issues);
        if ($this->kind === 'transform') {
            if ($status !== self::VALID) {
                return [self::ABORTED, null];
            }

            return [self::VALID, ($this->fn)($out)];
        }
        if ($status === self::ABORTED) {
            return [self::ABORTED, null];
        }
        if (! ($this->fn)($out, $path, $issues)) {
            $status = self::DIRTY;
        }

        return [$status, $out];
    }
}
