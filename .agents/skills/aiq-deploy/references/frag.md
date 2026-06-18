# FRAG / Foundational RAG

Use this path when the user asks to connect AI-Q to Foundational RAG or use `configs/config_web_frag.yml`.

FRAG requires a running RAG server and ingestor. AI-Q deployment alone is not enough.

## RAG Blueprint Ownership

RAG Blueprint deployment has its own Agent Skill in the NVIDIA Skills repository:

```text
https://github.com/NVIDIA/skills/tree/main/skills/rag/rag-blueprint
```

Use that skill when available for RAG deployment, RAG feature configuration, troubleshooting, and shutdown. Keep `aiq-deploy` responsible only for configuring AI-Q to point at a reachable RAG server and ingestor.

Do not assume RAG Blueprint can be deployed locally for external users. Self-hosted RAG has extensive GPU, driver, disk, and NVIDIA Container Toolkit requirements. The RAG Blueprint skill includes a Docker path that can use NVIDIA-hosted NIMs when local hardware is not sufficient; prefer that route when the user wants FRAG but cannot satisfy self-hosted requirements.

## Check Configuration

```bash
grep -E '^(RAG_SERVER_URL|RAG_INGEST_URL)=' deploy/.env || true
```

Probe only when values are set:

```bash
set -a
. deploy/.env
set +a
test -n "${RAG_SERVER_URL:-}" && curl -sf "$RAG_SERVER_URL/health" >/dev/null || true
test -n "${RAG_INGEST_URL:-}" && curl -sf "$RAG_INGEST_URL/health" >/dev/null || true
```

When AI-Q and RAG run as separate Docker Compose stacks, connect the AI-Q backend container to the RAG network after both stacks are up:

```bash
docker network connect nvidia-rag aiq-agent
```

If `aiq-agent` is recreated, repeat the network connection.

Do not claim FRAG is ready until both RAG URLs are configured and reachable.
