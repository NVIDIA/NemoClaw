#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# chad-ops.sh — one host-side dispatcher for the recurring Chad operations that
# otherwise turn into 10 ad-hoc ssh/kubectl/launchctl commands. Small atomic
# subcommands, plus a few *composed* "situation" commands (doctor / recover /
# gate-sync) that chain them in the right order. Every step is idempotent: it
# checks current state and skips work that's already healthy, so a partial run
# (e.g. an interrupted cold-start recovery) is finished by simply re-running.
#
# Runs on the HOST (needs docker+kubectl to the node, launchctl for the
# watchdogs, ssh to the sandbox). It is NOT deployed to the pod.
#
# ── Situations this codifies ────────────────────────────────────────────────
#   chad-ops doctor         Read-only: is anything broken right now?
#   chad-ops recover        Pod restarted / cold start — bring Chad fully back.
#   chad-ops gate-sync      Operators changed — push allowlist + restart shim.
#
# ── Atomic building blocks ──────────────────────────────────────────────────
#   chad-ops deploy [--all] chad-deploy push (binaries/config → pod)
#   chad-ops verify         chad-deploy verify (drift/absent report)
#   chad-ops chown          Fix /sandbox/.openclaw ownership (root → sandbox)
#   chad-ops gbrain-fix     Recreate the gbrain-bin stub the wrapper needs
#   chad-ops restart-shim   Bounce chad-shim + wait for :8901
#   chad-ops restart-gateway  Bounce openclaw gateway + wait for :18789
#   chad-ops creds-sync     Host creds → pod credentials.json (GITHUB_TOKEN, etc.)
#   chad-ops restore-data   chad-restore-from-github (workspace/memory/gbrain/cron)
#   chad-ops cron-reload    Re-register crons from the restored jobs.json
#   chad-ops embed-backfill Backfill gbrain embeddings (bg) after a restore
#   chad-ops bonjour-off    Disable the mDNS plugin that crashes the gateway
#   chad-ops gbrain-config  Rewrite gbrain embed config (NVIDIA key/model)
#   chad-ops skills-register  Set skills.load.extraDirs → Chad's custom skills
#   chad-ops gate-check     Verify the Chad-lite allowlist denies/allows correctly
#   chad-ops inbox-prune    Strip watchdog error noise from the agent-inbox
#
# Usage: chad-ops.sh <command> [args];  chad-ops.sh --help
# Env overrides: CHAD_SSH_HOST, CHAD_DOCKER_HOST, CHAD_K8S_NS, CHAD_POD,
#                CHAD_SHIM_PORT, CHAD_GATEWAY_PORT, CHAD_HOST_CREDS, SMITHERS_DIR.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SSH_HOST="${CHAD_SSH_HOST:-openshell-chad}"
DOCKER_HOST="${CHAD_DOCKER_HOST:-openshell-cluster-nemoclaw}"
K8S_NS="${CHAD_K8S_NS:-openshell}"
POD="${CHAD_POD:-chad}"
SHIM_PORT="${CHAD_SHIM_PORT:-8901}"
GW_PORT="${CHAD_GATEWAY_PORT:-18789}"
HOST_CREDS="${CHAD_HOST_CREDS:-${HOME}/.nemoclaw/credentials.json}"
ALLOWLIST_FILE="/sandbox/.openclaw-data/state/operator-allowlist"
INBOX="/sandbox/.openclaw-data/state/agent-inbox.jsonl"
GUI="gui/$(id -u)"

# ── Output helpers ──────────────────────────────────────────────────────────
RED='\033[0;31m' GRN='\033[0;32m' YEL='\033[1;33m' BLU='\033[0;34m' DIM='\033[2m' RST='\033[0m'
step() { printf '%b==>%b %s\n' "$BLU" "$RST" "$*"; }
ok()   { printf '  %b✓%b %s\n' "$GRN" "$RST" "$*"; }
warn() { printf '  %b!%b %s\n' "$YEL" "$RST" "$*"; }
bad()  { printf '  %b✗%b %s\n' "$RED" "$RST" "$*"; }
dim()  { printf '    %b%s%b\n' "$DIM" "$*" "$RST"; }

kx()  { docker exec "$DOCKER_HOST" kubectl exec -n "$K8S_NS" "$POD" -- sh -c "$1" </dev/null 2>&1 | grep -viE 'UNDICI|trace-warnings'; }
sshp(){ ssh -n -o BatchMode=yes -o ConnectTimeout=12 "$SSH_HOST" "$1" 2>&1 | grep -viE 'UNDICI|trace-warnings'; }

