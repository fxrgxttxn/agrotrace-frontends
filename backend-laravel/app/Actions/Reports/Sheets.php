<?php

namespace App\Actions\Reports;

use App\Actions\Analytics\Dashboard;
use App\Actions\Analytics\Window;
use App\Actions\Recalls\RecallView;
use App\Security\Principal;
use App\Support\Iso;
use Illuminate\Support\Facades\DB;
use Throwable;

/**
 * Report contents (downloadReport, contracts/openapi/paths/reports.yaml; FR-ANL-04, FR-ANL-05; Express
 * modules/reports/sheets.ts): the sheets of each report type with the contract's names, columns, row orders and cell
 * types, read in the caller's snapshot (Window::snapshot). Rendering is the sandbox's (resources/sandbox/report-render.php).
 *
 * Cells (ReportData): text — a string; int — a count; mass — kg as stored; dec2 — percents and `Hours`; moments — text
 * `YYYY-MM-DD HH:MM` in UTC, truncated to the minute (never rounded, R59); booleans — `да`/`нет`; enum codes as in the
 * API; null — an empty cell.
 *
 * Every windowed query reads at most `maxRows` + 1 rows (REPORT_MAX_ROWS): more than `maxRows` in any sheet is
 * `errors.type: [validation.report.tooManyRows]` (checked by the caller). The recall report reads its sheets whole,
 * as Express does (its members and tasks are bounded by the recall itself).
 *
 * Memory (review I1): a windowed sheet is read through a server-side cursor, CHUNK rows at a time, each row turned into
 * its cells and spooled at once (ReportSpool) — the request thread holds one chunk, never the report (a 50 000-row
 * complaints report of contract-length texts is ~300 MB of text).
 */
final class Sheets
{
    public const CHUNK = 500;

    private const LAB_OPEN = "('QUEUED', 'SAMPLED', 'ESCALATED')";

    private const EVENT_ORDER = ['RECALL_OPENED', 'TASK_CREATED', 'TASK_OVERDUE', 'TASK_CONFIRMED', 'RECALL_CLOSED'];

    /**
     * The report $type, or null when its recall or organization does not exist or is deleted (404). $params:
     * `window` (resolved), `id` (recall / organization), `head` (an organization head's report: its own organization
     * only), `maxRows`. Runs inside the snapshot transaction (the cursors live in it).
     *
     * @param  array{window: array{from: string, to: string}, id: ?string, head: bool, maxRows: int}  $params
     */
    public static function build(string $type, array $params, Principal $p): ?ReportData
    {
        $w = $params['window'];
        $headOrg = $params['head'] ? $p->orgId : null;
        $maxRows = (int) $params['maxRows'];
        $limit = $maxRows + 1;
        $spool = new ReportSpool;
        try {
            $report = match ($type) {
                'batches' => self::batches($spool, $w, $headOrg, $limit),
                'recalls' => self::recalls($spool, $w, $limit),
                'recall' => self::recall($spool, (string) $params['id']),
                'lab-tests' => self::labTests($spool, $w, $headOrg, $limit),
                'complaints' => self::complaints($spool, $w, $limit),
                default => self::org($spool, $w, (string) $params['id'], $limit),
            };
        } catch (Throwable $e) {
            $spool->close();
            throw $e;
        }
        if ($report === null) {
            $spool->close();
        }

        return $report;
    }

    /** `YYYY-MM-DD HH:MM` (UTC) of a PostgreSQL or API instant, seconds and fractions truncated; null stays null. */
    public static function minute(?string $instant): ?string
    {
        if ($instant === null) {
            return null;
        }
        $iso = str_contains($instant, 'T') ? $instant : (string) Iso::fromPg($instant);

        return substr($iso, 0, 10).' '.substr($iso, 11, 5);
    }

    /**
     * Spools the rows of $sql (bound by $bindings) through a server-side cursor, CHUNK rows per FETCH, each mapped to its
     * cells by $cells. Inside the snapshot transaction (a cursor lives until its transaction ends; it is closed here).
     *
     * @param  list<mixed>  $bindings
     * @param  callable(object): list<array{0: string, 1: string|int|null}>  $cells
     */
    public static function spoolRows(ReportSpool $spool, string $sql, array $bindings, callable $cells): void
    {
        DB::statement("DECLARE report_rows NO SCROLL CURSOR FOR {$sql}", $bindings);
        do {
            $chunk = DB::select('FETCH '.self::CHUNK.' FROM report_rows');
            foreach ($chunk as $r) {
                $spool->row($cells($r));
            }
        } while (count($chunk) === self::CHUNK);
        // On an error the transaction's rollback drops the cursor (a CLOSE there would hide the error).
        DB::statement('CLOSE report_rows');
    }

