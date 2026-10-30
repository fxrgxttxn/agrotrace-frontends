<?php

/*
 * The prelude of every sandbox child (auto_prepend_file, App\Infrastructure\Sandbox\Lane::command): the child's own
 * wall-clock limit, so it never outlives its job even when its parent is gone (review M1 of Tasks 4+5). SIGALRM keeps
 * its default action (no handler is installed): the kernel ends the process even inside a long libxml2 call.
 * - until `ready`: the start-up allowance (agrotrace.sandbox_ready_sec) plus the job's budget;
 * - `sandbox_ready()` writes `ready\n` and re-arms the alarm to the budget (agrotrace.sandbox_budget_sec, the job's
 *   remaining deadline when it was started) + 1 s — the parent, alive, always kills first.
 * Without pcntl the child refuses to run (exit 70): it must never run unbounded.
 */

declare(strict_types=1);

if (! function_exists('pcntl_alarm')) {
    fwrite(STDERR, "sandbox: pcntl is required\n");
    exit(70);
}

pcntl_alarm((int) get_cfg_var('agrotrace.sandbox_ready_sec') + (int) ceil((float) get_cfg_var('agrotrace.sandbox_budget_sec')) + 1);

function sandbox_ready(): void
{
    pcntl_alarm((int) ceil((float) get_cfg_var('agrotrace.sandbox_budget_sec')) + 1);
    fwrite(STDOUT, "ready\n");
    fflush(STDOUT);
}