wait_port_host() { # $1 port, $2 label — wait for host-tunnel port to answer 200 on /v1/models
  local i code
  for i in $(seq 1 "${3:-10}"); do
    code=$(curl -sS -o /dev/null -w '%{http_code}' -m 6 "http://127.0.0.1:$1/v1/models" 2>/dev/null)
    [ "$code" = "200" ] && { ok "$2 up on :$1"; return 0; }
    sleep 4
  done
  bad "$2 did not come up on :$1"; return 1
}

# ── Atomic subcommands ──────────────────────────────────────────────────────
cmd_verify()  { step "verify (binary/config drift)"; ( cd "$HERE" && ./chad-deploy.sh --verify ); }
cmd_deploy()  { step "deploy (push binaries/config)"; ( cd "$HERE" && ./chad-deploy.sh --push "$@" ); }

cmd_chown() {
  step "chown /sandbox/.openclaw → sandbox (post-restart ownership reset)"
  local n; n=$(kx 'find /sandbox/.openclaw ! -user sandbox 2>/dev/null | wc -l' | tr -d ' ')
  if [ "${n:-0}" = "0" ]; then ok "already sandbox-owned"; return 0; fi
  warn "$n entries root-owned — chowning"
  kx 'chown -R sandbox:sandbox /sandbox/.openclaw && mkdir -p /sandbox/.openclaw/workspace/state && chown sandbox:sandbox /sandbox/.openclaw/workspace/state' >/dev/null
  n=$(kx 'find /sandbox/.openclaw ! -user sandbox 2>/dev/null | wc -l' | tr -d ' ')
  [ "${n:-1}" = "0" ] && ok "ownership fixed" || bad "still $n root-owned"
}

cmd_gbrain_fix() {
  step "gbrain-fix (ensure gbrain-bin stub the wrapper execs)"
  if kx 'test -x /usr/local/bin/gbrain-bin && echo ok' | grep -q ok; then ok "gbrain-bin present"; return 0; fi
  # The image ships the real gbrain as a bun-CLI stub; chad-setup copies it to
  # gbrain-bin so the env-injecting wrapper can wrap it. A pod restart drops the
  # copy — recreate the identical stub pointing at the image's gbrain code.
  kx 'printf "#!/bin/sh\nexec bun /usr/local/lib/gbrain/node_modules/gbrain/src/cli.ts \"\$@\"\n" > /usr/local/bin/gbrain-bin && chmod 755 /usr/local/bin/gbrain-bin && echo done' >/dev/null
  if sshp 'gbrain health 2>&1 | head -1' | grep -qiE 'health score|coverage'; then ok "gbrain-bin restored, health responds"; else bad "gbrain still not answering"; fi
}

cmd_restart_shim() {
  step "restart-shim (+ refresh allowlist, wait :$SHIM_PORT)"
  sshp "pkill -9 -f chad-shim.py 2>/dev/null; true" >/dev/null
  launchctl kickstart -k "$GUI/dev.nemoclaw.chad-shim-watchdog" 2>/dev/null || true
  wait_port_host "$SHIM_PORT" "shim"
}

cmd_bonjour_off() {
  step "bonjour-off (the mDNS plugin crashes the pod gateway ~20s after start → 1006)"
  if sshp 'openclaw plugins list 2>/dev/null | grep -i bonjour | grep -qi disabled && echo d'; then ok "bonjour already disabled"; return 0; fi
  sshp 'openclaw plugins disable bonjour 2>&1 | grep -i disabled | head -1' >/dev/null
  ok "bonjour disabled (gateway restart applies it)"
}

cmd_gbrain_config() {
  step "gbrain-config (rewrite /sandbox/.gbrain/config.json — NVIDIA NIM key/model)"
  # gbrain init clobbers config to {engine,database_path} only, dropping the API
  # key + embed model → embeds 401 'unused'. Rewrite from the pod creds (needs
  # creds-sync first). Preserves the existing database_path.
  sshp 'python3 - <<PY
import json,os
key=json.load(open("/sandbox/.nemoclaw/credentials.json")).get("NVIDIA_API_KEY","") if os.path.exists("/sandbox/.nemoclaw/credentials.json") else ""
p="/sandbox/.gbrain/config.json"
try: cur=json.load(open(p))
except Exception: cur={}
cur.update({"engine":"pglite","database_path":cur.get("database_path","/sandbox/.gbrain/brain.pglite"),
  "openai_api_key":key or "unused","openai_base_url":"https://integrate.api.nvidia.com/v1",
  "embed_model":"nvidia/nemotron-3-embed-1b","embed_dimensions":"2048","embed_input_type":"passage"})
# NOTE: llama-nemotron-embed-1b-v2 (1536d) hit EOL 2026-08-25 (410). nemotron-3-embed-1b
# is the current successor but emits 2048d (no truncation), exceeding the pgvector HNSW
# 2000-dim cap, so content_chunks.embedding is vector(2048) WITHOUT an hnsw index
# (seq-scan; fine at this scale). A fresh gbrain init would fail the hnsw index on 2048;
# the live brain was migrated in place (see docs MASTER-REVIEW gbrain section).
json.dump(cur,open(p,"w"),indent=2); os.chmod(p,0o600)
print("key_set:",bool(key and key!="unused"))
PY'
}