    /** @return array{0: string, 1: ?string} */
    private static function t(mixed $v): array
    {
        return ['text', $v === null ? null : (string) $v];
    }

    /** @return array{0: string, 1: ?int} */
    private static function n(mixed $v): array
    {
        return ['int', $v === null ? null : (int) $v];
    }

    /** @return array{0: string, 1: string} */
    private static function yes(bool $b): array
    {
        return ['text', $b ? 'да' : 'нет'];
    }

    /** @param  array{from: string, to: string}  $w */
    private static function period(array $w): string
    {
        return "Период: {$w['from']} — {$w['to']} (UTC)";
    }

    /** @param  array{from: string, to: string}  $w */
    private static function batches(ReportSpool $spool, array $w, ?string $headOrg, int $limit): ReportData
    {
        $spool->sheet('Партии', ['Код партии', 'Продукт', 'Категория', 'Вид', 'Масса, кг', 'Статус', 'Создатель', 'Держатель',
            'Дата производства (UTC)', 'Анализ требуется', 'Основание анализа', 'Изменена (UTC)']);
        self::spoolRows($spool, 'SELECT b.public_code, p.name AS product, p.category, b.kind, b.mass_kg::text AS mass_kg, b.status,
                    o.name AS origin, h.name AS holder, coalesce(b.harvested_at, b.produced_at)::text AS at,
                    b.test_required, b.test_reason, b.updated_at::text AS updated_at
               FROM batches b
               JOIN products p ON p.id = b.product_id
               JOIN organizations o ON o.id = b.origin_org_id
               LEFT JOIN organizations h ON h.id = b.holder_org_id
              WHERE b.deleted_at IS NULL
                AND coalesce(b.harvested_at, b.produced_at) >= ?::timestamptz
                AND coalesce(b.harvested_at, b.produced_at) < ?::timestamptz
                AND (?::uuid IS NULL OR b.origin_org_id = ?::uuid OR b.holder_org_id = ?::uuid)
              ORDER BY b.public_code COLLATE "C"
              LIMIT ?', [...Window::bounds($w), $headOrg, $headOrg, $headOrg, $limit], fn (object $r): array => [
            self::t($r->public_code),
            self::t($r->product),
            self::t($r->category),
            self::t($r->kind),
            ['mass', (string) $r->mass_kg],
            self::t($r->status),
            self::t($r->origin),
            self::t($r->holder),
            self::t(self::minute($r->at)),
            self::yes($r->test_required === true),
            self::t($r->test_reason),
            self::t(self::minute($r->updated_at)),
        ]);

