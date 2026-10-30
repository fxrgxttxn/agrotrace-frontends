<?php

// LaneTest stub (T13 review M4): reports ready, writes a temporary file where PHP puts temporary files and names it in
// the file given on stdin, then hangs until the lane's deadline kills it.
sandbox_ready();
$note = trim((string) stream_get_contents(STDIN));
$tmp = tempnam(sys_get_temp_dir(), 'tmp-hang-');
file_put_contents((string) $tmp, str_repeat('x', 4096));
file_put_contents($note, (string) $tmp);
sleep(60);
