# PayFlow

**Payment reconciliation & transaction monitoring for finance teams.**
PayFlow imports payments from payment providers, matches them against invoices, surfaces everything that doesn't add up, and keeps a full audit trail of who decided what.

> **Sandbox only.** PayFlow ships with a simulated *mock* payment provider. No real money moves and live provider credentials are refused.

## Project status

| Area | Status |
|---|---|
| REST API (NestJS, Prisma, PostgreSQL, BullMQ/Redis) | ✅ Built, 104 automated tests |
| React web dashboard (Vite, TypeScript) | ✅ Built, 33 automated tests |
| Swagger / OpenAPI docs | ✅ `GET /api/docs` |
| Seed script with demo data | ✅ |
| React Native (Expo) mobile app | ⬜ Not started |
| Dockerfiles for the apps, GitHub Actions CI/CD | ⬜ Not started (infra `docker-compose.yml` for Postgres + Redis only) |
| Browser-driven end-to-end test | ⬜ Not started (API integration tests cover the flows; web UI has component tests but has not had a visual QA pass) |
| Real provider sandbox adapter (e.g. Stripe test mode) | ⬜ Only the mock provider exists |

## What it does

- **Import** payments by incremental sync or by signed webhook events.
- **Reconcile** payments against invoices with configurable rules. Exact matches are applied automatically; anything uncertain waits for a person.
- **Detect** duplicates, underpayments and overpayments, currency mismatches, unmatched payments and invoices, missing payments and delayed payments.
- **Investigate** exceptions: assign, add notes, resolve or dismiss with a recorded reason.
- **Report** with live dashboard figures and five CSV-exportable reports.
- **Audit** sensitive actions, with secrets stripped from the trail.

## Architecture

```mermaid
flowchart LR
  subgraph Clients
    Web["React dashboard"]
    Provider["Payment provider<br/>(mock sandbox)"]
  end
  subgraph API["NestJS API"]
    Guards["Guards: rate limit → JWT → org membership → role"]
    Mods["Auth · Organisations · Transactions · Invoices<br/>Reconciliation · Exceptions · Reports<br/>Integrations · Webhooks · Notifications · Audit"]
    Worker["BullMQ worker"]
  end
  DB[("PostgreSQL")]
  Redis[("Redis")]
  Web -- "REST + JWT" --> Guards --> Mods
  Provider -- "signed webhook" --> Mods
  Mods --> DB
  Mods -- "enqueue event" --> Redis --> Worker --> DB
```

### Webhook flow

```mermaid
sequenceDiagram
  participant P as Provider
  participant A as API (public endpoint)
  participant DB as PostgreSQL
  participant Q as Redis queue
  participant W as Worker
  P->>A: POST /api/webhooks/mock?connection=ID (signed)
  A->>A: Verify HMAC over the raw body (before parsing)
  A->>A: Validate payload
  A->>DB: INSERT event (unique per connection + event id)
  alt already received
    A-->>P: 202 duplicate (nothing applied twice)
  else new
    A->>Q: enqueue
    A-->>P: 202 accepted
    Q->>W: process
    W->>DB: lock payment row, apply if newer + valid transition, write history
    Note over W,DB: on failure: retry with exponential backoff,<br/>then DEAD_LETTER + notification
  end
```

### Data model

```mermaid
erDiagram
  Organisation ||--o{ OrganisationMembership : has
  User ||--o{ OrganisationMembership : joins
  Organisation ||--o{ ProviderConnection : configures
  PaymentProvider ||--o{ ProviderConnection : "instance of"
  ProviderConnection ||--o{ Transaction : imports
  ProviderConnection ||--o{ WebhookEvent : receives
  Transaction ||--o{ TransactionStatusHistory : "status changes"
  Organisation ||--o{ Invoice : issues
  Transaction ||--o{ InvoicePayment : "applied via"
  Invoice ||--o{ InvoicePayment : "paid by"
  Transaction ||--o{ ReconciliationMatch : candidates
  Invoice ||--o{ ReconciliationMatch : candidates
  ReconciliationRun ||--o{ ReconciliationMatch : produces
  Organisation ||--o{ PaymentException : tracks
  Organisation ||--o{ AuditLog : records
  Organisation ||--o{ Notification : notifies
  User ||--o{ RefreshToken : owns
```

