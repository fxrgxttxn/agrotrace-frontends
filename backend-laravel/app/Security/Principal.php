<?php

namespace App\Security;

/**
 * The authenticated caller (JWT claims P12: sub, org, roles, org_admin). Built by the auth middleware (Plan 5
 * Task 2) and kept in App\Support\RequestContext for the request only.
 */
final class Principal
{
    /** @param  list<string>  $roles */
    public function __construct(
        public readonly string $userId,
        public readonly string $orgId,
        public readonly array $roles,
        public readonly bool $orgAdmin,
    ) {}

    public function hasRole(string $role): bool
    {
        return in_array($role, $this->roles, true);
    }
}
