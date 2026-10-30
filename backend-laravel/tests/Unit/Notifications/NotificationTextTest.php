<?php

/*
 * The letters and Telegram texts of the delivery half (NotificationText = packages/i18n notificationMessage):
 * tests/Fixtures/notifications/texts.json holds the literals the TypeScript package renders (createT('ru') under tsx in
 * the tools image, written for the Django port's equivalent test) for every type of contracts/rules/notifications.json
 * — both events of RECALL / RECALL_TASK, unlabelled enum codes, instants with and without milliseconds — and all five
 * parts.
 */

use App\Contract\RulesRepo;
use App\Notifications\NotificationText;
use Tests\TestCase;

uses(TestCase::class);

/** @return list<array{type: string, payload: array<string, mixed>, parts: array<string, string>}> */
function notificationTextCases(): array
{
    return json_decode((string) file_get_contents(dirname(__DIR__, 2).'/Fixtures/notifications/texts.json'), true, 64, JSON_THROW_ON_ERROR);
}

it('covers every type of the rules file with exactly its payload keys', function () {
    $rules = RulesRepo::json('notifications');
    $types = array_unique(array_map(fn (array $c) => $c['type'], notificationTextCases()));
    sort($types);
    $expected = array_keys($rules['types']);
    sort($expected);
    expect($types)->toBe($expected);
    foreach (notificationTextCases() as $c) {
        $keys = array_keys($c['payload']);
        sort($keys);
        $want = $rules['types'][$c['type']]['payload'];
        sort($want);
        expect($keys)->toBe($want);
    }
});

it('renders every part as the TypeScript package does', function () {
    $n = 0;
    foreach (notificationTextCases() as $i => $c) {
        foreach (NotificationText::PARTS as $part) {
            $payload = json_decode((string) json_encode($c['payload']), false, 64, JSON_THROW_ON_ERROR);
            expect(NotificationText::message($c['type'], $payload, $part))->toBe($c['parts'][$part], "case {$i} {$c['type']} {$part}");
            $n++;
        }
    }
    expect($n)->toBeGreaterThan(50);
});

it('renders numbers as String(x), skips null and booleans, keeps a non-instant *At as it is', function () {
    $p = (object) ['waybillId' => 'w', 'number' => 'WB-1', 'senderOrgId' => 'o', 'senderName' => 'Ферма', 'itemsCount' => 3];
    expect(NotificationText::message('WAYBILL_INCOMING', $p, 'telegram'))->toBe('Накладная WB-1 от Ферма, позиций: 3');
    $p->itemsCount = 1.5;
    expect(NotificationText::message('WAYBILL_INCOMING', $p, 'telegram'))->toBe('Накладная WB-1 от Ферма, позиций: 1.5');
    $p->itemsCount = null;
    expect(NotificationText::message('WAYBILL_INCOMING', $p, 'telegram'))->toBe('Накладная WB-1 от Ферма, позиций: {itemsCount}');
    expect(NotificationText::dateTime('2026-01-02T03:04:05Z'))->toBe('02.01.2026 03:04');
});
