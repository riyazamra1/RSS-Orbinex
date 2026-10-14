# RSS Orbinex — Local-first development

This setup runs PostgreSQL, a migration runner, and the Fastify API on your own computer. It needs no paid API keys, AI provider keys, cloud account, public server, or DNS changes. The API and database ports bind to loopback only and are not exposed to your LAN or the internet.

## Prerequisites

- Docker Engine/Desktop with the Docker Compose plugin
- Node.js 22+ and npm (for running tests on the host)
- Git, if cloning the repository

## Start the full local stack

From the repository root:

```sh
cp .env.example .env
```

Edit `.env` and replace `BOOTSTRAP_SECRET` with a unique random value of at least 32 characters. Keep `.env` private; it is ignored by Git and excluded from the API image.

Start PostgreSQL, apply any pending migrations through the migration ledger, build the API image, and start the API:

```sh
docker compose up --build -d
docker compose ps
docker compose logs --tail=100 migrate api
```

The local API is available at `http://127.0.0.1:4000`. Check health:

```sh
curl -fsS http://127.0.0.1:4000/health/live
curl -fsS http://127.0.0.1:4000/health/ready
```

The API container waits for PostgreSQL and the migration service. The migration runner records successfully applied migration filenames in `rss_orbinex_schema_migrations` and skips those on later starts. This is a local-development convenience, not a substitute for reviewed production migration releases.

## Run code checks on the host

Install dependencies and run the current API checks:

```sh
npm install
npm run typecheck
npm run build
npm test
```

GitHub Actions is also configured to run these checks and apply the migrations against a clean PostgreSQL 17 database. Verify the workflow result in the repository's Actions tab before treating a commit as CI-approved.

## Bootstrap the first tenant

The API includes a one-time owner bootstrap endpoint. After the API and migrations are healthy, send a request to `POST /v1/platform/bootstrap` with the header `x-rss-bootstrap-secret` matching the local `BOOTSTRAP_SECRET` and the request body accepted by the current bootstrap route. The endpoint creates the initial tenant and owner and seeds a starter chart of accounts.

Bootstrap is not a complete production identity lifecycle. Do not expose this development API publicly or reuse the local secret in a production environment.

## Stop and reset

Stop containers while retaining the local database:

```sh
docker compose down
```

**Destructive local reset:** deletes the PostgreSQL volume and all local data:

```sh
docker compose down -v
```

Do not run the destructive reset unless you intend to erase the local development database.

## Local-first boundaries

- No paid third-party API keys are required for this stack.
- The API and database run locally; this is not yet a shared multi-user cloud service.
- The browser preview in the separate `RSS-Apps-Website/orbinex/` directory still uses browser-local demo data and is not connected to this API.
- Example credentials are for local development only. Change the bootstrap secret before use and never commit `.env`.
- Production still needs TLS, managed secrets, backups and tested restore, monitoring, reviewed migration/release procedures, full security/integration tests, and a deliberate deployment decision.
- Preserve the existing `rssapps.net` website and DNS. Do not deploy to the root domain or change DNS as part of local development.
