<?php

namespace App\Http\Validation\Z;

/**
 * ZodUnion: the first option that parses cleanly wins; else the issues of the first "dirty" option (it matched the
 * shape but failed a check); else one `validation.invalid` at the union's path.
 */
final class UnionS extends Schema
{
    /** @param  list<Schema>  $options */
    public function __construct(private readonly array $options) {}

    public function run(mixed $value, array $path, Issues $issues): array
    {
        $dirty = null;
        foreach ($this->options as $option) {
            $own = new Issues;
            [$s, $v] = $option->run($value, $path, $own);
            if ($s === self::VALID && $own->empty()) {
                return [self::VALID, $v];
            }
            if ($s === self::DIRTY && $dirty === null) {
                $dirty = [$v, $own];
            }
        }
        if ($dirty !== null) {
            foreach ($dirty[1]->all() as $issue) {
                $issues->add($issue['path'], $issue['message']);
            }

            return [self::DIRTY, $dirty[0]];
        }
        $issues->add($path, 'validation.invalid');

        return [self::ABORTED, null];
    }
}
