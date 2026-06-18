# Environment And Secrets

Use `deploy/.env` as the local deployment source of truth.

## Create Missing Env File

Do not overwrite an existing file.

```bash
if [ ! -f deploy/.env ]; then
  cp deploy/.env.example deploy/.env
  echo "created deploy/.env from deploy/.env.example"
fi
```

## Presence-Only Secret Check

Never print secret values.

```bash
python3 - <<'PY'
from pathlib import Path

env = Path("deploy/.env")
presence = {}
runtime_presence = {}
secret_keys = {
    "NVIDIA_API_KEY",
    "TAVILY_API_KEY",
    "SERPER_API_KEY",
    "EXA_API_KEY",
    "RAG_SERVER_URL",
    "RAG_INGEST_URL",
}
runtime_keys = {
    "NAT_JOB_STORE_DB_URL",
    "AIQ_CHECKPOINT_DB",
    "REQUIRE_AUTH",
    "BACKEND_CONFIG",
    "APP_ENV",
    "AIQ_DEV_ENV",
}
for line in env.read_text().splitlines():
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    key, value = line.split("=", 1)
    key = key.strip()
    is_set = bool(value.strip())
    if key in secret_keys:
        presence[key] = is_set
    elif key in runtime_keys:
        runtime_presence[key] = is_set

def present(key: str) -> str:
    return "SET" if presence.get(key) or runtime_presence.get(key) else "MISSING"

for key in [
    "NVIDIA_API_KEY",
    "TAVILY_API_KEY",
    "SERPER_API_KEY",
    "EXA_API_KEY",
    "NAT_JOB_STORE_DB_URL",
    "AIQ_CHECKPOINT_DB",
    "RAG_SERVER_URL",
    "RAG_INGEST_URL",
    "REQUIRE_AUTH",
    "APP_ENV",
    "AIQ_DEV_ENV",
]:
    print(f"{key}={present(key)}")

print(f"BACKEND_CONFIG={present('BACKEND_CONFIG')}")
PY
```

Core hosted-model usage requires `NVIDIA_API_KEY`. Web research requires at least one configured search provider key for the selected config.

For the public Agent Skill backend path, use `REQUIRE_AUTH=false` only for local single-user validation on a trusted
machine. This disables AI-Q API authentication. For any shared, multi-user, or internet-facing deployment, set
`REQUIRE_AUTH=true` and configure the matching authentication layer before using `aiq-research`.

If required values are missing, stop and ask the user to fill `deploy/.env`. Do not ask them to paste secrets into chat.

## Normalize Skill Backend Mode

When the user chooses Docker Compose Skill backend mode, set non-secret runtime defaults in `deploy/.env` before
starting services. This prevents a freshly copied `.env.example` from leaving the backend in CLI/development mode.
Preserve an existing `REQUIRE_AUTH` value; only add `REQUIRE_AUTH=false` when the key is missing.

WARNING: The normalization command edits `deploy/.env`. Before running it, tell the user it will update
`APP_ENV`, `AIQ_DEV_ENV`, and possibly add `REQUIRE_AUTH=false`; if `deploy/.env` already exists with different
values, show the planned key changes and get confirmation before applying them.

```bash
python3 - <<'PY'
from pathlib import Path

path = Path("deploy/.env")
updates = {
    "APP_ENV": "production",
    "AIQ_DEV_ENV": "skill",
}
defaults = {
    "REQUIRE_AUTH": "false",
}
lines = path.read_text().splitlines()
seen = set()
out = []
for line in lines:
    stripped = line.strip()
    if stripped and not stripped.startswith("#") and "=" in stripped:
        key = stripped.split("=", 1)[0].strip()
        if key in updates:
            out.append(f"{key}={updates[key]}")
            seen.add(key)
            continue
        if key in defaults:
            seen.add(key)
    out.append(line)
for key, value in updates.items():
    if key not in seen:
        out.append(f"{key}={value}")
for key, value in defaults.items():
    if key not in seen:
        out.append(f"{key}={value}")
path.write_text("\n".join(out) + "\n")
print("normalized non-secret Skill backend runtime mode")
PY
```

Do not run this normalization for CLI mode. For browser UI mode, use the deployment docs for that path and avoid setting `AIQ_DEV_ENV=cli`.