cmd_skills_register() {
  step "skills-register (skills.load.extraDirs → Chad's skill dir; a restart drops it)"
  local cur; cur=$(sshp 'python3 -c "import json;print(json.load(open(\"/sandbox/.openclaw/openclaw.json\")).get(\"skills\",{}).get(\"load\",{}).get(\"extraDirs\"))"')
  if echo "$cur" | grep -q "openclaw-data/skills"; then ok "extraDirs already set"; return 0; fi
  sshp 'openclaw config set skills.load.extraDirs --strict-json "[\"/sandbox/.openclaw-data/skills\"]" 2>&1 | grep -i updated | head -1' >/dev/null
  ok "extraDirs set (gateway restart applies it)"
}

cmd_restart_gateway() {
  step "restart-gateway (wait :$GW_PORT on pod)"
  kx 'pkill -9 -f "openclaw.*gateway" 2>/dev/null; pkill -9 -f openclaw-gateway 2>/dev/null; true' >/dev/null
  launchctl kickstart -k "$GUI/dev.nemoclaw.chad-gateway-watchdog" 2>/dev/null || true
  local i up
  for i in $(seq 1 12); do
    up=$(sshp "ss -tln 2>/dev/null | grep -q ':$GW_PORT' && echo yes || echo no")
    [ "$up" = "yes" ] && { ok "gateway listening on :$GW_PORT"; return 0; }
    sleep 5
  done
  bad "gateway did not bind :$GW_PORT"
}

cmd_creds_sync() {
  step "creds-sync (host creds → pod /sandbox/.nemoclaw/credentials.json, filtered)"
  # Mirror chad-setup.sh: push only the keys the pod actually needs. A pod
  # restart drops this file, which breaks gh operations (restore/backup) and
  # gbrain embeds (NVIDIA_API_KEY). Streamed over stdin — never on argv/ps.
  [ -f "$HOST_CREDS" ] || { bad "host creds not found: $HOST_CREDS"; return 1; }
  local filtered
  filtered="$(python3 -c "
import json,sys
keep=['PROTON_USERNAME','PROTON_PASSWORD','GITHUB_TOKEN','BRAVE_API_KEY','NVIDIA_API_KEY','ANTHROPIC_API_KEY','NEMOCLAW_INVOKER_TOKEN']
src=json.load(open('$HOST_CREDS'))
json.dump({k:src[k] for k in keep if k in src}, sys.stdout)
" 2>/dev/null)"
  [ -n "$filtered" ] || { bad "could not build filtered creds"; return 1; }
  printf '%s' "$filtered" | ssh -o BatchMode=yes -o ConnectTimeout=12 "$SSH_HOST" \
    "mkdir -p /sandbox/.nemoclaw && cat > /sandbox/.nemoclaw/credentials.json && chmod 600 /sandbox/.nemoclaw/credentials.json && echo ok" >/dev/null 2>&1 \
    && ok "pod credentials.json written ($(printf '%s' "$filtered" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)))') keys)" \
    || bad "failed to write pod credentials.json"
}

cmd_restore_data() {
  step "restore-data (chad-restore-from-github: workspace/memory/gbrain/cron)"
  warn "overwrites pod workspace state from the chad-state backup"
  sshp 'chad-restore-from-github 2>&1 | tail -20'
}

cmd_cron_reload() {
  step "cron-reload (re-register crons from restored jobs.json)"
  sshp 'chad-cron-reload 2>&1 | tail -8'
}

cmd_embed_backfill() {
  step "embed-backfill (gbrain embed --stale in background; NVIDIA NIM)"
  # After a restore the imported pages have no embeddings — semantic recall is
  # dark until backfilled. The nightly gbrain-dream cron does this incrementally;
  # this kicks it now, detached, so a big restore doesn't block the terminal.
  local miss; miss=$(sshp 'gbrain health 2>&1 | grep -i "missing embeddings" | grep -oE "[0-9]+" | head -1')
  if [ "${miss:-0}" = "0" ]; then ok "no missing embeddings"; return 0; fi
  warn "${miss} pages missing embeddings — backfilling in background"
  sshp "nohup sh -c 'gbrain embed --stale > /tmp/gbrain-embed.log 2>&1' >/dev/null 2>&1 & echo started pid \$!"
  dim "progress: ssh $SSH_HOST 'tail -f /tmp/gbrain-embed.log'"
}

