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
- Online login, server-validated session inspection, and online logout endpoints
- Opaque random bearer sessions stored as SHA-256 hashes, with expiry and server-side revocation
- Argon2id password verification and API rate limiting
- Tenant-scoped sync push/pull endpoints using an append-only change journal
- Tenant-safe customer, supplier, product, invoice, payment, stock movement, return, damage, account, and journal schema (migration 003)
- Database guards for posted invoice immutability, append-only payments/stock movements, and balanced posted journals (migration 004)
- Transactional stock movement API with idempotent operation IDs, tenant checks, negative-stock prevention, audit events, and balance lookup
- Transactional sync batches, operation-ID idempotency, server-assigned entity versions, and role-based write allowlists
- Initial tenant, identity, device, session, idempotency, change-event, and audit schema

The API authentication foundation is not yet a complete production identity lifecycle. User provisioning, password reset, MFA, admin/device management UI, formal migration tooling, and deployment hardening remain pending. Do not expose the service publicly until those controls and production monitoring are complete.

## Local API setup

1. Install Node.js 22 or newer and PostgreSQL.
2. Copy `.env.example` to `.env` and configure the database connection.
3. Create the development database and apply migrations in order: `001_platform_foundation.sql`, `002_auth_sessions.sql`, `003_business_domain.sql`, then `004_financial_integrity_guards.sql`.
4. Run `npm install`.
5. Run `npm run dev:api`.
6. Check `http://127.0.0.1:4000/health/live` and `http://127.0.0.1:4000/health/ready`.

Do not use example settings in production. Production database connections must use TLS. Migrations should be reviewed and applied through a controlled migration process.

## Planned implementation order

1. Complete the identity lifecycle and administrator/device management.
2. Implement transactional invoice creation/posting, payment recording, balanced journal posting, and validated domain sync adapters.
3. Add conflict-aware rules for posted invoices, payments, stock movements, returns, and damages; then add Windows/Android durable outbox clients.
4. Encrypted local storage and outbox for Windows/Android clients.
5. Accounting-aware conflict resolution and automatic sync.
6. Administrator-controlled encrypted removable-drive backup and tested restore.
7. Switchable object storage adapters and document handling.
8. Automated security, migration, concurrency, recovery, and platform tests.
