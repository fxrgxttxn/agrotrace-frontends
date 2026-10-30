<?php

namespace Tests;

use Illuminate\Contracts\Http\Kernel;
use Illuminate\Foundation\Testing\TestCase as BaseTestCase;
use Illuminate\Http\Request;
use Illuminate\Testing\TestResponse;

/**
 * The booted application (bootstrap/app.php). Tests of the `integration` group connect as `agrotrace_app` to the
 * per-backend test DB agrotrace_test_laravel (TEST_APP_DATABASE_URL, exported by `./at.sh laravel:test`, SP2) — never
 * to the dev DB; without it the connection points nowhere.
 */
abstract class TestCase extends BaseTestCase
{
    protected function setUp(): void
    {
        parent::setUp();
        $url = getenv('TEST_APP_DATABASE_URL');
        config(['database.connections.pgsql.url' => is_string($url) && $url !== '' ? $url : 'postgres://none:none@127.0.0.1:1/none']);
        $this->app['db']->purge('pgsql');
    }

    protected function requireDatabase(): void
    {
        $url = getenv('TEST_APP_DATABASE_URL');
        if (! is_string($url) || $url === '') {
            $this->fail('TEST_APP_DATABASE_URL is not set: run the suite with ./at.sh laravel:test');
        }
    }

    /**
     * A request with this exact raw REQUEST_URI (Laravel's call() would normalize `//`, `%`-escapes and trailing
     * slashes before the application sees them) through the HTTP kernel, terminated like a real one.
     *
     * @param  array<string, string>  $headers
     */
    protected function raw(string $method, string $rawUri, array $headers = [], string $body = ''): TestResponse
    {
        $server = ['REMOTE_ADDR' => '10.0.0.7'];
        foreach ($headers as $name => $value) {
            $key = strtoupper(str_replace('-', '_', $name));
            $server[in_array($key, ['CONTENT_TYPE', 'CONTENT_LENGTH'], true) ? $key : 'HTTP_'.$key] = $value;
        }
        $request = Request::create('/', $method, [], [], [], $server, $body);
        $request->server->set('REQUEST_URI', $rawUri);
        $request->server->set('QUERY_STRING', explode('?', $rawUri, 2)[1] ?? '');
        $request = Request::createFromBase($request);

        $kernel = $this->app->make(Kernel::class);
        $response = $kernel->handle($request);
        $kernel->terminate($request, $response);

        return TestResponse::fromBaseResponse($response, $request);
    }
}
