#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# openwebui-setup — one-shot orchestrator for the chat front-end.
#
# Stands up open-webui in docker, fronted by a Cloudflare Tunnel and gated
# by Cloudflare Access (email-OTP allowlist). Idempotent: safe to re-run.
#
# What it does:
#   1. Loads scripts/openwebui/.env (copies from env.template if missing).
#   2. Verifies docker + curl are present.
#   3. Creates a Cloudflare Tunnel via API → captures the connector token.
#   4. Configures tunnel ingress to route the FQDN at open-webui:8080.
#   5. Adds a DNS CNAME pointing the subdomain at the tunnel.
#   6. Creates a Cloudflare Access application + email-allowlist policy.
#   7. Writes CF_TUNNEL_ID + CF_TUNNEL_TOKEN back to .env.
#   8. Brings up docker compose (open-webui + cloudflared sidecar).
#
# Usage:
#   bash scripts/openwebui-setup.sh
#   bash scripts/openwebui-setup.sh --dry-run

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEBUI_DIR="$ROOT/scripts/openwebui"
ENV_FILE="$WEBUI_DIR/.env"
ENV_TEMPLATE="$WEBUI_DIR/env.template"
COMPOSE_FILE="$WEBUI_DIR/docker-compose.yml"

DRY_RUN=0
MODE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --mode=*)
      MODE="${1#--mode=}"
      shift
      ;;
    --mode)
      MODE="$2"
      shift 2
      ;;
    -h | --help)
      sed -n '4,25p' "$0" | sed 's|^# *||'
      exit 0
      ;;
    *)
      echo "openwebui-setup: unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

# ── Output helpers ──────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RESET='\033[0m'
step() { echo -e "${BLUE}==>${RESET} $*"; }
info() { echo -e "    $*"; }
ok() { echo -e "${GREEN}    ✓${RESET} $*"; }
warn() { echo -e "${YELLOW}    !${RESET} $*"; }
fail() {
  echo -e "${RED}    ✗${RESET} $*" >&2
  exit 1
}

# ── 1. .env preflight ──────────────────────────────────────────────
if [ ! -f "$ENV_FILE" ]; then
  step "No .env found — copying from template"
  cp "$ENV_TEMPLATE" "$ENV_FILE"
  warn "fill in $ENV_FILE then re-run: bash scripts/openwebui-setup.sh"
  exit 1
fi

# shellcheck source=/dev/null
set -a
. "$ENV_FILE"
set +a

# CLI --mode overrides .env WEBUI_MODE; default to tunnel.
MODE="${MODE:-${WEBUI_MODE:-tunnel}}"
case "$MODE" in
  tunnel | quick) ;;
  *) fail "invalid --mode '$MODE' (expected: tunnel | quick)" ;;
esac

require() {
  local var="$1"
  if [ -z "${!var:-}" ]; then
    fail "missing $var in $ENV_FILE"
  fi
}
require OPENAI_API_BASE_URL

if [ "$MODE" = "tunnel" ]; then
  require CF_DOMAIN
  require WEBUI_SUBDOMAIN
  require ADMIN_EMAILS
  require CF_API_TOKEN
  require CF_ACCOUNT_ID
  require CF_ZONE_ID
  WEBUI_FQDN="${WEBUI_SUBDOMAIN}.${CF_DOMAIN}"
  TUNNEL_NAME="nemoclaw-${WEBUI_SUBDOMAIN}"
  step "openwebui-setup starting [tunnel] (fqdn=${WEBUI_FQDN}, admins=${ADMIN_EMAILS})"
else
  step "openwebui-setup starting [quick] — ephemeral *.trycloudflare.com URL, no Access gate"
  warn "first-time setup: ENABLE_SIGNUP=True so you can create the first admin"
fi

# ── 2. Tooling preflight ────────────────────────────────────────────
command -v docker >/dev/null || fail "docker not installed"
command -v curl >/dev/null || fail "curl not installed"
command -v python3 >/dev/null || fail "python3 not installed (used to parse JSON responses)"

if [ "$DRY_RUN" -eq 1 ]; then
  warn "dry-run: no remote calls will be made"
fi

# ── 3. Cloudflare API helper ────────────────────────────────────────
cf_api() {
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "    [dry-run] curl $*" >&2
    echo '{"success":true,"result":{"id":"dry-run-id"}}'
    return 0
  fi
  curl -fsS \
    -H "Authorization: Bearer ${CF_API_TOKEN}" \
    -H "Content-Type: application/json" \
    "$@"
}

