# RSS Orbinex — Offline Synchronization and Removable-Drive Backup Requirements

**Document version:** 1.0  
**Status:** Approved architectural direction; implementation and platform validation still required  
**Applies to:** RSS Orbinex Windows desktop and Android clients, shared API, and PostgreSQL backend  
**Related specification:** [REQUIREMENTS.md](./REQUIREMENTS.md)

> This document extends the product requirements with the approved online-authentication, offline-work, recovery, synchronization, and removable-drive backup behavior. This document is a specification, not proof that these features have already been implemented.

## 1. Approved product behavior

1. **Internet is mandatory to log in.** The server authenticates the user and validates tenant membership, subscription, device/session status, and permissions before opening the normal workspace.
2. **Internet is mandatory to complete logout.** The client must obtain server confirmation of session termination/revocation. It must never falsely report that server logout succeeded while offline.
3. **An already authenticated session may continue during a temporary connection loss.** After successful online login and required initial synchronization, the user may perform supported offline operations. Changes must be durably saved locally and queued for synchronization.
4. **A fresh app launch while offline is blocked.** The app may show a connection/recovery screen and pending-change count, but must not unlock the normal workspace until internet returns, the server revalidates the account/session/device, and required recovery/synchronization checks pass.
5. **The server is authoritative.** PostgreSQL accessed through the shared API is the system of record. Local storage is a durable working and recovery store, not a replacement for the server.
6. **Pending local changes must never be silently discarded.** Failed sync, failed backup, logout, crash, power loss, app update, or removable-drive removal must not silently delete unacknowledged operations.
7. **Removable-drive backup is optional and administrator-controlled.** An administrator can enable backups to a supported removable drive and configure destination and policy.
8. **Do not run the active SQLite database directly from a removable drive.** Keep the active database in OS-managed app storage. The removable drive is a backup destination, not the default live database location.

## 2. Authorization boundaries

- Platform administrators operate platform infrastructure; platform access does not automatically grant routine access to tenant financial records.
- Tenant administrators may configure business-level users, devices where supported, and removable-drive backup policy.
- Users may access only records and modules authorized by server-side permissions.
- Every synchronized operation must be reauthorized by the server. Client-side controls are not security boundaries.
- A backup administrator's ability to configure backup policy does not grant additional permission to browse business data.

## 3. Authentication and workspace state

The client must distinguish these states: Signed out; Authenticating online; Authenticated—initial sync required; Workspace ready; Offline—current session active and changes queued; Syncing; Action required; Session expired/revoked—workspace locked; and Logout pending—server confirmation required.

### 3.1 Login and app launch

- **OFFAUTH-001 (MUST):** Login requires a live connection to the authenticated API.
- **OFFAUTH-002 (MUST):** Validate identity, tenant membership, subscription/entitlement state, device/session state, and permissions on the server.
- **OFFAUTH-003 (MUST):** Do not unlock the normal workspace before initial synchronization and required recovery checks finish.
- **OFFAUTH-004 (MUST):** After authentication, recover the durable local queue, reconcile previous pending operations, and perform required push/pull synchronization.
- **OFFAUTH-005 (MUST):** If an account is disabled, subscription policy blocks access, or a device/session is revoked, keep the workspace locked and preserve local pending data for authorized recovery.
- **OFFAUTH-006 (MUST):** Never store passwords or long-lived tokens in plaintext files, logs, preferences, or the business database.
- **OFFAUTH-007 (MUST):** Store session credentials using platform-protected storage such as Windows Credential Manager/DPAPI-backed protection or Android Keystore-backed storage, as appropriate.
- **OFFAUTH-008 (MUST):** Use TLS with certificate validation in production. Do not disable certificate checks to work around connectivity problems.
- **OFFAUTH-009 (MUST):** Provide actionable, non-sensitive errors for network failure, invalid credentials, expired sessions, disabled accounts, subscription restrictions, and sync failures.
- **OFFAUTH-010 (MUST):** If launched or restarted without internet, keep the normal workspace locked. Preserve local database, pending operations, conflict records, and recovery metadata.
- **OFFAUTH-011 (MUST):** Retry connectivity using bounded backoff, avoiding tight loops and excessive battery or data usage.
- **OFFAUTH-012 (MUST):** After connectivity returns, revalidate online, recover and synchronize pending operations, apply remote changes, and unlock only after required readiness checks pass.
- **OFFAUTH-013 (MUST):** If recovery or schema migration validation fails, do not open the database in an unsafe state. Preserve recoverable files and provide a safe recovery path.

