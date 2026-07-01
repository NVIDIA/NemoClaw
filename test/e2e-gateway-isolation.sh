#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# E2E test for gateway process isolation and entrypoint hardening.
# Builds the sandbox image and verifies that the sandboxed agent cannot
# compromise the gateway via the fake-HOME attack or related vectors.
#
# Requires: docker

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
IMAGE="${NEMOCLAW_TEST_IMAGE:-nemoclaw-isolation-test}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() {
  echo -e "${GREEN}PASS${NC}: $1"
  PASSED=$((PASSED + 1))
}
fail() {
  echo -e "${RED}FAIL${NC}: $1"
  FAILED=$((FAILED + 1))
}
info() { echo -e "${YELLOW}TEST${NC}: $1"; }

PASSED=0
FAILED=0

# ── Build the image ──────────────────────────────────────────────

# Skip build if image already exists (e.g., loaded from CI artifact)
if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  info "Using pre-built image: $IMAGE"
else
  info "Building sandbox image..."
  BUILD_LOG="$(mktemp)"
  if ! docker build -t "$IMAGE" "$REPO_DIR" >"$BUILD_LOG" 2>&1; then
    tail -40 "$BUILD_LOG"
    fail "Docker build failed (last 40 lines above)"
    exit 1
  fi
fi

# Helper: run a command inside the container as the sandbox user
run_as_sandbox() {
  docker run --rm --entrypoint "" "$IMAGE" gosu sandbox bash -c "$1" 2>&1
}

# Helper: run a command inside the container as root
run_as_root() {
  docker run --rm --entrypoint "" "$IMAGE" bash -c "$1" 2>&1
}

# ── Test 1: Gateway user exists and is different from sandbox ────

info "1. Gateway user exists with separate UID"
OUT=$(run_as_root "id gateway && id sandbox")
GW_UID=$(echo "$OUT" | grep "^uid=" | head -1 | sed 's/uid=\([0-9]*\).*/\1/')
SB_UID=$(echo "$OUT" | grep "^uid=" | tail -1 | sed 's/uid=\([0-9]*\).*/\1/')
SB_GID=$(echo "$OUT" | grep "^uid=" | tail -1 | sed 's/.*gid=\([0-9]*\).*/\1/')
if [ -n "$GW_UID" ] && [ -n "$SB_UID" ] && [ -n "$SB_GID" ] && [ "$GW_UID" != "$SB_UID" ]; then
  pass "gateway (uid=$GW_UID) and sandbox (uid=$SB_UID) are different users"
else
  fail "gateway and sandbox IDs not distinct or incomplete: $OUT"
fi

# ── Test 2: openclaw.json is writable by sandbox user (mutable default) ──

info "2. openclaw.json is writable by sandbox user (mutable default)"
OUT=$(run_as_sandbox "test -w /sandbox/.openclaw/openclaw.json && echo WRITABLE || echo BLOCKED")
if echo "$OUT" | grep -q "WRITABLE"; then
  pass "sandbox can write to openclaw.json (mutable default)"
else
  fail "sandbox should be able to write to openclaw.json in mutable default: $OUT"
fi

# ── Test 3: .openclaw directory is writable by sandbox (mutable default) ──

info "3. .openclaw directory is writable by sandbox (mutable default)"
OUT=$(run_as_sandbox "touch /sandbox/.openclaw/test-write && rm /sandbox/.openclaw/test-write && echo OK || echo BLOCKED")
if echo "$OUT" | grep -q "OK"; then
  pass "sandbox can write to .openclaw directory (mutable default)"
else
  fail "sandbox should be able to write to .openclaw in mutable default: $OUT"
fi

# ── Test 4: Config hash file exists and is valid ─────────────────

info "4. Config hash exists and matches openclaw.json"
OUT=$(run_as_root "cd /sandbox/.openclaw && sha256sum -c .config-hash --status && echo VALID || echo INVALID")
if echo "$OUT" | grep -q "VALID"; then
  pass "config hash matches openclaw.json"
else
  fail "config hash mismatch: $OUT"
fi

# ── Test 5: Update hints are disabled in sandbox config ──────────

info "5. Sandbox config disables startup update hints"
OUT=$(run_as_root "python3 -c 'import json; cfg=json.load(open(\"/sandbox/.openclaw/openclaw.json\")); print(\"OK\" if cfg.get(\"update\", {}).get(\"checkOnStart\") is False else \"BAD\")'")
if echo "$OUT" | grep -q "OK"; then
  pass "startup update hints disabled"
else
  fail "startup update hints not disabled: $OUT"
fi

# ── Test 6: Config hash is writable by sandbox (mutable default) ──

info "6. Config hash writable by sandbox user (mutable default)"
OUT=$(run_as_sandbox "test -w /sandbox/.openclaw/.config-hash && echo WRITABLE || echo BLOCKED")
if echo "$OUT" | grep -q "WRITABLE"; then
  pass "sandbox can write to config hash (mutable default)"
else
  fail "sandbox cannot write to config hash — should be writable: $OUT"
fi

# ── Test 7: gosu is installed ────────────────────────────────────

info "7. gosu binary is available"
OUT=$(run_as_root "command -v gosu && gosu --version")
if echo "$OUT" | grep -q "gosu"; then
  pass "gosu installed"
else
  fail "gosu not found: $OUT"
fi

# ── Test 8: Entrypoint PATH is locked to system dirs ─────────────

info "8. Entrypoint locks PATH to system directories"
# Walk the entrypoint line-by-line, eval only export lines, stop after PATH.
OUT=$(run_as_root "bash -c 'while IFS= read -r line; do case \"\$line\" in export\\ *) eval \"\$line\" 2>/dev/null;; esac; case \"\$line\" in \"export PATH=\"*) break;; esac; done < /usr/local/bin/nemoclaw-start; echo \$PATH'")
if echo "$OUT" | grep -q "^/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin$"; then
  pass "PATH is locked to system directories"
