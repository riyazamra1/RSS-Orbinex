# RSS Orbinex — Product and Technical Requirements

**Document version:** 1.0  
**Status:** Baseline specification — proposed requirements pending validation  
**Product:** RSS Orbinex  
**Category:** Subscription-based invoicing, inventory, and accounting management SaaS  
**Primary database:** PostgreSQL  
**Backend:** Shared, versioned API for the web application and future Windows desktop application  
**File storage:** Provider-switchable adapter supporting Oracle Cloud Infrastructure (OCI) Object Storage and Cloudflare R2  
**Hosting decision:** Compare OCI and Firebase for applicable services before deployment; do not use Firebase as the authoritative relational business database.

> This document defines the intended product and the acceptance baseline. Requirements marked **TBD** need a business decision before the affected feature is considered production-ready. Technical choices described as proposed are not proof that infrastructure has been provisioned or that a feature has been implemented.

## 1. Product vision and goals

RSS Orbinex will provide small and medium-sized businesses with a secure, dependable system to manage customers, suppliers, quotations, sales invoices, purchases, stock, payments, expenses, and financial reports from one place.

The product must use a central backend API so that web, Windows, and Android clients share the same business rules, permissions, database, and subscription enforcement. It must support multiple independent customer businesses (tenants) without exposing one tenant's records to another.

### 1.1 Goals

- Reduce duplicate data entry across sales, purchases, inventory, and accounting.
- Produce consistent invoices, credit notes, statements, and reports from validated business data.
- Maintain traceable stock movements and financial transactions.
- Offer subscription plans and enforce plan limits server-side.
- Keep infrastructure costs low during early development while allowing controlled growth.
- Allow file-storage providers to be changed without rewriting business features.
- Support secure web access first and a Windows desktop client later through the same API.
- Make backups, recovery, auditing, testing, and operational monitoring part of the design.

### 1.2 Non-goals for the initial release

Unless explicitly approved later, the first release does not promise:

- A full payroll, human resources, manufacturing, or point-of-sale hardware suite.
- Direct submission to every country's tax authority or guaranteed tax compliance in every jurisdiction.
- Bank-feed aggregation, automatic bank transfers, or payment processing without a selected provider.
- Offline operation that bypasses online authentication or guarantees conflict-free synchronization. Offline work is permitted only under the online-login, durable-local-queue, and domain-aware conflict rules in OFFLINE_SYNC_AND_REMOVABLE_BACKUP.md.
- AI-generated accounting entries without user review and explicit approval.
- Multi-currency revaluation or complex consolidation before the accounting rules are specified.
- A claim of certification, legal compliance, or guaranteed uptime that has not been independently verified.

## 2. Requirement conventions and priorities

Each requirement has a unique identifier and a priority:

- **MUST:** Required for the first production release or a fundamental safety/security constraint.
- **SHOULD:** Important; may be deferred only with a documented decision.
- **COULD:** Optional enhancement.
- **TBD:** A product or compliance decision is still required.

Requirements must be verified by automated tests, integration tests, security tests, documented manual acceptance tests, or a combination of these. A screen existing is not evidence that its underlying feature works.

## 3. Users, tenants, and permissions

### 3.1 User types

- **Platform administrator:** Operates the SaaS platform, manages plans and platform configuration, and investigates operational issues. Platform access must not automatically grant routine access to tenant financial data.
- **Business owner / tenant administrator:** Manages one business, its users, settings, subscription, and business records.
- **Accountant / finance user:** Manages permitted invoices, purchases, payments, accounts, and financial reports.
- **Sales user:** Manages permitted customers, quotations, sales invoices, and receipts.
- **Inventory / purchasing user:** Manages products, suppliers, purchase documents, and stock operations.
- **Read-only user / auditor:** Views explicitly permitted records and reports without changing them.
- **Future desktop client:** Uses the same authenticated API and authorization rules as the web client.

### 3.2 Authorization requirements

- **AUTH-001 (MUST):** Enforce role-based access control on the server for every protected API operation.
- **AUTH-002 (MUST):** Associate every tenant-owned business record with a tenant identifier.
- **AUTH-003 (MUST):** Derive tenant scope from the authenticated session/token and validated membership, not from an untrusted client-supplied tenant ID alone.
- **AUTH-004 (MUST):** Prevent cross-tenant reads, writes, searches, exports, file access, and indirect access through related records.
- **AUTH-005 (MUST):** Deny by default; a hidden or disabled UI control is not an authorization boundary.
- **AUTH-006 (MUST):** Apply least privilege to platform support tools and log privileged access.
- **AUTH-007 (SHOULD):** Support configurable roles and permissions without requiring separate code paths for each customer.
- **AUTH-008 (MUST):** Revoke or expire sessions after logout, credential reset, account disablement, or other defined security events.
- **AUTH-009 (MUST):** Test tenant isolation and permission boundaries in automated integration tests.

## 4. Functional requirements

### 4.1 Identity and account security

