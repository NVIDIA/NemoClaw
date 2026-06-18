# Agent Skill Backend Deployment

Use this path when the user wants a local AI-Q backend for the `aiq-research` Agent Skill without starting the browser UI.

This mode starts only the API server. It does not start the Next.js UI, and it disables the optional debug console.

## Prerequisites

```bash
python3 --version
uv --version
test -d .venv && echo "venv=present" || echo "venv=missing"
if lsof -nP -iTCP:8000 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port 8000 is already in use"
else
  echo "port 8000 is free"
fi
```

If `.venv` is missing, use the repository's documented setup flow before starting services. Ask before installing dependencies.

If port `8000` is already in use, choose another free port with `--port` and hand that URL to `aiq-research`.

## Start

```bash
./scripts/start_as_skill.sh --config_file configs/config_web_default_llamaindex.yml --port 8000
```

The default Agent Skill backend path starts:

- backend API: `http://localhost:8000`
- skill handoff URL: `AIQ_SERVER_URL=http://localhost:8000`
- frontend UI: not started
- debug console: disabled

## Authentication

Assume `REQUIRE_AUTH=false` for the public Agent Skill backend path. If the user requires authentication, they must enable and configure it for their own environment before using `aiq-research`.

## Verify

After startup, read `validation.md` and run the basic backend and async-agent validation checks. Do not require the frontend check for this mode.
