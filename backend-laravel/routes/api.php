<?php

/*
 * The contract operations (contracts/openapi.yaml), one route each, named by operationId (RouteTableTest, Task 14:
 * 92 operations). ContractGate has already matched the path and method; a declared operation without a route here is
 * 404 (not implemented yet). No implicit model binding (L9): parameters arrive as strings. Every operation route
 * carries `operation:{operationId}` — the contract's guard (x-roles, x-org-admin, the `user` limit).
 */

use App\Contract\Contract;
use App\Http\Controllers\Admin\AdminController;
use App\Http\Controllers\Audit\AuditController;
use App\Http\Controllers\Auth\AuthController;
use App\Http\Controllers\Batches\BatchesController;
use App\Http\Controllers\Dictionaries\DictionariesController;
use App\Http\Controllers\Docs\DocsController;
use App\Http\Controllers\Fields\FieldsController;
use App\Http\Controllers\Files\FilesController;
use App\Http\Controllers\Health\HealthController;
use App\Http\Controllers\Me\MeController;
use App\Http\Controllers\Organizations\OrganizationsController;
use App\Http\Controllers\Processing\ProcessingController;
use App\Http\Controllers\Users\UsersController;
use App\Http\Controllers\Waybills\WaybillsController;
use Illuminate\Support\Facades\Route;

/** @param  array{0: class-string, 1: string}  $action */
$op = function (string $method, string $path, array $action, string $operationId): void {
    $middleware = ["operation:{$operationId}"];
    // `x-idempotent: true` (R48): the Idempotency-Key protocol right after the guard, read from the contract itself.
    if ((app(Contract::class)->operation($operationId)['x-idempotent'] ?? false) === true) {
        $middleware[] = 'idempotency';
    }
    Route::match([$method], '/api/v1'.$path, $action)->name($operationId)->middleware($middleware);
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

// Dictionaries, administration, audit log, public regions (Task 4).
$op('GET', '/dictionaries/{name}', [DictionariesController::class, 'listDictionary'], 'listDictionary');
$op('POST', '/dictionaries/{name}', [DictionariesController::class, 'createDictionaryEntry'], 'createDictionaryEntry');
$op('PUT', '/dictionaries/{name}/{id}', [DictionariesController::class, 'updateDictionaryEntry'], 'updateDictionaryEntry');
$op('DELETE', '/dictionaries/{name}/{id}', [DictionariesController::class, 'deleteDictionaryEntry'], 'deleteDictionaryEntry');
$op('POST', '/dictionaries/{name}/import', [DictionariesController::class, 'importDictionary'], 'importDictionary');
$op('PUT', '/dictionaries/products/{id}/image', [DictionariesController::class, 'uploadProductImage'], 'uploadProductImage');
$op('GET', '/public/regions', [DictionariesController::class, 'listPublicRegions'], 'listPublicRegions');
$op('GET', '/admin/organizations', [AdminController::class, 'listAdminOrganizations'], 'listAdminOrganizations');
$op('PATCH', '/admin/organizations/{id}', [AdminController::class, 'updateAdminOrganization'], 'updateAdminOrganization');
$op('POST', '/admin/organizations/{id}/approve', [AdminController::class, 'approveOrganization'], 'approveOrganization');
$op('GET', '/audit-log', [AuditController::class, 'listAuditLog'], 'listAuditLog');

// Fields and treatments (Task 5).
$op('GET', '/fields', [FieldsController::class, 'listFields'], 'listFields');
$op('POST', '/fields', [FieldsController::class, 'createField'], 'createField');
$op('GET', '/fields/{id}', [FieldsController::class, 'getField'], 'getField');
$op('PUT', '/fields/{id}', [FieldsController::class, 'updateField'], 'updateField');
$op('DELETE', '/fields/{id}', [FieldsController::class, 'deleteField'], 'deleteField');
$op('GET', '/fields/{id}/treatments', [FieldsController::class, 'listFieldTreatments'], 'listFieldTreatments');
$op('POST', '/fields/{id}/treatments', [FieldsController::class, 'createTreatment'], 'createTreatment');
$op('PUT', '/treatments/{id}', [FieldsController::class, 'updateTreatment'], 'updateTreatment');

// Batches, graph, QR, documents (Task 6).
$op('GET', '/batches', [BatchesController::class, 'listBatches'], 'listBatches');
$op('POST', '/batches', [BatchesController::class, 'createBatch'], 'createBatch');
$op('GET', '/batches/{id}', [BatchesController::class, 'getBatch'], 'getBatch');
$op('GET', '/batches/{id}/graph', [BatchesController::class, 'getBatchGraph'], 'getBatchGraph');
$op('GET', '/batches/{id}/history', [BatchesController::class, 'getBatchHistory'], 'getBatchHistory');
$op('GET', '/batches/{id}/path', [BatchesController::class, 'getBatchPath'], 'getBatchPath');
$op('POST', '/batches/{id}/qr', [BatchesController::class, 'createBatchQr'], 'createBatchQr');
$op('GET', '/batches/{id}/qr', [BatchesController::class, 'downloadBatchQr'], 'downloadBatchQr');
$op('GET', '/batches/{id}/documents', [BatchesController::class, 'getBatchDocuments'], 'getBatchDocuments');
$op('POST', '/batches/{id}/documents/vsd/retry', [BatchesController::class, 'retryBatchVsdImport'], 'retryBatchVsdImport');
$op('POST', '/batches/{id}/on-sale', [BatchesController::class, 'putBatchOnSale'], 'putBatchOnSale');
$op('POST', '/batches/{id}/sold', [BatchesController::class, 'markBatchSold'], 'markBatchSold');

// Waybills (Task 7).
$op('GET', '/waybills', [WaybillsController::class, 'listWaybills'], 'listWaybills');
$op('POST', '/waybills', [WaybillsController::class, 'createWaybill'], 'createWaybill');
$op('GET', '/waybills/{id}', [WaybillsController::class, 'getWaybill'], 'getWaybill');
$op('DELETE', '/waybills/{id}', [WaybillsController::class, 'deleteWaybill'], 'deleteWaybill');
$op('POST', '/waybills/{id}/send', [WaybillsController::class, 'sendWaybill'], 'sendWaybill');
$op('POST', '/waybills/{id}/accept', [WaybillsController::class, 'acceptWaybill'], 'acceptWaybill');
$op('POST', '/waybills/{id}/reject', [WaybillsController::class, 'rejectWaybill'], 'rejectWaybill');

// Processing (Task 8).
$op('POST', '/processing', [ProcessingController::class, 'processBatches'], 'processBatches');

// Swagger UI (spec 8.3) — outside the contract, as in Express.
Route::get('/api/v1/docs', [DocsController::class, 'page']);
Route::get('/api/v1/docs/init.js', [DocsController::class, 'init']);
Route::get('/api/v1/docs/openapi.json', [DocsController::class, 'openapi']);
Route::get('/api/v1/docs/{asset}', [DocsController::class, 'asset'])->where('asset', '[^/]+');