Every business table carries an `organisationId`, and every query is scoped by it. Money is `Decimal(19,4)` with an explicit 3-letter currency; amounts travel over the API as decimal **strings**, never floats. The full schema is in [`apps/api/prisma/schema.prisma`](apps/api/prisma/schema.prisma).

## Quick start

**Prerequisites:** Node.js and npm, plus Docker. Developed and tested on Node 26 / npm 11; other versions are untested.

```bash
git clone https://github.com/Srivatsav1298/PayFlow.git
cd PayFlow
npm install
cp apps/api/.env.example apps/api/.env      # then replace the placeholder secrets (see below)
npm run infra:up                             # Postgres :5434 and Redis :6380
npm run prisma:deploy -w @payflow/api        # apply migrations
npm run seed -w @payflow/api                 # demo users, invoices, payments, a reconciliation run
```

Then run the API and the web app in two terminals:

```bash
npm run api:dev     # http://localhost:3100  (Swagger: /api/docs)
npm run web:dev     # http://localhost:5173  (proxies /api to :3100)
```

**Ports** are deliberately non-default (API 3100, Postgres 5434, Redis 6380) so PayFlow doesn't collide with other local projects.

### Demo logins

Created by the seed script. **Demo only; the seed refuses to run when `NODE_ENV=production`.**

| Role | Email | Password |
|---|---|---|
| Admin | `admin@payflow.demo` | `Demo-Passw0rd!` |
| Finance manager | `manager@payflow.demo` | `Demo-Passw0rd!` |
| Finance analyst | `analyst@payflow.demo` | `Demo-Passw0rd!` |

### Configuration

All settings live in `apps/api/.env` (template: [`.env.example`](apps/api/.env.example)). The API refuses to start with missing or weak secrets.

| Variable | Purpose |
|---|---|
| `DATABASE_URL`, `REDIS_URL` | Postgres and Redis connections |
| `JWT_ACCESS_SECRET` | ≥ 32 chars. Generate: `openssl rand -hex 48` |
| `ENCRYPTION_KEY` | 64 hex chars (AES-256-GCM key for provider credentials). Generate: `openssl rand -hex 32` |
| `JWT_ACCESS_TTL`, `REFRESH_TOKEN_TTL_DAYS` | Token lifetimes (default 15m / 30 days) |
| `THROTTLE_LIMIT`, `THROTTLE_TTL_MS`, `AUTH_THROTTLE_LIMIT` | Rate limits (global / login-register-refresh) |
| `WEBHOOK_MAX_ATTEMPTS`, `WEBHOOK_BACKOFF_BASE_MS` | Retry policy before dead-lettering |
| `CORS_ORIGINS` | Comma-separated allowed origins |

In production, the API rejects the example `ENCRYPTION_KEY` and any `JWT_ACCESS_SECRET` containing `change-me`.

## Roles and permissions

Enforced by backend guards on every request. The UI hides controls as a convenience only.

| Capability | Analyst | Manager | Admin |
|---|:-:|:-:|:-:|
| View transactions, invoices, exceptions, reconciliation results, dashboard | ✅ | ✅ | ✅ |
| Start investigating an exception, add notes | ✅ | ✅ | ✅ |
| Create / import / edit invoices | | ✅ | ✅ |
| Run reconciliation; confirm, reject, reverse, manually create matches | | ✅ | ✅ |
| Assign and resolve exceptions | | ✅ | ✅ |
| Import transactions; simulate sandbox events; retry webhook events | | ✅ | ✅ |
| Reports and CSV export | | ✅ | ✅ |
| Integrations, team, organisation & matching rules, audit log | | | ✅ |

An organisation can never lose its last admin. Role changes and removals take effect on the very next request.

## How reconciliation works

