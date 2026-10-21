<?php

/*
 * Octane on FrankenPHP (L3, L4). The server is started by docker/Caddyfile (`frankenphp run`), not by
 * `artisan octane:frankenphp`: that command drops the workers' stdout (our JSON log lines) and reformats stderr.
 * Per request App\Octane\EndOfRequest runs the after-response callbacks, disconnects from PostgreSQL and frees the
 * DbSlots slot (L4 order); RequestContext is a scoped binding, so the next request never sees it.
 */
use App\Contract\Contract;
use App\Infrastructure\Db\DbSlots;
use App\Octane\EndOfRequest;
use Laravel\Octane\Contracts\OperationTerminated;
use Laravel\Octane\Events\RequestHandled;
use Laravel\Octane\Events\RequestReceived;
use Laravel\Octane\Events\RequestTerminated;
use Laravel\Octane\Events\TaskReceived;
use Laravel\Octane\Events\TaskTerminated;
use Laravel\Octane\Events\TickReceived;
use Laravel\Octane\Events\TickTerminated;
use Laravel\Octane\Events\WorkerErrorOccurred;
use Laravel\Octane\Events\WorkerStarting;
use Laravel\Octane\Events\WorkerStopping;
use Laravel\Octane\Listeners\CloseMonologHandlers;
use Laravel\Octane\Listeners\EnsureUploadedFilesAreValid;
use Laravel\Octane\Listeners\EnsureUploadedFilesCanBeMoved;
use Laravel\Octane\Listeners\FlushOnce;
use Laravel\Octane\Listeners\FlushTemporaryContainerInstances;
use Laravel\Octane\Listeners\ReportException;
use Laravel\Octane\Listeners\StopWorkerIfNecessary;
use Laravel\Octane\Octane;

return [
    'server' => 'frankenphp',
    'https' => false,
    'listeners' => [
        WorkerStarting::class => [
            EnsureUploadedFilesAreValid::class,
            EnsureUploadedFilesCanBeMoved::class,
        ],
        RequestReceived::class => [
            ...Octane::prepareApplicationForNextOperation(),
            ...Octane::prepareApplicationForNextRequest(),
        ],
        RequestHandled::class => [],
        RequestTerminated::class => [
            EndOfRequest::class,
        ],
        TaskReceived::class => [
            ...Octane::prepareApplicationForNextOperation(),
        ],
        TaskTerminated::class => [],
        TickReceived::class => [
            ...Octane::prepareApplicationForNextOperation(),
        ],
        TickTerminated::class => [],
        OperationTerminated::class => [
            FlushOnce::class,
            FlushTemporaryContainerInstances::class,
        ],
        WorkerErrorOccurred::class => [
            ReportException::class,
            StopWorkerIfNecessary::class,
        ],
        WorkerStopping::class => [
            CloseMonologHandlers::class,
        ],
    ],
    // Resolved once per worker in the base application and shared by every request sandbox: the slot a request took
    // must be freed on the same DbSlots instance at the end of the request; the contract is parsed once per worker.
    'warm' => [
        ...Octane::defaultServicesToWarm(),
        DbSlots::class,
        Contract::class,
    ],
    'flush' => [],
    'tables' => [],
    'cache' => ['rows' => 1000, 'bytes' => 10000],
    'watch' => [],
    'garbage' => 50,
    // SSE streams (Task 12) outlive any fixed limit; PostgreSQL bounds every statement itself (30 s, P61).
    'max_execution_time' => 0,
];
