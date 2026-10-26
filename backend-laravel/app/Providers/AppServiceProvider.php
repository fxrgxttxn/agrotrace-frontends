<?php

namespace App\Providers;

use App\Contract\Contract;
use App\Http\Idempotency\IdemStore;
use App\Http\Idempotency\RedisIdemStore;
use App\Http\Routing\ContractRouteCollection;
use App\Infrastructure\Db\DbSlots;
use App\Infrastructure\Db\PgConnector;
use App\Infrastructure\Db\TxState;
use App\Infrastructure\Mercury\Mercury;
use App\Infrastructure\Outbox\Relay;
use App\Infrastructure\Storage\ObjectStore;
use App\Scheduler\Jobs\OutboxSweep;
use App\Support\RequestContext;
use App\Support\StopSignal;
use Illuminate\Routing\Router;
use Illuminate\Support\ServiceProvider;

final class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        // Per request (Octane: a fresh instance per request sandbox; Review Focus 4).
        $this->app->scoped(RequestContext::class);
        $this->app->scoped(TxState::class);

        // Per worker (warmed in config/octane.php).
        $this->app->singleton(Contract::class, fn () => Contract::fromFile(
            Contract::defaultPath(config('agrotrace.contract_path')),
        ));
        $this->app->singleton(DbSlots::class, fn () => new DbSlots(
            (int) config('agrotrace.db.slots', 11),
            (string) config('agrotrace.db.slots_dir'),
            (bool) config('agrotrace.db.slots_enabled'),
        ));
        $this->app->singleton(ObjectStore::class);
        $this->app->singleton(StopSignal::class);
        $this->app->singleton(IdemStore::class, RedisIdemStore::class);
        $this->app->bind(Mercury::class, fn () => Mercury::fromConfig());
        $this->app->bind(Relay::class, fn () => Relay::fromConfig('agrotrace-laravel-'.config('agrotrace.process')));
        // The sweeper keeps its confirm channel across ticks (one broker connection per job process).
        $this->app->singleton(OutboxSweep::class, fn ($app) => new OutboxSweep($app->make(Relay::class)));
        $this->app->bind('db.connector.pgsql', fn ($app) => new PgConnector($app->make(DbSlots::class)));

        // Dispatch by the operation ContractGate matched on the raw path (review I1).
        $this->app->extend('router', function (Router $router) {
            $router->setRoutes(new ContractRouteCollection);

            return $router;
        });
    }
}
