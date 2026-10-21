<?php

namespace App\Http\Controllers\Organizations;

use App\Actions\Organizations\OrganizationsActions;
use App\Http\Multipart\MultipartReader;
use App\Http\Query\Params;
use App\Http\Query\QueryReader;
use App\Http\Responses;
use App\Infrastructure\Files\Files;
use App\Security\Auth;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/** /organizations/* (contracts/openapi/paths/organizations.yaml): HTTP mapping of OrganizationsActions. */
final class OrganizationsController
{
    public function listOrganizations(Request $request): Response
    {
        return Responses::json(OrganizationsActions::directory(QueryReader::of($request)));
    }

    public function getOrganization(Request $request): Response
    {
        return Responses::json(OrganizationsActions::get(Auth::principal(), Params::id($request)));
    }

    /** P14: 400 id → 400/413 multipart → 404 → 403 by side → 415. */
    public function uploadOrganizationLogo(Request $request): Response
    {
        $id = Params::id($request);
        $upload = MultipartReader::read($request, OrganizationsActions::LOGO_MAX_BYTES);

        return Responses::json(OrganizationsActions::uploadLogo(Auth::principal(), $id, $upload, self::clientGone()));
    }

    public function getOrganizationLogo(Request $request): Response
    {
        $id = Params::id($request);
        $variant = Params::variant($request);

        return Files::send($request, OrganizationsActions::logoFile(Auth::principal(), $id), $variant, Files::CACHE_PRIVATE);
    }

    /**
     * P18: whether the client went away — a waiting SVG job is then dropped. FrankenPHP reports an aborted connection
     * only through connection_aborted() (see the Task 1 spike: not reliably while no output has been written).
     *
     * @return callable(): bool
     */
    private static function clientGone(): callable
    {
        return fn (): bool => connection_aborted() === 1;
    }
}
