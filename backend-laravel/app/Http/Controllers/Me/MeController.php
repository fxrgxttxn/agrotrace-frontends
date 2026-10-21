<?php

namespace App\Http\Controllers\Me;

use App\Actions\Me\MeActions;
use App\Http\Multipart\MultipartReader;
use App\Http\Responses;
use App\Security\Auth;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/** /me/* (contracts/openapi/paths/me.yaml): HTTP mapping of MeActions. */
final class MeController
{
    public function getMe(): Response
    {
        return Responses::json(MeActions::me(Auth::principal()->userId));
    }

    public function updateMe(Request $request): Response
    {
        return Responses::json(MeActions::updateMe(Auth::principal(), Responses::body($request)));
    }

    public function uploadMyAvatar(Request $request): Response
    {
        $upload = MultipartReader::read($request, MeActions::AVATAR_MAX_BYTES);

        return Responses::json(MeActions::uploadAvatar(Auth::principal(), $upload));
    }

    public function deleteMyAvatar(): Response
    {
        MeActions::deleteAvatar(Auth::principal());

        return Responses::noContent();
    }

    public function getMyChannels(): Response
    {
        return Responses::json(MeActions::channels(Auth::principal()->userId));
    }

    public function updateMyChannels(Request $request): Response
    {
        return Responses::json(MeActions::updateChannels(Auth::principal(), Responses::body($request)));
    }

    public function createTelegramCode(): Response
    {
        return Responses::json(MeActions::createTelegramCode(Auth::principal()), 201);
    }
}
