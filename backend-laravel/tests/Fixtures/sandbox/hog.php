<?php

// LaneTest stub (review I1): allocates the number of bytes given on stdin outside the lane's memory_limit (lifted at
// run time, as libxml2's own allocations are never counted by it) — only the OS limit of the child can stop it.
sandbox_ready();
$bytes = (int) stream_get_contents(STDIN);
ini_set('memory_limit', '-1');
$s = str_repeat('x', $bytes);
echo 'allocated ', strlen($s);
