# RSS Orbinex — Implementation Status

**Updated:** 2026-10-17  
**Source of truth:** `REQUIREMENTS.md` and `OFFLINE_SYNC_AND_REMOVABLE_BACKUP.md`

This is an implementation tracker, not a declaration that the full product is production-ready. A route passing TypeScript/build/unit CI does not replace PostgreSQL integration, security, concurrency, recovery, or end-to-end testing.

## Build and website preview handoff

- [x] Added GitHub Actions workflow `.github/workflows/ci.yml` to install dependencies, run the ledger-based migration runner against a clean PostgreSQL 17 service, type-check, build, run API tests, and build the API container image.
- [x] Fixed a mismatched PostgreSQL dollar-quote terminator in `004_financial_integrity_guards.sql`, identified after the first migration CI run failed.
- [x] Verified corrected migrations, API type-check/build/tests, and Docker image build in GitHub Actions on `main` (run 38599160975, conclusion `success`, 2026-10-14). This is CI evidence, not yet proof of a deployed production environment.
- [x] Updated the RSS Apps website source to list RSS Orbinex, add homepage and project-detail links to the interactive preview, and validate the preview and navigation scripts.
- [ ] Confirm that the website hosting provider deploys the updated `RSS-Apps-Website` main branch and verify `https://rssapps.net/orbinex/` in a browser. GitHub source changes do not by themselves prove the live host has updated.
- [x] Added an API-connected static browser workspace in `apps/web/` with online login/session revalidation, customer/supplier/product create-and-list flows, draft invoice creation, invoice posting, customer payment recording with ledger posting, purchase-bill draft creation and posting, expense draft creation, payment lists, and ledger report views. API CI including migrations, type-check, build, tests, browser JavaScript validation, and container build passed at `b5c3d51`. Added an explicit API CORS origin allowlist via `WEB_ORIGINS` and a CI JavaScript/manifest validator.\n- [ ] Deploy the API/database and configure its HTTPS URL before the connected workspace can sign in on the public website; live sign-in and persisted end-to-end workflows are not yet verified.

## Full accounts-software acceptance scope (user-confirmed)

RSS Orbinex is required to become a complete accounts and business-management application, not only an invoice UI or dashboard. Completion must be verified by working end-to-end workflows, persisted PostgreSQL records, role/tenant enforcement, and automated tests.

- [ ] Sales: customers, quotations, invoices, configurable tax/discounts, PDF/print, credit notes, sales returns, customer statements, receivables aging, and immutable finalized-document snapshots.
- [ ] Inventory: products/services, SKUs, purchase receipts, stock ledger, transfers/adjustments, damaged-stock approvals/write-offs, low-stock alerts, returns, and an approved costing/valuation method.
- [~] Purchasing API: supplier purchase bills (draft create/list/detail, totals, posting, ledger entry, stock receipt movement, product cost update), supplier payments (partial/full payment, balance/currency/account validation, ledger posting, idempotency and audit). Purchase orders, separate receipt workflow, supplier returns, and supplier balance reconciliation remain outstanding. No end-to-end UI workflow is verified.
- [~] Payments API: customer invoice payments and supplier payments are implemented with transactional ledger posting and balance checks. Expense records now support draft creation, listing/detail, and posting to a balanced expense/cash-bank journal. Payment allocations across multiple invoices, refunds/reversals, cash/bank reconciliation, and reconciliation reports remain outstanding.
- [ ] Full double-entry accounting: chart of accounts, posting rules for each transaction type, immutable balanced journals, general ledger, trial balance, profit and loss, balance sheet, receivables/payables, and subledger reconciliation.
- [ ] Business controls: authentication lifecycle, role permissions, tenant isolation, audit log, fiscal periods, exports, backup/restore, subscription limits, and secure shared API access.
- [ ] Launch decisions still required before accounting-grade production claims: target tax jurisdiction and rules, base/multi-currency policy, inventory costing method, hosting/backup targets, and provider choices. Defaults must not be invented silently.

A module is not complete merely because a route or screen exists. It must pass its workflow, persistence, authorization, failure/retry, and reconciliation tests.

## Local-first development foundation

- [x] Added a Compose-managed PostgreSQL 17 database and Fastify API, both exposed only on `127.0.0.1`, with persistent local database storage and container health checks.
- [x] Added a Dockerfile and `.dockerignore`; local secrets are excluded from the image, and the runtime image prunes development dependencies.
- [x] Added a migration runner with a database ledger so successful migration files are skipped on subsequent local starts.
- [x] Added `LOCAL_DEVELOPMENT.md` with local setup, ordered migration, health-check, test, stop, and reset instructions.
- [x] Updated the example environment and API development/start scripts to load the root `.env` file without adding a third-party service or API key.
- [ ] Run the local setup on a real development machine and verify migrations, API readiness, and tests end to end. This has not been run from this repository connector session.

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
- [x] CI workflow runs API type-check, build, tests, migration checks, and container build. Purchase validation commits `3a52bd6` and `c48a92e` passed API CI and full Orbinex CI. Expense migration/API commits `aabf6b8`, `a256ca0`, `dabdbbe`, and route-auth test commit `b18911d` passed API CI and full Orbinex CI. CORS changes passed API CI at `c97fafd`; the newer browser workspace and static validation must pass the current run before they are treated as verified.

## Not yet production-ready

- [ ] Apply and verify migrations against a real PostgreSQL database; add migration automation and integration tests.
- [ ] Deploy the API and database with TLS, managed secrets, backups, monitoring, and tested restore procedures.
- [~] A separate API-connected client now exists at `RSS-Apps-Website/orbinex/app/` in source, while `RSS-Apps-Website/orbinex/` remains the clearly labelled browser-local demo. Website hosting/deployment and API/database connectivity still require verification.
- [ ] Complete email invitations/verification, password reset, MFA, device-management UI, and production account recovery.
- [ ] Add quotes, purchase orders/receipts, supplier returns, credit notes, and sales-return workflow. Supplier bill/payment and expense APIs now exist, but still need PostgreSQL integration and end-to-end workflow tests.
- [ ] Add invoice/quotation PDFs, printing, document storage adapters (OCI Object Storage / Cloudflare R2), and retention policies.
- [ ] Complete reports, including aged receivables/payables, inventory valuation using an approved costing method, profit and loss, balance sheet, and cash flow.
- [ ] Implement subscription plans, billing integration, tenant limits, platform administration, and server-side entitlement enforcement.
- [ ] Implement validated domain-aware sync that writes to business tables (current generic sync only records change events), plus encrypted durable offline queues for web/Windows/Android clients.
- [ ] Implement encrypted removable-drive backup/restore, Windows desktop client, and platform-specific acceptance tests.
- [ ] Add database-backed tests for tenant isolation, permission boundaries, concurrent stock/invoice/payment operations, idempotency replay/conflicts, and journal integrity.
- [ ] Connect and verify the API-backed UI at `https://rssapps.net/orbinex/` without replacing the existing `rssapps.net` root site.

## Deployment safety

No production database, API URL, secret configuration, or deployment target is assumed to exist. Do not expose the API publicly or run bootstrap until the server, PostgreSQL database, TLS, secrets, and migration state have been configured and reviewed.
