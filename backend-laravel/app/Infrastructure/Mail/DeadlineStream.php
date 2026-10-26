<?php

namespace App\Infrastructure\Mail;

use Symfony\Component\Mailer\Exception\TransportException;
use Symfony\Component\Mailer\Transport\Smtp\Stream\AbstractStream;

/**
 * The SMTP connection of one send attempt (Express mailer: connection/greeting 5 s, socket 10 s; the attempt's 30 s
 * deadline, N5). Symfony's SocketStream sets one stream timeout per read, and fgets keeps waiting inside C as long as
 * some byte arrives within it: a server that trickles its reply never times out, and no signal handler runs before
 * the C call returns (SIGALRM measured: a 3 s alarm fired at 13 s). Here every read is a stream_select bounded by the
 * smaller of the idle timeout (10 s) and what is left of the attempt's deadline, so an attempt ends by its deadline
 * whatever the server does. Plain TCP only (the transport runs with auto_tls off, as before).
 */
final class DeadlineStream extends AbstractStream
{
    private string $host = 'localhost';

    private int $port = 25;

    private string $buffer = '';

    public function __construct(private readonly float $deadline, private readonly float $idleSec = 10.0) {}

    public function setHost(string $host): static
    {
        $this->host = $host;

        return $this;
    }

    public function setPort(int $port): static
    {
        $this->port = $port;

        return $this;
    }

    public function getHost(): string
    {
        return $this->host;
    }

    public function getPort(): int
    {
        return $this->port;
    }

    /** EsmtpTransport's calls on its stream: plain TCP — TLS stays off. */
    public function disableTls(): static
    {
        return $this;
    }

    public function isTLS(): bool
    {
        return false;
    }

    public function hasPendingData(): bool
    {
        return $this->buffer !== '' || parent::hasPendingData();
    }

    public function initialize(): void
    {
        $timeout = $this->left();
        $errno = 0;
        $errstr = '';
        $stream = @stream_socket_client("tcp://{$this->host}:{$this->port}", $errno, $errstr, $timeout);
        if ($stream === false) {
            throw new TransportException(sprintf('Connection could not be established with host "%s:%d": %s', $this->host, $this->port, $errstr));
        }
        stream_set_blocking($stream, true);
        stream_set_timeout($stream, (int) $timeout, (int) (($timeout - (int) $timeout) * 1_000_000));
        $this->stream = $stream;
        $this->in = &$this->stream;
        $this->out = &$this->stream;
    }

    public function readLine(): string
    {
        while (($nl = strpos($this->buffer, "\n")) === false) {
            $wait = $this->left();
            $read = [$this->out];
            $none = null;
            $ready = @stream_select($read, $none, $none, (int) $wait, (int) (($wait - (int) $wait) * 1_000_000));
            if ($ready === false) {
                throw new TransportException(sprintf('Unable to read from connection to "%s".', $this->getReadConnectionDescription()));
            }
            if ($ready === 0) {
                throw new TransportException(sprintf('Connection to "%s" timed out.', $this->getReadConnectionDescription()));
            }
            $chunk = @fread($this->out, 8192);
            if ($chunk === false || ($chunk === '' && feof($this->out))) {
                throw new TransportException(sprintf('Connection to "%s" has been closed unexpectedly.', $this->getReadConnectionDescription()));
            }
            $this->buffer .= $chunk;
        }
        $line = substr($this->buffer, 0, $nl + 1);
        $this->buffer = substr($this->buffer, $nl + 1);

        return $line;
    }

    public function write(string $bytes, bool $debug = true): void
    {
        // Writes are short (one letter); the remaining deadline bounds each blocking fwrite as well.
        $left = $this->left();
        stream_set_timeout($this->in, (int) $left, (int) (($left - (int) $left) * 1_000_000));
        parent::write($bytes, $debug);
    }

    /** Seconds the next wait may take: the idle timeout, at most what is left of the deadline (never ≤ 0). */
    private function left(): float
    {
        $left = min($this->idleSec, $this->deadline - microtime(true));
        if ($left <= 0) {
            throw new TransportException('the send attempt passed its deadline');
        }

        return $left;
    }

    protected function getReadConnectionDescription(): string
    {
        return "{$this->host}:{$this->port}";
    }
}