- **ID-001 (MUST):** Support secure account registration or administrator-provisioned accounts, sign-in, sign-out, and email verification where email is used for identity.
- **ID-002 (MUST):** Provide a secure password-reset flow with short-lived, single-use tokens and non-enumerating responses.
- **ID-003 (MUST):** Hash passwords with a modern, maintained password-hashing algorithm and safe parameters; never store plaintext passwords.
- **ID-004 (MUST):** Rate-limit login, password reset, verification, and other abuse-prone endpoints.
- **ID-005 (SHOULD):** Support multi-factor authentication, preferably for platform administrators and tenant administrators.
- **ID-006 (MUST):** Record security-relevant events such as failed sign-ins, credential changes, session revocation, and privileged actions without logging passwords, secrets, or authentication tokens.
- **ID-007 (MUST):** Provide account disablement and session revocation.
- **ID-008 (MUST):** Use secure, HTTP-only, SameSite cookies for browser sessions where cookie-based authentication is chosen; protect state-changing requests against CSRF. If bearer tokens are used, define secure storage, expiry, rotation, and revocation.

### 4.2 Tenant onboarding and business profile

- **TEN-001 (MUST):** Allow an authorized user to create and configure a business profile, subject to subscription and platform rules.
- **TEN-002 (MUST):** Store business name, contact details, address, country, base currency, time zone, fiscal-year settings, and invoice numbering settings.
- **TEN-003 (MUST):** Allow business logo upload with validated type, size, and dimensions.
- **TEN-004 (MUST):** Support tenant user invitations, membership status, role assignment, and removal.
- **TEN-005 (MUST):** Apply tenant-specific settings consistently to documents, reports, dates, currency display, and permissions.
- **TEN-006 (SHOULD):** Support multiple business locations or warehouses under one tenant, subject to plan limits.
- **TEN-007 (MUST):** Prevent tenant deletion until an authorized, audited retention/deletion workflow is completed.

### 4.3 Customers and suppliers

- **CRM-001 (MUST):** Create, view, edit, search, filter, archive, and export authorized customer records.
- **CRM-002 (MUST):** Create, view, edit, search, filter, archive, and export authorized supplier records.
- **CRM-003 (MUST):** Store appropriate names, contact information, addresses, tax identifiers where applicable, payment terms, notes, and active/archive status.
- **CRM-004 (MUST):** Validate required fields and normalize searchable fields consistently.
- **CRM-005 (SHOULD):** Detect likely duplicate customer or supplier records and let authorized users resolve them safely.
- **CRM-006 (MUST):** Preserve historical document references when a customer or supplier is archived; do not cascade-delete financial history.

### 4.4 Products and inventory

- **INV-001 (MUST):** Maintain products/services with unique tenant-scoped SKU or code, name, description, unit of measure, selling price, purchase cost, tax category, and active status as applicable.
- **INV-002 (MUST):** Support stock-tracked and non-stock/service items as distinct product types.
- **INV-003 (MUST):** Track on-hand quantity by product and, when enabled, by warehouse/location.
- **INV-004 (MUST):** Record stock receipts, issues, sales, purchase receipts, returns, transfers, and approved adjustments as traceable stock movements.
- **INV-005 (MUST):** Derive stock balances from a consistent movement ledger or maintain balances transactionally with reconciliation checks. A document must not update stock twice when retried.
- **INV-006 (MUST):** Support configurable low-stock thresholds and low-stock reporting.
- **INV-007 (MUST):** Validate negative-stock behavior according to a tenant setting. The default should prevent negative stock unless an authorized user explicitly enables it.
- **INV-008 (MUST):** Require a reason and actor for manual stock adjustments.
- **INV-009 (SHOULD):** Support barcode fields and barcode-based lookup; hardware-specific scanning can be added later.
- **INV-010 (SHOULD):** Support batch/expiry/serial tracking only after the data model and acceptance rules are defined.
- **INV-011 (MUST):** Provide stock valuation using a documented costing method. The initial costing method is **TBD** and must be selected before inventory valuation is treated as accounting-grade.
- **INV-012 (MUST):** Handle stock changes and the related sale/purchase transaction atomically or through a reliable, idempotent workflow.
- **INV-013 (MUST):** Provide stock movement history and reconciliation reports.

### 4.5 Quotations, sales, and invoicing

- **SAL-001 (MUST):** Create, edit drafts, preview, approve/finalize, search, filter, and retrieve quotations and sales invoices.
- **SAL-002 (MUST):** Support line items, quantities, unit prices, discounts, taxes, shipping/other charges, notes, due dates, and payment terms where applicable.
- **SAL-003 (MUST):** Calculate line totals, tax, discounts, document totals, and balances on the server using decimal-safe arithmetic and a documented rounding policy.
- **SAL-004 (MUST):** Recalculate and validate totals on the server; never trust totals supplied by the client.
- **SAL-005 (MUST):** Assign unique, tenant-scoped document numbers using concurrency-safe numbering rules and configurable prefixes/periods.
- **SAL-006 (MUST):** Prevent ordinary users from silently modifying finalized invoices. Corrections must use an audited amendment, cancellation, return, or credit-note workflow.
- **SAL-007 (MUST):** Support invoice statuses such as draft, issued, partially paid, paid, overdue, void/cancelled where legally and operationally permitted.
- **SAL-008 (MUST):** Generate printable/downloadable PDF invoices and quotations with tenant branding and consistent totals.
- **SAL-009 (MUST):** Support conversion of an accepted quotation to an invoice without duplicating or losing line details.
- **SAL-010 (MUST):** Support credit notes and sales returns with linked source documents and correct stock/accounting effects.
- **SAL-011 (SHOULD):** Email documents through a configurable provider with delivery status and retry handling.
- **SAL-012 (MUST):** Provide customer statements and invoice aging.
- **SAL-013 (MUST):** Ensure document retries and repeated requests do not create duplicate invoices, stock movements, or ledger postings.
- **SAL-014 (MUST):** Keep a snapshot of relevant customer details, item descriptions, prices, tax rates, and terms on finalized documents so later master-data changes do not rewrite history.

