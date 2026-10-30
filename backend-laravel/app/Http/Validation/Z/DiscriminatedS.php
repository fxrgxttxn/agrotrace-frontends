<?php

namespace App\Http\Validation\Z;

/**
 * ZodDiscriminatedUnion: a value that is not an object is `validation.type` (or `validation.required`); the option is
 * chosen by the exact value of the discriminator — none (absent, another value or type) is one `validation.enum` at
 * the discriminator's path and aborts; otherwise the chosen option alone parses the value.
 */
final class DiscriminatedS extends Schema
{
    /** @param  array<string, Schema>  $options  by discriminator value */
    public function __construct(private readonly string $discriminator, private readonly array $options) {}

    public function run(mixed $value, array $path, Issues $issues): array
    {
        if (! self::isObject($value)) {
            return self::typeIssue($value, $path, $issues);
        }
        $d = get_object_vars($value)[$this->discriminator] ?? null;
        $option = is_string($d) ? ($this->options[$d] ?? null) : null;
        if ($option === null) {
            $issues->add([...$path, $this->discriminator], 'validation.enum');

            return [self::ABORTED, null];
        }

        return $option->run($value, $path, $issues);
    }
}