1. **Duplicates first.** Payments with the same customer, amount, currency and reference within 72 hours are flagged. Copies are never matched, so they can't double-pay an invoice.
2. **Score** each remaining payment against open invoices on five weighted criteria (defaults): reference 40, amount 30, currency 10, date 10, customer 10. Amounts are compared against the invoice's **outstanding** balance with exact decimal arithmetic.
3. **Exact match** = reference matches, currency equal, amount equals outstanding (within the configured tolerance) and no customer conflict. Exact matches are confirmed automatically (this can be switched off).
4. **Everything else is a suggestion** for a person to confirm or reject: underpayments, overpayments, a reference found only inside free text, and ties between several exact candidates. **Uncertain matches are never auto-confirmed.**
5. **Exceptions** are raised idempotently (one per problem, never re-opened once resolved): duplicate transaction, unmatched transaction, unmatched invoice, missing payment, amount discrepancy, currency mismatch, failed payment, delayed (long-pending) payment. A confirmed match closes the exceptions it solves.
6. **Human decisions stick.** Rejected suggestions are not re-suggested; confirmed matches can be reversed, which restores the invoice balance.

Rules (tolerance, date window, weights, thresholds, grace periods) are configurable per organisation under *Settings → Organisation & rules*.

## Reliability and data integrity

- **Idempotent webhooks:** provider event IDs are unique per connection; redelivery is acknowledged but never reapplied.
- **One write path** for payment state (webhooks and imports): row-level lock, one database transaction, and the status history entry commits with the change.
- **Out-of-order safe:** an event applies only if its sequence is newer, and terminal states can't regress (a late `pending` can't overwrite `succeeded`).
- **Concurrency safe:** simultaneous creates of the same payment race on a unique constraint and retry into the update path; allocations lock the payment then the invoice (fixed order, no deadlocks); only one reconciliation run per organisation can be `RUNNING` (partial unique index).
- **Retries:** failed events retry with exponential backoff, then move to `DEAD_LETTER`, raise a notification, and can be retried manually.
- **Money:** `Decimal(19,4)` in the database, decimal strings on the wire, exact decimal arithmetic in the API.

## Webhooks

`POST /api/webhooks/:provider?connection=<connectionId>` (public; authenticity comes from the signature).

```
X-PayFlow-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">
```

The signature is verified over the exact raw bytes with a constant-time comparison, and timestamps older than 5 minutes are rejected (replay protection). An unknown connection and a bad signature are indistinguishable (both `401`). Supported events: `payment.created`, `payment.pending`, `payment.succeeded`, `payment.failed`, `payment.refunded`.

To try it without writing code: *Settings → Integrations → Simulate event* sends a correctly signed event through the real intake path (it can also replay a duplicate or an out-of-order event).

## API

Interactive docs: **`/api/docs`** (Swagger UI). Authenticate with `Authorization: Bearer <accessToken>`; multi-organisation users may send `X-Organisation-Id`. Lists are paginated (`page`, `pageSize` ≤ 100) and validated; unknown request fields are rejected.

| Area | Endpoints (min. role) |
|---|---|
| **Auth** | `POST /api/auth/register`, `login`, `refresh`, `logout` (public) · `GET /api/auth/me` |
| **Transactions** | `GET /api/transactions`, `/:id`, `/:id/history` (analyst) · `POST /api/transactions/import` (manager) |
| **Invoices** | `GET /api/invoices`, `/:id` (analyst) · `POST /api/invoices`, `POST /api/invoices/import`, `PATCH /api/invoices/:id` (manager) |
| **Reconciliation** | `GET /api/reconciliation/runs`, `/runs/:id`, `/results` (analyst) · `POST /api/reconciliation/run`, `/matches/manual`, `/matches/:id/confirm`, `/reject`, `/reverse` (manager) |
| **Exceptions** | `GET /api/exceptions`, `/:id`, `/summary` · `PATCH /:id/investigate` · `POST /:id/notes` (analyst) · `PATCH /:id/assign`, `/:id/resolve` (manager) |
| **Reports** | `GET /api/reports/overview` (analyst) · `/reconciliation`, `/transaction-volume`, `/failed-payments`, `/outstanding-invoices`, `/provider-performance` — add `?format=csv` to download (manager) |
| **Webhooks** | `POST /api/webhooks/:provider` (public, signed) · `GET /api/webhooks/events/history`, `POST /api/webhooks/events/:id/retry` (manager) |
| **Integrations** | `GET/POST /api/integrations`, `PATCH/DELETE /:id`, `POST /:id/rotate-webhook-secret` (admin) · `POST /:id/simulate` (manager) |
| **Organisation** | `GET/PATCH /api/organisations/current` · members: `GET/POST /current/members`, `PATCH/DELETE /current/members/:id` (admin) |
| **Other** | `GET /api/notifications`, `PATCH /:id/read` · `GET /api/payment-providers` · `GET /api/audit-logs` (admin) · `GET /api/health` (public) |

