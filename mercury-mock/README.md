# mercury-mock

Emulator of ФГИС «Меркурий» (the Russian veterinary e-certification system), used by all
three backends' Mercury integration adapters in dev/test. Implemented with `node:http`
only — no framework, no runtime npm dependencies.

Network name inside the `at` docker-compose network: `mercury-mock`, port `8080`
(`MERCURY_URL=http://mercury-mock:8080` in `.env.example`). Not published to the host.

## Endpoints

All three endpoints below are `GET`-only. A non-`GET` request to one of them returns
`405 { "error": "METHOD_NOT_ALLOWED" }` with an `Allow: GET` header. A request to any
other path returns `404 { "error": "NOT_FOUND" }` regardless of method.

### `GET /health`

Always returns `200 { "status": "ok" }`, regardless of `X-Mock-Fail` or `MOCK_FAIL_RATE`
(so the Docker healthcheck and compose `depends_on: condition: service_healthy` stay
reliable even while a test is deliberately injecting chaos on the data endpoints).

```json
{ "status": "ok" }
```

### `GET /api/v1/vsd`

Lists veterinary accompanying documents (VSD — ветеринарный сопроводительный документ).

Query parameters (all optional, combinable):

| Param | Match | Example |
|---|---|---|
| `productCode` | exact match on `product.code` | `productCode=10.51.11` |
| `senderInn` | exact match on `consignor.inn` | `senderInn=2312450016` |
| `dateFrom` | `issueDate >= dateFrom` (inclusive) | `dateFrom=2026-02-01` |
| `dateTo` | `issueDate <= dateTo` (inclusive) | `dateTo=2026-03-31` |

`dateFrom`/`dateTo` must be `YYYY-MM-DD` and a real calendar date. A malformed value
(bad format, or an overflowing date such as `2026-02-30`) returns:

```
400 Bad Request
{ "error": "BAD_REQUEST" }
```

Success response:

```
200 OK
{ "items": [ /* Vsd[] */ ] }
```

An empty array is returned (never a 404) when the filters match nothing.

### `GET /api/v1/vsd/{uuid}`

Returns a single VSD by its `uuid`.

```
200 OK
{ /* Vsd */ }
```

Unknown uuid:

```
404 Not Found
{ "error": "NOT_FOUND" }
```

A `uuid` segment with malformed percent-encoding (e.g. an incomplete `%`-escape) is a
client error, not a lookup miss:

```
400 Bad Request
{ "error": "BAD_REQUEST" }
```

### `Vsd` shape

```ts
interface Vsd {
  uuid: string;
  number: string;          // e.g. "VSD-2026-000001"
  issueDate: string;       // YYYY-MM-DD
  status: 'CONFIRMED' | 'WITHDRAWN' | 'UTILIZED';
  product: { code: string; name: string };
  volume: { value: number; unit: string };
  consignor: { inn: string; name: string };  // sender
  consignee: { inn: string; name: string };  // receiver
  vetInspection: { result: 'HEALTHY'; date: string; doctor: string };
}
```

Example:

```json
{
  "uuid": "d3bc6508-f9e7-412e-a6c4-690f31cd59f0",
  "number": "VSD-2026-000001",
  "issueDate": "2026-01-15",
  "status": "CONFIRMED",
  "product": { "code": "10.51.11", "name": "Молоко сырое коровье" },
  "volume": { "value": 12500, "unit": "л" },
  "consignor": { "inn": "2312450016", "name": "ООО «Агрофирма Заря»" },
  "consignee": { "inn": "7705120028", "name": "ООО «Молкомбинат Ставропольский»" },
  "vetInspection": { "result": "HEALTHY", "date": "2026-01-14", "doctor": "Сидорова Е.В." }
}
```

## Failure modes (for testing backend adapters)

Two independent mechanisms, so an adapter's test suite can force a specific failure on a
specific request, or soak-test against a background failure rate.

Both mechanisms are scoped to the `/api/v1/vsd` and `/api/v1/vsd/{uuid}` endpoints only —
never to `/health`, and never to an unknown path. A typo'd path or a health probe can
never be mistaken for the mock's own simulated outage, even while it's sent with
`X-Mock-Fail` or under a nonzero `MOCK_FAIL_RATE` (e.g. `GET /nope` with
`X-Mock-Fail: 500` still returns a plain `404`, not `500`).

### `X-Mock-Fail` request header

Sent by the caller on a request to `/api/v1/vsd` or `/api/v1/vsd/{uuid}`:

| Value | Effect |
|---|---|
| `X-Mock-Fail: 500` | Immediately responds `500 { "error": "INTERNAL" }`. |
| `X-Mock-Fail: timeout` | Delays the response by `MOCK_TIMEOUT_MS` (default 30000 ms), then serves the request normally (including its own `405`/`400`/`404` handling, if applicable). Use a small `MOCK_TIMEOUT_MS` in tests to keep them fast while still exercising the adapter's own client-side timeout/retry handling. |

Any other value (or the header absent) has no special effect.

### `MOCK_FAIL_RATE` environment variable

A number in `[0, 1]` (values outside the range are clamped, non-numeric values are
treated as `0`). On every request to `/api/v1/vsd` or `/api/v1/vsd/{uuid}`, a random
`500 { "error": "INTERNAL" }` is injected with that probability, independent of the
`X-Mock-Fail` header (an explicit header always wins). `0` (the default) disables fault
injection entirely; `1` fails every request.

### `MOCK_TIMEOUT_MS` environment variable

Delay in milliseconds applied when `X-Mock-Fail: timeout` is sent (default `30000`).
Tests should set this to a small value (e.g. tens of ms) so the timeout path stays fast
to run.

## Data

Served from [`data/vsd.json`](./data/vsd.json): 15 documents covering the four
animal-origin product categories seeded here (молоко, мясо говядина, яйцо куриное, мёд),
5 sender organizations and 3 receiver organizations, dates spanning 2026-01-15 through
2026-09-10, and all three statuses (`CONFIRMED`, `WITHDRAWN`, `UTILIZED`). All
`consignor.inn`/`consignee.inn` values pass the FNS INN checksum
(`@agrotrace/validation`'s `isValidInn`) so they can be reused as-is by the seed task:

| INN | Organization | Role |
|---|---|---|
| `2312450016` | ООО «Агрофирма Заря» | sender |
| `502701234075` | КФХ Петров И.С. | sender |
| `7806540043` | ООО «Молочная ферма Луговая» | sender |
| `3601110050` | ООО «Пасека Медовый край» | sender |
| `2302220060` | ООО «Птицефабрика Рассвет» | sender |
| `7705120028` | ООО «Молкомбинат Ставропольский» | receiver |
| `5009870030` | ООО «Мясокомбинат Заречный» | receiver |
| `231099887716` | ООО «Торговый дом Провизия» | receiver |

Product codes used are OKPD2-style: `10.51.11` (молоко сырое коровье), `10.11.11` (мясо
говядина), `01.47.21` (яйцо куриное), `01.49.24` (мёд натуральный).

## Running

```bash
# inside the at docker-compose network
docker compose up -d mercury-mock
docker compose run --rm -T tools curl -fsS http://mercury-mock:8080/health

# local dev (hot reload)
pnpm --filter @agrotrace/mercury-mock dev

# tests
pnpm --filter @agrotrace/mercury-mock test
```

Environment variables: `PORT` (default `8080`), `MOCK_FAIL_RATE` (default `0`),
`MOCK_TIMEOUT_MS` (default `30000`).