### 4.6 Purchases and supplier documents

- **PUR-001 (MUST):** Create and manage purchase orders, supplier bills, purchase receipts, and supplier returns according to configured workflows.
- **PUR-002 (MUST):** Calculate purchase totals and tax on the server using the same defined decimal and rounding rules.
- **PUR-003 (MUST):** Receive stock against a purchase document without duplicating receipt quantities on retries.
- **PUR-004 (MUST):** Track supplier balances, due dates, and payment status.
- **PUR-005 (MUST):** Support purchase returns and link them to source documents.
- **PUR-006 (MUST):** Preserve audit history for changes to finalized supplier bills and stock-affecting documents.

### 4.7 Payments, expenses, and cash/bank records

- **PAY-001 (MUST):** Record customer receipts, supplier payments, refunds, and payment allocations.
- **PAY-002 (MUST):** Support partial payments and multiple allocations where valid.
- **PAY-003 (MUST):** Prevent over-allocation beyond permitted outstanding balances unless a documented advance/credit workflow applies.
- **PAY-004 (MUST):** Support payment methods such as cash, bank transfer, card, and other tenant-configured methods without implying that the app processes the payment itself.
- **PAY-005 (MUST):** Record expenses with date, category, amount, payment account/method, reference, attachment if applicable, and notes.
- **PAY-006 (MUST):** Maintain a traceable record of reversals/refunds instead of deleting posted payments.
- **PAY-007 (SHOULD):** Support cash and bank accounts with opening balances and transfers.
- **PAY-008 (SHOULD):** Provide a bank reconciliation workflow with imported statement lines and user-confirmed matches; bank-feed integrations are out of scope until a provider is selected.

### 4.8 Accounting ledger and financial reporting

- **ACC-001 (MUST):** Define a chart of accounts before claiming full double-entry accounting.
- **ACC-002 (MUST):** If double-entry accounting is enabled, each posted journal must balance: total debits equal total credits in the transaction currency and applicable base currency rules.
- **ACC-003 (MUST):** Keep posted journal entries immutable; correct them using linked reversal and replacement entries.
- **ACC-004 (MUST):** Define posting rules for sales, purchases, receipts, payments, taxes, inventory cost, returns, and adjustments before enabling automatic posting.
- **ACC-005 (MUST):** Provide trial balance, general ledger, profit and loss, balance sheet, accounts receivable, accounts payable, cash/bank, sales, purchase, expense, and inventory reports as their underlying modules become production-ready.
- **ACC-006 (MUST):** Ensure reports use a defined date basis, fiscal period, tenant time zone, and currency basis.
- **ACC-007 (MUST):** Provide report filters and CSV/PDF export with tenant authorization and export audit events.
- **ACC-008 (MUST):** Reconcile subledgers (receivables, payables, inventory) to the general ledger when those modules are enabled.
- **ACC-009 (MUST):** Restrict closed accounting periods; reopening must require permission, reason, and audit entry.
- **ACC-010 (TBD):** Decide whether the first release includes full double-entry accounting or only operational financial summaries. Do not label the product a complete accounting system until the ledger and posting rules pass acceptance tests.
- **ACC-011 (TBD):** Decide the initial base-currency and multi-currency policy, including exchange rates, gains/losses, rounding, and historical-rate retention.
- **ACC-012 (TBD):** Decide supported jurisdictions, tax schemes, inclusive/exclusive tax behavior, exemptions, and legally required document fields. Tax behavior must be configurable and reviewed by a qualified local professional before production use.

### 4.9 Search, dashboards, and notifications

- **DASH-001 (MUST):** Provide a tenant-scoped dashboard with key metrics such as sales, outstanding receivables, payables, stock alerts, and recent activity.
- **DASH-002 (MUST):** Derive dashboard figures from authoritative stored records and display the selected date range and currency.
- **DASH-003 (MUST):** Provide consistent search, pagination, filtering, and sorting for major lists.
- **DASH-004 (MUST):** Enforce authorization and tenant scope in search results and exports.
- **DASH-005 (SHOULD):** Provide in-app notifications for overdue invoices, low stock, subscription events, and relevant system messages.
- **DASH-006 (SHOULD):** Support configurable reminders without sending duplicate messages on retries.

### 4.10 Files and document storage