## Security

- **Passwords:** `scrypt` with a per-password salt. Refresh tokens are stored only as SHA-256 hashes; they rotate on every use, and reusing a revoked one revokes the whole token family.
- **Access control:** JWT + per-request organisation membership check + role check. Cross-organisation access returns `404` (existence isn't leaked).
- **Secrets at rest:** provider credentials and webhook secrets are AES-256-GCM encrypted; webhook secrets are shown once and can't be read back.
- **Input:** `class-validator` with whitelist + forbid-unknown; money and currency strictly validated; security headers via Helmet; rate limiting (tighter on login/register/refresh).
- **Logs and audit:** authorization headers, signatures, passwords and tokens are redacted from logs; audit metadata is scrubbed of secrets.
- **CSV export** neutralises spreadsheet formula injection (`=`, `+`, `@`, …).
- **Errors:** no stack traces, SQL or internals in responses.

## Testing

```bash
npm run infra:up                                   # integration tests need Postgres + Redis
DATABASE_URL='postgresql://payflow:payflow_dev_password@localhost:5434/payflow_test?schema=public' \
  npm run prisma:deploy -w @payflow/api            # one-time: migrate the isolated test database
npm run api:test                                   # 39 unit tests
npm run test:int -w @payflow/api                   # 65 integration tests
npm run test -w @payflow/web                       # 33 web tests (Vitest + React Testing Library)
```

Integration tests run against a separate `payflow_test` database and Redis DB 1, so they can never touch development data. They cover signature verification, duplicates and concurrent deliveries, out-of-order events, retry → dead-letter, every reconciliation scenario, organisation isolation, the role matrix, token rotation, secret handling, and exact dashboard figures.

## Project layout

```
apps/
  api/            NestJS API
    prisma/       schema, migrations, seed
    src/          auth, organisations, transactions, invoices, reconciliation,
                  exceptions, reports, providers, integrations, webhooks,
                  notifications, audit-logs, common
    test/         integration tests and helpers
  web/            React + Vite dashboard
docker-compose.yml   Postgres + Redis for local development
```

## Manual production build

Dockerfiles and CI are not included yet. To build by hand:

```bash
npm run api:build && npm run build -w @payflow/web
NODE_ENV=production npm run prisma:deploy -w @payflow/api
NODE_ENV=production node apps/api/dist/main.js          # serve apps/web/dist behind a reverse proxy that forwards /api
```

Set real values for `JWT_ACCESS_SECRET`, `ENCRYPTION_KEY`, `DATABASE_URL`, `REDIS_URL` and `CORS_ORIGINS`, and don't run the seed against production.

## Known limitations

- Only the **mock provider** exists. Adding a real provider means implementing `PaymentProviderInterface` and registering it in `PaymentProviderService`.
- **No currency conversion:** a payment and invoice in different currencies are flagged, never matched.
- **Incremental sync** resumes from a position cursor and doesn't re-fetch payments that changed after import; webhooks cover those changes.
- **Matching cost** grows with payments × open invoices; fine at demo scale, needs indexing/blocking for very large datasets.
- A worker that crashes mid-processing leaves its event in `PROCESSING` until someone retries it manually.
- **Rate limiting** uses an in-memory store, so limits are per API instance. Use a shared store behind multiple instances.
- The web app keeps the **refresh token in `localStorage`**, which is exposed if an XSS bug exists. An httpOnly-cookie flow would be stronger.
- Concurrent syncs of the same connection aren't locked (they are safe, because ingest is idempotent).

## Roadmap

Expo mobile app for finance managers · Dockerfiles and GitHub Actions CI/CD · browser-driven end-to-end tests · a real provider sandbox adapter · shared-store rate limiting · httpOnly-cookie sessions.
