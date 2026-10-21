<?php

namespace App\Http\Controllers\Files;

use App\Actions\Files\FileAccess;
use App\Http\Problem\Problem;
use App\Http\Problem\ProblemCode;
use App\Http\Query\Params;
use App\Http\Query\QueryReader;
use App\Infrastructure\Files\Files;
use App\Infrastructure\RateLimit\RateLimiter;
use App\Security\Auth;
use App\Security\FileUrls;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * downloadFile (`GET /files/{id}`, x-access: signed) and downloadPublicFile (`GET /public/files/{id}`) — Express
 * modules/files/routes.ts. downloadFile, in this order:
 * 1. a valid Bearer token counts against the `user` limit — also when a signature is present;
 * 2. `exp` or `sig` present → only the signature decides (both present, `exp` `^[1-9]\d{0,11}$` not in the past,
 *    `sig` the contract's HMAC in constant time) — else 403; rights are not checked, Authorization is ignored;
 * 3. no signature → a valid Bearer token or 401;
 * 4. 400 for `id` / `variant`; 5. a missing, deleted or (Bearer) unreadable file → 404.
 */
final class FilesController
{
    public function downloadFile(Request $request): Response
    {
        $principal = Auth::bearer($request);
        if ($principal !== null) {
            RateLimiter::hit('user', $principal->userId);
        }
        $q = QueryReader::of($request);
        $signed = $q->has('exp') || $q->has('sig');
        if ($signed) {
            $exp = $q->has('exp') ? $q->string('exp') : null;
            $sig = $q->has('sig') ? $q->string('sig') : null;
            if (! FileUrls::verify((string) $request->route('id'), $exp, $sig)) {
                throw new Problem(403, ProblemCode::FORBIDDEN);
            }
        } elseif ($principal === null) {
            throw new Problem(401, ProblemCode::UNAUTHORIZED);
        }
        $id = Params::id($request);
        $variant = Params::variant($request);
        $file = Files::live($id);
        if ($file === null || (! $signed && ! FileAccess::canRead($principal, $file))) {
            throw new Problem(404, ProblemCode::NOT_FOUND);
        }

        return Files::send($request, $file, $variant, Files::CACHE_PRIVATE);
    }

    public function downloadPublicFile(Request $request): Response
    {
        $id = Params::id($request);
        $variant = Params::variant($request);
        $file = Files::live($id);
        if ($file === null || ! in_array($file->kind, FileUrls::PUBLIC_KINDS, true)) {
            throw new Problem(404, ProblemCode::NOT_FOUND);
        }

        return Files::send($request, $file, $variant, Files::CACHE_PUBLIC);
    }
}