### 3.2 Connection loss during an active session

- **OFFAUTH-014 (MUST):** Temporary internet loss after successful login must not erase locally committed changes.
- **OFFAUTH-015 (MUST):** While offline, allow only operations explicitly designed and tested for offline execution and permitted by local policy.
- **OFFAUTH-016 (MUST):** Show a persistent offline indicator and the number of unsynchronized operations.
- **OFFAUTH-017 (MUST):** When connectivity returns, revalidate the server session before protected synchronization and apply revocation/expiry rules.
- **OFFAUTH-018 (MUST):** If the server reports session revocation, lock protected actions and preserve the encrypted local queue. Never bypass revocation by inventing an offline identity.
- **OFFAUTH-019 (SHOULD):** Support an explicit maximum offline duration for an already authenticated session. This policy does not permit launching a new session offline.
- **OFFAUTH-020 (MUST):** Distinguish **Saved locally**, **Sync pending**, and **Synced**. Never claim server synchronization while offline.

### 3.3 Logout

- **OFFAUTH-021 (MUST):** Logout requires an online server request and acknowledgement of session termination/revocation.
- **OFFAUTH-022 (MUST):** Before logout, attempt to synchronize eligible pending changes and display pending, rejected, and conflicted counts.
- **OFFAUTH-023 (MUST):** If operations remain unacknowledged, never delete them. Explain the remaining changes and the recovery path.
- **OFFAUTH-024 (MUST):** Do not show logout as server-confirmed until the server confirms it. If the connection drops during the request, show an uncertain/pending state and retry safely when online.
- **OFFAUTH-025 (MUST):** After confirmed logout, clear transient sensitive UI state and remove/revoke local session credentials according to policy, while preserving encrypted unacknowledged business operations for authorized recovery.
- **OFFAUTH-026 (MUST):** On the next authorized login, validate ownership of preserved operations before synchronization. Never upload one tenant's data under another tenant.

## 4. Local database and crash recovery

- **LOCAL-001 (MUST):** Use SQLite or an equivalent transactional local store for supported clients; keep the active database in app-controlled local storage, not on a removable drive.
- **LOCAL-002 (MUST):** Encrypt the local business database using a maintained, reviewed implementation appropriate to each platform. SQLite alone does not encrypt database contents.
- **LOCAL-003 (MUST):** Protect encryption keys with OS-backed key storage; do not store keys in plaintext beside the database.
- **LOCAL-004 (MUST):** Use transactional writes, foreign-key enforcement, versioned migrations, and a durability configuration validated for each platform.
- **LOCAL-005 (MUST):** Commit each business change and its corresponding outbox entry in the same local transaction.
- **LOCAL-006 (MUST):** Show **Saved locally** only after the local transaction has committed successfully.
- **LOCAL-007 (MUST):** If disk space is exhausted, the database is corrupt/read-only, or a write fails, do not claim success; block operations that cannot be persisted and show an actionable error.
- **LOCAL-008 (MUST):** Recover committed operations after crashes, process termination, restart, or power loss to the extent supported by device hardware and the OS.
- **LOCAL-009 (MUST):** Reuse the original operation identifier on retry; do not create a new identifier for the same business action.
- **LOCAL-010 (MUST):** Track interrupted sync batches, pending acknowledgements, conflicts, migration state, and the last durably applied server cursor.
- **LOCAL-011 (MUST):** Make migrations transactional where supported and test interrupted upgrades against existing-version fixtures.
- **LOCAL-012 (MUST):** Preserve the database and pending queue through app updates; updates must not reset user data as an installation side effect.
- **LOCAL-013 (SHOULD):** Provide an authorized recovery/export workflow that protects plaintext data and credentials.

Each durable outbox entry must include a stable unique operation ID, tenant ID, device ID where applicable, entity type and ID, operation type, base version, payload/schema version, creation time, status, attempt count, last error code, and dependency/order metadata. Sensitive payloads must be encrypted at rest and excluded from ordinary logs.

## 5. Synchronization protocol

