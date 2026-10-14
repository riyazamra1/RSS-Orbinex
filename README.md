# RSS-Orbinex

RSS Orbinex is a secure, subscription-based invoicing, inventory, and accounting platform. The shared API is the authority for tenant data, financial rules, authorization, and subscription entitlements.

## Repository status

The project is being established incrementally. Requirements documents describe intended behavior; they do not mean every feature is already implemented.

- [Product and technical requirements](./REQUIREMENTS.md)
- [Offline sync and removable-drive backup requirements](./OFFLINE_SYNC_AND_REMOVABLE_BACKUP.md)

## Initial technology foundation

- Node.js 22+ and TypeScript
- Fastify API
- PostgreSQL via the pg driver
- Zod environment validation
- API liveness/readiness endpoints
- One-time, secret-protected initial tenant/owner bootstrap that seeds a default chart of accounts; online login, server-validated session inspection, and online logout endpoints
- Opaque random bearer sessions stored as SHA-256 hashes, with expiry and server-side revocation
- Argon2id password verification and API rate limiting
- Tenant-scoped sync push/pull endpoints using an append-only change journal
- Tenant-safe customer, supplier, product, invoice, payment, stock movement, return, damage, account, and journal schema (migration 003)
- Database guards for posted invoice immutability, append-only payments/stock movements, and balanced posted journals (migration 004)
- Transactional stock movement API with idempotent operation IDs, tenant checks, negative-stock prevention, audit events, and balance lookup
- Tenant-scoped customer and supplier records; product create/list/update/search, stock/service classification, stock balances, low-stock flags, and movement history
- Transactional draft invoice creation with tenant-scoped customer/product validation, database-calculated totals, and operation-ID idempotency
- Tenant-scoped chart-of-accounts APIs, draft journal creation, server-validated balanced journal posting, audit events, idempotency, and trial-balance reporting
- Transactional customer payment recording with invoice balance checks, automatic balanced cash/receivables journal posting, invoice paid/part-paid status transitions, and sync events
- Invoice posting with invoice row locks, sorted per-product advisory locks, stock availability checks, atomic stock deductions, immutable posted status, audit records, and sync change events
- Transactional sync batches, operation-ID idempotency, server-assigned entity versions, and role-based write allowlists
- Initial tenant, identity, device, session, idempotency, change-event, and audit schema

The API authentication foundation is not yet a complete production identity lifecycle. Ongoing user invitations/provisioning, password reset, MFA, admin/device management UI, formal migration tooling, and deployment hardening remain pending. Do not expose the service publicly until those controls and production monitoring are complete.

## Implemented API routes

- `GET /health/live` and `GET /health/ready`
- `POST /v1/platform/bootstrap` (one-time setup; requires `x-rss-bootstrap-secret` matching `BOOTSTRAP_SECRET`)
- `POST /v1/auth/login`, `GET /v1/auth/session`, `POST /v1/auth/logout`
- `POST /v1/inventory/movements`, `GET /v1/inventory/products/:productId/balance`, `GET /v1/inventory/movements/history`
- `GET/POST/PATCH /v1/customers`, `GET /v1/customers/:id`
- `GET/POST/PATCH /v1/suppliers`, `GET/POST/PATCH /v1/products`
- `GET /v1/suppliers/:id`, `GET /v1/products/:id`
- `GET /v1/invoices`, `GET /v1/invoices/:invoiceId`, `POST /v1/invoices`, `POST /v1/invoices/:invoiceId/post`
- `GET /v1/accounting/accounts`, `POST /v1/accounting/accounts`
- `POST /v1/accounting/journals`, `POST /v1/accounting/journals/:journalId/post`, `GET /v1/accounting/trial-balance`
- `GET /v1/payments`, `POST /v1/payments` (records a received payment and posts its balanced journal atomically)
- `POST /v1/sync/push`, `GET /v1/sync/pull`

Protected routes require an active online bearer session. Route availability does not mean a production database, identity lifecycle, or deployment has been provisioned.

## Local API setup

1. Install Node.js 22 or newer and PostgreSQL.
2. Copy `.env.example` to `.env` and configure the database connection.
3. Create the development database and apply migrations in order: `001_platform_foundation.sql`, `002_auth_sessions.sql`, `003_business_domain.sql`, then `004_financial_integrity_guards.sql`, then `005_product_types.sql`.
4. Run `npm install`.
5. Run `npm run dev:api`.
6. Check `http://127.0.0.1:4000/health/live` and `http://127.0.0.1:4000/health/ready`.

Do not use example settings in production. Production database connections must use TLS. Migrations should be reviewed and applied through a controlled migration process.

## Planned implementation order

1. Complete the identity lifecycle and administrator/device management.
2. Add PDF/print rendering for invoices and quotations, credit notes, purchase documents, and statement generation.
3. Add validated domain sync adapters; current generic sync endpoints append change events and do not yet apply every entity payload to domain tables.
4. Add conflict-aware rules for posted invoices, payments, stock movements, returns, and damages; then add Windows/Android durable outbox clients.
5. Encrypted local storage and outbox for Windows/Android clients.
6. Accounting-aware conflict resolution and automatic sync.
7. Administrator-controlled encrypted removable-drive backup and tested restore.
8. Switchable object storage adapters and document handling.
9. Automated security, migration, concurrency, recovery, and platform tests.