- **FILE-001 (MUST):** Route file operations through a storage abstraction; business modules must not depend directly on OCI or R2 SDK details.
- **FILE-002 (MUST):** Implement provider adapters for OCI Object Storage and Cloudflare R2, with a configuration-based active provider.
- **FILE-003 (MUST):** Store file metadata, tenant ownership, provider/object key, size, MIME type, checksum, upload actor, and timestamps in PostgreSQL.
- **FILE-004 (MUST):** Keep buckets private by default. Grant temporary, narrowly scoped access through short-lived signed URLs or authenticated download endpoints.
- **FILE-005 (MUST):** Validate allowed file types and sizes, use generated object keys, and prevent path traversal and unsafe content handling.
- **FILE-006 (MUST):** Do not expose provider credentials or unrestricted object-store URLs to clients.
- **FILE-007 (MUST):** Make provider switching a controlled migration: copy objects, verify checksums and counts, update metadata, test reads, and retain rollback capability until verified.
- **FILE-008 (MUST):** Do not assume OCI and R2 have identical API behavior, consistency semantics, egress costs, or lifecycle features; test each adapter independently.
- **FILE-009 (SHOULD):** Apply retention rules to temporary exports and generated files.
- **FILE-010 (MUST):** Ensure file downloads independently validate tenant ownership and permissions, even when a URL or object key is guessed.

### 4.11 Subscription plans and SaaS administration

- **SUB-001 (MUST):** Support configurable plans with price, billing interval, allowed features, user limits, record/storage quotas, and other limits.
- **SUB-002 (MUST):** Enforce entitlements and quotas on the backend, not solely in the UI.
- **SUB-003 (MUST):** Provide trial, active, past-due, suspended, cancelled, and expired states as applicable to the chosen billing model.
- **SUB-004 (MUST):** Define what happens when a subscription expires: read-only access, grace period, export access, and data retention must be explicit.
- **SUB-005 (MUST):** Keep billing events idempotent and verify webhook signatures when a payment provider is integrated.
- **SUB-006 (MUST):** Do not store raw card details. Use a compliant payment provider if card payments are introduced.
- **SUB-007 (MUST):** Provide platform administration for plans, tenant status, subscription status, quotas, and operational support actions, with audit logs.
- **SUB-008 (SHOULD):** Support invoices/receipts for subscription charges and customer-visible usage.
- **SUB-009 (TBD):** Select payment provider, supported currencies, billing country, taxes, refund policy, and subscription terms before paid launch.
- **SUB-010 (MUST):** A subscription change must not silently delete tenant financial data.

### 4.12 Audit, import, export, and data lifecycle

- **AUD-001 (MUST):** Record audit events for creation, modification, finalization, cancellation, reversal, permission changes, subscription changes, exports, and privileged actions.
- **AUD-002 (MUST):** Include actor, tenant, timestamp, action, entity reference, request/correlation ID, and a safe change summary where appropriate.
- **AUD-003 (MUST):** Protect audit records from ordinary tenant-user modification and deletion.
- **AUD-004 (MUST):** Avoid logging secrets, passwords, full authentication tokens, or unnecessary sensitive data.
- **DATA-001 (MUST):** Provide authorized data export for relevant tenant records in documented formats.
- **DATA-002 (SHOULD):** Provide validated CSV import for customers, suppliers, products, and opening balances with preview, error reporting, and duplicate handling.
- **DATA-003 (MUST):** Make destructive bulk operations previewable, permission-checked, and auditable.
- **DATA-004 (MUST):** Define retention, backup, tenant closure, deletion, and export policies consistent with applicable law and customer contracts.
- **DATA-005 (MUST):** Use database transactions or durable workflows for operations that update multiple related records.
- **DATA-006 (MUST):** Store timestamps consistently (UTC internally) and display them using the tenant's configured time zone.

## 5. Technical architecture requirements

### 5.1 Architecture principles

- **ARCH-001 (MUST):** Use a client-server architecture. Web and future desktop clients must call the same versioned backend API.
- **ARCH-002 (MUST):** The backend is the sole trusted enforcement point for business rules, tenant authorization, subscription entitlements, calculations, and finalization.
- **ARCH-003 (MUST):** PostgreSQL is the authoritative relational database for business records, tenancy, subscriptions, audit metadata, and file metadata.
- **ARCH-004 (MUST):** Do not connect web or desktop clients directly to PostgreSQL.
- **ARCH-005 (MUST):** Do not put database credentials, cloud storage keys, billing secrets, or signing secrets in client bundles or source control.
- **ARCH-006 (SHOULD):** Prefer a modular monolith for the first release unless a measured need justifies separately deployed services.
- **ARCH-007 (MUST):** Separate domain logic from provider-specific storage, email, payment, and hosting integrations.
- **ARCH-008 (MUST):** Maintain architecture decision records for significant decisions and document trade-offs.

### 5.2 Infrastructure selection

- **INF-001 (MUST):** Compare OCI and Firebase based on real workload, free-tier eligibility, region availability, database needs, backup/recovery, operational effort, network/egress, and total monthly cost.
- **INF-002 (MUST):** Use PostgreSQL for core relational business data. Firebase may be used only for a clearly justified supporting capability; it is not the source of truth for invoices, inventory, or the accounting ledger.
- **INF-003 (SHOULD):** Evaluate OCI compute for the backend and PostgreSQL where region, capacity, eligibility, security, and operations are acceptable.
- **INF-004 (MUST):** Treat free-tier availability and pricing as variable and subject to provider terms; do not assume production hosting will remain free.
- **INF-005 (MUST):** Estimate recurring costs for compute, database storage, backups, object storage, egress, logs, email, domain, monitoring, and payment fees before launch.
- **INF-006 (MUST):** Keep infrastructure provisioning reproducible and document environment-specific settings.
- **INF-007 (MUST):** Separate development, staging, and production environments and credentials.

