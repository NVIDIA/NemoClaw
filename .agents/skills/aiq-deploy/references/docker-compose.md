# Docker Compose Deployment

Use this as the default durable local deployment path for external users.

For Agent Skill backend use, start only `aiq-agent`; Docker Compose will also start required dependencies such as PostgreSQL. Start the `frontend` service only when the user asks for the browser UI.

## Prerequisites

```bash
docker --version
docker compose version
docker info >/dev/null
for port in 8000 5432; do
  if lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is already in use"
  else
    echo "port $port is free"
  fi
done
if lsof -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port 3000 is already in use; required only for browser UI mode"
else
  echo "port 3000 is free"
fi
```

If port `8000` is already in use, set `PORT=8100` or another free port in `deploy/.env` before starting Compose. If port `5432` is in use, resolve the PostgreSQL conflict before starting this Compose stack. If port `3000` is in use, it only blocks full browser UI mode; backend-only Agent Skill mode can still run.

## Start For Agent Skill Backend

Before starting, read `env-and-secrets.md` and run its Skill backend mode normalization. This sets non-secret values such as `APP_ENV=production` and `AIQ_DEV_ENV=skill`, and it defaults `REQUIRE_AUTH=false` only when not already configured.

WARNING: `REQUIRE_AUTH=false` disables AI-Q API authentication. Use it only for local single-user Agent Skill
validation on a trusted machine. For any shared, multi-user, or internet-facing deployment, set `REQUIRE_AUTH=true`
and configure the matching authentication layer before exposing the service.

```bash
cd deploy/compose
BUILD_TARGET=release docker compose --env-file ../.env -f docker-compose.yaml config --quiet
BUILD_TARGET=release docker compose --env-file ../.env -f docker-compose.yaml up -d --build aiq-agent
```

Use pre-built images only when the user asks for registry images or faster startup:

```bash
cd deploy/compose
docker compose --env-file ../.env -f docker-compose.yaml up -d aiq-agent
```

The release build target excludes the CLI and debug UI. Keep this path backend-only unless the user asks for the browser UI.

## Start Full Browser UI

Before starting, make sure `deploy/.env` is not left in CLI mode. If `AIQ_DEV_ENV=cli` is present from a copied template, change it to a non-CLI value such as `AIQ_DEV_ENV=web`.

```bash
cd deploy/compose
docker compose --env-file ../.env -f docker-compose.yaml config --quiet
docker compose --env-file ../.env -f docker-compose.yaml up -d --build
```

Use pre-built images only when the user asks for registry images or faster startup:

```bash
cd deploy/compose
docker compose --env-file ../.env -f docker-compose.yaml up -d
```

## Runtime Checks For Agent Skill Backend

Run these when only `aiq-agent` and its dependencies were started:

```bash
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" | grep -E 'aiq-agent|aiq-postgres'
docker exec aiq-postgres pg_isready -U aiq -d aiq_jobs
docker exec aiq-postgres pg_isready -U aiq -d aiq_checkpoints
```

Do not require `aiq-blueprint-ui` for backend-only Agent Skill mode.

## Runtime Checks For Full Browser UI

Run these when the user requested the browser UI:

```bash
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" | grep -E 'aiq-agent|aiq-blueprint-ui|aiq-postgres'
docker exec aiq-postgres pg_isready -U aiq -d aiq_jobs
docker exec aiq-postgres pg_isready -U aiq -d aiq_checkpoints
```

After startup, read `validation.md` and run the basic validation checks.
