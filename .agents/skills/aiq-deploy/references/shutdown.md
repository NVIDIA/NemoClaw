# Shutdown And Cleanup

Use this when the user asks to stop, restart, rebuild, or clean up AI-Q services.

## Stop Local Non-Docker Server

Use this when AI-Q was started with `scripts/start_as_skill.sh`, `scripts/start_e2e.sh`, `scripts/start_server_in_debug_mode.sh`, or direct `nat serve`.

If the process is still attached to the current terminal, stop it with `Ctrl+C`.

If it is running in the background, identify the process first:

```bash
lsof -nP -iTCP:${PORT:-8000} -sTCP:LISTEN
ps -p <PID> -o pid,ppid,command
```

Only stop the process after confirming it is the AI-Q/NAT backend:

```bash
kill <PID>
```

If it does not exit cleanly, ask before using `kill -9 <PID>`.

For `scripts/start_e2e.sh`, prefer `Ctrl+C` in the owning terminal when available because the script traps shutdown and stops both backend and frontend child processes.

## Stop Docker Compose

```bash
cd deploy/compose
docker compose --env-file ../.env -f docker-compose.yaml down
```

## Restart Docker Compose Backend Only

Use this when AI-Q was started for Agent Skill backend use:

```bash
cd deploy/compose
BUILD_TARGET=release docker compose --env-file ../.env -f docker-compose.yaml up -d --build aiq-agent
```

## Restart Docker Compose Full UI

Use this only when the user wants the browser UI:

```bash
cd deploy/compose
docker compose --env-file ../.env -f docker-compose.yaml up -d
```

## Rebuild Docker Compose Backend Only

Use this when AI-Q was started for Agent Skill backend use:

```bash
cd deploy/compose
BUILD_TARGET=release docker compose --env-file ../.env -f docker-compose.yaml build --no-cache aiq-agent
BUILD_TARGET=release docker compose --env-file ../.env -f docker-compose.yaml up -d aiq-agent
```

## Rebuild Docker Compose Full UI

Use this only when the user wants the browser UI:

```bash
cd deploy/compose
docker compose --env-file ../.env -f docker-compose.yaml build --no-cache
docker compose --env-file ../.env -f docker-compose.yaml up -d
```

## Destructive Cleanup

Ask for explicit confirmation before deleting volumes:

```bash
cd deploy/compose
docker compose --env-file ../.env -f docker-compose.yaml down -v
```

Explain that this can remove local PostgreSQL data and job history.
