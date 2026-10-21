<?php

// LaneTest stub: optionally sleeps before `ready` (argv-free: STARTUP_MS env), then echoes stdin after the delay
// given in its first line ("<ms>\n<payload>"); "<ms>" = -1 → hangs forever.
$startup = (int) (getenv('LANE_STUB_STARTUP_MS') ?: 0);
usleep($startup * 1000);
fwrite(STDOUT, "ready\n");
fflush(STDOUT);
$input = (string) stream_get_contents(STDIN);
[$ms, $payload] = explode("\n", $input, 2) + [1 => ''];
if ((int) $ms < 0) {
    for (; ;) {
        sleep(1);
    }
}
usleep((int) $ms * 1000);
fwrite(STDOUT, "<svg>{$payload}</svg>");