else
  fail "PATH not locked as expected: $OUT"
fi

# ── Test 9: openclaw resolves to expected absolute path ──────────

info "9. Gateway runs the expected openclaw binary"
OUT=$(run_as_root "gosu gateway which openclaw")
if [ "$OUT" = "/usr/local/bin/openclaw" ]; then
  pass "openclaw resolves to /usr/local/bin/openclaw"
else
  fail "openclaw resolves to unexpected path: $OUT"
fi

# ── Test 10: State directories exist directly in .openclaw ──────

info "10. Agent state directories exist in .openclaw"
MISSING_DIRS=""
for dir in agents extensions workspace skills hooks memory; do
  OUT=$(run_as_root "test -d /sandbox/.openclaw/$dir && echo EXISTS || echo MISSING")
  if echo "$OUT" | grep -q "MISSING"; then
    MISSING_DIRS="$MISSING_DIRS $dir"
  fi
done
if [ -z "$MISSING_DIRS" ]; then
  pass "all expected state directories exist in .openclaw"
else
  fail "missing directories in .openclaw:$MISSING_DIRS"
fi

# ── Test 11: iptables is installed (required for network policy enforcement) ──

info "11. iptables is installed"
OUT=$(run_as_root "iptables --version 2>&1")
if echo "$OUT" | grep -q "iptables v"; then
  pass "iptables installed: $OUT"
else
  fail "iptables not found — sandbox network policies will not be enforced: $OUT"
fi

# ── Test 12: chattr is available for immutable hardening ─────────

info "12. chattr is available for shields up immutability"
OUT=$(run_as_root "command -v chattr 2>/dev/null || true")
if [ -n "$OUT" ]; then
  pass "chattr available at $OUT"
else
  fail "chattr not found — shields up immutability will not work"
fi

# ── Test 13: Sandbox user cannot kill gateway-user processes ─────

