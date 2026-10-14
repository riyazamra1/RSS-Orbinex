#!/bin/sh
set -eu

: "${DATABASE_URL:?DATABASE_URL must be set}"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-apps/api/migrations}"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "CREATE TABLE IF NOT EXISTS public.rss_orbinex_schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"

for migration in "$MIGRATIONS_DIR"/*.sql; do
  [ -f "$migration" ] || continue
  filename=$(basename "$migration")
  applied=$(psql "$DATABASE_URL" -At -v ON_ERROR_STOP=1 -c "SELECT 1 FROM public.rss_orbinex_schema_migrations WHERE filename = '$filename'")
  if [ "$applied" = "1" ]; then
    echo "Already applied: $filename"
    continue
  fi

  echo "Applying: $filename"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$migration"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "INSERT INTO public.rss_orbinex_schema_migrations (filename) VALUES ('$filename')"
done

echo "RSS Orbinex database migrations are up to date."