        return new ReportData('Реестр партий', "agrotrace-batches_{$w['from']}_{$w['to']}", self::period($w), $spool);
    }

    /** @param  array{from: string, to: string}  $w */
    private static function recalls(ReportSpool $spool, array $w, int $limit): ReportData
    {
        $spool->sheet('Отзывы', ['ID отзыва', 'Исходная партия', 'Продукт', 'Источник', 'Причина', 'Статус', 'Открыт (UTC)',
            'Закрыт (UTC)', 'Длительность, ч', 'Партий', 'Задач', 'Подтверждено', 'Просрочено']);
        self::spoolRows($spool, "SELECT r.id, b.public_code, p.name AS product, r.trigger, r.reason, r.status,
                    r.opened_at::text AS opened_at, r.closed_at::text AS closed_at,
                    floor(extract(epoch FROM r.closed_at - r.opened_at))::bigint::text AS secs,
                    (SELECT count(*)::int FROM recall_batches rb WHERE rb.recall_id = r.id) AS batches,
                    (SELECT count(*)::int FROM recall_tasks t WHERE t.recall_id = r.id) AS total,
                    (SELECT count(*)::int FROM recall_tasks t WHERE t.recall_id = r.id AND t.status = 'CONFIRMED') AS confirmed,
                    (SELECT count(*)::int FROM recall_tasks t
                      WHERE t.recall_id = r.id AND t.status <> 'CONFIRMED' AND now() > t.due_at) AS overdue
               FROM recalls r
               JOIN batches b ON b.id = r.source_batch_id
               JOIN products p ON p.id = b.product_id
              WHERE r.deleted_at IS NULL AND r.opened_at >= ?::timestamptz AND r.opened_at < ?::timestamptz
              ORDER BY r.opened_at, r.id::text COLLATE \"C\"
              LIMIT ?", [...Window::bounds($w), $limit], fn (object $r): array => [
            self::t($r->id),
            self::t($r->public_code),
            self::t($r->product),
            self::t($r->trigger),
            self::t($r->reason),
            self::t($r->status),
            self::t(self::minute($r->opened_at)),
            self::t(self::minute($r->closed_at)),
            ['dec2', $r->secs === null ? null : Dashboard::hours((string) $r->secs, 1)],
            self::n($r->batches),
            self::n($r->total),
            self::n($r->confirmed),
            self::n($r->overdue),
        ]);

        return new ReportData('Реестр отзывов', "agrotrace-recalls_{$w['from']}_{$w['to']}", self::period($w), $spool);
    }

    /** The recall report (FR-ANL-04), or null when the recall does not exist or is deleted. */
    private static function recall(ReportSpool $spool, string $id): ?ReportData
    {
        $r = RecallView::card($id);
        if ($r === null) {
            return null;
        }
        $head = DB::selectOne('SELECT r.opened_at::text AS opened_at, r.closed_at::text AS closed_at, o.name AS origin
               FROM recalls r JOIN batches b ON b.id = r.source_batch_id JOIN organizations o ON o.id = b.origin_org_id
              WHERE r.id = ?', [$id]);
        $secs = [];
        foreach (DB::select('SELECT t.id, floor(extract(epoch FROM t.confirmed_at - r.opened_at))::bigint::text AS secs
               FROM recall_tasks t JOIN recalls r ON r.id = t.recall_id
              WHERE t.recall_id = ?', [$id]) as $t) {
            $secs[(string) $t->id] = $t->secs === null ? null : (string) $t->secs;
        }
        $source = (string) $r['sourceBatch']['publicCode'];
        $origin = (string) $head->origin;
        $openedAt = (string) Iso::fromPg($head->opened_at);
        // Events: the moment (ms, as Express's Date), then the event order, then the batch code (code points).
        $events = [];
        $add = function (string $at, string $event, string $code, string $org) use (&$events): void {
            $events[] = ['at' => Iso::epochMs($at), 'order' => (int) array_search($event, self::EVENT_ORDER, true),
                'iso' => $at, 'event' => $event, 'code' => $code, 'org' => $org];
        };
        $add($openedAt, 'RECALL_OPENED', $source, $origin);
        foreach ($r['tasks'] as $t) {
            $code = (string) $t['batch']['publicCode'];
            $holder = (string) $t['holder']['name'];
            $add($openedAt, 'TASK_CREATED', $code, $holder);
            if ($t['escalatedAt'] !== null) {
                $add((string) $t['escalatedAt'], 'TASK_OVERDUE', $code, $holder);
            }
            if ($t['confirmedAt'] !== null) {
                $add((string) $t['confirmedAt'], 'TASK_CONFIRMED', $code, $holder);
            }
        }
        if ($head->closed_at !== null) {
            $add((string) Iso::fromPg($head->closed_at), 'RECALL_CLOSED', $source, $origin);
        }
        usort($events, fn (array $a, array $b): int => ($a['at'] <=> $b['at']) ?: ($a['order'] <=> $b['order'])
            ?: strcmp($a['code'], $b['code']));

        $spool->sheet('Отзыв', ['Поле', 'Значение']);
        foreach ([
            [self::t('ID'), self::t($r['id'])],
            [self::t('Исходная партия'), self::t($source)],
            [self::t('Продукт'), self::t($r['sourceBatch']['product']['name'])],
            [self::t('Источник'), self::t($r['trigger'])],
            [self::t('Причина'), self::t($r['reason'])],
            [self::t('Статус'), self::t($r['status'])],
            [self::t('Блокировка источников'), self::yes($r['blockUpstream'] === true)],
            [self::t('Открыт (UTC)'), self::t(self::minute($r['openedAt']))],
            [self::t('Закрыт (UTC)'), self::t(self::minute($r['closedAt']))],
            [self::t('Инициатор'), self::t($r['openedBy']['fullName'] ?? null)],
            [self::t('Партий'), self::n($r['batchesCount'])],
            [self::t('Задач'), self::n($r['progress']['total'])],
            [self::t('Подтверждено'), self::n($r['progress']['confirmed'])],
        ] as $row) {
            $spool->row($row);
        }
        $spool->sheet('Партии', ['Код партии', 'Продукт', 'Направление', 'Глубина', 'Статус до отзыва', 'Статус сейчас', 'Держатель']);
        foreach ($r['batches'] as $m) {
            $spool->row([
                self::t($m['batch']['publicCode']),
                self::t($m['batch']['product']['name']),
                self::t($m['direction']),
                self::n($m['depth']),
                self::t($m['statusBefore']),
                self::t($m['batch']['status']),
                self::t($m['batch']['holder']['name'] ?? null),
            ]);
        }
        $spool->sheet('Задачи', ['Код партии', 'Держатель', 'Срок (UTC)', 'Статус', 'Эскалирована (UTC)', 'Подтверждена (UTC)',
            'Подтвердил', 'Время подтверждения, ч']);
        foreach ($r['tasks'] as $t) {
            $spool->row([
                self::t($t['batch']['publicCode']),
                self::t($t['holder']['name']),
                self::t(self::minute($t['dueAt'])),
                self::t($t['status']),
                self::t(self::minute($t['escalatedAt'])),
                self::t(self::minute($t['confirmedAt'])),
                self::t($t['confirmedBy']['fullName'] ?? null),
                ['dec2', ($secs[$t['id']] ?? null) === null ? null : Dashboard::hours((string) $secs[$t['id']], 1)],
            ]);
        }
        $spool->sheet('Хронология', ['Время (UTC)', 'Событие', 'Партия', 'Организация']);
        foreach ($events as $e) {
            $spool->row([self::t(self::minute($e['iso'])), self::t($e['event']), self::t($e['code']), self::t($e['org'])]);
        }

        return new ReportData('Отчёт по отзыву', "agrotrace-recall_{$r['id']}", "Отзыв: {$r['id']}", $spool);
    }

    /** @param  array{from: string, to: string}  $w */
    private static function labTests(ReportSpool $spool, array $w, ?string $headOrg, int $limit): ReportData
    {
        $spool->sheet('Анализы', ['Код партии', 'Продукт', 'Лаборатория', 'Основание', 'Статус', 'Заключение', 'Создан (UTC)',
            'Срок (UTC)', 'Проба (UTC)', 'Завершён (UTC)', 'Просрочен', 'Превышенные показатели']);
        self::spoolRows($spool, 'SELECT b.public_code, p.name AS product, l.name AS lab, lt.reason, lt.status, lt.conclusion,
                    lt.created_at::text AS created_at, lt.due_at::text AS due_at, lt.sampled_at::text AS sampled_at,
                    lt.completed_at::text AS completed_at,
                    (lt.status IN '.self::LAB_OPEN.' AND now() > lt.due_at) AS overdue,
                    (SELECT string_agg(i.name, \', \' ORDER BY i.name COLLATE "C")
                       FROM lab_results lr JOIN indicators i ON i.id = lr.indicator_id
                      WHERE lr.lab_test_id = lt.id AND lr.is_exceeded) AS exceeded
               FROM lab_tests lt
               JOIN batches b ON b.id = lt.batch_id
               JOIN products p ON p.id = b.product_id
               JOIN organizations l ON l.id = lt.lab_org_id
              WHERE lt.deleted_at IS NULL AND b.deleted_at IS NULL
                AND lt.created_at >= ?::timestamptz AND lt.created_at < ?::timestamptz
                AND (?::uuid IS NULL OR lt.lab_org_id = ?::uuid)
              ORDER BY lt.created_at, lt.id::text COLLATE "C"
              LIMIT ?', [...Window::bounds($w), $headOrg, $headOrg, $limit], fn (object $r): array => [
            self::t($r->public_code),
            self::t($r->product),
            self::t($r->lab),
            self::t($r->reason),
            self::t($r->status),
            self::t($r->conclusion),
            self::t(self::minute($r->created_at)),
            self::t(self::minute($r->due_at)),
            self::t(self::minute($r->sampled_at)),
            self::t(self::minute($r->completed_at)),
            self::yes($r->overdue === true),
            self::t($r->exceeded),
        ]);

        return new ReportData('Лабораторные анализы', "agrotrace-lab-tests_{$w['from']}_{$w['to']}", self::period($w), $spool);
    }

    /**
     * The complaints (the buyer's contact is not in the report, R59).
     *
     * @param  array{from: string, to: string}  $w
     */
    private static function complaints(ReportSpool $spool, array $w, int $limit): ReportData
    {
        $spool->sheet('Жалобы', ['Поступила (UTC)', 'Код партии', 'Продукт', 'Текст', 'Статус', 'Решение', 'Комментарий',
            'Инспектор', 'Решение принято (UTC)']);
        self::spoolRows($spool, 'SELECT c.created_at::text AS created_at, b.public_code, p.name AS product, c.text, c.status,
                    c.decision, c.decision_comment, u.full_name AS inspector, c.decided_at::text AS decided_at
               FROM complaints c
               JOIN batches b ON b.id = c.batch_id
               JOIN products p ON p.id = b.product_id
               LEFT JOIN users u ON u.id = c.inspector_id
              WHERE c.deleted_at IS NULL AND c.created_at >= ?::timestamptz AND c.created_at < ?::timestamptz
              ORDER BY c.created_at, c.id::text COLLATE "C"
              LIMIT ?', [...Window::bounds($w), $limit], fn (object $r): array => [
            self::t(self::minute($r->created_at)),
            self::t($r->public_code),
            self::t($r->product),
            self::t($r->text),
            self::t($r->status),
            self::t($r->decision),
            self::t($r->decision_comment),
            self::t($r->inspector),
            self::t(self::minute($r->decided_at)),
        ]);

        return new ReportData('Жалобы', "agrotrace-complaints_{$w['from']}_{$w['to']}", self::period($w), $spool);
    }

    /**
     * The organization summary, or null when the organization does not exist or is deleted.
     *
     * @param  array{from: string, to: string}  $w
     */
    private static function org(ReportSpool $spool, array $w, string $orgId, int $limit): ?ReportData
    {
        $org = DB::selectOne('SELECT o.name, o.inn, o.type, r.name AS region, o.status, o.trust_rating
               FROM organizations o JOIN regions r ON r.id = o.region_id
              WHERE o.id = ? AND o.deleted_at IS NULL', [$orgId]);
        if ($org === null) {
            return null;
        }
        $b = Window::bounds($w);
        $spool->sheet('Организация', ['Поле', 'Значение']);
        foreach ([
            [self::t('Название'), self::t($org->name)],
            [self::t('ИНН'), self::t($org->inn)],
            [self::t('Тип'), self::t($org->type)],
            [self::t('Регион'), self::t($org->region)],
            [self::t('Статус'), self::t($org->status)],
            [self::t('Рейтинг доверия'), self::n($org->type === 'FARM' ? $org->trust_rating : null)],
            [self::t('Период'), self::t("{$w['from']} — {$w['to']}")],
        ] as $row) {
            $spool->row($row);
        }
        $spool->sheet('Партии по статусам', ['Статус', 'Количество']);
        foreach (Dashboard::byStatus($orgId) as $s) {
            $spool->row([self::t($s['status']), self::n($s['count'])]);
        }
        // «Анализы»: DONE tests of the organization's batches — for a laboratory, the tests it performed.
        $owner = $org->type === 'LAB' ? 'lt.lab_org_id = ?' : 'b.origin_org_id = ?';
        $spool->sheet('Анализы', ['Код партии', 'Продукт', 'Лаборатория', 'Заключение', 'Завершён (UTC)']);
        self::spoolRows($spool, "SELECT b.public_code, p.name AS product, l.name AS lab, lt.conclusion,
                    lt.completed_at::text AS completed_at
               FROM lab_tests lt
               JOIN batches b ON b.id = lt.batch_id
               JOIN products p ON p.id = b.product_id
               JOIN organizations l ON l.id = lt.lab_org_id
              WHERE lt.deleted_at IS NULL AND b.deleted_at IS NULL AND lt.status = 'DONE'
                AND lt.completed_at >= ?::timestamptz AND lt.completed_at < ?::timestamptz
                AND {$owner}
              ORDER BY lt.completed_at, lt.id::text COLLATE \"C\"
              LIMIT ?", [...$b, $orgId, $limit], fn (object $r): array => [
            self::t($r->public_code), self::t($r->product), self::t($r->lab), self::t($r->conclusion),
            self::t(self::minute($r->completed_at)),
        ]);
        $spool->sheet('Задачи отзыва', ['Код партии', 'ID отзыва', 'Срок (UTC)', 'Статус', 'Подтверждена (UTC)']);
        self::spoolRows($spool, 'SELECT b.public_code, t.recall_id, t.due_at::text AS due_at, t.status,
                    t.confirmed_at::text AS confirmed_at
               FROM recall_tasks t
               JOIN recalls r ON r.id = t.recall_id
               JOIN batches b ON b.id = t.batch_id
              WHERE t.holder_org_id = ? AND r.deleted_at IS NULL AND b.deleted_at IS NULL
                AND t.created_at >= ?::timestamptz AND t.created_at < ?::timestamptz
              ORDER BY t.due_at, t.id::text COLLATE "C"
              LIMIT ?', [$orgId, ...$b, $limit], fn (object $r): array => [
            self::t($r->public_code), self::t($r->recall_id), self::t(self::minute($r->due_at)), self::t($r->status),
            self::t(self::minute($r->confirmed_at)),
        ]);

        return new ReportData('Сводка по организации', "agrotrace-org_{$org->inn}_{$w['from']}_{$w['to']}", self::period($w), $spool);
    }
}
