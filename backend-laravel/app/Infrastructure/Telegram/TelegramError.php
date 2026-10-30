<?php

namespace App\Infrastructure\Telegram;

use RuntimeException;

/** A failed Bot API call: transport error, non-2xx status or `ok: false`. */
final class TelegramError extends RuntimeException {}
