<?php

namespace App\Actions\Reports;

use App\Infrastructure\Db\DbSlots;
use App\Infrastructure\Db\Tx;
use App\Infrastructure\Sandbox\LaneRefused;
use App\Infrastructure\Sandbox\LaneTicket;
use LogicException;
use RuntimeException;

/**
 * A report's place in the render queue (Queue::admit). render() waits for the running slot and renders the job in the
 * sandbox (resources/sandbox/report-render.php) — never with a DB slot or connection held (P61: the rows were read and
 * the slot released before); a missed deadline, a crashed child or one over its memory → 503 report-busy; a client
 * that went away while waiting → ReportAborted (nobody reads the answer). release() gives the place back.
 */
final class Ticket
{
    public function __construct(private readonly LaneTicket $lane) {}

    /** @param  null|callable(): bool  $clientGone */
    public function render(string $jobJson, ?callable $clientGone = null): string
    {
        if (Tx::active() || app(DbSlots::class)->held()) {
            throw new LogicException('Ticket::render() with a DB slot held (P61)');
        }
        try {
            $out = $this->lane->run(base_path('resources/sandbox/report-render.php'), $jobJson, $clientGone);
        } catch (LaneRefused $e) {
            throw $e->reason === 'aborted' ? new ReportAborted : Queue::busy();
        }
        // The child answers `OK\n` + the file bytes, or `ERR\n` + the message when rendering threw — a defect, 500 as in
        // Express (its worker posts null); a child that died (memory, signal) was already `too-complex` → 503 above.
        if (! str_starts_with($out, "OK\n")) {
            throw new RuntimeException('report rendering failed: '.substr($out, 0, 500));
        }

        return substr($out, 3);
    }

    public function release(): void
    {
        $this->lane->release();
    }
}