# Stamp a key=value into .env, replacing the existing line if present.
write_env() {
  local key="$1"
  local val="$2"
  python3 - "$ENV_FILE" "$key" "$val" <<'PY'
import sys, re
path, key, val = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path) as f:
    lines = f.readlines()
pat = re.compile(rf"^{re.escape(key)}=")
found = False
for i, line in enumerate(lines):
    if pat.match(line):
        lines[i] = f"{key}={val}\n"
        found = True
        break
if not found:
    if lines and not lines[-1].endswith("\n"):
        lines[-1] += "\n"
    lines.append(f"{key}={val}\n")
with open(path, "w") as f:
    f.writelines(lines)
PY
}

# ── Quick-mode short-circuit ────────────────────────────────────────
if [ "$MODE" = "quick" ]; then
  step "Setting trusted-header SSO disabled (quick mode uses local login)"
  write_env WEBUI_AUTH_TRUSTED_EMAIL_HEADER ""
  write_env WEBUI_MODE "quick"

  # Allow first-admin creation. User flips back to False after first login.
  if [ "${ENABLE_SIGNUP:-False}" != "True" ]; then
    warn "first run: setting ENABLE_SIGNUP=True so you can create the first admin"
    warn "after first login, edit .env and re-run to lock signup back to False"
    write_env ENABLE_SIGNUP "True"
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    step "[dry-run] would: docker compose --profile quick up -d"
    exit 0
  fi

  step "Starting docker compose (quick profile)"
  (cd "$WEBUI_DIR" && docker compose --env-file "$ENV_FILE" --profile quick up -d) \
    || fail "docker compose up failed"
  ok "open-webui + quick tunnel running"

  step "Waiting for cloudflared to print the random URL"
  WEBUI_URL=""
  for _ in $(seq 1 30); do
    sleep 2
    # Match the success line; exclude api.trycloudflare.com which appears in
    # connection logs as the API endpoint, not the tunnel URL.
    WEBUI_URL="$(docker logs nemoclaw-cloudflared-quick 2>&1 \
      | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' \
      | grep -v '://api\.' \
      | head -1 || true)"
    [ -n "$WEBUI_URL" ] && break
  done

  if [ -n "$WEBUI_URL" ]; then
    ok "URL: ${WEBUI_URL}"
  else
    warn "URL not detected in 60s — run: docker logs nemoclaw-cloudflared-quick"
  fi

  step "Quick-mode setup complete"
  info "  URL:         ${WEBUI_URL:-<see logs>}"
  info "  Local debug: http://127.0.0.1:${WEBUI_HOST_PORT:-3000}"
  info "  Logs:        npm run webui:logs"
  info "  Stop:        npm run webui:down"
  info ""
  info "  ⚠ Quick mode caveats:"
  info "  • URL changes on every cloudflared restart."
  info "  • No Cloudflare Access — open-webui's email/password is the only gate."
  info "  • Lock ENABLE_SIGNUP=False after creating the first admin."
  exit 0
fi

# ── 4. Tunnel ───────────────────────────────────────────────────────
if [ -n "${CF_TUNNEL_ID:-}" ]; then
  step "Tunnel already configured (id=${CF_TUNNEL_ID})"
else
  step "Creating Cloudflare Tunnel: ${TUNNEL_NAME}"
  TUNNEL_SECRET="$(openssl rand -base64 32 | tr -d '=' | head -c 32)"
  TUNNEL_RESP="$(cf_api -X POST \
    "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/cfd_tunnel" \
    -d "$(printf '{"name":"%s","tunnel_secret":"%s","config_src":"cloudflare"}' \
      "$TUNNEL_NAME" "$TUNNEL_SECRET")")"
  CF_TUNNEL_ID="$(echo "$TUNNEL_RESP" \
    | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin)
    print(d["result"]["id"] if d.get("success") else "")
except Exception: print("")')"
  [ -n "$CF_TUNNEL_ID" ] || fail "tunnel create failed: $TUNNEL_RESP"

  TOKEN_RESP="$(cf_api \
    "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/cfd_tunnel/${CF_TUNNEL_ID}/token")"
  CF_TUNNEL_TOKEN="$(echo "$TOKEN_RESP" \
    | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin); r=d.get("result")
    print(r if isinstance(r,str) else "")
