<?php

/*
 * Download headers (R34, R28, R88 M2): the contract's Content-Disposition example and rules, If-None-Match (weak,
 * lists, `*`), and the signed-URL recipe with the contract's worked example.
 */

use App\Infrastructure\Files\Files;
use App\Security\FileUrls;
use Tests\TestCase;

uses(TestCase::class);

it('Content-Disposition reproduces the contract example and its rules', function () {
    expect(Files::contentDisposition('петров.jpg', 'webp'))
        ->toBe("inline; filename=\"______.webp\"; filename*=UTF-8''%D0%BF%D0%B5%D1%82%D1%80%D0%BE%D0%B2.webp");
    expect(Files::contentDisposition('a "b"\c (1).png', 'webp'))
        ->toBe("inline; filename=\"a _b__c (1).webp\"; filename*=UTF-8''a%20%22b%22%5Cc%20%281%29.webp");
    expect(Files::contentDisposition('archive.tar.gz', 'pdf'))->toBe("inline; filename=\"archive.tar.pdf\"; filename*=UTF-8''archive.tar.pdf");
    expect(Files::contentDisposition('.hidden', 'svg'))->toBe("inline; filename=\".hidden.svg\"; filename*=UTF-8''.hidden.svg");
    expect(Files::contentDisposition('noext', 'png'))->toBe("inline; filename=\"noext.png\"; filename*=UTF-8''noext.png");
});

it('If-None-Match compares weakly, accepts lists and *', function (string $header, bool $expected) {
    expect(Files::ifNoneMatch($header, '"ab"'))->toBe($expected);
})->with([
    ['"ab"', true], ['W/"ab"', true], ['"x", "ab"', true], ['*', true], ['"abc"', false], ['', false],
]);

it('signs file URLs by the contract recipe (the worked example of downloadFile)', function () {
    $secret = 'dev_only_change_me_32_bytes_minimum_xx';
    expect(bin2hex(FileUrls::key($secret)))->toBe('ecedca06a78414e48b66ba0a401a61401c7f8af078b2fc35c8dfe5017e7a4a70');
    expect(FileUrls::signature('3c9d7e1f-2a4b-4c6d-8e0f-1a2b3c4d5e6f', 1790247600, $secret))
        ->toBe('9de1ced479cc0f1c78c9d8deff00f42955b37d6a7cb19f9635a07a6300c29ee0');
});

it('issues URLs with exp = now + 3600 and verifies exp/sig strictly (P17)', function () {
    config(['agrotrace.jwt_secret' => 'dev_only_change_me_32_bytes_minimum_xx']);
    $id = '3C9D7E1F-2A4B-4C6D-8E0F-1A2B3C4D5E6F';
    $url = FileUrls::signed($id, null, 1790244000);
    expect($url)->toBe('/api/v1/files/3c9d7e1f-2a4b-4c6d-8e0f-1a2b3c4d5e6f?exp=1790247600&sig=9de1ced479cc0f1c78c9d8deff00f42955b37d6a7cb19f9635a07a6300c29ee0');
    $sig = '9de1ced479cc0f1c78c9d8deff00f42955b37d6a7cb19f9635a07a6300c29ee0';
    expect(FileUrls::verify($id, '1790247600', $sig, 1790244000))->toBeTrue();
    expect(FileUrls::verify($id, '1790247600', $sig, 1790247601))->toBeFalse(); // expired
    expect(FileUrls::verify($id, '01790247600', $sig, 1790244000))->toBeFalse(); // a leading zero
    expect(FileUrls::verify($id, '1790247600', strtoupper($sig), 1790244000))->toBeFalse();
    expect(FileUrls::verify($id, '1790247600', null, 1790244000))->toBeFalse();
    expect(FileUrls::verify($id, 'soon', $sig, 1790244000))->toBeFalse();
    expect(FileUrls::verify('00000000-0000-4000-8000-000000000000', '1790247600', $sig, 1790244000))->toBeFalse();
    expect(FileUrls::forKind('LOGO', $id))->toBe('/api/v1/public/files/3c9d7e1f-2a4b-4c6d-8e0f-1a2b3c4d5e6f');
});
