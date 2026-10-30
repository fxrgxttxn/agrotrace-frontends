<?php

namespace App\Security;

/**
 * The authenticated caller, from the verified JWT claims only (P12: sub, org, roles, org_admin, exp) — no database
 * read. Built by App\Http\Middleware\Operation and kept in App\Support\RequestContext for the request only.
 */
final class Principal
{
    public const ROLES = ['FARMER', 'PROCESSOR', 'LAB', 'RETAILER', 'INSPECTOR', 'ADMIN'];

    /** @param  list<string>  $roles */
    public function __construct(
        public readonly string $userId,
        public readonly string $orgId,
        public readonly array $roles,
        public readonly bool $orgAdmin,
        public readonly int $exp = 0,
    ) {}

    public function hasRole(string $role): bool
    {
        return in_array($role, $this->roles, true);
    }

    public function isAdmin(): bool
    {
        return $this->hasRole('ADMIN');
    }

    /** INSPECTOR and ADMIN see every organization and batch (п. 4.2). */
    public function seesAll(): bool
    {
        return $this->hasRole('INSPECTOR') || $this->hasRole('ADMIN');
    }

    /** FARMER, PROCESSOR or RETAILER — an organization that originates, holds, sends and receives batches. */
    public function isParticipant(): bool
    {
        return $this->hasRole('FARMER') || $this->hasRole('PROCESSOR') || $this->hasRole('RETAILER');
    }
}