except Exception: print("")')"
  [ -n "$CF_TUNNEL_TOKEN" ] || fail "tunnel token fetch failed: $TOKEN_RESP"

  write_env CF_TUNNEL_ID "$CF_TUNNEL_ID"
  write_env CF_TUNNEL_TOKEN "$CF_TUNNEL_TOKEN"
  ok "tunnel created (id=${CF_TUNNEL_ID})"
fi

# ── 5. Tunnel ingress ───────────────────────────────────────────────
step "Configuring tunnel ingress → http://open-webui:8080"
INGRESS_BODY="$(
  cat <<JSON
{"config":{"ingress":[
  {"hostname":"${WEBUI_FQDN}","service":"http://open-webui:8080"},
  {"service":"http_status:404"}
]}}
JSON
)"
cf_api -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/cfd_tunnel/${CF_TUNNEL_ID}/configurations" \
  -d "$INGRESS_BODY" >/dev/null \
  || fail "ingress config failed"
ok "ingress: ${WEBUI_FQDN} → open-webui:8080"

# ── 6. DNS CNAME ────────────────────────────────────────────────────
step "Creating DNS CNAME ${WEBUI_FQDN} → ${CF_TUNNEL_ID}.cfargotunnel.com"
DNS_BODY="$(
  cat <<JSON
{"type":"CNAME","name":"${WEBUI_SUBDOMAIN}","content":"${CF_TUNNEL_ID}.cfargotunnel.com","proxied":true}
JSON
)"
DNS_RESP="$(cf_api -X POST \
  "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records" \
  -d "$DNS_BODY" 2>&1 || true)"
if echo "$DNS_RESP" | grep -q '"success":true'; then
  ok "DNS record created"
elif echo "$DNS_RESP" | grep -q "already exists"; then
  ok "DNS record already exists (skipping)"
else
  warn "DNS create response: $DNS_RESP"
fi

# ── 7. Cloudflare Access application ────────────────────────────────
step "Creating Cloudflare Access application"
APP_BODY="$(
  cat <<JSON
{
  "name":"${TUNNEL_NAME}",
  "domain":"${WEBUI_FQDN}",
  "type":"self_hosted",
  "session_duration":"24h",
  "auto_redirect_to_identity":false
}
JSON
)"
APP_RESP="$(cf_api -X POST \
  "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/access/apps" \
  -d "$APP_BODY" 2>/dev/null || true)"
APP_ID="$(echo "$APP_RESP" | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin)
    print(d["result"]["id"] if d.get("success") else "")
except Exception: print("")')"

if [ -z "$APP_ID" ]; then
  step "App may already exist — looking up by domain"
  APP_LOOKUP="$(cf_api \
    "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/access/apps")"
  APP_ID="$(echo "$APP_LOOKUP" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    for a in d.get('result', []):
        if a.get('domain') == '${WEBUI_FQDN}':
            print(a['id']); break
except Exception:
    pass")"
fi
[ -n "$APP_ID" ] || fail "could not create or find Access app"
ok "Access app id=${APP_ID}"

# ── 8. Access policy: email allowlist ───────────────────────────────
# Idempotent: on first run we POST a new policy; on re-run we look up the
# existing admin-allowlist policy and PUT the current ${ADMIN_EMAILS} list
# so adding/removing an admin is a single .env edit + re-run away.
step "Reconciling Access policy (allowlist: ${ADMIN_EMAILS})"
INCLUDE_RULES="$(python3 -c "
import json, sys
emails = '${ADMIN_EMAILS}'.split(',')
print(json.dumps([{'email': {'email': e.strip()}} for e in emails if e.strip()]))")"

EXISTING_POLICY_ID="$(cf_api \
  "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/access/apps/${APP_ID}/policies" \
  | python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
    for p in d.get("result", []):
        if p.get("name") == "admin-allowlist":
            print(p.get("id", ""))
            break
except Exception:
    pass')"

if [ -n "$EXISTING_POLICY_ID" ]; then
  POLICY_BODY="$(
    cat <<JSON
{"name":"admin-allowlist","decision":"allow","include":${INCLUDE_RULES},"exclude":[],"require":[]}
JSON
  )"
  POLICY_RESP="$(cf_api -X PUT \
    "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/access/apps/${APP_ID}/policies/${EXISTING_POLICY_ID}" \
    -d "$POLICY_BODY" 2>&1 || true)"
  if echo "$POLICY_RESP" | grep -q '"success":true'; then
    ok "policy updated (allowlist now: ${ADMIN_EMAILS})"
  else
    warn "policy update response: $POLICY_RESP"
  fi
