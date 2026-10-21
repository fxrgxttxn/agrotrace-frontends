<?php

// L1: Laravel Queue is not used (own AMQP transport, app/Infrastructure/Amqp, Plan 5 Task 6).
return [
    'default' => 'sync',
    'connections' => ['sync' => ['driver' => 'sync']],
    'failed' => ['driver' => 'null'],
];
