<?php

// LaneTest stub of a runaway child (review M1): reports ready through the Lane prelude, writes its PID to the file named
// on stdin, then burns CPU forever — only its own limits (or its parent) can end it.
sandbox_ready();
$pidFile = trim((string) stream_get_contents(STDIN));
if ($pidFile !== '') {
    file_put_contents($pidFile, (string) getmypid());
}
for ($i = 0; ; $i++) {
    $i &= 0xFFFF;
}