else
  POLICY_BODY="$(
    cat <<JSON
{"name":"admin-allowlist","decision":"allow","include":${INCLUDE_RULES}}
JSON
  )"
  POLICY_RESP="$(cf_api -X POST \
    "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/access/apps/${APP_ID}/policies" \
    -d "$POLICY_BODY" 2>&1 || true)"
  if echo "$POLICY_RESP" | grep -q '"success":true'; then
    ok "policy created"
  else
    warn "policy create response: $POLICY_RESP"
  fi
fi

# ── 9. Bring up compose ─────────────────────────────────────────────
step "Setting trusted-header SSO + locking signup for tunnel mode"
write_env WEBUI_AUTH_TRUSTED_EMAIL_HEADER "Cf-Access-Authenticated-User-Email"
write_env ENABLE_SIGNUP "False"
write_env WEBUI_MODE "tunnel"

if [ "$DRY_RUN" -eq 1 ]; then
  step "Skipping docker compose up (dry-run)"
else
  step "Starting docker compose (tunnel profile)"
  (cd "$WEBUI_DIR" && docker compose --env-file "$ENV_FILE" --profile tunnel up -d) \
    || fail "docker compose up failed"
  ok "open-webui + cloudflared running"
fi

# ── 9b. Deploy static loader.js (model dropdown tooltips + browser-vm panel) ─
#
# Open-webui serves /static/* from STATIC_DIR (/app/backend/open_webui/static)
# inside the container, and backend config.py copies /app/build/static/* into
# STATIC_DIR exactly ONCE, at module import (i.e. container boot). There is no
# watcher: a rebuilt loader does NOT appear until the container restarts.
#
# The bind mount (./static/loader.js → /app/build/static/loader.js) is what
# makes a fresh/recreated container pick the loader up for free on boot. But
# `docker cp` into that path fails with "device or resource busy" because it is
# a live mount, so it must NOT gate the real target below — the previous
# version chained the two with `&&`, so the busy error short-circuited the
# STATIC_DIR copy and this step silently deployed nothing.
#
# So: patch STATIC_DIR (what is served) unconditionally, and treat the
# /app/build/static copy as best-effort for containers on an older compose
# that has no mount yet.
LOADER_SRC="${WEBUI_DIR}/static/loader.js"
if [ "$DRY_RUN" -eq 0 ] && [ -f "$LOADER_SRC" ]; then
  step "Deploying static/loader.js into open-webui container"
  loader_ok=0
  if docker cp "$LOADER_SRC" nemoclaw-openwebui:/app/backend/open_webui/static/loader.js >/dev/null 2>&1; then
    ok "loader.js deployed to STATIC_DIR (served immediately)"
    loader_ok=1
  else
    warn "could not write STATIC_DIR — loader.js will land on the next container restart"
  fi
  # Best-effort for pre-mount containers; "resource busy" is expected here.
  if ! docker cp "$LOADER_SRC" nemoclaw-openwebui:/app/build/static/loader.js >/dev/null 2>&1; then
    info "skipped /app/build/static/loader.js (live bind mount; boot copy handles it)"
  fi
  if [ "$loader_ok" -eq 0 ]; then
    docker restart nemoclaw-openwebui >/dev/null 2>&1 \
      && ok "restarted open-webui to pick up loader.js from the bind mount" \
      || warn "loader.js deploy failed — model picker still works, no tooltips"
  fi
fi

# ── 9c. Seed curated model records into webui.db ─────────────────────
#
# The 14-model curated picker (Chad agent + Nemotron + Llama family +
# Mixtral + Gemma + GPT-OSS + Phi-4 + Qwen3 Coder + GLM + MiniMax) lives
# in webui.db's `model` table. A fresh DB or a `--purge`-style teardown
# wipes them. seed-models.sql is INSERT-OR-REPLACE so re-applying never
# duplicates and never overwrites user_id assignments.
SEED_SQL="${WEBUI_DIR}/seed-models.sql"
WEBUI_DB="${WEBUI_DATA_DIR:-${HOME}/.nemoclaw/openwebui/data}/webui.db"
if [ "$DRY_RUN" -eq 0 ] && [ -f "$SEED_SQL" ] && [ -f "$WEBUI_DB" ]; then
  step "Seeding curated model records (idempotent)"
  if sqlite3 "$WEBUI_DB" <"$SEED_SQL" 2>&1; then
    count="$(sqlite3 "$WEBUI_DB" 'SELECT COUNT(*) FROM model;' 2>/dev/null || echo '?')"
    ok "model records seeded (${count} total in webui.db)"
    docker restart nemoclaw-openwebui >/dev/null 2>&1 || true
  else
    warn "seed-models.sql apply failed — admin UI > Models still works for manual entry"
  fi