cmd_gate_sync() {
  step "gate-sync (push operator allowlist from host creds → pod file, restart shim)"
  local list
  list="$(python3 -c "import json;v=json.load(open('$HOST_CREDS')).get('CHAD_OPERATOR_ALLOWLIST','');print(','.join(v) if isinstance(v,list) else v)" 2>/dev/null || true)"
  if [ -z "$list" ]; then bad "no CHAD_OPERATOR_ALLOWLIST in $HOST_CREDS — gate would be fail-open"; return 1; fi
  dim "operators: $list"
  sshp "mkdir -p \$(dirname '$ALLOWLIST_FILE'); printf '%s\n' '$list' | tr ',' '\n' > '$ALLOWLIST_FILE'; echo wrote" >/dev/null
  ok "allowlist file written"
  cmd_restart_shim
  cmd_gate_check
}

cmd_gate_check() {
  step "gate-check (Chad-lite allowlist: deny non-operator, allow operator)"
  local op deny allow
  op="$(python3 -c "import json;v=json.load(open('$HOST_CREDS')).get('CHAD_OPERATOR_ALLOWLIST','');print((v[0] if isinstance(v,list) else v.split(',')[0]).strip())" 2>/dev/null || true)"
  deny=$(sshp "curl -sS -m 20 http://127.0.0.1:$SHIM_PORT/v1/chat/completions -H 'Content-Type: application/json' -H 'X-OpenWebUI-User-Email: nobody@example.invalid' -d '{\"model\":\"chad\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}'")
  echo "$deny" | grep -q "Chad Lite" && ok "non-operator DENIED (Chad Lite)" || bad "non-operator NOT denied — gate is fail-open!"
  if [ -n "$op" ]; then
    allow=$(sshp "curl -sS -m 45 http://127.0.0.1:$SHIM_PORT/v1/chat/completions -H 'Content-Type: application/json' -H 'X-OpenWebUI-User-Email: $op' -d '{\"model\":\"chad\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}'")
    echo "$allow" | grep -q "Chad Lite" && bad "operator $op wrongly DENIED" || ok "operator $op passes the gate"
  fi
}

cmd_inbox_prune() {
  step "inbox-prune (strip watchdog error noise)"
  sshp "
    cp '$INBOX' '$INBOX.bak.\$(date -u +%Y%m%dT%H%M%SZ)' 2>/dev/null
    b=\$(wc -l < '$INBOX' 2>/dev/null || echo 0)
    grep -vE '\"kind\":\"(chad-shim-restart-failed|spawn-poll-error|skill-watch-error)\"' '$INBOX' > '$INBOX.tmp' 2>/dev/null && mv '$INBOX.tmp' '$INBOX'
    a=\$(wc -l < '$INBOX' 2>/dev/null || echo 0)
    echo \"inbox: \$b -> \$a (removed \$((b-a)))\"
  "
}