### 5.3 Backend API

- **API-001 (MUST):** Expose documented, versioned HTTP APIs using HTTPS in production.
- **API-002 (MUST):** Define consistent request validation, response schemas, pagination, sorting, error codes, and correlation IDs.
- **API-003 (MUST):** Return safe error messages without stack traces, SQL details, credentials, or internal infrastructure data.
- **API-004 (MUST):** Use database transactions and idempotency keys for critical create/post/pay operations where clients may retry.
- **API-005 (MUST):** Apply request size limits, rate limits, input validation, and abuse protection.
- **API-006 (MUST):** Document endpoints using an API specification such as OpenAPI.
- **API-007 (MUST):** Maintain backward-compatible API changes where possible; use explicit versioning and a deprecation process for breaking changes.
- **API-008 (SHOULD):** Provide health/readiness endpoints that do not disclose sensitive internal details.
- **API-009 (MUST):** Generate request IDs and structured logs to trace failures across API and background jobs.

### 5.4 PostgreSQL data design

- **DB-001 (MUST):** Use supported PostgreSQL versions and apply security updates through a documented maintenance process.
- **DB-002 (MUST):** Define relational constraints, foreign keys, unique constraints, and indexes for critical business invariants.
- **DB-003 (MUST):** Use exact decimal/numeric types for money and quantities requiring exact decimal representation; do not use binary floating-point for financial totals.
- **DB-004 (MUST):** Store currency codes and define precision/rounding per currency and tax rule.
- **DB-005 (MUST):** Use tenant-aware uniqueness where appropriate, such as document numbers and product codes.
- **DB-006 (MUST):** Prevent tenant scoping bugs using explicit repository/service checks and, where practical, PostgreSQL row-level security as defense in depth.
- **DB-007 (MUST):** Manage schema changes with versioned migrations and a tested rollback/forward-recovery strategy.
- **DB-008 (MUST):** Keep development seed data synthetic; never copy production customer data into development without an approved anonymization process.
- **DB-009 (MUST):** Test concurrent document numbering, stock updates, payment allocation, and ledger posting for race conditions.
- **DB-010 (MUST):** Never use cascading deletes that erase finalized financial history or audit evidence.

### 5.5 Frontend and user experience

- **UI-001 (MUST):** Provide a responsive web interface for supported modern browsers on desktop, tablet, and mobile.
- **UI-002 (MUST):** Use consistent navigation, forms, tables, filters, loading states, empty states, validation messages, confirmation dialogs, and error handling.
- **UI-003 (MUST):** Provide clear distinction between draft and finalized records and visibly indicate destructive or irreversible actions.
- **UI-004 (MUST):** Support keyboard navigation, visible focus, accessible labels, sufficient contrast, and semantic controls.
- **UI-005 (SHOULD):** Target WCAG 2.2 AA for core user journeys.
- **UI-006 (MUST):** Use the backend as the source of truth for totals, permissions, quotas, and statuses.
- **UI-007 (MUST):** Do not show success until the server confirms a write operation.
- **UI-008 (SHOULD):** Support configurable branding and document templates within safe limits.
- **UI-009 (MUST):** Display actionable, non-sensitive error messages and preserve safe form input after recoverable errors where practical.

### 5.6 Windows and Android clients

- **DESK-001 (MUST):** Windows and Android clients must use the shared versioned API and the same server-side business rules, permission checks, tenant isolation, and subscription enforcement.
- **DESK-002 (MUST):** Login requires internet connectivity. A fresh app launch while offline must keep the normal workspace locked until online revalidation and required synchronization complete.
- **DESK-003 (MUST):** During a previously authenticated session, support only explicitly designed offline operations; persist each change and its sync-queue entry atomically in encrypted local storage.
- **DESK-004 (MUST):** Automatically synchronize queued operations after connectivity returns, with stable idempotency IDs, durable cursors, server-side validation, and accounting-aware conflict handling.
- **DESK-005 (MUST):** Preserve unacknowledged local operations across crashes, power loss, logout attempts, and app updates. Never silently discard pending operations.
- **DESK-006 (MUST):** Store credentials and encryption keys using platform-protected facilities; never embed backend secrets in client packages.
- **DESK-007 (MUST):** Define signed release artifacts, update verification, rollback, and a secure update channel before distribution.
- **DESK-008 (MUST):** Removable-drive backup is optional and administrator-controlled. Keep the active local database in app-managed storage; encrypt and verify backups, and test restore before release.
- **DESK-009 (MUST):** Do not claim offline, recovery, synchronization, or removable-drive backup support until the dedicated acceptance tests pass. See OFFLINE_SYNC_AND_REMOVABLE_BACKUP.md.

## 6. Security and privacy requirements

