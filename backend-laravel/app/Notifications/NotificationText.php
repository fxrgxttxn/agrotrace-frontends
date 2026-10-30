<?php

namespace App\Notifications;

use App\Infrastructure\I18n\Messages;
use App\Support\JsNumber;
use stdClass;

/**
 * One part of a notification's text (R87; packages/i18n/src/notification.ts `notificationMessage` line by line): the
 * letters and Telegram messages of the delivery half, in Russian (users have no locale).
 *
 * Key: `notification.<TYPE>.<event>.<part>` when the payload carries a string `event` (RECALL: OPENED/CLOSED,
 * RECALL_TASK: CREATED/REASSIGNED), else `notification.<TYPE>.<part>`. Params, in payload order: the enum codes of
 * `reason`, `conclusion`, `trigger` as their labels (the code itself when the label is missing); `*At` strings that
 * start like an ISO instant as `formatDateTime` (`dd.mm.yyyy hh:mm` of the string as written — UTC on the wire);
 * other strings and numbers as they are (numbers as JavaScript `String(x)`); anything else (null, booleans, objects)
 * is no param. `makeT`'s plural branch needs a numeric `count`, which no notification payload has
 * (contracts/rules/notifications.json), so it is not ported.
 */
final class NotificationText
{
    public const PARTS = ['title', 'body', 'email.subject', 'email.body', 'telegram'];

    /** @var array<string, string> payload key → label namespace (NOTIFICATION_PARAM_LABELS) */
    public const PARAM_LABELS = [
        'reason' => 'labTestReason',
        'conclusion' => 'labConclusion',
        'trigger' => 'recallTrigger',
    ];

    private const ISO_DATETIME = '/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/';

    /** @param  stdClass|array<string, mixed>  $payload */
    public static function message(string $type, stdClass|array $payload, string $part): string
    {
        $payload = (array) $payload;
        $event = is_string($payload['event'] ?? null) ? $payload['event'] : null;
        $key = $event !== null ? "notification.{$type}.{$event}.{$part}" : "notification.{$type}.{$part}";
        $params = [];
        foreach ($payload as $name => $value) {
            $name = (string) $name;
            if (is_string($value) && isset(self::PARAM_LABELS[$name])) {
                $labelKey = self::PARAM_LABELS[$name].'.'.$value;
                $label = Messages::t($labelKey);
                $params[$name] = $label === $labelKey ? $value : $label;
            } elseif (is_string($value) && str_ends_with($name, 'At') && preg_match(self::ISO_DATETIME, $value) === 1) {
                $params[$name] = self::dateTime($value);
            } elseif (is_string($value)) {
                $params[$name] = $value;
            } elseif (is_int($value) || is_float($value)) {
                $params[$name] = JsNumber::text($value);
            }
        }

        return Messages::t($key, $params);
    }

    /** formatDateTime(iso, 'ru'): `dd.mm.yyyy hh:mm` sliced from the string (packages/i18n/src/format.ts). */
    public static function dateTime(string $iso): string
    {
        return substr($iso, 8, 2).'.'.substr($iso, 5, 2).'.'.substr($iso, 0, 4).' '.substr($iso, 11, 5);
    }
}
