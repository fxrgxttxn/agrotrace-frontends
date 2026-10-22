<?php

namespace App\Actions\Fields;

use App\Domain\Dates;
use App\Http\Problem\Problem;
use App\Http\Problem\ProblemCode;
use App\Http\Query\QueryReader;
use App\Http\Validation\Schemas\FieldSchemas;
use App\Infrastructure\Audit\AuditLog;
use App\Infrastructure\Db\Locks;
use App\Infrastructure\Db\Tx;
use App\Queries\Visibility;
use App\Security\FileUrls;
use App\Security\Principal;
use App\Support\Iso;
use App\Support\Json;
use App\Support\UtcDays;
use DateTimeImmutable;
use DateTimeZone;
use Illuminate\Support\Facades\DB;
use LogicException;
use stdClass;

/**
 * Fields and treatments (contracts/openapi/paths/fields.yaml, treatments.yaml; FR-PROD-01/02, R41/D1, R51; Express
 * fields/service.ts).
 *
 * Visibility (tag Fields): FARMER — the non-deleted fields of the own farm, the only ones it may change; INSPECTOR and
 * ADMIN — every non-deleted field, read-only. A treatment is visible with its field. Writes are by the own farm only,
 * even for a FARMER that is also INSPECTOR: a foreign field is 404 (D14). A treatment may be changed while the
 * transaction's time ≤ createdAt + 24 h (`Dates::canEditTreatment`, inclusive), else 403 {reason: EDIT_WINDOW_CLOSED}.
 * Locks (P57, Locks::field): updateField and createTreatment FOR NO KEY UPDATE, updateTreatment FOR KEY SHARE, deleteField
 * FOR UPDATE; the region FOR KEY SHARE, the substance FOR SHARE.
 */
final class FieldsActions
{
    private const FIELD_SORT = ['name', 'areaHa', 'lastTreatmentAt', 'createdAt'];

    private const TREATMENT_SORT = ['appliedAt', 'createdAt'];

    private const DAY_MS = 86400000;

    private const LAST_TREATMENT = '(SELECT max(t.applied_at) FROM treatments t WHERE t.field_id = f.id AND t.deleted_at IS NULL)';

