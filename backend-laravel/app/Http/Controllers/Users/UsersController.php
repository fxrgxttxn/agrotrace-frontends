<?php

namespace App\Http\Controllers\Users;

use App\Actions\Users\UsersActions;
use App\Http\Problem\Problem;
use App\Http\Problem\ProblemCode;
use App\Http\Query\Params;
use App\Http\Query\QueryReader;
use App\Http\Responses;
use App\Infrastructure\Files\Files;
use App\Security\Auth;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Symfony\Component\HttpFoundation\Response;

/** /users/* (contracts/openapi/paths/users.yaml): HTTP mapping of UsersActions and getUserAvatar. */
final class UsersController
{
    public function listUsers(Request $request): Response
    {
        return Responses::json(UsersActions::list(Auth::principal(), QueryReader::of($request)));
    }

    public function inviteUser(Request $request): Response
    {
        return Responses::json(UsersActions::invite(Auth::principal(), Responses::body($request)), 201);
    }

    public function updateUser(Request $request): Response
    {
        $id = Params::id($request);

        return Responses::json(UsersActions::update(Auth::principal(), $id, Responses::body($request)));
    }

    /** getUserAvatar — any authenticated user (п. 4.2); no user, no avatar → 404. */
    public function getUserAvatar(Request $request): Response
    {
        $id = Params::id($request);
        $variant = Params::variant($request);
        $file = DB::selectOne('SELECT f.id, f.object_key, f.original_name, f.mime, f.size_bytes, f.sha256, f.variants::text AS variants, f.kind, f.owner_id
              FROM users u JOIN files f ON f.id = u.avatar_file_id
             WHERE u.id = ? AND u.deleted_at IS NULL AND f.deleted_at IS NULL', [$id]);
        if ($file === null) {
            throw new Problem(404, ProblemCode::NOT_FOUND);
        }

        return Files::send($request, $file, $variant, Files::CACHE_PRIVATE);
    }
}