- **SYNC-001 (MUST):** Use a versioned authenticated API; desktop and mobile clients must never connect directly to PostgreSQL.
- **SYNC-002 (MUST):** Trigger sync after a local write when online, after reconnection, after successful startup authentication, and through bounded retries/manual retry.
- **SYNC-003 (MUST):** Push queued operations using stable operation IDs and base versions.
- **SYNC-004 (MUST):** The server atomically validates/applies each business operation and records its idempotency result.
- **SYNC-005 (MUST):** Retrying after a lost response must return the prior result or a safe equivalent, not create duplicate invoices, payments, stock movements, or journal entries.
- **SYNC-006 (MUST):** Mark an operation acknowledged only after a valid server acknowledgement.
- **SYNC-007 (MUST):** Pull remote changes using a durable resumable cursor/change sequence, including deletion tombstones where applicable.
- **SYNC-008 (MUST):** Commit downloaded changes and the corresponding cursor atomically; never advance the cursor before the changes are durable.
- **SYNC-009 (MUST):** Respect operation dependencies and server ordering constraints.
- **SYNC-010 (MUST):** Use bounded exponential backoff with jitter for transient errors; distinguish network/server failures from permanent validation, permission, and business-rule errors.
- **SYNC-011 (MUST):** Keep rejected operations and conflict details available for resolution; do not retry permanent errors forever.
- **SYNC-012 (MUST):** Show **Fully synced** only when eligible operations are acknowledged, required remote changes are durably applied, and no blocking conflict/error remains in the declared sync scope.
- **SYNC-013 (MUST):** Show sync status, last successful sync time, pending count, and actionable conflict/error details.
- **SYNC-014 (MUST):** The backend validates tenant ownership, permissions, schema version, business invariants, and subscription restrictions for every operation.
- **SYNC-015 (SHOULD):** Support manual retry and support-safe diagnostics with secrets and business payloads redacted.

## 6. Accounting-aware conflict policy

Generic last-write-wins is prohibited for financial and inventory transactions.

- **CON-001 (MUST):** Merge independent field edits only where the entity's domain rules permit it.
- **CON-002 (MUST):** Detect same-field concurrent edits with version checks; surface protected conflicts instead of silently overwriting a value.
- **CON-003 (MUST):** Treat posted invoices and posted journal entries as immutable. Corrections use authorized credit notes, cancellations, reversals, or replacement entries.
- **CON-004 (MUST):** Treat payments, receipts, refunds, stock movements, and ledger postings as append-only events with stable IDs and deduplication.
- **CON-005 (MUST):** Derive stock balances from authoritative movements or update balances transactionally with reconciliation checks; enforce configured negative-stock policy.
- **CON-006 (MUST):** Generate final invoice/document numbers on the server or use a concurrency-safe allocation protocol. Offline drafts may use temporary local identifiers, never presented as final server numbers.
- **CON-007 (MUST):** Use decimal-safe money arithmetic and documented rounding; the server recalculates totals, taxes, balances, and posting effects.
- **CON-008 (MUST):** Enforce payment allocation, refund, period-close, tax, stock, and ledger invariants on the server at sync time.
- **CON-009 (MUST):** Preserve audit history of accepted changes, conflicts, resolutions, reversals, and rejected operations.
- **CON-010 (MUST):** Never discard local data during conflict resolution without a visible and auditable decision.
- **CON-011 (MUST):** If an offline action is invalid under current server state, retain it as action-required and provide a correction/recovery path; never silently convert it into a different financial transaction.

## 7. Removable-drive backup

### 7.1 Administrator settings

- **USB-001 (MUST):** Provide administrator-only controls to enable/disable removable-drive backups.
- **USB-002 (MUST):** Allow selection of a detected, supported removable-drive destination.
- **USB-003 (MUST):** Support manual backups and configurable triggers such as after successful sync or at an interval. A pre-logout backup may be offered but does not replace synchronization.
- **USB-004 (MUST):** Require encryption for removable-drive backups; encryption is enabled by default.
- **USB-005 (MUST):** Configure retention with safeguards against deleting the only known-good backup.
- **USB-006 (MUST):** Show last backup time, result, destination, size, and actionable failure status.
- **USB-007 (MUST):** Restrict backup settings and contents according to administrator permissions.
- **USB-008 (MUST):** Never imply that backup administration grants permission to browse business records.

### 7.2 Backup creation and integrity