- **SEC-001 (MUST):** Require HTTPS/TLS for production traffic and secure configuration for all service-to-service connections.
- **SEC-002 (MUST):** Store secrets in a managed secret store or protected environment configuration; rotate credentials and restrict access.
- **SEC-003 (MUST):** Validate and normalize all untrusted input on the server; use parameterized database queries and context-appropriate output encoding.
- **SEC-004 (MUST):** Protect against broken access control, injection, CSRF where relevant, XSS, SSRF, unsafe file uploads, replay, and abuse of expensive endpoints.
- **SEC-005 (MUST):** Apply least-privilege database, operating-system, cloud, and support permissions.
- **SEC-006 (MUST):** Encrypt data in transit and use provider-supported encryption at rest for database, backups, and object storage.
- **SEC-007 (MUST):** Define a threat model and review tenant isolation, account takeover, privileged access, document tampering, and storage access.
- **SEC-008 (MUST):** Run dependency and secret scanning in CI. Block commits containing live secrets.
- **SEC-009 (MUST):** Maintain a vulnerability response process, supported dependency policy, and security patch workflow.
- **SEC-010 (MUST):** Audit administrative access and sensitive exports; limit support access to the minimum necessary.
- **SEC-011 (MUST):** Define privacy notices, lawful processing, retention, data-subject handling, and incident response for the actual launch jurisdictions.
- **SEC-012 (MUST):** Never claim compliance with a law or standard until applicability and implementation have been reviewed and verified.

## 7. Non-functional requirements and service targets

The targets below are initial engineering goals, not a guarantee of production service levels. They must be validated against the selected hosting tier and expected workload.

### 7.1 Performance and capacity

- **NFR-PERF-001 (SHOULD):** Under the agreed baseline workload, 95% of ordinary read API requests should complete within 500 ms, excluding network latency outside the service.
- **NFR-PERF-002 (SHOULD):** Under the agreed baseline workload, 95% of ordinary write API requests should complete within 800 ms, excluding external provider delays.
- **NFR-PERF-003 (MUST):** PDF generation and report queries must have defined timeouts and resource limits; large exports should run asynchronously.
- **NFR-PERF-004 (MUST):** Establish and record baseline throughput, concurrency, database size, and tenant counts before production launch.
- **NFR-PERF-005 (MUST):** Test performance using representative synthetic data and publish the tested workload and results.

### 7.2 Availability, backup, and recovery

- **NFR-REL-001 (MUST):** Provide automated database backups on a documented schedule.
- **NFR-REL-002 (MUST):** Encrypt backups and restrict access independently from the production application.
- **NFR-REL-003 (MUST):** Perform and document restore drills before production and periodically thereafter.
- **NFR-REL-004 (MUST):** Define approved recovery point objective (RPO) and recovery time objective (RTO) before production. Initial proposed targets are RPO of 24 hours or better and RTO of 8 hours or better; confirm these against cost and business needs.
- **NFR-REL-005 (MUST):** Monitor service health, database capacity, backup success, disk usage, error rates, and certificate expiry.
- **NFR-REL-006 (MUST):** Fail safely when a dependency is unavailable; do not report an uncommitted transaction as successful.
- **NFR-REL-007 (SHOULD):** Define a production availability target after selecting the deployment architecture and support budget.

### 7.3 Maintainability and delivery

- **NFR-MAINT-001 (MUST):** Use automated tests for business calculations, authorization, tenant isolation, inventory movements, payment allocation, and ledger balancing.
- **NFR-MAINT-002 (MUST):** Require code review for changes to authentication, authorization, money calculations, migrations, subscription enforcement, and storage access.
- **NFR-MAINT-003 (MUST):** Run linting, type checks where supported, unit tests, integration tests, and dependency/security checks in CI.
- **NFR-MAINT-004 (MUST):** Keep setup, environment variables, migrations, deployment, backup, restore, and incident procedures documented.
- **NFR-MAINT-005 (MUST):** Use structured, redacted logs and metrics; do not log unnecessary customer financial or personal information.
- **NFR-MAINT-006 (MUST):** Provide repeatable deployment and database migration steps for staging and production.

### 7.4 Accessibility, compatibility, and usability

- **NFR-UX-001 (SHOULD):** Target WCAG 2.2 AA for critical workflows.
- **NFR-UX-002 (MUST):** Test the supported browser matrix and screen sizes before each production release.
- **NFR-UX-003 (MUST):** Display dates, number formats, currencies, and time zones consistently with tenant settings.
- **NFR-UX-004 (MUST):** Prevent silent data loss during navigation, session expiry, or recoverable API failures wherever practical.

### 7.5 Cost efficiency

- **NFR-COST-001 (MUST):** Track estimated and actual infrastructure costs by environment and provider.
- **NFR-COST-002 (MUST):** Define usage quotas and alerts for compute, database, storage, egress, email, logs, and backups.
- **NFR-COST-003 (MUST):** Provide a documented migration path for storage providers and avoid provider-specific object keys in business logic.
- **NFR-COST-004 (SHOULD):** Prefer a simple modular deployment until measured scale or reliability needs justify additional services.
- **NFR-COST-005 (MUST):** Do not rely on an unverified free-tier assumption for financial projections or paid-service promises.

