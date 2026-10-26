<?php

// RecallsTest: a second createRecall in its own process (its own session, its own Tx state) on agrotrace_test_laravel —
// the request that wins the race while the parent's attempt holds its snapshot. argv: sourceBatchId, userId, orgId.
// Prints {"status": …, "id": …} and exits 0, or the exception and exits 1.

use App\Actions\Recalls\RecallsActions;
use App\Security\Principal;
use Illuminate\Contracts\Console\Kernel;

require __DIR__.'/../../../vendor/autoload.php';
$app = require __DIR__.'/../../../bootstrap/app.php';
$app->make(Kernel::class)->bootstrap();
config(['database.connections.pgsql.url' => getenv('TEST_APP_DATABASE_URL')]);
$app['db']->purge('pgsql');

[, $source, $userId, $orgId] = $argv;
try {
    $out = RecallsActions::create(new Principal($userId, $orgId, ['INSPECTOR'], false),
        (object) ['sourceBatchId' => $source, 'reason' => 'The winner', 'blockUpstream' => false]);
    echo json_encode(['status' => $out['status'], 'id' => $out['body']['id']]);
    exit(0);
} catch (Throwable $e) {
    fwrite(STDERR, $e::class.': '.$e->getMessage());
    exit(1);
}