info "13. Sandbox user cannot kill gateway-user processes"
# Start a dummy process as gateway, try to kill it as sandbox
OUT=$(docker run --rm --entrypoint "" "$IMAGE" bash -c '
  gosu gateway sleep 60 &
  GW_PID=$!
  sleep 0.5
  RESULT=$(gosu sandbox kill $GW_PID 2>&1 || echo "EPERM")
  echo "$RESULT"
  kill $GW_PID 2>/dev/null || true
')
if echo "$OUT" | grep -qi "EPERM\|not permitted\|operation not permitted"; then
  pass "sandbox cannot kill gateway-user processes"
else
  fail "sandbox CAN kill gateway processes: $OUT"
fi

# ── Test 13a: Final image enforces the gateway-control boundary ──

info "13a. Final image keeps gateway control root-only with required group access"
# shellcheck disable=SC2016 # The container-side bash expands these expressions.
ROOT_CONTROL_OUT=$(run_as_root '
  set -eu
  [ "$(stat -c "%U:%G %a" /usr/local/bin/nemoclaw-gateway-control)" = "root:root 700" ]
  [ "$(stat -c "%U:%G %a" /usr/local/lib/nemoclaw/managed-gateway-control.py)" = "root:root 500" ]
  [ "$(stat -c "%U:%G %a" /usr/local/lib/nemoclaw/state-dir-guard.py)" = "root:root 500" ]
  [ "$(stat -c "%U:%G %a" /usr/local/lib/nemoclaw/openclaw-config-guard.py)" = "root:root 500" ]
  [ "$(stat -c "%U:%G %a" /usr/local/lib/nemoclaw/gateway-supervisor.sh)" = "root:root 444" ]
  [ "$(stat -c "%U:%G %a" /usr/local/lib/nemoclaw/normalize_mutable_config_perms.py)" = "root:root 555" ]
  echo META_OK
  id -nG gateway | tr " " "\n" | grep -qx sandbox
  id -nG root | tr " " "\n" | grep -qx sandbox
  echo GROUPS_OK
  nonce=$(printf "%064d" 0)
  rc=0
  /usr/local/bin/nemoclaw-gateway-control probe "$nonce" >/tmp/gateway-control-probe.out 2>&1 || rc=$?
  cat /tmp/gateway-control-probe.out
  [ "$rc" -ne 0 ]
  grep -qx SUPERVISOR_UNAVAILABLE /tmp/gateway-control-probe.out
  echo ROOT_PROBE_OK
' 2>&1 || true)
# shellcheck disable=SC2016 # The container-side bash expands these expressions.
SANDBOX_CONTROL_OUT=$(run_as_sandbox '
  nonce=$(printf "%064d" 0)
  /usr/local/bin/nemoclaw-gateway-control probe "$nonce"
' 2>&1 || true)
if echo "$ROOT_CONTROL_OUT" | grep -q META_OK \
  && echo "$ROOT_CONTROL_OUT" | grep -q GROUPS_OK \
  && echo "$ROOT_CONTROL_OUT" | grep -q ROOT_PROBE_OK \
  && echo "$SANDBOX_CONTROL_OUT" | grep -qi "permission denied" \
  && ! echo "$SANDBOX_CONTROL_OUT" | grep -q PRIVILEGED_CONTROL_UNAVAILABLE; then
  pass "gateway control modes, group access, root probe, and sandbox-user refusal are enforced"
else
  fail "gateway control boundary mismatch: root=[$ROOT_CONTROL_OUT] sandbox=[$SANDBOX_CONTROL_OUT]"
fi

# ── Test 14: Dangerous capabilities are dropped by entrypoint ────

info "14. Entrypoint drops the full issue #3280 dangerous-cap inventory from sandbox-user bounding set"
# Inventory every cap named in issue #3280 against CapBnd of the
# sandbox-user process AFTER both stages of the entrypoint's privilege
# step-down: (1) the entrypoint-wide capsh drop in drop_capabilities()
# and (2) the per-user setpriv drop in STEP_DOWN_PREFIX_SANDBOX. The
# previous test (#3328) only exercised stage 1 and classified
# CAP_FOWNER/SETUID/SETGID as load-bearing because gosu needed them;
# the follow-up replaces gosu with setpriv so those three drop
# atomically with reuid, and ALL eight issue-named caps must be absent.
#
# IMPORTANT: docker's default bounding set already excludes CAP_SYS_ADMIN
# and CAP_SYS_PTRACE, so a plain "docker run" cannot reproduce the issue
# #3280 condition (permissive OpenShell runtime). We --cap-add those two
# caps here so the bounding set entering the entrypoint resembles the
# runtime that triggered T6002104.
#
# Strategy: replay the two production drop stages inline by sourcing
# sandbox-init.sh and using its drop_capabilities() function and
# STEP_DOWN_PREFIX_SANDBOX array directly. This avoids depending on the
# entrypoint's volume mounts / config files while still exercising the
# exact production code paths.
OUT=$(docker run --rm --entrypoint "" \
  --cap-add=CAP_SYS_ADMIN --cap-add=CAP_SYS_PTRACE \
  "$IMAGE" \
  bash -c '
    source /usr/local/lib/nemoclaw/sandbox-init.sh
    # Stage 1: drop_capabilities re-execs via capsh with the entrypoint-
    # wide --drop list. The argument is the inner script that runs after
    # the re-exec, which then does stage 2 (setpriv step-down) via
    # STEP_DOWN_PREFIX_SANDBOX and prints CapBnd. We exec grep directly
    # rather than wrapping in bash -c "awk ..." to avoid a triple-quoted
    # awk script — the $2 in $print $2$ would otherwise be expanded by
    # bash on its way through capsh re-exec.
    drop_capabilities /bin/bash -c "
      source /usr/local/lib/nemoclaw/sandbox-init.sh
      exec \"\${STEP_DOWN_PREFIX_SANDBOX[@]}\" grep ^CapBnd: /proc/self/status
    "
  ' 2>&1 || true)
echo "Sandbox-user CapBnd output: $OUT"

CAP_BND=$(echo "$OUT" | grep ^CapBnd: | head -1 | awk '{print $2}')
if [ -z "$CAP_BND" ]; then
  fail "could not capture CapBnd from post-stepdown process: $OUT"
else
  val=$((16#$CAP_BND))
  bad=0
  for entry in \
    21:CAP_SYS_ADMIN \
    19:CAP_SYS_PTRACE \
    13:CAP_NET_RAW \
    10:CAP_NET_BIND_SERVICE \
    1:CAP_DAC_OVERRIDE \
    3:CAP_FOWNER \
    7:CAP_SETUID \
    6:CAP_SETGID; do
    bit=${entry%%:*}
    name=${entry#*:}
    if [ $(((val >> bit) & 1)) -ne 0 ]; then
      bad=$((bad + 1))
      fail "$name still present in sandbox-user CapBnd (issue #3280)"
    fi
  done
  if [ "$bad" -eq 0 ]; then
    pass "entrypoint drops the full issue #3280 dangerous-cap inventory (all 8 caps absent from sandbox-user CapBnd: 0x$CAP_BND)"
  fi
fi

# ── Test 13b: Sandbox user cannot write to .nemoclaw parent ───────
# Note: /sandbox itself is sandbox-owned and writable in the mutable-default
# policy. This check only covers the root-owned .nemoclaw parent.

info "13b. Sandbox user cannot create files in /sandbox/.nemoclaw"
OUT=$(run_as_sandbox "touch /sandbox/.nemoclaw/testfile 2>&1 || echo BLOCKED")
if echo "$OUT" | grep -q "BLOCKED\|Permission denied"; then
  pass "sandbox cannot create files in .nemoclaw parent (root-owned)"
else
  fail "sandbox CAN create files in .nemoclaw parent: $OUT"
fi

# ── Test 14b: Sandbox user cannot modify blueprints ──────────────

info "14b. Sandbox user cannot modify blueprints"
OUT=$(run_as_sandbox "touch /sandbox/.nemoclaw/blueprints/testfile 2>&1 || echo BLOCKED")
if echo "$OUT" | grep -q "BLOCKED\|Permission denied"; then
  pass "sandbox cannot write to blueprints (root-owned)"
else
  fail "sandbox CAN write to blueprints: $OUT"
fi

# ── Test 15: Sandbox user CAN write to .nemoclaw/state ────────────

info "15. Sandbox user can write to .nemoclaw/state"
OUT=$(run_as_sandbox "touch /sandbox/.nemoclaw/state/testfile && echo OK || echo FAILED")
if echo "$OUT" | grep -q "OK"; then
  pass "sandbox can write to .nemoclaw/state (sandbox-owned)"
else
  fail "sandbox cannot write to .nemoclaw/state: $OUT"
fi

# ── Test 16: Sandbox user CAN write to .openclaw ──────────────────

info "16. Sandbox user can write to .openclaw"
OUT=$(run_as_sandbox "touch /sandbox/.openclaw/testfile && rm -f /sandbox/.openclaw/testfile && echo OK || echo FAILED")
if echo "$OUT" | grep -q "OK"; then
  pass "sandbox can write to .openclaw (sandbox-owned, mutable default)"
else
  fail "sandbox cannot write to .openclaw: $OUT"
fi

# ── Test 17: Sandbox user cannot rename/delete blueprints dir ─────

info "17. Sandbox user cannot rename blueprints directory"
OUT=$(run_as_sandbox "mv /sandbox/.nemoclaw/blueprints /sandbox/.nemoclaw/blueprints-evil 2>&1 || echo BLOCKED")
if echo "$OUT" | grep -q "BLOCKED\|Permission denied"; then
  pass "sandbox cannot rename blueprints (parent is root-owned)"
else
  fail "sandbox CAN rename blueprints: $OUT"
fi

# ── Test 18: Sandbox user CAN write to .nemoclaw/migration ────────

info "18. Sandbox user can write to .nemoclaw/migration"
OUT=$(run_as_sandbox "touch /sandbox/.nemoclaw/migration/testfile && echo OK || echo FAILED")
if echo "$OUT" | grep -q "OK"; then
  pass "sandbox can write to .nemoclaw/migration (sandbox-owned)"
else
  fail "sandbox cannot write to .nemoclaw/migration: $OUT"
fi

# ── Test 19: Sandbox user CAN write to .nemoclaw/snapshots ────────

info "19. Sandbox user can write to .nemoclaw/snapshots"
OUT=$(run_as_sandbox "touch /sandbox/.nemoclaw/snapshots/testfile && echo OK || echo FAILED")
if echo "$OUT" | grep -q "OK"; then
  pass "sandbox can write to .nemoclaw/snapshots (sandbox-owned)"
else
  fail "sandbox cannot write to .nemoclaw/snapshots: $OUT"
fi

# ── Test 20: Sandbox user CAN write to .nemoclaw/staging ──────────

info "20. Sandbox user can write to .nemoclaw/staging"
OUT=$(run_as_sandbox "touch /sandbox/.nemoclaw/staging/testfile && echo OK || echo FAILED")
if echo "$OUT" | grep -q "OK"; then
  pass "sandbox can write to .nemoclaw/staging (sandbox-owned)"
else
  fail "sandbox cannot write to .nemoclaw/staging: $OUT"
fi

# ── Test 21: Sandbox user CAN write to .nemoclaw/config.json ──────

info "21. Sandbox user can write to .nemoclaw/config.json"
OUT=$(run_as_sandbox "echo '{}' > /sandbox/.nemoclaw/config.json && echo OK || echo FAILED")
if echo "$OUT" | grep -q "OK"; then
  pass "sandbox can write to .nemoclaw/config.json (sandbox-owned)"
else
  fail "sandbox cannot write to .nemoclaw/config.json: $OUT"
fi

# ── Test 22: Sandbox user can create new files in .openclaw (mutable default) ──

info "22. Sandbox user can create new files in .openclaw directory (mutable default)"
OUT=$(run_as_sandbox "touch /sandbox/.openclaw/newfile && rm -f /sandbox/.openclaw/newfile && echo OK || echo BLOCKED")
if echo "$OUT" | grep -q "OK"; then
  pass "sandbox can create new files in .openclaw (mutable default)"
else
  fail "sandbox cannot create new files in .openclaw — should be writable: $OUT"
fi

# ── Test 23: .bashrc has no proxy entries ────────────────────────

info "23. .bashrc has no proxy entries"
OUT=$(run_as_sandbox "if [ ! -f /sandbox/.bashrc ]; then echo MISSING; elif grep -i proxy /sandbox/.bashrc; then echo FOUND; else echo OK; fi")
if echo "$OUT" | grep -qx "OK"; then
  pass ".bashrc has no proxy entries"
elif echo "$OUT" | grep -q "MISSING\|No such file"; then
  fail ".bashrc is missing"
else
  fail ".bashrc contains proxy entries: $OUT"
fi

# ── Test 24: .profile has no proxy entries ───────────────────────

info "24. .profile has no proxy entries"
OUT=$(run_as_sandbox "if [ ! -f /sandbox/.profile ]; then echo MISSING; elif grep -i proxy /sandbox/.profile; then echo FOUND; else echo OK; fi")
if echo "$OUT" | grep -qx "OK"; then
  pass ".profile has no proxy entries"
elif echo "$OUT" | grep -q "MISSING\|No such file"; then
  fail ".profile is missing"
else
  fail ".profile contains proxy entries: $OUT"
fi

# ── Test 25: proxy-env.sh is NOT writable by sandbox user (#2181) ──
# The entrypoint writes /tmp/nemoclaw-proxy-env.sh via emit_sandbox_sourced_file()
# which sets mode 444 and root ownership. The sandbox user must not be able to
# modify this file, as the system-wide shell hooks source it on every connect.
# Since the E2E bypasses the entrypoint (--entrypoint ""), we simulate what the
# entrypoint does: create the file as root with mode 444, then verify sandbox
# cannot modify it.

info "25. proxy-env.sh is not writable by sandbox user"
OUT=$(docker run --rm --entrypoint "" "$IMAGE" bash -c '
  echo "# proxy config placeholder" > /tmp/nemoclaw-proxy-env.sh
  chown root:root /tmp/nemoclaw-proxy-env.sh
  chmod 444 /tmp/nemoclaw-proxy-env.sh
  gosu sandbox bash -c "echo test >> /tmp/nemoclaw-proxy-env.sh 2>&1; echo EXIT=\$?"
' 2>&1)
if echo "$OUT" | grep -q "EXIT=1\|Permission denied"; then
  pass "sandbox user cannot write to /tmp/nemoclaw-proxy-env.sh"
else
  fail "sandbox user CAN write to proxy-env.sh: $OUT"
fi

# ── Test 26: proxy-env.sh has correct permissions (#2181) ─────────

info "26. proxy-env.sh is read-only (mode 444, root-owned)"
OUT=$(docker run --rm --entrypoint "" "$IMAGE" bash -c '
  echo "# proxy config placeholder" > /tmp/nemoclaw-proxy-env.sh
  chown root:root /tmp/nemoclaw-proxy-env.sh
  chmod 444 /tmp/nemoclaw-proxy-env.sh
  stat -c "%a %U" /tmp/nemoclaw-proxy-env.sh
' 2>&1)
if echo "$OUT" | grep -q "444 root"; then
  pass "proxy-env.sh is 444 root-owned"
else
  fail "proxy-env.sh has unexpected permissions: $OUT"
fi

# ── Test 26a: /etc/profile.d/nemoclaw-proxy.sh sources proxy-env (#2704) ──
# Login shells (bash -lc) run /etc/profile, which dot-sources every
# /etc/profile.d/*.sh.  Without this hook, login shells started as a user
# whose HOME ≠ /sandbox (root, container exec without --user) silently miss
# the proxy env even when /tmp/nemoclaw-proxy-env.sh is populated.

info "26a. /etc/profile.d/nemoclaw-proxy.sh sources proxy config"
OUT=$(run_as_root "cat /etc/profile.d/nemoclaw-proxy.sh 2>/dev/null || echo MISSING")
if echo "$OUT" | grep -q "/tmp/nemoclaw-proxy-env.sh"; then
  pass "/etc/profile.d/nemoclaw-proxy.sh sources /tmp/nemoclaw-proxy-env.sh"
elif echo "$OUT" | grep -q "MISSING"; then
  fail "/etc/profile.d/nemoclaw-proxy.sh is missing (#2704)"
else
  fail "/etc/profile.d/nemoclaw-proxy.sh does not source from expected path: $OUT"
fi

# ── Test 26b: /etc/bash.bashrc prepends the proxy hook (#2704) ────
# Interactive non-login bash (bash -ic) sources /etc/bash.bashrc.  The
# stock Debian/Ubuntu file has `[ -z "$PS1" ] && return` near the top, so
# the hook must precede that guard to fire reliably in non-TTY contexts.

info "26b. /etc/bash.bashrc prepends proxy source line ahead of PS1 guard"
OUT=$(run_as_root "head -3 /etc/bash.bashrc")
if echo "$OUT" | head -2 | grep -q "/tmp/nemoclaw-proxy-env.sh"; then
  pass "/etc/bash.bashrc sources /tmp/nemoclaw-proxy-env.sh before the PS1 guard"
else
  fail "/etc/bash.bashrc does not source the proxy hook in the first 3 lines: $OUT"
fi

# ── Test 26c: bash -ic and bash -lc both pick up /tmp/nemoclaw-proxy-env.sh (#2704) ──
# End-to-end check: write a sentinel export into the runtime proxy-env
# file, then verify both interactive (bash -ic) and login (bash -lc)
# bash modes export it, regardless of which user is running. Mirrors the
# QA test T5893674.

info "26c. bash -ic and bash -lc export proxy env from /tmp/nemoclaw-proxy-env.sh"
OUT=$(docker run --rm --entrypoint "" "$IMAGE" bash -c '
  printf "export NEMOCLAW_PROXY_PROBE=https://probe.invalid:9999\n" \
    > /tmp/nemoclaw-proxy-env.sh
  chmod 444 /tmp/nemoclaw-proxy-env.sh
  echo "ROOT_BASH_IC=$(bash -ic "echo \$NEMOCLAW_PROXY_PROBE" 2>/dev/null)"
  echo "ROOT_BASH_LC=$(bash -lc "echo \$NEMOCLAW_PROXY_PROBE" 2>/dev/null)"
  echo "SANDBOX_BASH_IC=$(gosu sandbox bash -ic "echo \$NEMOCLAW_PROXY_PROBE" 2>/dev/null)"
  echo "SANDBOX_BASH_LC=$(gosu sandbox bash -lc "echo \$NEMOCLAW_PROXY_PROBE" 2>/dev/null)"
' 2>&1)
EXPECTED="https://probe.invalid:9999"
if echo "$OUT" | grep -qE "ROOT_BASH_IC=$EXPECTED" \
  && echo "$OUT" | grep -qE "ROOT_BASH_LC=$EXPECTED" \
  && echo "$OUT" | grep -qE "SANDBOX_BASH_IC=$EXPECTED" \
  && echo "$OUT" | grep -qE "SANDBOX_BASH_LC=$EXPECTED"; then
  pass "bash -ic / bash -lc export proxy env for both root and sandbox"
else
  fail "proxy env not set in all bash modes (#2704): $OUT"
fi

# ── Test 27: Non-root mode executes without gosu ──────────────────
# The entrypoint detects uid != 0, skips gosu, and execs the command directly.
# Use the image's actual sandbox uid/gid here: the system-assigned sandbox uid
# is not guaranteed to be 1000 on every runner, and the non-root fallback is
# designed to run as that sandbox user.

info "27. Non-root mode executes command without gosu"
OUT=$(docker run --rm --user "${SB_UID}:${SB_GID}" "$IMAGE" bash -c 'printf "%s\n" "NON_ROOT_EXEC_OK"; sleep 0.2' 2>&1 || true)
if echo "$OUT" | grep -q "NON_ROOT_EXEC_OK"; then
  pass "non-root mode executed command directly (no gosu)"
else
  fail "non-root command execution failed: $OUT"
fi

# ── Test 28: Model override patches openclaw.json at startup ─────
# NEMOCLAW_MODEL_OVERRIDE should patch agents.defaults.model.primary,
# model id, and model name in openclaw.json before Landlock locks it.
# Ref: https://github.com/NVIDIA/NemoClaw/issues/759

info "28. NEMOCLAW_MODEL_OVERRIDE patches openclaw.json"
OUT=$(docker run --rm -e NEMOCLAW_MODEL_OVERRIDE="test/override-model" \
  --entrypoint "" "$IMAGE" bash -c '
  # Source the entrypoint function without running the full startup. Keep the
  # extraction whitespace-tolerant and fail closed if the function cannot be
  # found, instead of sourcing an empty snippet.
  APPLY_MODEL_OVERRIDE_SNIPPET=$(sed -n "/^[[:space:]]*apply_model_override[[:space:]]*()[[:space:]]*{/,/^[[:space:]]*}[[:space:]]*$/p" /usr/local/bin/nemoclaw-start)
  if [ -z "$APPLY_MODEL_OVERRIDE_SNIPPET" ]; then
    echo "EXTRACT_FAIL apply_model_override"
    exit 1
  fi
  source /dev/stdin <<<"$APPLY_MODEL_OVERRIDE_SNIPPET"
  export NEMOCLAW_MODEL_OVERRIDE="test/override-model"
  apply_model_override
  python3 -c "
import json
with open(\"/sandbox/.openclaw/openclaw.json\") as f:
    cfg = json.load(f)
primary = cfg[\"agents\"][\"defaults\"][\"model\"][\"primary\"]
providers = cfg.get(\"models\", {}).get(\"providers\", {})
all_models = [m for pval in providers.values() for m in pval.get(\"models\", [])]
all_patched = all(
    m.get(\"id\") == \"test/override-model\" and m.get(\"name\") == \"test/override-model\"
    for m in all_models
)
if primary == \"test/override-model\" and all_models and all_patched:
    print(\"OVERRIDE_OK\")
else:
    print(f\"OVERRIDE_FAIL primary={primary} models={len(all_models)} all_patched={all_patched}\")
"
' 2>&1 || true)
if echo "$OUT" | grep -q "OVERRIDE_OK"; then
  pass "NEMOCLAW_MODEL_OVERRIDE patches primary, id, and name"
else
  fail "model override did not patch correctly: $OUT"
fi

# ── Test 29: Model override is a no-op when env var is unset ─────

info "29. No override when NEMOCLAW_MODEL_OVERRIDE is unset"
OUT=$(docker run --rm --entrypoint "" "$IMAGE" bash -c '
  APPLY_MODEL_OVERRIDE_SNIPPET=$(sed -n "/^[[:space:]]*apply_model_override[[:space:]]*()[[:space:]]*{/,/^[[:space:]]*}[[:space:]]*$/p" /usr/local/bin/nemoclaw-start)
  if [ -z "$APPLY_MODEL_OVERRIDE_SNIPPET" ]; then
    echo "EXTRACT_FAIL apply_model_override"
    exit 1
  fi
  source /dev/stdin <<<"$APPLY_MODEL_OVERRIDE_SNIPPET"
  ORIGINAL=$(python3 -c "import json; print(json.load(open(\"/sandbox/.openclaw/openclaw.json\"))[\"agents\"][\"defaults\"][\"model\"][\"primary\"])")
  apply_model_override
  AFTER=$(python3 -c "import json; print(json.load(open(\"/sandbox/.openclaw/openclaw.json\"))[\"agents\"][\"defaults\"][\"model\"][\"primary\"])")
  if [ "$ORIGINAL" = "$AFTER" ]; then echo "NOOP_OK"; else echo "NOOP_FAIL orig=$ORIGINAL after=$AFTER"; fi
' 2>&1 || true)
if echo "$OUT" | grep -q "NOOP_OK"; then
  pass "no override applied when env var is unset"
else
  fail "config changed unexpectedly without override: $OUT"
fi

# ── Test 30: One-shot cleanup repairs post-Doctor DAC modes ──────
# PID 1 drops CAP_DAC_OVERRIDE, so root cannot traverse a sandbox-owned 0700
# config directory. Exercise the supervised helper from the built image: a
# permanently dropped owner child repairs the tree, then transfers its pinned
# directory descriptor to the root-only baseline lock.

info "30. One-shot cleanup repairs 700/600 without CAP_DAC_OVERRIDE"
OUT=$(docker run --rm --cap-drop DAC_OVERRIDE --entrypoint bash "$IMAGE" -lc '
  set -euo pipefail
  sed -n "/^normalize_mutable_config_perms() {$/,/^}$/p" /usr/local/bin/nemoclaw-start >/tmp/normalize.sh
  test -s /tmp/normalize.sh
  source /tmp/normalize.sh
  capsh --has-p=cap_setgid
  capsh --has-p=cap_setuid
  gosu sandbox sh -c "printf baseline > /sandbox/.openclaw/openclaw.json.nemoclaw-baseline; chmod 600 /sandbox/.openclaw/openclaw.json.nemoclaw-baseline"
  gosu sandbox chmod 600 /sandbox/.openclaw/openclaw.json /sandbox/.openclaw/.config-hash
  gosu sandbox chmod 700 /sandbox/.openclaw
  normalize_mutable_config_perms
  gosu sandbox sh -c "test \"\$(stat -c %a /sandbox/.openclaw)\" = 2770"
  gosu sandbox sh -c "test \"\$(stat -c %a /sandbox/.openclaw/openclaw.json)\" = 660"
  gosu sandbox sh -c "test \"\$(stat -c %a /sandbox/.openclaw/.config-hash)\" = 660"
  gosu sandbox sh -c "test \"\$(stat -c \"%a %U:%G\" /sandbox/.openclaw/openclaw.json.nemoclaw-baseline)\" = \"440 root:sandbox\""
  gosu gateway sh -c "printf \" \" >>/sandbox/.openclaw/openclaw.json"
  printf "ONESHOT_DAC_REPAIR_OK\n"
' 2>&1 || true)
if echo "$OUT" | grep -q "ONESHOT_DAC_REPAIR_OK"; then
  pass "owner-UID repair restores 2770/660 and gateway-user writes"
else
  fail "one-shot DAC repair failed: $OUT"
fi

# ── Test 30a: Mutable repair rejects a non-sandbox tree owner ─────

info "30a. One-shot cleanup rejects a mutable tree owned by another UID"
OUT=$(docker run --rm --entrypoint bash "$IMAGE" -lc '
  set -euo pipefail
  sed -n "/^normalize_mutable_config_perms() {$/,/^}$/p" /usr/local/bin/nemoclaw-start >/tmp/normalize.sh
  test -s /tmp/normalize.sh
  source /tmp/normalize.sh
  chown -R gateway:gateway /sandbox/.openclaw
  before=$(stat -c "%u %a" /sandbox/.openclaw)
  rc=0
  normalize_mutable_config_perms || rc=$?
  after=$(stat -c "%u %a" /sandbox/.openclaw)
  [ "$rc" -eq 1 ]
  [ "$before" = "$after" ]
  printf "OWNER_UID_REFUSAL_OK\n"
' 2>&1 || true)
if echo "$OUT" | grep -q "OWNER_UID_REFUSAL_OK" \
  && echo "$OUT" | grep -q "does not match sandbox UID"; then
  pass "owner-UID repair refuses a non-sandbox config tree without changing it"
else
  fail "owner-UID mismatch was not rejected safely: $OUT"
fi

# ── Test 30b: Baseline lock fails closed without CAP_SETGID ──────

info "30b. One-shot cleanup reports a missing CAP_SETGID precondition"
OUT=$(docker run --rm --user 0:0 --cap-drop DAC_OVERRIDE --cap-drop SETGID --entrypoint bash "$IMAGE" -lc '
  set -euo pipefail
  sed -n "/^normalize_mutable_config_perms() {$/,/^}$/p" /usr/local/bin/nemoclaw-start >/tmp/normalize.sh
  test -s /tmp/normalize.sh
  source /tmp/normalize.sh
  sandbox_gid=$(id -g sandbox)
  python3 - "$sandbox_gid" <<"PY_ASSERT_GROUP_ABSENT"
import os
import sys

assert int(sys.argv[1]) not in os.getgroups()
PY_ASSERT_GROUP_ABSENT
  before=$(stat -c "%u %g %a" /sandbox/.openclaw)
  rc=0
  normalize_mutable_config_perms || rc=$?
  after=$(stat -c "%u %g %a" /sandbox/.openclaw)
  [ "$rc" -eq 1 ]
  [ "$before" = "$after" ]
  printf "CAP_SETGID_REFUSAL_OK\n"
' 2>&1 || true)
if echo "$OUT" | grep -q "CAP_SETGID_REFUSAL_OK" \
  && echo "$OUT" | grep -q "CAP_SETGID is required"; then
  pass "baseline lock fails closed with an actionable CAP_SETGID diagnostic"
else
  fail "missing CAP_SETGID was not reported safely: $OUT"
fi

# ── Test 30c: Post-override capture severs hardlink aliases ─────

info "30c. Post-override capture freshens a hardlinked recovery baseline"
OUT=$(docker run --rm --entrypoint bash "$IMAGE" -lc '
  set -euo pipefail
  {
    sed -n "/^normalize_mutable_config_perms() {$/,/^}$/p" /usr/local/bin/nemoclaw-start
    sed -n "/^write_openclaw_config_baseline() {$/,/^}$/p" /usr/local/bin/nemoclaw-start
  } >/tmp/normalize.sh
  test -s /tmp/normalize.sh
  source /tmp/normalize.sh
  rm -f /sandbox/.openclaw/openclaw.json.nemoclaw-baseline
  normalize_mutable_config_perms
  gosu sandbox sh -c "rm -f /sandbox/.openclaw/openclaw.json.nemoclaw-baseline; printf \"{\\\"safe\\\":true}\\n\" > /sandbox/baseline-hardlink-target; chmod 640 /sandbox/baseline-hardlink-target; ln /sandbox/baseline-hardlink-target /sandbox/.openclaw/openclaw.json.nemoclaw-baseline"
  before=$(stat -c "%u %g %a" /sandbox/baseline-hardlink-target)
  [ "$(stat -c "%h" /sandbox/baseline-hardlink-target)" -eq 2 ]
  write_openclaw_config_baseline
  after=$(stat -c "%u %g %a" /sandbox/baseline-hardlink-target)
  [ "$before" = "$after" ]
  [ "$(stat -c "%h" /sandbox/baseline-hardlink-target)" -eq 1 ]
  [ "$(stat -c "%a %U:%G %h" /sandbox/.openclaw/openclaw.json.nemoclaw-baseline)" = "440 root:sandbox 1" ]
  ! cmp -s /sandbox/baseline-hardlink-target /sandbox/.openclaw/openclaw.json.nemoclaw-baseline
  cmp -s /sandbox/.openclaw/openclaw.json /sandbox/.openclaw/openclaw.json.nemoclaw-baseline
  printf "HARDLINK_PROMOTION_OK\n"
' 2>&1 || true)
if echo "$OUT" | grep -q "HARDLINK_PROMOTION_OK"; then
  pass "baseline promotion leaves an external hardlink inode untouched"
else
  fail "hardlinked baseline was not promoted safely: $OUT"
fi

# ── Test 30d: Pinned owner descriptor rejects path replacement ──

info "30d. One-shot cleanup rejects replacement after owner normalization"
OUT=$(docker run --rm --entrypoint bash "$IMAGE" -lc '
  set -euo pipefail
  python3 - <<"PY_INJECT_HANDOFF_RACE"
from pathlib import Path

source = Path("/usr/local/lib/nemoclaw/normalize_mutable_config_perms.py").read_text()
needle = "            rights_fds = [root_fd]\n"
replacement = """            for required_name in ("openclaw.json", ".config-hash"):
                os.unlink(os.path.join(config_dir, required_name))
            os.rmdir(config_dir)
            os.mkdir(config_dir, 0o700)
            for name, content in (("openclaw.json", "{}\\n"), (".config-hash", "hash\\n")):
                path = os.path.join(config_dir, name)
                with open(path, "w", encoding="utf-8") as replacement_file:
                    replacement_file.write(content)
                os.chmod(path, 0o600)
            rights_fds = [root_fd]
"""
if source.count(needle) != 1:
    raise SystemExit("handoff injection point changed")
Path("/tmp/normalizer-handoff-race.py").write_text(source.replace(needle, replacement))
PY_INJECT_HANDOFF_RACE
  sed -n "/^normalize_mutable_config_perms() {$/,/^}$/p" /usr/local/bin/nemoclaw-start \
    | sed "s#/usr/local/lib/nemoclaw/normalize_mutable_config_perms.py#/tmp/normalizer-handoff-race.py#" \
    >/tmp/normalize.sh
  source /tmp/normalize.sh
  find /sandbox/.openclaw -mindepth 1 -delete
  gosu sandbox sh -c "printf \"{}\\n\" > /sandbox/.openclaw/openclaw.json; printf \"hash\\n\" > /sandbox/.openclaw/.config-hash"
  gosu sandbox chmod 600 /sandbox/.openclaw/openclaw.json /sandbox/.openclaw/.config-hash
  gosu sandbox chmod 700 /sandbox/.openclaw
  rc=0
  normalize_mutable_config_perms || rc=$?
  [ "$rc" -eq 1 ]
  [ "$(stat -c "%a" /sandbox/.openclaw)" = "700" ]
  [ "$(stat -c "%a" /sandbox/.openclaw/openclaw.json)" = "600" ]
  [ ! -e /sandbox/.openclaw/openclaw.json.nemoclaw-baseline ]
  printf "HANDOFF_SWAP_REFUSAL_OK\n"
' 2>&1 || true)
if echo "$OUT" | grep -q "HANDOFF_SWAP_REFUSAL_OK"; then
  pass "pinned owner descriptor prevents root action on a replacement tree"
else
  fail "owner-to-root descriptor handoff accepted a replacement: $OUT"
fi

# ── Test 30e: Empty-config recovery never follows sandbox links ─

info "30e. Empty-config recovery refuses a protected-target symlink"
OUT=$(docker run --rm --entrypoint bash "$IMAGE" -lc '
  set -euo pipefail
  {
    sed -n "/^normalize_mutable_config_perms() {$/,/^}$/p" /usr/local/bin/nemoclaw-start
    sed -n "/^recover_openclaw_config_if_empty() {$/,/^}$/p" /usr/local/bin/nemoclaw-start
  } >/tmp/recover.sh
  source /tmp/recover.sh
  printf "protected\n" >/sandbox/recovery-protected
  chmod 600 /sandbox/recovery-protected
  chown root:root /sandbox/recovery-protected
  gosu sandbox rm -f /sandbox/.openclaw/openclaw.json
  gosu sandbox ln -s /sandbox/recovery-protected /sandbox/.openclaw/openclaw.json
  before=$(stat -c "%U:%G:%a" /sandbox/recovery-protected):$(cat /sandbox/recovery-protected)
  rc=0
  recover_openclaw_config_if_empty || rc=$?
  after=$(stat -c "%U:%G:%a" /sandbox/recovery-protected):$(cat /sandbox/recovery-protected)
  [ "$rc" -eq 1 ]
  [ "$before" = "$after" ]
  [ -L /sandbox/.openclaw/openclaw.json ]
  printf "RECOVERY_LINK_REFUSAL_OK\n"
' 2>&1 || true)
if echo "$OUT" | grep -q "RECOVERY_LINK_REFUSAL_OK" \
  && echo "$OUT" | grep -q "descriptor-safe repair detected an unsafe link"; then
  pass "empty-config recovery leaves a protected symlink target untouched"
else
  fail "empty-config recovery followed a sandbox-controlled link: $OUT"
fi

# ── Test 30f: Root never falls back to an environment helper ────

info "30f. Root repair rejects an environment-selected helper"
OUT=$(docker run --rm --entrypoint bash "$IMAGE" -lc '
  set -euo pipefail
  cat >/tmp/untrusted-normalizer.py <<"PY_UNTRUSTED_NORMALIZER"
from pathlib import Path

Path("/tmp/untrusted-normalizer-ran").write_text("unsafe\n")
PY_UNTRUSTED_NORMALIZER
  sed -n "/^normalize_mutable_config_perms() {$/,/^}$/p" /usr/local/bin/nemoclaw-start \
    | sed "s#/usr/local/lib/nemoclaw/normalize_mutable_config_perms.py#/tmp/missing-normalizer.py#" \
    >/tmp/normalize.sh
  source /tmp/normalize.sh
  export NEMOCLAW_MUTABLE_CONFIG_NORMALIZER=/tmp/untrusted-normalizer.py
  rc=0
  normalize_mutable_config_perms || rc=$?
  [ "$rc" -eq 1 ]
  [ ! -e /tmp/untrusted-normalizer-ran ]
  printf "ROOT_HELPER_FALLBACK_REFUSAL_OK\n"
' 2>&1 || true)
if echo "$OUT" | grep -q "ROOT_HELPER_FALLBACK_REFUSAL_OK" \
  && echo "$OUT" | grep -q "trusted normalizer is missing"; then
  pass "root repair fails closed when the installed helper is missing"
else
  fail "root repair executed an environment-selected helper: $OUT"
fi

# ── Summary ──────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "  Results: ${GREEN}$PASSED passed${NC}, ${RED}$FAILED failed${NC}"
echo -e "${GREEN}========================================${NC}"

# Cleanup — only remove images we built ourselves
if [ -z "${NEMOCLAW_TEST_IMAGE:-}" ]; then
  docker rmi "$IMAGE" >/dev/null 2>&1 || true
fi

[ "$FAILED" -eq 0 ] || exit 1
