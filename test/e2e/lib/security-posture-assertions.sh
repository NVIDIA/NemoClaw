#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Shared assertions for full onboard tests that need to prove the Linux
# Docker-driver security posture that caught the Hermes rc-file startup bug.
# The caller provides the e2e `section`, `info`, `pass`, and `fail` functions.

security_posture_sandbox_exec() {
  local sandbox_name="$1"
  local remote_cmd="$2"
  openshell sandbox exec --name "$sandbox_name" -- sh -lc "$remote_cmd" 2>&1
}

security_posture_cap_absent() {
  local cap_hex="$1"
  local bit="$2"
  local cap_name="$3"
  local context="$4"
  local cap_val

  cap_val=$((16#$cap_hex))
  if [ $(((cap_val >> bit) & 1)) -eq 0 ]; then
    pass "${context}: ${cap_name} absent from CapBnd (0x${cap_hex})"
  else
    fail "${context}: ${cap_name} still present in CapBnd (0x${cap_hex})"
  fi
}

security_posture_assert_host_user() {
  if [ "${NEMOCLAW_E2E_EXPECT_NON_ROOT_HOST:-}" != "1" ]; then
    return 0
  fi

  local uid gid
  uid="$(id -u)"
  gid="$(id -g)"
  if [ "$uid" -eq 0 ]; then
    fail "Host test process is running as root; expected a non-root host user"
  else
    pass "Host test process is non-root (uid=${uid}, gid=${gid})"
  fi
}

security_posture_dangerous_caps_present() {
  local cap_hex="$1"
  local val entry bit name present_caps=""

  val=$((16#$cap_hex))
  for entry in \
    "21:CAP_SYS_ADMIN" \
    "19:CAP_SYS_PTRACE" \
    "13:CAP_NET_RAW" \
    "10:CAP_NET_BIND_SERVICE" \
    "1:CAP_DAC_OVERRIDE"; do
    bit="${entry%%:*}"
    name="${entry#*:}"
    if [ $(((val >> bit) & 1)) -ne 0 ]; then
      present_caps="${present_caps:+$present_caps,}$name"
    fi
  done
  printf '%s\n' "$present_caps"
}

security_posture_assert_entrypoint_process() {
  local sandbox_name="$1"
  local out cap_bnd cap_eff no_new_privs entry_uid present_caps

  out="$(security_posture_sandbox_exec "$sandbox_name" 'grep -E "^(Uid|Gid|CapBnd|CapEff|NoNewPrivs):" /proc/1/status 2>/dev/null || true')" || true
  info "PID 1 status: ${out//$'\n'/; }"
  entry_uid="$(printf '%s\n' "$out" | awk '/^Uid:/ { print $2; exit }')"
  cap_bnd="$(printf '%s\n' "$out" | awk '/^CapBnd:/ { print $2; exit }')"
  cap_eff="$(printf '%s\n' "$out" | awk '/^CapEff:/ { print $2; exit }')"
  no_new_privs="$(printf '%s\n' "$out" | awk '/^NoNewPrivs:/ { print $2; exit }')"

  if [ "${NEMOCLAW_E2E_EXPECT_NON_ROOT_ENTRYPOINT:-}" = "1" ]; then
    if [ -n "$entry_uid" ] && [ "$entry_uid" != "0" ]; then
      pass "Entrypoint PID 1 is non-root inside the sandbox (uid=${entry_uid})"
    else
      fail "Entrypoint PID 1 expected non-root uid, got '${entry_uid:-<missing>}'"
    fi
  elif [ -n "$entry_uid" ]; then
    info "Entrypoint PID 1 uid=${entry_uid}"
  fi

  if [ -z "$cap_bnd" ]; then
    fail "Could not capture PID 1 CapBnd from sandbox ${sandbox_name}: ${out:0:300}"
    return 0
  fi

  if [ "${NEMOCLAW_E2E_EXPECT_DROPPED_BOUNDS:-}" = "1" ]; then
    security_posture_cap_absent "$cap_bnd" 21 CAP_SYS_ADMIN "Entrypoint PID 1"
    security_posture_cap_absent "$cap_bnd" 19 CAP_SYS_PTRACE "Entrypoint PID 1"
    security_posture_cap_absent "$cap_bnd" 13 CAP_NET_RAW "Entrypoint PID 1"
    security_posture_cap_absent "$cap_bnd" 10 CAP_NET_BIND_SERVICE "Entrypoint PID 1"
    security_posture_cap_absent "$cap_bnd" 1 CAP_DAC_OVERRIDE "Entrypoint PID 1"
  else
    present_caps="$(security_posture_dangerous_caps_present "$cap_bnd")"
    if [ -n "$present_caps" ]; then
      info "Entrypoint PID 1 residual CapBnd dangerous caps: ${present_caps}"
    else
      pass "Entrypoint PID 1 dangerous caps are absent from CapBnd"
    fi
  fi

  if [ -n "$cap_eff" ]; then
    present_caps="$(security_posture_dangerous_caps_present "$cap_eff")"
    if [ -n "$present_caps" ]; then
      info "Entrypoint PID 1 residual CapEff dangerous caps: ${present_caps}"
    else
      pass "Entrypoint PID 1 dangerous caps are absent from CapEff"
    fi
  fi

  if [ "${NEMOCLAW_E2E_EXPECT_NO_NEW_PRIVS:-}" = "1" ]; then
    if [ "$no_new_privs" = "1" ]; then
      pass "Entrypoint PID 1 has NoNewPrivs=1"
    else
      fail "Entrypoint PID 1 expected NoNewPrivs=1, got '${no_new_privs:-<missing>}'"
    fi
  elif [ -n "$no_new_privs" ]; then
    info "Entrypoint PID 1 NoNewPrivs=${no_new_privs}"
  fi
}

security_posture_assert_rc_files() {
  local sandbox_name="$1"
  local out rc

  rc=0
  # shellcheck disable=SC2016 # Remote shell snippet; expansion must happen inside the sandbox.
  out="$(security_posture_sandbox_exec "$sandbox_name" 'bad=0; for f in /sandbox/.bashrc /sandbox/.profile; do if [ ! -f "$f" ]; then echo "MISSING $f"; bad=1; continue; fi; if [ -L "$f" ]; then echo "SYMLINK $f"; bad=1; fi; meta=$(stat -c "%a %U:%G" "$f" 2>/dev/null || true); echo "META $f $meta"; set -- $meta; mode="${1:-}"; owner="${2:-}"; if [ "$mode" != "444" ]; then echo "BAD_MODE $f $mode"; bad=1; fi; if [ "$owner" != "root:root" ]; then echo "BAD_OWNER $f $owner"; bad=1; fi; if grep -Eq "nemoclaw-configure-guard|^(openclaw|hermes)\(\)" "$f" 2>/dev/null; then echo "INLINE_GUARD $f"; bad=1; fi; done; exit "$bad"')" || rc=$?
  info "rc-file metadata: ${out//$'\n'/; }"
  if [ "$rc" -eq 0 ]; then
    pass "Sandbox rc files are static root-owned 444 shims without inline configure guards"
  else
    fail "Sandbox rc files are not locked/static as expected: ${out:0:500}"
  fi
}

security_posture_assert_proxy_env() {
  local sandbox_name="$1"
  local agent_name="$2"
  local function_name guard_arg out rc allow_non_root_owner

  case "$agent_name" in
    hermes)
      function_name="hermes"
      guard_arg="setup"
      ;;
    *)
      function_name="openclaw"
      guard_arg="configure"
      ;;
  esac

  allow_non_root_owner=0
  if [ "${NEMOCLAW_E2E_EXPECT_NON_ROOT_HOST:-}" = "1" ]; then
    # OpenShell's non-root host posture creates the runtime proxy-env file
    # after dropping to the sandbox user. Keep root ownership required in
    # normal lanes, but accept current-user ownership for that explicit lane.
    allow_non_root_owner=1
  fi

  rc=0
  out="$(security_posture_sandbox_exec "$sandbox_name" "f=/tmp/nemoclaw-proxy-env.sh; allow_non_root_owner=${allow_non_root_owner}; bad=0; if [ ! -f \"\$f\" ]; then echo MISSING_PROXY_ENV; exit 1; fi; if [ -L \"\$f\" ]; then echo SYMLINK_PROXY_ENV; bad=1; fi; meta=\$(stat -c \"%a %U:%G\" \"\$f\" 2>/dev/null || true); echo \"META \$f \$meta\"; set -- \$meta; mode=\"\${1:-}\"; owner=\"\${2:-}\"; current_owner=\"\$(id -un):\$(id -gn)\"; if [ \"\$mode\" != \"444\" ]; then echo \"BAD_PROXY_ENV_MODE \$mode\"; bad=1; fi; case \"\$owner\" in root:root) ;; \"\$current_owner\") if [ \"\$allow_non_root_owner\" = \"1\" ]; then echo \"NON_ROOT_PROXY_ENV_OWNER \$owner\"; else echo \"BAD_PROXY_ENV_OWNER \$owner\"; bad=1; fi ;; *) echo \"BAD_PROXY_ENV_OWNER \$owner\"; bad=1 ;; esac; grep -Fq '# nemoclaw-configure-guard begin' \"\$f\" || { echo MISSING_GUARD_BEGIN; bad=1; }; grep -Fq '${function_name}() {' \"\$f\" || { echo MISSING_AGENT_GUARD_FUNCTION; bad=1; }; grep -Fq '# nemoclaw-configure-guard end' \"\$f\" || { echo MISSING_GUARD_END; bad=1; }; exit \"\$bad\"")" || rc=$?
  info "runtime proxy-env metadata: ${out//$'\n'/; }"
  if [ "$rc" -eq 0 ]; then
    pass "Runtime proxy env is mode 444 with an accepted owner and carries the ${function_name} configure guard"
  else
    fail "Runtime proxy env is not locked or missing guard content: ${out:0:500}"
  fi

  rc=0
  out="$(security_posture_sandbox_exec "$sandbox_name" ". /tmp/nemoclaw-proxy-env.sh || { echo SOURCE_FAILED; exit 1; }; if ${function_name} ${guard_arg} >/tmp/nemoclaw-security-guard-probe.out 2>&1; then echo GUARD_DID_NOT_BLOCK; cat /tmp/nemoclaw-security-guard-probe.out; exit 1; fi; cat /tmp/nemoclaw-security-guard-probe.out; grep -q 'cannot modify config inside the sandbox' /tmp/nemoclaw-security-guard-probe.out || { echo GUARD_MESSAGE_MISSING; exit 1; }")" || rc=$?
  info "configure guard probe: ${out//$'\n'/; }"
  if [ "$rc" -eq 0 ]; then
    pass "${function_name} ${guard_arg} is blocked by the runtime guard after sourcing proxy-env"
  else
    fail "Runtime configure guard did not behave as expected: ${out:0:500}"
  fi
}

security_posture_assert_start_log() {
  local sandbox_name="$1"
  local agent_name="$2"
  local out rc launch_pattern

  case "$agent_name" in
    hermes) launch_pattern='hermes gateway launched' ;;
    *) launch_pattern='openclaw gateway launched' ;;
  esac

  rc=0
  out="$(security_posture_sandbox_exec "$sandbox_name" "log=/tmp/nemoclaw-start.log; bad=0; [ -f \"\$log\" ] || { echo MISSING_START_LOG; exit 1; }; if ! grep -qi '${launch_pattern}' \"\$log\"; then echo MISSING_GATEWAY_LAUNCH_MARKER; bad=1; fi; if grep -E 'mktemp:.*(/sandbox/\\.\\.(bashrc|profile)\\.tmp|/sandbox/\\.nemoclaw.*tmp)|Permission denied.*(/sandbox/\\.bashrc|/sandbox/\\.profile)' \"\$log\"; then echo START_LOG_HAS_RC_WRITE_FAILURE; bad=1; fi; tail -n 20 \"\$log\"; exit \"\$bad\"")" || rc=$?
  info "start log probe: ${out//$'\n'/; }"
  if [ "$rc" -eq 0 ]; then
    pass "Startup log has no rc-file mktemp/permission failure"
  else
    fail "Startup log shows the rc-file write failure class: ${out:0:500}"
  fi
}

security_posture_assertions_run() {
  local sandbox_name="$1"
  local agent_name="${2:-openclaw}"

  section "Security posture regression checks"
  security_posture_assert_host_user
  security_posture_assert_entrypoint_process "$sandbox_name"
  security_posture_assert_rc_files "$sandbox_name"
  security_posture_assert_proxy_env "$sandbox_name" "$agent_name"
  security_posture_assert_start_log "$sandbox_name" "$agent_name"
}
