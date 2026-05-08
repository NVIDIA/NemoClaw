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

# ── Test 14: Dangerous capabilities are dropped by entrypoint ────

info "14. Entrypoint drops dangerous capabilities from bounding set"
# Run capsh directly with the same --drop flags as the entrypoint, then
# check CapBnd. This avoids running the full entrypoint which starts
# gateway services that fail in CI without a running OpenShell environment.
# Extract the --drop list from the shared sandbox-init library to stay in sync.
# The drop_capabilities() function lives in sandbox-init.sh (not the entrypoint).
DROP_LIST=$(run_as_root "grep -oP '(?<=--drop=)[^ \\\\]+' /usr/local/lib/nemoclaw/sandbox-init.sh")
if [ -z "$DROP_LIST" ]; then
  fail "could not extract --drop list from entrypoint"
else
  OUT=$(run_as_root "capsh --drop=${DROP_LIST} -- -c '
    CAP_BND=\$(grep \"^CapBnd:\" /proc/self/status | awk \"{print \\\$2}\")
    echo \"CapBnd=\$CAP_BND\"
    BND_DEC=\$((16#\$CAP_BND))
    NET_RAW_BIT=\$((1 << 13))
    if [ \$((BND_DEC & NET_RAW_BIT)) -ne 0 ]; then
      echo \"DANGEROUS: cap_net_raw present\"
    else
      echo \"SAFE: cap_net_raw dropped\"
    fi
  '")
  if echo "$OUT" | grep -q "SAFE: cap_net_raw dropped"; then
    pass "entrypoint drops dangerous capabilities (cap_net_raw not in bounding set)"
  elif echo "$OUT" | grep -q "DANGEROUS"; then
    fail "cap_net_raw still present after capsh drop: $OUT"
  else
    fail "could not verify capability state: $OUT"
  fi
fi

# ── Test 13b: Sandbox user cannot write to .nemoclaw parent ───────
# Note: /sandbox itself is sandbox-owned (DAC allows writes). Landlock makes it
# read-only in production — tested in checks/04-landlock-readonly.sh instead.

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

# ── Test 23: .bashrc sources proxy-env from /tmp ──────────────────
# Requires base image with pre-built .bashrc (#804). Skip gracefully
# if the file doesn't exist yet (base image not rebuilt).

info "23. .bashrc sources proxy config from /tmp"
OUT=$(run_as_sandbox "cat /sandbox/.bashrc 2>/dev/null || echo MISSING")
if echo "$OUT" | grep -q "/tmp/nemoclaw-proxy-env.sh"; then
  pass ".bashrc sources /tmp/nemoclaw-proxy-env.sh"
elif echo "$OUT" | grep -q "MISSING\|No such file"; then
  info "SKIP: .bashrc not present (base image needs rebuild for #804)"
else
  fail ".bashrc does not source from expected path: $OUT"
fi

# ── Test 24: .profile sources proxy-env from /tmp ─────────────────

info "24. .profile sources proxy config from /tmp"
OUT=$(run_as_sandbox "cat /sandbox/.profile 2>/dev/null || echo MISSING")
if echo "$OUT" | grep -q "/tmp/nemoclaw-proxy-env.sh"; then
  pass ".profile sources /tmp/nemoclaw-proxy-env.sh"
elif echo "$OUT" | grep -q "MISSING\|No such file"; then
  info "SKIP: .profile not present (base image needs rebuild for #804)"
else
  fail ".profile does not source from expected path: $OUT"
fi

# ── Test 25: proxy-env.sh is NOT writable by sandbox user (#2181) ──
# The entrypoint writes /tmp/nemoclaw-proxy-env.sh via emit_sandbox_sourced_file()
# which sets mode 444 and root ownership. The sandbox user must not be able to
# modify this file, as .bashrc/.profile source it on every connect.
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
  # Source the entrypoint functions without running the full startup
  source <(sed -n "/^apply_model_override/,/^}/p" /usr/local/bin/nemoclaw-start)
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
  source <(sed -n "/^apply_model_override/,/^}/p" /usr/local/bin/nemoclaw-start)
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
