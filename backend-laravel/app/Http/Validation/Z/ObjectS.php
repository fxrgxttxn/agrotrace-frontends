<?php

namespace App\Http\Validation\Z;

/**
 * ZodObject: a JSON object (stdClass — an array is `validation.type`). The shape's keys are parsed first, in shape
 * order; `strict` then reports every other key as `validation.unknownField` at its own path (Zod's one
 * unrecognized_keys issue expanded by toFieldErrors). An aborted value aborts the object. The output holds only the
 * shape's keys that are present (or parsed to something other than undefined).
 */
final class ObjectS extends Schema
{
    /** @param  array<string, Schema>  $shape */
    public function __construct(public readonly array $shape, private readonly bool $strict = true) {}

    /** `.partial()`: every key optional. */
    public function partial(): self
    {
        return new self(array_map(fn (Schema $s) => $s instanceof OptionalS ? $s : $s->optional(), $this->shape), $this->strict);
    }

    public function run(mixed $value, array $path, Issues $issues): array
    {
        if (! self::isObject($value)) {
            return self::typeIssue($value, $path, $issues);
        }
        $data = get_object_vars($value);
        $status = self::VALID;
        $aborted = false;
        $out = [];
        foreach ($this->shape as $key => $schema) {
            $present = array_key_exists($key, $data);
            [$s, $v] = $schema->run($present ? $data[$key] : Missing::Undefined, [...$path, $key], $issues);
            if ($s === self::ABORTED) {
                $aborted = true;
            } elseif ($s === self::DIRTY) {
                $status = self::DIRTY;
            }
            if ($v !== Missing::Undefined || $present) {
                $out[$key] = $v;
            }
        }
        if ($this->strict) {
            foreach (array_keys($data) as $key) {
                if (! array_key_exists((string) $key, $this->shape)) {
                    $issues->add([...$path, (string) $key], 'validation.unknownField');
                    $status = self::DIRTY;
                }
            }
        }

        return $aborted ? [self::ABORTED, null] : [$status, $out];
    }
}