## 8. API and integration contracts

- **INT-001 (MUST):** Document authentication, tenant resolution, pagination, error schema, idempotency, and API versioning.
- **INT-002 (MUST):** Define stable API contracts for identity, tenant settings, customers, suppliers, products, stock, sales, purchases, payments, reports, subscriptions, and files.
- **INT-003 (MUST):** Validate webhooks, prevent replay/duplicate processing, and record processing status if external billing or email providers are used.
- **INT-004 (MUST):** Use retry with backoff for transient external failures and a dead-letter/manual recovery path for durable background jobs.
- **INT-005 (MUST):** Define timeouts and maximum payload sizes for all external calls.
- **INT-006 (MUST):** Provide a sandbox or test-mode integration configuration when a provider supports it.
- **INT-007 (MUST):** Keep a provider interface and contract tests for OCI Object Storage and Cloudflare R2.
- **INT-008 (TBD):** Select email provider, subscription payment provider, and any tax or bank integrations before implementing those integrations.

## 9. Core data entities

The final schema must be normalized appropriately and reviewed before implementation. At minimum, evaluate these entities:

- Identity: User, Session/RefreshToken (as applicable), Invitation, Role, Permission, TenantMembership.
- Tenant configuration: Tenant, BusinessProfile, Location/Warehouse, NumberingSequence, FiscalPeriod, TaxConfiguration, CurrencyConfiguration.
- Commercial: Customer, Supplier, Product, UnitOfMeasure, Price/Tax snapshot.
- Sales: Quotation, QuotationLine, SalesInvoice, SalesInvoiceLine, CreditNote, SalesReturn.
- Purchasing: PurchaseOrder, SupplierBill, PurchaseReceipt, PurchaseReturn.
- Inventory: StockMovement, StockBalance (if maintained), StockAdjustment, StockTransfer, StockValuationLayer if required by the selected costing method.
- Payments: Payment, PaymentAllocation, Refund, CashBankAccount, BankStatementLine if reconciliation is implemented.
- Accounting: Account, JournalEntry, JournalLine, PostingRule, PeriodClose, Reconciliation.
- SaaS: Plan, PlanEntitlement, Subscription, SubscriptionEvent, UsageCounter, BillingInvoice/Receipt.
- Files and operations: StoredFile, AuditEvent, BackgroundJob, IdempotencyRecord, SystemConfiguration.
- Most tenant-owned entities require tenant ownership, created/updated timestamps, and appropriate actor references.

## 10. Business rules and financial integrity

- **FIN-001 (MUST):** Use one documented rounding policy across previews, finalized documents, payments, exports, and reports.
- **FIN-002 (MUST):** Store finalized transaction values as immutable snapshots where later master-data changes would otherwise alter history.
- **FIN-003 (MUST):** Use database transactions for operations that must succeed or fail together.
- **FIN-004 (MUST):** Use idempotency keys or equivalent deduplication for retryable financial and stock-changing operations.
- **FIN-005 (MUST):** Do not hard-delete posted invoices, payments, stock movements, or journals; use controlled cancellation, return, or reversal workflows.
- **FIN-006 (MUST):** Provide reconciliation checks that detect discrepancies between source documents, stock balances, payment allocations, and accounting postings.
- **FIN-007 (MUST):** Keep invoice numbering, posting sequence, and audit sequence safe under concurrent requests.
- **FIN-008 (MUST):** Define how rounding differences, refunds, deposits, write-offs, overpayments, and partial returns are handled before release.
- **FIN-009 (MUST):** All calculations must be independently tested with boundary cases, fractional quantities, discounts, taxes, returns, and currency precision.
- **FIN-010 (MUST):** Never silently change finalized historical amounts after a tax, price, product, or customer setting changes.

## 11. Testing and acceptance

### 11.1 Required test layers

- Unit tests for calculations, validation, status transitions, permission decisions, and domain rules.
- Integration tests against a real PostgreSQL test instance for constraints, transactions, migrations, and concurrency.
- API tests for schemas, authentication, authorization, rate limits, idempotency, and error responses.
- End-to-end tests for critical workflows in the web client.
- Tenant-isolation tests across list, detail, search, reports, exports, files, background jobs, and admin/support actions.
- Security tests for common web vulnerabilities, session handling, upload/download access, and secret leakage.
- Backup restoration and disaster-recovery exercises.
- Storage adapter contract tests against each configured provider or its supported test environment.
- Regression tests for all resolved defects affecting financial or stock correctness.

### 11.2 Minimum release acceptance criteria

A release must not be considered production-ready until:

1. All MUST requirements in the release scope are implemented or explicitly blocked by a documented decision.
2. No known critical or high-severity security defect remains unresolved without formal risk acceptance.
3. Automated tests pass in CI and migrations succeed on a clean database and a representative upgrade path.
4. Tenant-isolation and role-permission tests pass.
5. Financial calculations, stock movements, payment allocations, and (if enabled) ledger postings pass reconciliation tests.
6. Backup restoration has been demonstrated and recovery instructions are accessible to authorized operators.
7. Production secrets are absent from source control and client bundles.
8. Monitoring, error reporting, operational runbooks, and rollback/recovery procedures are in place.
9. The supported browser matrix and critical user journeys have been tested.
10. Billing, privacy, tax, and data-retention decisions required for the target launch jurisdiction are reviewed and documented.