    /**
     * `Field` views of $ids, in the order given.
     *
     * @param  list<string>  $ids
     * @return list<array<string, mixed>>
     */
    private static function fieldViews(array $ids): array
    {
        if ($ids === []) {
            return [];
        }
        $marks = implode(',', array_fill(0, count($ids), '?'));
        $byId = [];
        foreach (DB::select('SELECT f.id, f.name, f.area_ha, f.geometry::text AS geometry, r.code AS region_code, r.name AS region_name,
                o.id AS org_id, o.name AS org_name, o.type AS org_type, o.logo_file_id,
                '.self::LAST_TREATMENT."::text AS last_treatment_at,
                (SELECT count(*) FROM treatments t WHERE t.field_id = f.id AND t.deleted_at IS NULL) AS treatments_count
              FROM fields f JOIN regions r ON r.id = f.region_id JOIN organizations o ON o.id = f.organization_id
             WHERE f.id IN ({$marks})", $ids) as $f) {
            $byId[$f->id] = $f;
        }
        $out = [];
        foreach ($ids as $id) {
            $f = $byId[$id] ?? null;
            if ($f === null) {
                continue;
            }
            $out[] = [
                'id' => $f->id,
                'name' => $f->name,
                'areaHa' => $f->area_ha,
                'region' => ['code' => $f->region_code, 'name' => $f->region_name],
                'geometry' => $f->geometry !== null ? Json::decode($f->geometry) : null,
                'lastTreatmentAt' => Iso::fromPg($f->last_treatment_at),
                'treatmentsCount' => (int) $f->treatments_count,
                'organization' => [
                    'id' => $f->org_id,
                    'name' => $f->org_name,
                    'type' => $f->org_type,
                    'logoUrl' => $f->logo_file_id !== null ? FileUrls::public($f->logo_file_id) : null,
                ],
            ];
        }

        return $out;
    }

    /** @return array<string, mixed> */
    private static function fieldView(string $id): array
    {
        return self::fieldViews([$id])[0] ?? throw new LogicException("field {$id} vanished");
    }

    /** A non-deleted field $p may see (own farm; every farm for INSPECTOR/ADMIN), else 404. */
    private static function visibleField(Principal $p, string $id): void
    {
        [$sql, $bindings] = Visibility::fieldVisibleTo($p, 'f');
        if (DB::selectOne("SELECT f.id FROM fields f WHERE f.id = ? AND f.deleted_at IS NULL AND {$sql}", [$id, ...$bindings]) === null) {
            throw new Problem(404, ProblemCode::NOT_FOUND);
        }
    }

    /** The own farm's non-deleted field, locked with $strength (P57), else 404. */
    private static function ownField(Principal $p, string $id, string $strength): object
    {
        return Locks::field($id, $strength, $p->orgId) ?? throw new Problem(404, ProblemCode::NOT_FOUND);
    }

    /** The region by code FOR KEY SHARE (a parallel deleteDictionaryEntry waits and then sees this field, P23). */
    private static function regionId(string $code): string
    {
        $r = DB::selectOne('SELECT id FROM regions WHERE code = ? FOR KEY SHARE', [$code]);
        if ($r === null) {
            throw Problem::validation(['regionCode' => ['validation.notFound']]);
        }

        return $r->id;
    }

    /**
     * TreatmentInput references and dates (400, collected): a non-deleted substance (FOR SHARE), appliedAt not after
     * the transaction's time (P43).
     *
     * @param  array<string, mixed>  $input
     */
    private static function checkTreatmentRefs(array $input, string $now): void
    {
        $errors = [];
        if (DB::selectOne('SELECT id FROM substances WHERE id = ? AND deleted_at IS NULL FOR SHARE', [strtolower($input['substanceId'])]) === null) {
            $errors['substanceId'] = ['validation.notFound'];
        }
        if (self::epochMs($input['appliedAt']) > Dates::ms((string) Iso::fromPg($now))) {
            $errors['appliedAt'] = ['validation.date.future'];
        }
        if ($errors !== []) {
            throw Problem::validation($errors);
        }
    }

    /**
     * Date.parse of a validated `DateTime` (`YYYY-MM-DDTHH:MM[:SS[.fraction]]Z`): milliseconds, the fraction cut to
     * three digits as JavaScript does.
     */
    public static function epochMs(string $iso): int
    {
        $date = substr($iso, 0, 10);
        $time = substr($iso, 11, -1);
        [$hms, $frac] = array_pad(explode('.', $time, 2), 2, '');
        if (strlen($hms) === 5) {
            $hms .= ':00';
        }
        $d = new DateTimeImmutable("{$date}T{$hms}", new DateTimeZone('UTC'));

        return (int) $d->format('U') * 1000 + (int) str_pad(substr($frac, 0, 3), 3, '0');
    }

    /**
     * listFields — own farm for FARMER, all for INSPECTOR/ADMIN (`organizationId` only for them, R51).
     *
     * @return array<string, mixed>
     */
    public static function list(Principal $p, QueryReader $q): array
    {
        ['page' => $page, 'size' => $size, 'sort' => $sort] = $q->page(self::FIELD_SORT, 'name,asc');
        $text = $q->q();
        $regionCode = $q->matching('regionCode', '^[0-9A-Z-]{1,8}$');
        $organizationId = null;
        if ($p->seesAll()) {
            $organizationId = $q->uuid('organizationId');
        } else {
            $q->notAllowed('organizationId');
        }
        $q->done();

        $where = ['f.deleted_at IS NULL'];
        $bindings = [];
        $orgId = $p->seesAll() ? $organizationId : $p->orgId;
        if ($orgId !== null) {
            $where[] = 'f.organization_id = ?';
            $bindings[] = $orgId;
        }
        if ($regionCode !== null) {
            $where[] = 'f.region_id IN (SELECT id FROM regions WHERE code = ?)';
            $bindings[] = $regionCode;
        }
        if ($text !== null) {
            $where[] = 'position(lower(?) in lower(f.name)) > 0';
            $bindings[] = $text;
        }
        $cond = implode(' AND ', $where);
        $total = (int) DB::selectOne("SELECT count(*) AS total FROM fields f WHERE {$cond}", $bindings)->total;
        $order = match ($sort['field']) {
            'name' => 'f.name COLLATE "C"',
            'areaHa' => 'f.area_ha',
            'lastTreatmentAt' => self::LAST_TREATMENT,
            default => 'f.created_at',
        };
        $dir = $sort['dir'] === 'asc' ? 'ASC' : 'DESC';
        $ids = array_map(fn ($r) => $r->id, DB::select("SELECT f.id FROM fields f WHERE {$cond}
            ORDER BY {$order} {$dir} NULLS LAST, f.id::text COLLATE \"C\" LIMIT ? OFFSET ?", [...$bindings, $size, ($page - 1) * $size]));

        return ['items' => self::fieldViews($ids), 'page' => $page, 'size' => $size, 'total' => $total];
    }

    /**
     * createField — in the user's farm; unknown regionCode → 400 notFound.
     *
     * @return array<string, mixed>
     */
    public static function create(Principal $p, mixed $body): array
    {
        $input = FieldSchemas::parseField($body);
        $id = Tx::run(function () use ($p, $input): string {
            $region = self::regionId($input['regionCode']);
            $geometry = $input['geometry'] ?? null;
            $f = DB::selectOne('INSERT INTO fields (organization_id, name, area_ha, geometry, region_id, created_by)
                 VALUES (?, ?, ?, ?::jsonb, ?, ?) RETURNING id, area_ha',
                [$p->orgId, $input['name'], $input['areaHa'], $geometry !== null ? Json::encode($geometry) : null, $region, $p->userId]);
            AuditLog::write($p->userId, 'createField', 'field', $f->id, AuditLog::diff(null, [
                'name' => $input['name'],
                'areaHa' => $f->area_ha,
                'regionCode' => $input['regionCode'],
                'geometry' => $geometry,
                'organizationId' => $p->orgId,
            ]));

            return $f->id;
        });

        return self::fieldView($id);
    }

    /** @return array<string, mixed> */
    public static function get(Principal $p, string $id): array
    {
        self::visibleField($p, $id);

        return self::fieldView($id);
    }

    /**
     * updateField — full replacement (absent geometry → none); last write wins (no version). Nothing changed (the
     * geometry compared with sorted keys: jsonb reorders them) → no write, no audit row.
     *
     * @return array<string, mixed>
     */
    public static function update(Principal $p, string $id, mixed $body): array
    {
        $input = FieldSchemas::parseField($body);
        Tx::run(function () use ($p, $id, $input): void {
            $f = self::ownField($p, $id, 'for no key update');
            $region = self::regionId($input['regionCode']);
            $before = [
                'name' => $f->name,
                'areaHa' => $f->area_ha,
                'regionCode' => $f->region_code,
                'geometry' => $f->geometry !== null ? Json::decode($f->geometry) : null,
            ];
            $geometry = $input['geometry'] ?? null;
            $wanted = ['name' => $input['name'], 'areaHa' => $input['areaHa'], 'regionCode' => $input['regionCode'], 'geometry' => $geometry];
            if (self::canonical($before) === self::canonical($wanted)) {
                return;
            }
            $after = DB::selectOne('UPDATE fields SET name = ?, area_ha = ?, region_id = ?, geometry = ?::jsonb, updated_at = now()
                 WHERE id = ? RETURNING area_ha, geometry::text AS geometry',
                [$input['name'], $input['areaHa'], $region, $geometry !== null ? Json::encode($geometry) : null, $id]);
            $diff = AuditLog::diff($before, [
                'name' => $input['name'],
                'areaHa' => $after->area_ha,
                'regionCode' => $input['regionCode'],
                'geometry' => $after->geometry !== null ? Json::decode($after->geometry) : null,
            ]);
            if ($diff !== []) {
                AuditLog::write($p->userId, 'updateField', 'field', $id, $diff);
            }
        });

        return self::fieldView($id);
    }

    /** deleteField — soft; treatments stay (BR-01 of existing batches), new ones are refused (404). */
    public static function remove(Principal $p, string $id): void
    {
        Tx::run(function () use ($p, $id): void {
            self::ownField($p, $id, 'for update');
            $now = Tx::now();
            DB::update('UPDATE fields SET deleted_at = ?::timestamptz WHERE id = ?', [$now, $id]);
            AuditLog::write($p->userId, 'deleteField', 'field', $id, ['deletedAt' => [null, Iso::fromPg($now)]]);
        });
    }

    /**
     * listFieldTreatments — the field's non-deleted treatments; substanceId; from/to by UTC date of appliedAt.
     *
     * @return array<string, mixed>
     */
    public static function listTreatments(Principal $p, string $fieldId, QueryReader $q): array
    {
        ['page' => $page, 'size' => $size, 'sort' => $sort] = $q->page(self::TREATMENT_SORT, 'appliedAt,desc');
        $substanceId = $q->uuid('substanceId');
        ['from' => $from, 'to' => $to] = $q->dateRange();
        $q->done();
        self::visibleField($p, $fieldId);

        $where = ['t.field_id = ?', 't.deleted_at IS NULL'];
        $bindings = [$fieldId];
        if ($substanceId !== null) {
            $where[] = 't.substance_id = ?';
            $bindings[] = $substanceId;
        }
        [$days, $dayBindings] = UtcDays::range('t.applied_at', $from, $to);
        array_push($where, ...$days);
        array_push($bindings, ...$dayBindings);
        $cond = implode(' AND ', $where);
        $total = (int) DB::selectOne("SELECT count(*) AS total FROM treatments t WHERE {$cond}", $bindings)->total;
        $column = $sort['field'] === 'createdAt' ? 't.created_at' : 't.applied_at';
        $dir = $sort['dir'] === 'asc' ? 'ASC' : 'DESC';
        $ids = array_map(fn ($r) => $r->id, DB::select("SELECT t.id FROM treatments t WHERE {$cond}
            ORDER BY {$column} {$dir}, t.id::text COLLATE \"C\" LIMIT ? OFFSET ?", [...$bindings, $size, ($page - 1) * $size]));

        return ['items' => self::treatmentViews($ids), 'page' => $page, 'size' => $size, 'total' => $total];
    }

    /**
     * createTreatment — order: body → 404 (own non-deleted field, locked) → references/dates (400).
     *
     * @return array<string, mixed>
     */
    public static function createTreatment(Principal $p, string $fieldId, mixed $body): array
    {
        $input = FieldSchemas::treatmentInput()->parse($body);
        $id = Tx::run(function () use ($p, $fieldId, $input): string {
            self::ownField($p, $fieldId, 'for no key update');
            $now = Tx::now();
            self::checkTreatmentRefs($input, $now);
            $t = DB::selectOne('INSERT INTO treatments (field_id, substance_id, dose, dose_unit, applied_at, created_at, updated_at, created_by)
                 VALUES (?, ?, ?, ?, ?::timestamptz, ?::timestamptz, ?::timestamptz, ?)
                 RETURNING id, field_id, substance_id, dose, dose_unit, applied_at::text AS applied_at',
                [$fieldId, strtolower($input['substanceId']), $input['dose'], $input['doseUnit'], $input['appliedAt'], $now, $now, $p->userId]);
            AuditLog::write($p->userId, 'createTreatment', 'treatment', $t->id, AuditLog::diff(null, self::treatmentAudit($t)));

            return $t->id;
        });

        return self::treatmentViews([$id])[0];
    }

    /**
     * updateTreatment — order: body → 404 (missing/deleted treatment, or its field deleted or not the user's farm) →
     * 403 EDIT_WINDOW_CLOSED (now > createdAt + 24 h) → references/dates (400). The window is not extended. Lock order
     * field → treatment: the field FOR KEY SHARE (a parallel deleteField cannot interleave), then the treatment row.
     *
     * @return array<string, mixed>
     */
    public static function updateTreatment(Principal $p, string $id, mixed $body): array
    {
        $input = FieldSchemas::treatmentInput()->parse($body);
        Tx::run(function () use ($p, $id, $input): void {
            $owner = DB::selectOne('SELECT field_id FROM treatments WHERE id = ?', [$id]);
            if ($owner === null || Locks::field($owner->field_id, 'for key share', $p->orgId) === null) {
                throw new Problem(404, ProblemCode::NOT_FOUND);
            }
            $t = DB::selectOne('SELECT t.id, t.field_id, t.substance_id, t.dose, t.dose_unit, t.applied_at::text AS applied_at, t.created_at::text AS created_at
                  FROM treatments t JOIN fields f ON f.id = t.field_id
                 WHERE t.id = ? AND t.deleted_at IS NULL AND f.deleted_at IS NULL AND f.organization_id = ?
                 FOR NO KEY UPDATE OF t', [$id, $p->orgId]);
            if ($t === null) {
                throw new Problem(404, ProblemCode::NOT_FOUND);
            }
            $now = Tx::now();
            $createdAt = (string) Iso::fromPg($t->created_at);
            if (! Dates::canEditTreatment(['createdAt' => $createdAt, 'now' => (string) Iso::fromPg($now)])['allowed']) {
                throw new Problem(403, ProblemCode::FORBIDDEN, title: 'Edit window closed', params: [
                    'reason' => 'EDIT_WINDOW_CLOSED',
                    'editableUntil' => Dates::fromMs(Dates::ms($createdAt) + self::DAY_MS)->format(Iso::FORMAT),
                ]);
            }
            self::checkTreatmentRefs($input, $now);
            $after = DB::selectOne('UPDATE treatments SET substance_id = ?, dose = ?, dose_unit = ?, applied_at = ?::timestamptz, updated_at = ?::timestamptz
                 WHERE id = ? RETURNING field_id, substance_id, dose, dose_unit, applied_at::text AS applied_at',
                [strtolower($input['substanceId']), $input['dose'], $input['doseUnit'], $input['appliedAt'], $now, $id]);
            $diff = AuditLog::diff(self::treatmentAudit($t), self::treatmentAudit($after));
            if ($diff !== []) {
                AuditLog::write($p->userId, 'updateTreatment', 'treatment', $id, $diff);
            }
        });

        return self::treatmentViews([$id])[0];
    }

    /**
     * `Treatment` views of $ids, in the order given.
     *
     * @param  list<string>  $ids
     * @return list<array<string, mixed>>
     */
    private static function treatmentViews(array $ids): array
    {
        if ($ids === []) {
            return [];
        }
        $marks = implode(',', array_fill(0, count($ids), '?'));
        $byId = [];
        foreach (DB::select("SELECT t.id, t.field_id, t.dose, t.dose_unit, t.applied_at::text AS applied_at, t.created_at::text AS created_at,
                s.id AS substance_id, s.name AS substance_name, s.type AS substance_type, s.waiting_period_days
              FROM treatments t JOIN substances s ON s.id = t.substance_id WHERE t.id IN ({$marks})", $ids) as $t) {
            $byId[$t->id] = $t;
        }

        return array_map(function (string $id) use ($byId): array {
            $t = $byId[$id];
            $createdAt = (string) Iso::fromPg($t->created_at);

            return [
                'id' => $t->id,
                'fieldId' => $t->field_id,
                'substance' => [
                    'id' => $t->substance_id,
                    'name' => $t->substance_name,
                    'type' => $t->substance_type,
                    'waitingPeriodDays' => (int) $t->waiting_period_days,
                ],
                'dose' => $t->dose,
                'doseUnit' => $t->dose_unit,
                'appliedAt' => Iso::fromPg($t->applied_at),
                'createdAt' => $createdAt,
                'editableUntil' => Dates::fromMs(Dates::ms($createdAt) + self::DAY_MS)->format(Iso::FORMAT),
            ];
        }, $ids);
    }

    /** @return array<string, mixed> the audit view of a treatment row (API names; `appliedAt` ISO UTC) */
    private static function treatmentAudit(stdClass $t): array
    {
        return [
            'fieldId' => $t->field_id,
            'substanceId' => $t->substance_id,
            'dose' => $t->dose,
            'doseUnit' => $t->dose_unit,
            'appliedAt' => Iso::fromPg($t->applied_at),
        ];
    }

    /** JSON with object keys sorted (jsonb reorders keys: stored and sent geometry compare by content). */
    private static function canonical(mixed $v): string
    {
        if ($v instanceof stdClass) {
            $v = get_object_vars($v);
            if ($v === []) {
                return '{}';
            }
        }
        if (is_array($v)) {
            if (array_is_list($v)) {
                return '['.implode(',', array_map(fn ($x) => self::canonical($x), $v)).']';
            }
            ksort($v, SORT_STRING);
            $parts = [];
            foreach ($v as $k => $x) {
                $parts[] = Json::encode((string) $k).':'.self::canonical($x);
            }

            return '{'.implode(',', $parts).'}';
        }

        return Json::encode($v);
    }
}