- **USB-009 (MUST):** Create a consistent database backup using a supported SQLite backup/checkpoint procedure. Do not blindly copy an actively written database file.
- **USB-010 (MUST):** Include a manifest with format version, app/schema version, tenant identifier, creation time, device identifier where appropriate, encryption metadata, and integrity checksum. Exclude credentials and session tokens.
- **USB-011 (MUST):** Encrypt backup content with maintained authenticated encryption. Manage recovery keys separately; a key stored only beside the backup on the same drive is inadequate.
- **USB-012 (MUST):** Verify backup integrity and readability before marking it successful.
- **USB-013 (MUST):** Write to a temporary file and finalize atomically where supported. Do not replace the last known-good backup until the new backup is verified.
- **USB-014 (MUST):** Keep local database and pending queue intact if the drive fills, backup fails, or the drive is removed.
- **USB-015 (MUST):** Do not expose plaintext business data in logs, filenames, manifests, or errors.
- **USB-016 (SHOULD):** Support versioned rotation while protecting the latest verified backup and administrator-pinned backups.

### 7.3 Missing or removed drive

- **USB-017 (MUST):** Detect missing/disconnected destinations where the OS provides required notifications.
- **USB-018 (MUST):** If the drive is absent, mark the backup skipped/failed and notify the administrator. Do not block ordinary use unless an explicit organizational policy makes backup a prerequisite.
- **USB-019 (MUST):** If the drive is removed during backup, fail safely, do not mark the backup successful, clean incomplete temporary output when safe, and preserve local data and the previous verified backup.
- **USB-020 (MUST):** Never format, repartition, or delete unrelated drive content automatically.
- **USB-021 (MUST):** Validate free space, permissions, filesystem support, and destination identity before backup.
- **USB-022 (MUST):** Validate Windows drive detection and Android USB/Storage Access Framework behavior separately. Android support may depend on device, OS, permissions, and user-selected destination.
- **USB-023 (MUST):** If a configured drive is unavailable, do not silently fall back to an arbitrary path or cloud destination.

### 7.4 Restore

- **USB-024 (MUST):** Restore is an explicit, administrator-authorized workflow showing backup time, tenant, schema version, and validation result.
- **USB-025 (MUST):** Validate integrity/authentication, encryption key availability, format, schema compatibility, and tenant ownership before restore.
- **USB-026 (MUST):** Reject corrupted, tampered, wrong-tenant, or unsupported backups without replacing current data.
- **USB-027 (MUST):** Preserve a recovery copy of the current local database and outbox before a destructive restore.
- **USB-028 (MUST):** Never silently overwrite newer server data. After restore, require online reauthentication and server reconciliation before workspace unlock.
- **USB-029 (MUST):** Document recovery-key handling and the consequence of key loss.
- **USB-030 (SHOULD):** Provide a restore preview and explicit confirmation before replacing or merging local data.

## 8. Server backups remain mandatory

A removable drive is an additional recovery layer, not the authoritative backup strategy.

- **BKP-001 (MUST):** Maintain automated, encrypted backups of the authoritative PostgreSQL database.
- **BKP-002 (MUST):** Restrict server-backup access independently from normal application access.
- **BKP-003 (MUST):** Perform documented restore drills and validate recovery objectives before production.
- **BKP-004 (MUST):** Do not claim USB backup replaces server backups, point-in-time recovery, or off-site disaster recovery.
- **BKP-005 (MUST):** Report local removable-drive backup status separately from server backup status.

## 9. UI status requirements

Provide explicit statuses such as:
- **Online — Synced**
- **Online — Syncing**
- **Offline — Changes saved locally**
- **Pending sync — N changes**
- **Action required — N conflicts/errors**
- **Workspace locked — Internet required to sign in**
- **Workspace locked — Revalidation/synchronization required**
- **Backup complete** / **Backup failed**
- **Removable drive not available**
- **Restore rejected — backup validation failed**

Every status must distinguish data saved on the device from data confirmed by the server.

## 10. Security requirements

- **OFFSEC-001 (MUST):** Encrypt local databases and removable-drive backups with maintained cryptographic implementations and authenticated encryption.
- **OFFSEC-002 (MUST):** Use OS-protected keys/credentials and least-privilege filesystem permissions.
- **OFFSEC-003 (MUST):** Never embed backend master secrets or database credentials in Windows/Android clients.
- **OFFSEC-004 (MUST):** Redact secrets and business payloads from logs, crash reports, and diagnostics.
- **OFFSEC-005 (MUST):** Revalidate authorization and tenant ownership server-side for every sync operation and recovery handoff.
- **OFFSEC-006 (MUST):** Treat endpoint compromise as a residual risk: a person controlling an unlocked or compromised device may access data while in use. Encryption at rest does not eliminate this risk.
- **OFFSEC-007 (MUST):** Sign application releases and verify update integrity; updates must preserve the database and pending queue.
- **OFFSEC-008 (MUST):** Audit sensitive backup/restore actions, conflict resolutions, and session revocations without recording secrets.

