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
- Initial tenant, identity, device, idempotency, change-event, and audit schema

The API foundation is not yet a complete authentication system and must not be exposed publicly until authentication, authorization, rate limiting, migration tooling, and deployment security are implemented.

## Local API setup

1. Install Node.js 22 or newer and PostgreSQL.
2. Copy `.env.example` to `.env` and configure the database connection.
3. Create the development database and apply `apps/api/migrations/001_platform_foundation.sql`.
4. Run `npm install`.
5. Run `npm run dev:api`.
6. Check `http://127.0.0.1:4000/health/live` and `http://127.0.0.1:4000/health/ready`.

Do not use example settings in production. Production database connections must use TLS. Migrations should be reviewed and applied through a controlled migration process.

## Planned implementation order

1. Secure online authentication and tenant membership authorization.
2. Versioned API contracts and server-side idempotency.
3. Durable change feed and audited business transactions.
4. Encrypted local storage and outbox for Windows/Android clients.
5. Accounting-aware conflict resolution and automatic sync.
6. Administrator-controlled encrypted removable-drive backup and tested restore.
7. Switchable object storage adapters and document handling.
8. Automated security, migration, concurrency, recovery, and platform tests.
