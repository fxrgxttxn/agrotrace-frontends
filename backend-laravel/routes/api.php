<?php

/*
 * The contract operations (contracts/openapi.yaml), one route each, named by operationId (RouteTableTest, Task 14:
 * 92 operations). ContractGate has already matched the path and method; a declared operation without a route here is
 * 404 (not implemented yet). No implicit model binding (L9): parameters arrive as strings. Every operation route
 * carries `operation:{operationId}` — the contract's guard (x-roles, x-org-admin, the `user` limit).
 */

use App\Http\Controllers\Auth\AuthController;
use App\Http\Controllers\Docs\DocsController;
use App\Http\Controllers\Files\FilesController;
use App\Http\Controllers\Health\HealthController;
use App\Http\Controllers\Me\MeController;
use App\Http\Controllers\Organizations\OrganizationsController;
use App\Http\Controllers\Users\UsersController;
use Illuminate\Support\Facades\Route;

/** @param  array{0: class-string, 1: string}  $action */
$op = function (string $method, string $path, array $action, string $operationId): void {
    Route::match([$method], '/api/v1'.$path, $action)->name($operationId)->middleware("operation:{$operationId}");
};

Route::get('/api/v1/health/live', [HealthController::class, 'live'])->name('getHealthLive');
Route::get('/api/v1/health/ready', [HealthController::class, 'ready'])->name('getHealthReady');

// Auth (Task 2).
$op('POST', '/auth/login', [AuthController::class, 'login'], 'login');
$op('POST', '/auth/refresh', [AuthController::class, 'refreshToken'], 'refreshToken');
$op('POST', '/auth/logout', [AuthController::class, 'logout'], 'logout');
$op('POST', '/auth/2fa/verify', [AuthController::class, 'verifyTwoFactor'], 'verifyTwoFactor');
$op('POST', '/auth/2fa/setup', [AuthController::class, 'setupTwoFactor'], 'setupTwoFactor');
$op('POST', '/auth/password/forgot', [AuthController::class, 'forgotPassword'], 'forgotPassword');
$op('POST', '/auth/password/reset', [AuthController::class, 'resetPassword'], 'resetPassword');
$op('POST', '/auth/register-organization', [AuthController::class, 'registerOrganization'], 'registerOrganization');
$op('POST', '/auth/accept-invite', [AuthController::class, 'acceptInvite'], 'acceptInvite');

// Profile, users, organizations, files (Task 3).
$op('GET', '/me', [MeController::class, 'getMe'], 'getMe');
$op('PATCH', '/me', [MeController::class, 'updateMe'], 'updateMe');
$op('PUT', '/me/avatar', [MeController::class, 'uploadMyAvatar'], 'uploadMyAvatar');
$op('DELETE', '/me/avatar', [MeController::class, 'deleteMyAvatar'], 'deleteMyAvatar');
$op('GET', '/me/channels', [MeController::class, 'getMyChannels'], 'getMyChannels');
$op('PUT', '/me/channels', [MeController::class, 'updateMyChannels'], 'updateMyChannels');
$op('POST', '/me/telegram-code', [MeController::class, 'createTelegramCode'], 'createTelegramCode');
$op('GET', '/users', [UsersController::class, 'listUsers'], 'listUsers');
$op('POST', '/users', [UsersController::class, 'inviteUser'], 'inviteUser');
$op('PATCH', '/users/{id}', [UsersController::class, 'updateUser'], 'updateUser');
$op('GET', '/users/{id}/avatar', [UsersController::class, 'getUserAvatar'], 'getUserAvatar');
$op('GET', '/organizations', [OrganizationsController::class, 'listOrganizations'], 'listOrganizations');
$op('GET', '/organizations/{id}', [OrganizationsController::class, 'getOrganization'], 'getOrganization');
$op('PUT', '/organizations/{id}/logo', [OrganizationsController::class, 'uploadOrganizationLogo'], 'uploadOrganizationLogo');
$op('GET', '/organizations/{id}/logo', [OrganizationsController::class, 'getOrganizationLogo'], 'getOrganizationLogo');
$op('GET', '/files/{id}', [FilesController::class, 'downloadFile'], 'downloadFile');
$op('GET', '/public/files/{id}', [FilesController::class, 'downloadPublicFile'], 'downloadPublicFile');

// Swagger UI (spec 8.3) — outside the contract, as in Express.
Route::get('/api/v1/docs', [DocsController::class, 'page']);
Route::get('/api/v1/docs/init.js', [DocsController::class, 'init']);
Route::get('/api/v1/docs/openapi.json', [DocsController::class, 'openapi']);
Route::get('/api/v1/docs/{asset}', [DocsController::class, 'asset'])->where('asset', '[^/]+');
