<?php

namespace App\Http;

use App\Http\Middleware\JsonBody;
use App\Support\Json;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use stdClass;

/** JSON responses as Express's `res.json` sends them, and the request body as `express.json` leaves it. */
final class Responses
{
    /**
     * A response whose headers are exactly the ones given (ExactHeaders: Cache-Control byte for byte).
     *
     * @param  array<string, string>  $headers
     */
    public static function make(string $body, int $status, array $headers = []): Response
    {
        $res = new Response($body, $status);
        $res->headers = new ExactHeaders($headers);

        return $res;
    }

    /** @param  array<string, string>  $headers */
    public static function json(mixed $data, int $status = 200, array $headers = []): Response
    {
        return self::make(Json::encode($data), $status, ['Content-Type' => 'application/json; charset=utf-8', ...$headers]);
    }

    public static function noContent(): Response
    {
        return self::make('', 204);
    }

    /** The decoded JSON body (JsonBody); `{}` when the request had none or another type (body-parser's default). */
    public static function body(Request $request): mixed
    {
        return $request->attributes->has(JsonBody::ATTR_JSON) ? $request->attributes->get(JsonBody::ATTR_JSON) : new stdClass;
    }
}
