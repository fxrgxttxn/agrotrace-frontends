<?php

namespace App\Http\Controllers\Notifications;

use App\Actions\Notifications\NotificationsActions;
use App\Http\Query\QueryReader;
use App\Http\Responses;
use App\Security\Auth;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * /notifications, /notifications/read (contracts/openapi/paths/notifications.yaml; Express notifications/routes.ts),
 * x-roles ANY. Order: `operation` (401, the `user` limit) → query or body (400) → the action.
 */
final class NotificationsController
{
    public function listNotifications(Request $request): Response
    {
        return Responses::json(NotificationsActions::list(Auth::principal(), QueryReader::of($request)));
    }

    public function markNotificationsRead(Request $request): Response
    {
        return Responses::json(NotificationsActions::markRead(Auth::principal(), Responses::body($request)));
    }
}
