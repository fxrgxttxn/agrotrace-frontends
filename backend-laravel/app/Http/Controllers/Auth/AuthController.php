<?php

namespace App\Http\Controllers\Auth;

use App\Actions\Auth\AuthActions;
use App\Actions\Auth\Sessions;
use App\Http\Problem\Problem;
use App\Http\Problem\ProblemCode;
use App\Http\Problem\Renderer;
use App\Http\RefreshCookie;
use App\Http\Responses;
use App\Security\Auth;
use App\Support\RequestContext;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * /auth/* (contracts/openapi/paths/auth.yaml): HTTP mapping of AuthActions — the `at_refresh` cookie (exactly one
 * Set-Cookie, R32/R40), statuses, `Cache-Control: no-store` on every response that carries a token.
 */
final class AuthController
{
    public function login(Request $request): Response
    {
        $result = AuthActions::login(app(RequestContext::class)->clientIp(), Responses::body($request));
        if ($result['twoFactorRequired']) {
            return Responses::json(['twoFactorRequired' => true, 'challengeId' => $result['challengeId']], 200, ['Cache-Control' => 'no-store']);
        }

        return self::session($result['session']);
    }

    public function verifyTwoFactor(Request $request): Response
    {
        return self::session(AuthActions::verifyTwoFactor(Responses::body($request)));
    }

    public function setupTwoFactor(Request $request): Response
    {
        return Responses::json(AuthActions::setupTwoFactor(Auth::principal(), Responses::body($request)), 200, ['Cache-Control' => 'no-store']);
    }

    public function refreshToken(Request $request): Response
    {
        $outcome = Sessions::rotate(RefreshCookie::fromHeader($request->headers->get('Cookie')));
        switch ($outcome['kind']) {
            case 'rotated':
                $res = Responses::json(['accessToken' => AuthActions::accessTokenFor($outcome['userId']), 'expiresIn' => 900], 200, ['Cache-Control' => 'no-store']);
                $res->headers->setCookie(RefreshCookie::set($outcome['token']));

                return $res;
            case 'expired':
                $res = Renderer::response(new Problem(401, ProblemCode::TOKEN_EXPIRED));
                if ($outcome['clearCookie']) {
                    $res->headers->setCookie(RefreshCookie::clear());
                }

                return $res;
            default:
                $res = Renderer::response(new Problem(403, ProblemCode::FORBIDDEN, params: ['reason' => $outcome['reason']]));
                $res->headers->setCookie(RefreshCookie::clear());

                return $res;
        }
    }

    public function logout(Request $request): Response
    {
        Sessions::revoke(RefreshCookie::fromHeader($request->headers->get('Cookie')));
        $res = Responses::noContent();
        $res->headers->setCookie(RefreshCookie::clear());

        return $res;
    }

    public function forgotPassword(Request $request): Response
    {
        AuthActions::forgotPassword(Responses::body($request));

        return Responses::noContent();
    }

    public function resetPassword(Request $request): Response
    {
        AuthActions::resetPassword(Responses::body($request));

        return Responses::noContent();
    }

    public function registerOrganization(Request $request): Response
    {
        return Responses::json(AuthActions::registerOrganization(Responses::body($request)), 201);
    }

    public function acceptInvite(Request $request): Response
    {
        AuthActions::acceptInvite(Responses::body($request));

        return Responses::noContent();
    }

    /** @param  array<string, mixed>  $s */
    private static function session(array $s): Response
    {
        $res = Responses::json(
            ['twoFactorRequired' => false, 'accessToken' => $s['accessToken'], 'expiresIn' => $s['expiresIn'], 'user' => $s['user']],
            200,
            ['Cache-Control' => 'no-store'],
        );
        $res->headers->setCookie(RefreshCookie::set($s['refreshToken']));

        return $res;
    }
}
