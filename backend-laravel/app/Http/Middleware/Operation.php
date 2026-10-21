<?php

namespace App\Http\Middleware;

use App\Contract\Contract;
use App\Http\Problem\Problem;
use App\Http\Problem\ProblemCode;
use App\Infrastructure\RateLimit\RateLimiter;
use App\Security\Auth;
use App\Support\RequestContext;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * `operation:{operationId}` on every contract route: the guard of a Bearer-secured operation, read from the contract
 * itself (`x-roles`, `x-org-admin`), so routes cannot drift from it. Order (contract info.description): 401 → the
 * `user` rate limit (R30: every Bearer-authenticated request counts) → 403 FORBIDDEN without params (`ANY` = any
 * authenticated role; `x-org-admin`: roles other than ADMIN must be the head of their organization). The principal
 * (verified claims only) is put in RequestContext — Auth::principal(). PUBLIC operations and the signed downloadFile
 * (`x-access: signed`, its own order) pass through.
 */
final class Operation
{
    public function __construct(private readonly Contract $contract) {}

    public function handle(Request $request, Closure $next, string $operationId): Response
    {
        $op = $this->contract->operation($operationId);
        $roles = $op['x-roles'] ?? [];
        if (in_array('PUBLIC', $roles, true) || ($op['x-access'] ?? null) === 'signed') {
            return $next($request);
        }
        $principal = Auth::bearer($request) ?? throw new Problem(401, ProblemCode::UNAUTHORIZED);
        RateLimiter::hit('user', $principal->userId);
        $roleOk = in_array('ANY', $roles, true) || array_intersect($principal->roles, $roles) !== [];
        $adminOk = ($op['x-org-admin'] ?? false) !== true || $principal->isAdmin() || $principal->orgAdmin;
        if (! $roleOk || ! $adminOk) {
            throw new Problem(403, ProblemCode::FORBIDDEN);
        }
        app(RequestContext::class)->setPrincipal($principal);

        return $next($request);
    }
}
