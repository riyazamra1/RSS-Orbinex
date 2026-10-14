# RSS Orbinex — Local-first development

This setup runs the API and PostgreSQL on your own computer. It needs no paid API keys, AI provider keys, cloud account, public server, or DNS changes. The PostgreSQL port is bound to loopback only; it is not exposed to your LAN or the internet.

## Prerequisites

- Node.js 22 or newer and npm
- Docker Engine/Desktop with the Compose plugin
- Git, if cloning the repository

## Start from a clean local checkout

Run these commands from the repository root:

```sh
cp .env.example .env
```

Set a unique local bootstrap secret in `.env` (at least 32 characters). Do not commit `.env` or reuse this development secret in production.

Start the local database:

```sh
docker compose up -d postgres
docker compose ps
```

Install dependencies and apply the checked-in migrations in filename order:

```sh
npm install
for migration in apps/api/migrations/*.sql; do
  echo "Applying $migration"
  docker compose exec -T postgres psql -U rss_orbinex -d rss_orbinex -v ON_ERROR_STOP=1 -f - < "$migration" || exit 1
done
```

The migration loop is intended for a fresh local development database. Do not use it as a production migration process or blindly rerun it against a database with existing data.

Start the API:

```sh
npm run dev:api
```

In another terminal, verify local health:

```sh
curl -fsS http://127.0.0.1:4000/health/live
curl -fsS http://127.0.0.1:4000/health/ready
```

Run the current checks:

```sh
npm run typecheck
npm run build
npm test
```

## Stop and reset

Stop PostgreSQL but keep its data:

```sh
docker compose down
```

**Destructive local reset:** this deletes the local PostgreSQL volume and all data in it:

```sh
docker compose down -v
```

Do not run the destructive reset unless you intend to erase the local development database.

## Bootstrap the first tenant

The API includes a one-time owner bootstrap endpoint. Generate a random secret locally and put it in `.env` as `BOOTSTRAP_SECRET`. Once the API and migrations are running, call the bootstrap endpoint with that secret and the request body required by the current bootstrap route. The endpoint is not a replacement for the pending full identity lifecycle. Never expose this development API publicly.

## Local-first boundaries

- No paid API keys are required for the current backend foundation.
- The API and database run locally; this does not yet make a shared multi-user cloud service.
- The browser preview in `RSS-Apps-Website/orbinex/` still uses browser-local storage and is not connected to this API.
- Local development credentials are examples only. Change them before sharing the environment.
- Production still needs reviewed migrations, TLS, managed secrets, backups and restore tests, monitoring, security/integration tests, and a deliberate deployment decision.
- Preserve the existing `rssapps.net` website and DNS. Do not deploy to the root domain or change DNS as part of local development.