fi

# ── 9d. Pin journal_mode=DELETE on webui.db ─────────────────────────
#
# Docker Desktop's macOS bind-mount filesystem ("fakeowner") flakes under
# SQLite WAL: the SHM coordination file can return SQLITE_IOERR ("disk
# I/O error") on reads, which OpenWebUI's `Users.get_user_by_email`
# silently swallows (returns None). Trusted-header SSO then falls
# through to signup, which exposes the same I/O error on INSERT and
# returns 401 to the browser — locking the user out even though the
# account exists. DELETE journal mode is the original SQLite default
# and works reliably on bind-mounts.
#
# `PRAGMA journal_mode=DELETE` is persistent on the file, but apply on
# every setup run for safety: an alembic migration or upstream change
# could flip it back to WAL.
if [ "$DRY_RUN" -eq 0 ] && [ -f "$WEBUI_DB" ]; then
  step "Pinning webui.db journal_mode=DELETE (bind-mount safety)"
  current_mode="$(sqlite3 "$WEBUI_DB" 'PRAGMA journal_mode;' 2>/dev/null || echo 'unknown')"
  if [ "$current_mode" = "delete" ]; then
    ok "journal_mode already DELETE"
  else
    docker stop nemoclaw-openwebui >/dev/null 2>&1 || true
    new_mode="$(sqlite3 "$WEBUI_DB" 'PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;' 2>/dev/null | tail -1)"
    docker start nemoclaw-openwebui >/dev/null 2>&1 || true
    if [ "$new_mode" = "delete" ]; then
      ok "journal_mode switched ${current_mode} → DELETE"
    else
      warn "journal_mode switch returned: ${new_mode} (signin may still 401)"
    fi
  fi
fi

# ── 9e. Seed Open Terminal connection + per-user terminal settings ───
#
# OpenWebUI's terminal UI is driven from TWO independent places and seeding
# only the first is the documented cause of "No terminal connections
# configured.":
#
#   1. config table, key terminal_server.connections  (the admin list —
#      what GET /api/v1/terminals/ returns). TERMINAL_SERVER_CONNECTIONS in
#      docker-compose.yml seeds this on the FIRST boot of a fresh webui.db
#      only, and is silently ignored on every boot after that.
#   2. user.settings -> ui.terminalServers             (the per-user list).
#      The frontend's $terminalServers store is populated only from here, and
#      the chat's terminal controls are gated on $selectedTerminalId, which is
#      set only when a user picks a terminal from the dropdown.
#
# With (2) empty the UI renders "No terminal connections configured." even
# though (1) is perfect and the API returns 200. seed-terminal-config.py writes
# both, idempotently, and backs the DB up first. Re-running is a no-op.
SEED_TERMINAL="${WEBUI_DIR}/seed-terminal-config.py"
if [ "$DRY_RUN" -eq 0 ] && [ -f "$SEED_TERMINAL" ] && [ -f "$WEBUI_DB" ]; then
  step "Seeding Open Terminal connection + per-user terminal settings (idempotent)"
  if seed_out="$(WEBUI_DB="$WEBUI_DB" python3 "$SEED_TERMINAL" --apply 2>&1)"; then
    ok "terminal config seeded"
    printf '%s\n' "$seed_out" | sed 's/^/    /'
    # Users must reload for the per-user settings to reach the Svelte store.
    docker restart nemoclaw-openwebui >/dev/null 2>&1 || true
  else
    warn "seed-terminal-config.py failed — the chat terminal will show 'no terminal configured':"
    printf '%s\n' "$seed_out" | sed 's/^/    /'
  fi
fi

# ── 10. Summary ─────────────────────────────────────────────────────
step "Setup complete"
info "  URL:          https://${WEBUI_FQDN}"
info "  Admin emails: ${ADMIN_EMAILS}"
info "  Local debug:  http://127.0.0.1:${WEBUI_HOST_PORT:-3000}"
info "  Logs:         npm run webui:logs"
info "  Stop:         npm run webui:down"
info "  Tear down +"
info "  CF cleanup:   bash scripts/openwebui-down.sh --purge"