## 11. Acceptance tests

| ID | Scenario | Expected result |
|---|---|---|
| AT-OFF-001 | Launch with no internet | Workspace stays locked; local data and pending operations remain intact. |
| AT-OFF-002 | Login with internet | Server validates account/tenant/device; required recovery and sync finish before unlock. |
| AT-OFF-003 | Internet drops after login | Supported edits commit locally and queue atomically; UI shows pending count. |
| AT-OFF-004 | Crash after local commit, before sync | Operation is recovered and submitted with the same ID. |
| AT-OFF-005 | Server applies operation but response is lost | Retry returns original result; no duplicate invoice/payment/stock/journal. |
| AT-OFF-006 | Internet returns during active session | Session is revalidated; queued and remote changes synchronize safely. |
| AT-OFF-007 | Session/device revoked while offline | Protected actions lock when revocation is learned; pending data remains preserved. |
| AT-OFF-008 | Logout with pending operations | Pending count is shown; data is not deleted; logout is not falsely reported as server-confirmed. |
| AT-OFF-009 | Concurrent independent field edits | Permitted independent fields merge without overwriting unrelated changes. |
| AT-OFF-010 | Concurrent edits to same protected field | Conflict is surfaced and resolved audibly; no silent overwrite. |
| AT-OFF-011 | Concurrent stock/payment/invoice operation | Server invariants and idempotency prevent duplicates/inconsistent balances. |
| AT-USB-001 | Backup to selected drive | Encrypted verified backup and manifest are written; success follows verification. |
| AT-USB-002 | Drive missing before backup | Backup is skipped/failed with warning; local data remains intact. |
| AT-USB-003 | Drive removed during backup | Incomplete backup is not marked successful; previous verified backup remains intact. |
| AT-USB-004 | Drive full or write denied | Actionable error; no pending business data is deleted. |
| AT-USB-005 | Corrupt/tampered backup | Restore is rejected and current local data is unchanged. |
| AT-USB-006 | Backup belongs to another tenant | Restore is rejected; no cross-tenant data is opened or uploaded. |
| AT-USB-007 | Valid but older backup restored | Current data is preserved first; online reauthentication and reconciliation are required. |
| AT-USB-008 | App update with pending operations | Database and queue survive and operations can be recovered after update. |
| AT-SEC-001 | Inspect local files and backup drive | No plaintext database/backup or session secret is exposed. |
| AT-SEC-002 | Attempt cross-tenant operation using modified client | Server rejects it and records an appropriate security event. |

## 12. Implementation sequence

1. Inspect the repository to identify existing frontend, backend, schema, authentication, and test architecture.
2. Confirm API contracts, tenant/session model, server-side idempotency, and change-journal primitives.
3. Implement server idempotency and change-feed support before client synchronization.
4. Implement encrypted local storage and atomic outbox on the first supported client.
5. Implement online login, offline launch lock, reconnect revalidation, push/pull synchronization, and recovery UI.
6. Add domain-specific conflict handling for invoices, payments, inventory, and ledger entries.
7. Implement administrator-controlled removable-drive backup, integrity verification, retention, and restore preview.
8. Implement Windows and Android drive support separately behind platform capability checks.
9. Add automated crash, retry, duplicate, conflict, drive-removal, and restore tests.
10. Verify server backups and restore drills independently of removable-drive backup.
11. Update user documentation only after tests demonstrate the behavior.

## 13. Definition of done

The feature is complete only when the behavior is implemented in the actual codebase; server authorization, tenant isolation, and idempotency tests pass; offline durability and synchronization recovery pass; Windows and Android behavior is validated independently; removable-drive backups are encrypted, integrity-checked, and restore-tested; server backups remain configured and restore-tested; app updates preserve pending data; and documentation accurately distinguishes implemented behavior from planned behavior.

A specification, UI screen, or successful compilation alone is not proof of completion.
