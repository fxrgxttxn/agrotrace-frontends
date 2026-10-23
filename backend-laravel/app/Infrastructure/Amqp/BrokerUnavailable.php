<?php

namespace App\Infrastructure\Amqp;

use RuntimeException;

/** RabbitMQ cannot be used right now (connect failed, in back-off, a confirm timed out, a copy was refused). */
final class BrokerUnavailable extends RuntimeException {}