cmd_doctor() {
  step "doctor — Chad health (read-only)"
  # shim
  local code; code=$(curl -sS -o /dev/null -w '%{http_code}' -m 6 "http://127.0.0.1:$SHIM_PORT/v1/models" 2>/dev/null)
  [ "$code" = "200" ] && ok "shim :$SHIM_PORT → 200" || bad "shim :$SHIM_PORT → ${code:-unreachable}"
  # gateway
  [ "$(sshp "ss -tln 2>/dev/null | grep -q ':$GW_PORT' && echo y")" = "y" ] && ok "gateway listening :$GW_PORT" || bad "gateway not listening :$GW_PORT"
  # gbrain
  local gh; gh=$(sshp 'gbrain health 2>&1 | grep -i "health score" | head -1')
  [ -n "$gh" ] && ok "gbrain: $gh" || bad "gbrain not answering (gbrain-bin missing?)"
  # binaries
  local drift; drift=$( ( cd "$HERE" && ./chad-deploy.sh --verify 2>/dev/null | grep -oE 'drift=[0-9]+  absent=[0-9]+' ) )
  echo "$drift" | grep -q 'drift=0  absent=0' && ok "binaries in sync ($drift)" || warn "binary drift: ${drift:-unknown} — run: chad-ops deploy"
  # allowlist gate
  local n; n=$(sshp "test -s '$ALLOWLIST_FILE' && wc -l < '$ALLOWLIST_FILE'")
  [ -n "$n" ] && ok "allowlist gate armed ($n operators)" || bad "allowlist EMPTY — gate fail-open (run: chad-ops gate-sync)"
  # crons registered (canonical durable set = 10 pod crons; 3 more are host timers)
  local crons; crons=$(sshp "openclaw cron list 2>/dev/null | grep -cE 'cron [0-9*]'")
  [ "${crons:-0}" -ge 10 ] && ok "crons registered ($crons)" || warn "only ${crons:-0} crons registered (expect 10) — run: chad-ops cron-reload"
  # Chad's custom skills loaded (extraDirs)
  local sk; sk=$(sshp "python3 -c \"import json;print('y' if 'openclaw-data/skills' in str(json.load(open('/sandbox/.openclaw/openclaw.json')).get('skills',{}).get('load',{}).get('extraDirs')) else 'n')\"")
  [ "$sk" = "y" ] && ok "custom skills loaded (extraDirs set)" || bad "skills.load.extraDirs unset — Chad skills dark (run: chad-ops skills-register)"
  # gbrain embed config (NVIDIA key, not clobbered)
  local ek; ek=$(sshp "python3 -c \"import json;c=json.load(open('/sandbox/.gbrain/config.json'));print('y' if c.get('openai_api_key') and c['openai_api_key']!='unused' and 'nvidia' in c.get('openai_base_url','') else 'n')\"")
  [ "$ek" = "y" ] && ok "gbrain embed config OK (NVIDIA)" || bad "gbrain embed config clobbered → 401 (run: chad-ops gbrain-config)"
  # inbox noise today
  local errs; errs=$(sshp "grep \$(date -u +%Y-%m-%d) '$INBOX' 2>/dev/null | grep -c '\"severity\":\"error\"'")
  [ "${errs:-0}" -gt 50 ] && warn "agent-inbox has ${errs} error events today (run: chad-ops inbox-prune)" || ok "agent-inbox clean (${errs:-0} errors today)"
}

cmd_recover() {
  step "RECOVER — full post-restart cold-start (idempotent; skips healthy steps)"
  # Order matters:
  #  - creds-sync before restore (restore needs GITHUB_TOKEN on the pod).
  #  - chown + gbrain-fix before restore (so it runs as sandbox and imports).
  #  - deploy AFTER restore: restore repopulates bin/ from the backup, which can
  #    be stale or non-executable (mode 644 → rc=126). deploy is the authoritative
  #    source for binaries/config, so it must win — run it last of the two.
  #  - restart gateway/shim after deploy+chown so they pick up fresh binaries.
  cmd_creds_sync
  cmd_chown
  cmd_gbrain_fix
  cmd_gbrain_config      # NVIDIA embed key/model (clobbered by gbrain init on restart)
  cmd_restore_data
  cmd_deploy || true
  cmd_cron_reload        # reconcile gateway ← jobs.json (restores the durable cron set)
  cmd_bonjour_off        # before gateway restart: stops the ~20s crash loop
  cmd_skills_register    # before gateway restart: loads Chad's custom skills
  cmd_restart_gateway
  cmd_gate_sync          # writes allowlist, restarts shim, verifies deny/allow
  cmd_embed_backfill
  echo; step "post-recovery doctor"; cmd_doctor
}

usage() { sed -n '4,45p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

main() {
  local c="${1:-}"; shift || true
  case "$c" in
    doctor)          cmd_doctor ;;
    recover)         cmd_recover ;;
    deploy)          cmd_deploy "$@" ;;
    verify)          cmd_verify ;;
    chown)           cmd_chown ;;
    gbrain-fix)      cmd_gbrain_fix ;;
    restart-shim)    cmd_restart_shim ;;
    restart-gateway) cmd_restart_gateway ;;
    creds-sync)      cmd_creds_sync ;;
    restore-data)    cmd_restore_data ;;
    cron-reload)     cmd_cron_reload ;;
    embed-backfill)  cmd_embed_backfill ;;
    bonjour-off)     cmd_bonjour_off ;;
    gbrain-config)   cmd_gbrain_config ;;
    skills-register) cmd_skills_register ;;
    gate-sync)       cmd_gate_sync ;;
    gate-check)      cmd_gate_check ;;
    inbox-prune)     cmd_inbox_prune ;;
    ""|-h|--help)    usage ;;
    *) echo "chad-ops: unknown command '$c'" >&2; usage; exit 2 ;;
  esac
}
main "$@"
