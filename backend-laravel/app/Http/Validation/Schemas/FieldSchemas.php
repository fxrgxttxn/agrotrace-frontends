<?php

namespace App\Http\Validation\Schemas;

use App\Http\Problem\Problem;
use App\Http\Validation\Z\ObjectS;
use App\Http\Validation\Z\Z;

/** packages/validation/src/fields.ts, one to one (FieldInput with its GeoJSON Polygon, TreatmentInput). */
final class FieldSchemas
{
    public const RING_NOT_CLOSED = 'validation.geometry.ringNotClosed';

    public const DOSE_UNITS = ['л/га', 'мл/га', 'кг/га', 'г/га'];

    public static function fieldInput(): ObjectS
    {
        $longitude = Z::number()->min(-180)->max(180);
        $latitude = Z::number()->min(-90)->max(90);
        $ring = Z::array(Z::tuple([$longitude, $latitude]))->min(4)->max(1000)
            ->refine(function (array $ring): bool {
                // An empty ring is reported by min(4) alone (the refinement still runs on a "dirty" array).
                if ($ring === []) {
                    return true;
                }
                $first = $ring[0];
                $last = $ring[count($ring) - 1];

                return $first[0] == $last[0] && $first[1] == $last[1];
            }, self::RING_NOT_CLOSED);
        $polygon = Z::object([
            'type' => Z::literal('Polygon'),
            'coordinates' => Z::array($ring)->min(1)->max(10),
        ]);

        return Z::object([
            'name' => Z::codePointString(1, 160, '\S'),
            'areaHa' => Z::string()->regex('^(?!0+\.00$)\d{1,8}\.\d{2}$', 'validation.areaHa.format'),
            'regionCode' => Z::regionCode(),
            'geometry' => $polygon->nullable()->optional(),
        ]);
    }

    public static function treatmentInput(): ObjectS
    {
        return Z::object([
            'substanceId' => Z::uuid(),
            'dose' => Z::string()->regex('^(?!0+\.000$)\d{1,7}\.\d{3}$', 'validation.dose.format'),
            'doseUnit' => Z::enum(self::DOSE_UNITS),
            'appliedAt' => Z::isoDateTime(),
        ]);
    }

    /**
     * FieldInput by the shared schema; the contract reports an open ring at `errors.geometry` (not at the ring's own
     * path), other geometry errors keep their paths (`geometry.coordinates[0]`, …) — D12.
     *
     * @return array<string, mixed>
     */
    public static function parseField(mixed $body): array
    {
        $r = self::fieldInput()->safeParse($body);
        if ($r['ok']) {
            return $r['value'];
        }
        $errors = $r['issues']->fieldErrors();
        foreach ($errors as $path => $keys) {
            $path = (string) $path;
            if ($path === 'geometry' || ! str_starts_with($path, 'geometry') || ! in_array(self::RING_NOT_CLOSED, $keys, true)) {
                continue;
            }
            $rest = array_values(array_filter($keys, fn (string $k) => $k !== self::RING_NOT_CLOSED));
            if ($rest !== []) {
                $errors[$path] = $rest;
            } else {
                unset($errors[$path]);
            }
            $at = $errors['geometry'] ?? [];
            if (! in_array(self::RING_NOT_CLOSED, $at, true)) {
                $at[] = self::RING_NOT_CLOSED;
            }
            $errors['geometry'] = $at;
        }
        throw Problem::validation($errors);
    }
}
