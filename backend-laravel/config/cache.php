<?php

// No Laravel cache holds shared state (the Redis keys of the contract are written directly, SP7): the default store is
// the in-process array, so nothing reaches the database or Redis behind the application's back.
return [
    'default' => 'array',
    'stores' => [
        'array' => ['driver' => 'array', 'serialize' => false],
    ],
    'prefix' => '',
];