### 11.3 Definition of done for a feature

A feature is complete only when its requirements are linked to implementation and tests, authorization and tenant isolation are verified, errors and loading states are handled, audit requirements are met, documentation is updated, and acceptance criteria pass. A visual mockup or placeholder endpoint alone is not complete.

## 12. Delivery roadmap

Order may change based on technical findings, but dependencies must be respected.

### Phase 0 — Decisions and foundation

- Confirm hosting and deployment options, target jurisdiction, currency/tax scope, accounting depth, payment provider, and subscription rules.
- Establish repository conventions, environments, secret management, CI, test strategy, and database migration workflow.
- Create architecture decision records and initial threat model.

### Phase 1 — Secure platform foundation

- Implement identity, tenant membership, role-based authorization, audit events, tenant configuration, and PostgreSQL migrations.
- Implement versioned API conventions, structured logs, rate limits, backup automation, and health checks.
- Prove cross-tenant isolation with tests before adding broad business functionality.

### Phase 2 — Core business operations

- Implement customers, suppliers, products, stock movements, quotations, sales invoices, purchase documents, and PDF output.
- Add payments, allocations, returns, and reconciliation.
- Implement file storage through the provider adapter.

### Phase 3 — Accounting and SaaS billing

- Finalize chart of accounts, posting rules, costing method, fiscal periods, currencies, and tax behavior.
- Implement ledger posting and financial reports if full double-entry accounting is in the launch scope.
- Implement plans, trials, quotas, subscription state transitions, and the selected payment provider.

### Phase 4 — Production hardening

- Complete security testing, performance testing, restore drills, cost review, operational runbooks, and user acceptance testing.
- Resolve all release-blocking defects and verify production deployment/rollback.

### Phase 5 — Desktop and expansion

- Build Windows and Android clients on the shared API and platform-protected local storage.
- Implement the approved offline-session, synchronization, recovery, and removable-drive backup requirements in OFFLINE_SYNC_AND_REMOVABLE_BACKUP.md; release only after acceptance tests pass.
- Expand integrations and advanced features based on customer evidence and validated requirements.

## 13. Open decisions requiring explicit approval

| ID | Decision | Why it matters |
|---|---|---|
| OQ-001 | Initial target market and applicable jurisdiction(s) | Tax rules, invoice fields, privacy, retention, and localization |
| OQ-002 | Initial currency and multi-currency scope | Precision, exchange rates, and reporting rules |
| OQ-003 | Full double-entry accounting in first release or phased later | Ledger schema, posting rules, reconciliation, and release claims |
| OQ-004 | Inventory costing method | Stock valuation and cost-of-goods-sold accuracy |
| OQ-005 | Tax calculation rules and local review | Legal accuracy and document validity |
| OQ-006 | Backend language/framework and frontend stack | Build, deployment, hiring, and maintenance |
| OQ-007 | OCI vs alternative backend hosting | Cost, operations, region, reliability, and recovery |
| OQ-008 | Managed PostgreSQL vs self-managed PostgreSQL | Cost vs backup, patching, availability, and operational burden |
| OQ-009 | Email provider and payment/subscription provider | Verification, notifications, billing, refunds, and webhooks |
| OQ-010 | Subscription prices, plans, trials, quotas, and grace period | Entitlement enforcement and customer terms |
| OQ-011 | Backup retention, RPO/RTO, and production availability target | Recovery capability and operating cost |
| OQ-012 | Client rollout order and platform-specific storage constraints | Windows/Android packaging, secure updates, removable-drive APIs, and platform validation |
| OQ-013 | Logo/branding and document-template customization | User experience and branding scope |
| OQ-014 | Data retention and tenant closure/export process | Contractual and jurisdictional obligations |

Until these decisions are approved, treat the affected items as proposed requirements, not finalized product behavior.

## 14. Traceability and change control

- Keep requirement IDs stable when wording changes; mark removed requirements as deprecated rather than reusing IDs.
- Link each implemented requirement to relevant code changes, tests, and release notes where practical.
- Record changes to financial rules, security boundaries, schema, providers, and subscription behavior in reviewable commits and architecture decision records.
- Update this document whenever an approved product decision changes scope or acceptance criteria.
- Do not mark a requirement complete based solely on a commit existing; verify behavior through tests and acceptance evidence.

## 15. Glossary

- **Tenant:** A customer business workspace with isolated data and settings.
- **SaaS:** Software delivered as a hosted subscription service.
- **RBAC:** Role-based access control.
- **API:** Application programming interface used by clients to access backend functionality.
- **Idempotency:** Repeating the same request safely without creating duplicate effects.
- **Ledger:** A record of financial postings used to produce accounting balances and reports.
- **RPO:** Recovery point objective; the acceptable amount of data loss measured in time.
- **RTO:** Recovery time objective; the target time to restore service after an incident.
- **OCI:** Oracle Cloud Infrastructure.
- **R2:** Cloudflare's object storage service.
