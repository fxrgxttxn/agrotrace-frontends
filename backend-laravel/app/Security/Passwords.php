<?php

namespace App\Security;

/**
 * Passwords (spec 8.8, R31, L12): Argon2id PHC strings `$argon2id$v=19$m=65536,t=3,p=1$<salt 16 B>$<hash 32 B>` — the
 * parameters of Express and of the seed (db/seed/src/passwords.ts), so any backend verifies any hash. Compared
 * byte-exact (R36): never trimmed or normalized.
 *
 * `verify` answers false for anything that is not an Argon2id PHC string (an invited user's '!') without calling
 * Hash::check, which throws there when `hashing.argon.verify` is on (L12).
 */
final class Passwords
{
    public const OPTIONS = ['memory_cost' => 65536, 'time_cost' => 3, 'threads' => 1];

    /**
     * R31 step 4: an unknown email still costs one Argon2 verification with the same parameters, so the response time
     * does not reveal whether the account exists — against this hash of a random, discarded password.
     */
    private const DUMMY = '$argon2id$v=19$m=65536,t=3,p=1$WGs0eTFTN0gwTWFjVUhvNQ$0DAEeL4J8W67ovka0ezI6LAC1cdOB3MwjhLwSmbhGtU';

    public static function hash(string $plain): string
    {
        return password_hash($plain, PASSWORD_ARGON2ID, self::OPTIONS);
    }

    public static function verify(string $plain, string $phc): bool
    {
        if (! str_starts_with($phc, '$argon2id$')) {
            return false;
        }

        return password_verify($plain, $phc);
    }

    public static function dummyVerify(string $plain = ''): void
    {
        password_verify($plain, self::DUMMY);
    }
}
