<?php

/*
 * The contract operations (contracts/openapi.yaml), one route each, named by operationId (RouteTableTest, Task 14:
 * 92 operations). ContractGate has already matched the path and method; a declared operation without a route here is
 * 404 (not implemented yet). No implicit model binding (L9): parameters arrive as strings.
 */

use App\Http\Controllers\Docs\DocsController;
use App\Http\Controllers\Health\HealthController;
use Illuminate\Support\Facades\Route;

Route::get('/api/v1/health/live', [HealthController::class, 'live'])->name('getHealthLive');
Route::get('/api/v1/health/ready', [HealthController::class, 'ready'])->name('getHealthReady');

// Swagger UI (spec 8.3) — outside the contract, as in Express.
Route::get('/api/v1/docs', [DocsController::class, 'page']);
Route::get('/api/v1/docs/init.js', [DocsController::class, 'init']);
Route::get('/api/v1/docs/openapi.json', [DocsController::class, 'openapi']);
Route::get('/api/v1/docs/{asset}', [DocsController::class, 'asset'])->where('asset', '[^/]+');
