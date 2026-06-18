# Local Web Deployment

Use this path for quick local development without Docker Compose when the user wants the browser UI.

For backend-only Agent Skill use, read `skill-backend.md` instead.

## Prerequisites

```bash
python3 --version
uv --version
test -d .venv && echo "venv=present" || echo "venv=missing"
node --version 2>/dev/null || echo "node=missing"
npm --version 2>/dev/null || echo "npm=missing"
for port in 8000 3000; do
  if lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is already in use"
  else
    echo "port $port is free"
  fi
done
```

If `.venv` is missing, use the repository's documented setup flow before starting services. Ask before installing dependencies.

The local web script uses backend port `8000` and frontend port `3000`. If either port is in use, stop and ask the user whether to shut down the conflicting process or use Docker Compose with custom port mappings instead.

## Start

```bash
./scripts/start_e2e.sh --config_file configs/config_web_default_llamaindex.yml
```

The default local web path starts:

- backend: `http://localhost:8000`
- frontend: `http://localhost:3000`

## Verify

After startup, read `validation.md` and run the basic validation checks.
