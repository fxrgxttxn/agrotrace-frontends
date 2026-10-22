<?php

/*
 * JsonBody (L8, review I4/I5): the 12 MiB limit is the JSON limit (Express express.json) — other bodies (multipart
 * uploads, Tasks 3–5) keep their operation's own limits; over it, 413 FILE_TOO_LARGE `maxBytes` with Connection: close.
 */

use Tests\TestCase;

uses(TestCase::class);

it('refuses a declared JSON body over 12 MiB with 413 and Connection: close', function () {
    $res = $this->raw('POST', '/api/v1/auth/login', ['Content-Type' => 'application/json', 'Content-Length' => '13000000']);
    $res->assertStatus(413);
    expect($res->json())->toMatchArray(['code' => 'FILE_TOO_LARGE', 'params' => ['maxBytes' => 12582912]]);
    expect($res->headers->get('Connection'))->toBe('close');
});

it('leaves non-JSON bodies to their operation (multipart, octet-stream: no JSON limit)', function (string $type) {
    $res = $this->raw('POST', '/api/v1/batches', ['Content-Type' => $type, 'Content-Length' => '13000000']);
    $res->assertStatus(404); // the operation has no route yet; above all, not the JSON 413
})->with(['multipart/form-data; boundary=x', 'application/octet-stream', 'text/plain']);

it('refuses malformed JSON with _root invalid and accepts +json types', function () {
    $res = $this->raw('POST', '/api/v1/auth/login', ['Content-Type' => 'application/problem+json'], '{"a":');
    $res->assertStatus(400);
    expect($res->json('errors'))->toBe(['_root' => ['validation.invalid']]);
});
