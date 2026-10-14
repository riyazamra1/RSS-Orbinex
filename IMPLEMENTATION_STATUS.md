# RSS Orbinex — Implementation Status

**Updated:** 2026-10-14  
**Source of truth:** `REQUIREMENTS.md` and `OFFLINE_SYNC_AND_REMOVABLE_BACKUP.md`

This is an implementation tracker, not a declaration that the full product is production-ready. A route passing TypeScript/build/unit CI does not replace PostgreSQL integration, security, concurrency, recovery, or end-to-end testing.

## Implemented in the API repository

- [x] Fastify + TypeScript API foundation, PostgreSQL access, health/readiness routes, request rate limits, and security headers.
- [x] Online bearer-session login, session inspection, logout/revocation, Argon2id password verification, and tenant membership checks.
- [x] One-time bootstrap endpoint protected by `BOOTSTRAP_SECRET`; creates the first tenant and owner and seeds a starter chart of accounts.
- [x] Tenant member list/create/update endpoints; membership revocation revokes tenant sessions; prevents removing the last active owner and blocks administrator privilege escalation.
- [x] Tenant-scoped customer list/detail/create/update APIs with search, status, and pagination.
- [x] Tenant-scoped supplier list/detail/create/update APIs with search, status, and pagination.
- [x] Tenant-scoped product list/detail/create/update APIs, stock/service classification, stock balances, low-stock flags, and inventory movement history.
- [x] Idempotent stock movement recording with tenant checks, negative-stock prevention, audit records, and balance lookup; service items cannot receive stock movements.
- [x] Draft invoice creation, invoice list/detail, server-calculated totals, idempotency, and transactional invoice posting with stock deduction only for stock-tracked items.
- [x] Customer payment list/record APIs. Receiving a payment validates the remaining invoice balance and posts the payment plus balanced cash/receivables journal in one transaction.
- [x] Chart-of-accounts list/create, draft journal creation, balanced journal posting, and trial-balance reporting.
- [x] Tenant-scoped sync push/pull event-journal endpoints.
- [x] CI currently runs API type-check, build, and the existing test suite; latest API source commit was checked successfully by GitHub Actions.

## Not yet production-ready

- [ ] Apply and verify migrations against a real PostgreSQL database; add migration automation and integration tests.
- [ ] Deploy the API and database with TLS, managed secrets, backups, monitoring, and tested restore procedures.
- [ ] Connect the browser UI to the API. The temporary `RSS-Apps-Website/orbinex/` prototype still uses browser-local storage and is not a shared multi-user application.
- [ ] Complete email invitations/verification, password reset, MFA, device-management UI, and production account recovery.
- [ ] Add quotes, purchases, supplier payments, credit notes, sales-return workflow, and expense workflows.
- [ ] Add invoice/quotation PDFs, printing, document storage adapters (OCI Object Storage / Cloudflare R2), and retention policies.
- [ ] Complete reports, including aged receivables/payables, inventory valuation using an approved costing method, profit and loss, balance sheet, and cash flow.
- [ ] Implement subscription plans, billing integration, tenant limits, platform administration, and server-side entitlement enforcement.
- [ ] Implement validated domain-aware sync that writes to business tables (current generic sync only records change events), plus encrypted durable offline queues for web/Windows/Android clients.
- [ ] Implement encrypted removable-drive backup/restore, Windows desktop client, and platform-specific acceptance tests.
- [ ] Add database-backed tests for tenant isolation, permission boundaries, concurrent stock/invoice/payment operations, idempotency replay/conflicts, and journal integrity.
- [ ] Connect and verify the API-backed UI at `https://rssapps.net/orbinex/` without replacing the existing `rssapps.net` root site.

## Deployment safety

No production database, API URL, secret configuration, or deployment target is assumed to exist. Do not expose the API publicly or run bootstrap until the server, PostgreSQL database, TLS, secrets, and migration state have been configured and reviewed.
