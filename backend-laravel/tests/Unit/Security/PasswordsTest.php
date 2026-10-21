<?php

/*
 * Passwords (spec 8.8, R31, L12): Argon2id PHC m=65536,t=3,p=1 with a 16-byte salt and a 32-byte hash — the strings
 * of Express and the seed; a vector made once by Express's `argon2` verifies here; a non-PHC value (an invited user's
 * '!') is simply false.
 */

use App\Security\Passwords;

/** Produced once with node `argon2.hash('Ozimaya-2026! вектор', {argon2id, 65536, 3, 1})` (the Express parameters). */
const EXPRESS_PHC = '$argon2id$v=19$m=65536,t=3,p=1$lvWNbK9UWKH2OGn8pHZGsw$jldRxjc8m/Q6utY0SmJHop03IMMtzk68iwX5rliKfDw';

it('hashes as Argon2id PHC with m=65536,t=3,p=1, a 16-byte salt and a 32-byte hash', function () {
    $phc = Passwords::hash('Ozimaya-2026!');
    expect($phc)->toStartWith('$argon2id$v=19$m=65536,t=3,p=1$');
    [, , , , $salt, $hash] = explode('$', $phc);
    expect(strlen(base64_decode($salt)))->toBe(16);
    expect(strlen(base64_decode($hash)))->toBe(32);
    expect(Passwords::verify('Ozimaya-2026!', $phc))->toBeTrue();
    expect(Passwords::verify('Ozimaya-2026! ', $phc))->toBeFalse(); // byte-exact, never trimmed
});

it('verifies the Express vector', function () {
    expect(Passwords::verify('Ozimaya-2026! вектор', EXPRESS_PHC))->toBeTrue();
    expect(Passwords::verify('Ozimaya-2026! вектоp', EXPRESS_PHC))->toBeFalse();
});

it('answers false for a stored value that is no Argon2id PHC string, without an exception', function () {
    expect(Passwords::verify('x', '!'))->toBeFalse();
    expect(Passwords::verify('x', ''))->toBeFalse();
    expect(Passwords::verify('x', '$2y$10$abcdefghijklmnopqrstuuJ8l4E0Qe5n0nQ1nJ8u6Jw1o5o5o5o5o'))->toBeFalse();
    Passwords::dummyVerify('whatever'); // costs one verification, never throws
});
