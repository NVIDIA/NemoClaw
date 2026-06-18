# Basic Validation

These checks confirm the deployed AI-Q system is reachable and minimally usable. They are not report-quality scoring.

## Determine Server URL

Default:

```bash
PORT="${PORT:-8000}"
AIQ_SERVER_URL="${AIQ_SERVER_URL:-http://localhost:$PORT}"
echo "AIQ_SERVER_URL=$AIQ_SERVER_URL"
```

If the user configured a custom `PORT` or external host, use that URL.

## Backend API

```bash
curl -sf "$AIQ_SERVER_URL/health" >/dev/null && echo "backend=healthy"
```

If `/health` is unavailable, try `/v1/health` before failing:

```bash
curl -sf "$AIQ_SERVER_URL/v1/health" >/dev/null && echo "backend=healthy"
```

## UI When Applicable

Run this only for deployment modes that intentionally start the browser UI:

```bash
curl -sf "http://localhost:${FRONTEND_PORT:-3000}" >/dev/null && echo "frontend=reachable"
```

## PostgreSQL When Using Docker Compose

Run this only for Docker Compose deployments. It is not required for local process or CLI modes unless the selected config explicitly uses a local PostgreSQL service.

```bash
docker exec aiq-postgres pg_isready -U aiq -d aiq_jobs
docker exec aiq-postgres pg_isready -U aiq -d aiq_checkpoints
```

## Async Agent API

Use the installed `aiq-research` helper from the skill checkout when available:

```bash
AIQ_SERVER_URL="$AIQ_SERVER_URL" python3 skills/aiq-research/scripts/aiq.py health
AIQ_SERVER_URL="$AIQ_SERVER_URL" python3 skills/aiq-research/scripts/aiq.py agents
```

## Shallow End-To-End Check

Run a shallow `/chat` check when required model/search credentials are present. If credentials are missing, report that deploy validation reached infrastructure/API readiness but could not prove model-backed response generation.

```bash
AIQ_SERVER_URL="$AIQ_SERVER_URL" python3 skills/aiq-research/scripts/aiq.py chat "Briefly confirm AI-Q is responding."
```

Do not run deep research as part of basic deploy validation. Deep research belongs to `aiq-research` when requested, and broader integration validation belongs to `end-to-end-validation.md`.

## Optional Deep Research Completion Validation

Basic deploy validation does not prove that deep research can complete. It confirms that services are reachable and, when credentials are present, that a shallow model-backed request can run. Use `end-to-end-validation.md` for the optional deeper check: submit an explicit `deep_researcher` job, poll it to completion, and fetch the final report.

## Handoff

When validation passes, tell the user:

- backend URL
- frontend URL when applicable, or that the UI was intentionally not started
- PostgreSQL readiness when using Docker Compose
- whether `aiq-research` can use its default `AIQ_SERVER_URL`
- the exact `export AIQ_SERVER_URL=...` command when not using the default backend URL
- whether only basic deploy validation was run or deep research completion validation also passed

Then ask:

```text
Basic deployment validation passed. Would you like me to run deep research completion validation now? This submits a `deep_researcher` job and commonly takes 7-20 minutes with substantial model/search quota. Otherwise, you can skip validation and try AI-Q yourself.
```

Only start deep research completion validation if the user confirms.
