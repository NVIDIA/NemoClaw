#!/usr/bin/env bash

# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

IMAGE_REPOSITORY=brevdev/nemoclaw-image
IMAGE_WORKFLOW=build-launchable-e2e-image.yml
cleanup_required=0
diagnostic_capture=""
ownership_receipt=""
raw_log=""
raw_log_directory=""
SSH_PROBE_OPTIONS=(-T -o BatchMode=yes -o ConnectTimeout=10 -o ConnectionAttempts=1
  -o NumberOfPasswordPrompts=0 -o RequestTTY=no -o LogLevel=ERROR)

log() {
  printf '%s\n' "$*" | tee -a "$WORK_DIR/lane.log"
}

die() {
  log "FAILED: $*" >&2
  exit 1
}

require() {
  local name="$1"
  [ -n "${!name:-}" ] || die "$name is required"
}

write_workspace_ownership() {
  local create_state="$1" delete_attempts="${2:-}" temporary
  case "$create_state" in
    pending | accepted | reconciled) ;;
    *) die "workspace ownership state is invalid" ;;
  esac
  ownership_receipt="${WORK_DIR}.workspace-owner"
  if [ -z "$delete_attempts" ]; then
    delete_attempts="$(jq -r '.deleteAttempts // 0' "$ownership_receipt" 2>/dev/null || printf '0')"
  fi
  [[ "$delete_attempts" =~ ^[01]$ ]] || die "workspace delete attempt count is invalid"
  temporary="${ownership_receipt}.tmp"
  if ! jq -n --arg workspaceName "$INSTANCE_NAME" --arg createState "$create_state" \
    --argjson deleteAttempts "$delete_attempts" \
    '{workspaceName:$workspaceName,createState:$createState,deleteAttempts:$deleteAttempts}' \
    >"$temporary"; then
    rm -f -- "$temporary"
    return 1
  fi
  if ! chmod 600 "$temporary" || ! mv "$temporary" "$ownership_receipt"; then
    rm -f -- "$temporary"
    return 1
  fi
}

workspace_rows() {
  timeout 30s brev ls --json | jq -c '
    if type == "array" then .
    elif type == "object" and has("workspaces") and .workspaces == null then []
    elif type == "object" and (.workspaces | type) == "array" then .workspaces
    else error("unexpected brev ls --json shape") end'
}

workspace() {
  workspace_rows | jq -c --arg name "$INSTANCE_NAME" '
    map(select(((.name // .workspaceName // .instanceName // "") | tostring) == $name))
    | if length == 0 then empty elif length == 1 then .[0]
      else error("workspace name is ambiguous") end'
}

sanitize_probe_error() {
  python3 -c '
import os
import re
import sys

known_values = [
    os.environ.get(name, "")
    for name in ("BREV_API_KEY", "GH_TOKEN", "NVIDIA_INFERENCE_API_KEY")
]
instance = os.environ.get("INSTANCE_NAME", "")
safe_tail = bytearray()
private_key = False
debug_marker_written = False


def retain(text: str) -> None:
    safe_tail.extend(text.encode("utf-8"))
    if len(safe_tail) > 512:
        del safe_tail[:-512]


def sanitize_line(line: str) -> str:
    global debug_marker_written
    line = re.sub(r"\x1b\][^\x07]*(?:\x07|\x1b\\)", "", line)
    line = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", line)
    line = re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", line)
    for value in known_values:
        if value:
            line = line.replace(value, "[REDACTED]")
    if instance:
        line = line.replace(instance, "[REDACTED HOST]")
    line = re.sub(
        r"(?i)\b(authorization)\b(\s*[:=]\s*)[^\r\n]+",
        r"\1\2[REDACTED]",
        line,
    )
    line = re.sub(
        r"(?i)\b(api[_ -]?key|token|password|secret|credential|authorization)\b"
        r"(\s*[:=]\s*)(\"[^\"]*\"|\x27[^\x27]*\x27|\S+)",
        r"\1\2[REDACTED]",
        line,
    )
    line = re.sub(
        r"(?i)\b(identityfile|certificatefile|proxycommand|proxyjump)\s*[:=]\s*\S+",
        r"\1=[REDACTED SSH CONFIGURATION]",
        line,
    )
    line = re.sub(
        r"(?i)\b(host|hostname|address|endpoint)\s*[:=]\s*\S+",
        r"\1=[REDACTED ADDRESS]",
        line,
    )
    line = re.sub(
        r"(?i)(connect to host|resolve hostname)\s+\S+",
        r"\1 [REDACTED HOST]",
        line,
    )
    line = re.sub(
        r"(?i)(?<![A-Za-z0-9._-])[^@\s:]+@(?:\[[^\]]+\]|[A-Za-z0-9._-]+)",
        "[REDACTED SSH USER]@[REDACTED HOST]",
        line,
    )
    line = re.sub(r"(?i)\b(?:nvapi-|gh[pousr]_)[A-Za-z0-9_-]+", "[REDACTED]", line)
    def redact_generic_token(match):
        value = match.group(0)
        if value in {
            "client_loop_send_disconnect",
            "kex_exchange_identification",
            "ssh_exchange_identification",
        }:
            return value
        return "[REDACTED]"

    line = re.sub(
        r"(?<![A-Za-z0-9])[A-Za-z0-9_./+=-]{20,}(?![A-Za-z0-9])",
        redact_generic_token,
        line,
    )
    line = re.sub(r"https?://[^/\s]+", "[REDACTED ADDRESS]", line)
    line = re.sub(
        r"(?<![\w])(?:\d{1,3}\.){3}\d{1,3}(?![\w])",
        "[REDACTED ADDRESS]",
        line,
    )
    line = re.sub(
        r"(?<![\w])(?:[0-9a-fA-F]{1,4}:){2,}[0-9a-fA-F:]{1,4}(?![\w])",
        "[REDACTED ADDRESS]",
        line,
    )
    line = re.sub(r"(?i)(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}", "[REDACTED ADDRESS]", line)
    line = " ".join(line.split())
    if re.match(r"(?i)^debug[123]:", line):
        if debug_marker_written:
            return ""
        debug_marker_written = True
        return "SSH debug output omitted"
    if re.match(
        r"(?i)^(hostname|user|port|identityfile|certificatefile|proxycommand|proxyjump)\s+",
        line,
    ):
        return "[REDACTED SSH CONFIGURATION]"
    return re.sub(r"(?i)load key \S+", "SSH private key load failed", line)


while True:
    raw_line = sys.stdin.buffer.readline(4097)
    if not raw_line:
        break
    if len(raw_line) > 4096:
        while raw_line and not raw_line.endswith(b"\n"):
            raw_line = sys.stdin.buffer.readline(4097)
        retain("[REDACTED LONG LINE]\n")
        continue
    line = raw_line.decode("utf-8", errors="replace")
    if private_key:
        if re.search(r"-----END [^-\n]*PRIVATE KEY-----", line):
            private_key = False
        continue
    if re.search(r"-----BEGIN [^-\n]*PRIVATE KEY-----", line):
        retain("[REDACTED PRIVATE KEY]\n")
        if not re.search(r"-----END [^-\n]*PRIVATE KEY-----", line):
            private_key = True
        continue
    cleaned = sanitize_line(line)
    if cleaned:
        retain(f"{cleaned}\n")

result = safe_tail.decode("utf-8", errors="ignore")
result = " | ".join(dict.fromkeys(part.strip() for part in result.splitlines() if part.strip()))
sys.stdout.write(result.encode("utf-8")[-512:].decode("utf-8", errors="ignore"))
'
}

run_bounded_probe() {
  local timeout_seconds="$1"
  local output_name="$2"
  local status_name="$3"
  local output status
  local -a pipeline_status
  shift 3
  if [ -z "$diagnostic_capture" ]; then
    diagnostic_capture="$(mktemp "${RUNNER_TEMP:-/tmp}/brev-launchable-diagnostic.XXXXXX")"
  fi
  : >"$diagnostic_capture"
  set +e
  timeout "${timeout_seconds}s" "$@" 2>&1 \
    | sanitize_probe_error >"$diagnostic_capture"
  pipeline_status=("${PIPESTATUS[@]}")
  set -e
  status="${pipeline_status[0]}"
  output="$(<"$diagnostic_capture")"
  if [ -z "$output" ]; then
    if [ "$status" -eq 0 ]; then
      output="none"
    elif [ "$status" -eq 124 ]; then
      output="probe timed out"
    else
      output="no diagnostic output"
    fi
  fi
  printf -v "$output_name" '%s' "$output"
  printf -v "$status_name" '%s' "$status"
}

run_budgeted_diagnostic_probe() {
  local deadline="$1" output_name="$2" status_name="$3"
  local remaining
  shift 3
  remaining=$((deadline - SECONDS))
  if [ "$remaining" -le 0 ]; then
    printf -v "$output_name" '%s' "diagnostic budget exhausted"
    printf -v "$status_name" '%s' "not-run"
    return
  fi
  [ "$remaining" -le 5 ] || remaining=5
  run_bounded_probe "$remaining" "$output_name" "$status_name" "$@"
}

report_full_e2e_failure_diagnostic() {
  local label="$1" status="$2" output="$3"
  if [ "$status" = "not-run" ]; then
    log "Full E2E failure diagnostic $label: not run; output: $output"
  else
    log "Full E2E failure diagnostic $label: status $status; output: $output"
  fi
}

capture_full_e2e_failure_diagnostics() {
  local timeout_seconds="${FULL_E2E_FAILURE_DIAGNOSTIC_TIMEOUT_SECONDS:-30}"
  local deadline=$((SECONDS + timeout_seconds))
  local diagnostic_output diagnostic_status

  log "Full E2E failure diagnostics budget: up to $timeout_seconds seconds"

  # The remote shell expands the single-quoted command.
  # shellcheck disable=SC2016
  run_budgeted_diagnostic_probe "$deadline" diagnostic_output diagnostic_status \
    ssh "${SSH_PROBE_OPTIONS[@]}" "$INSTANCE_NAME" \
    'set -eu; state=$(sudo -n systemctl show --no-pager --property=Id --property=LoadState --property=UnitFileState --property=ActiveState --property=SubState --property=Result --property=ExecMainCode --property=ExecMainStatus --property=NRestarts --property=ActiveEnterTimestampMonotonic --property=ActiveExitTimestampMonotonic --property=InactiveEnterTimestampMonotonic --property=InactiveExitTimestampMonotonic openshell-gateway.service); restart=$(sudo -n systemctl show --no-pager --property=Restart --value openshell-gateway.service); exec_start=$(sudo -n systemctl show --no-pager --property=ExecStart --value openshell-gateway.service); fragment=$(sudo -n systemctl show --no-pager --property=FragmentPath --value openshell-gateway.service); drop_ins=$(sudo -n systemctl show --no-pager --property=DropInPaths --value openshell-gateway.service); printf "%s\n" "$state" | sed -e "s/^ActiveEnterTimestampMonotonic=/active-enter-us: /" -e "s/^ActiveExitTimestampMonotonic=/active-exit-us: /" -e "s/^InactiveEnterTimestampMonotonic=/inactive-enter-us: /" -e "s/^InactiveExitTimestampMonotonic=/inactive-exit-us: /" -e "s/=/ : /"; if [ "$restart" = always ]; then printf "restart-policy is always: true\n"; else printf "restart-policy is always: false\n"; fi; exec_count=$(printf "%s\n" "$exec_start" | grep -oF "{ path=" | wc -l | tr -d " "); exec_path=$(printf "%s\n" "$exec_start" | sed -n "s/^{ path=\\([^ ;]*\\) ;.*/\\1/p"); exec_argv0=$(printf "%s\n" "$exec_start" | sed -n "s/^{ path=[^;]* ; argv\\[\\]=\\([^ ;]*\\) ;.*/\\1/p"); if [ "$exec_count" -eq 1 ] && [ "$exec_path" = /usr/local/bin/nemoclaw-openshell-gateway-service ] && [ "$exec_argv0" = /usr/local/bin/nemoclaw-openshell-gateway-service ]; then printf "exec-start matches packaged gateway service: true\n"; else printf "exec-start matches packaged gateway service: false\n"; fi; if [ "$fragment" = /etc/systemd/system/openshell-gateway.service ]; then printf "fragment-path is packaged unit path: true\n"; else printf "fragment-path is packaged unit path: false\n"; fi; if [ -z "$drop_ins" ]; then printf "drop-ins: absent\n"; else printf "drop-ins: present\n"; fi'
  report_full_e2e_failure_diagnostic "gateway state" "$diagnostic_status" "$diagnostic_output"

  # The remote shell expands the single-quoted command.
  # shellcheck disable=SC2016
  run_budgeted_diagnostic_probe "$deadline" diagnostic_output diagnostic_status \
    ssh "${SSH_PROBE_OPTIONS[@]}" "$INSTANCE_NAME" \
    'set -eu; state=$(sudo -n systemctl show --no-pager --property=Id --property=ActiveState --property=SubState --property=Result --property=NRestarts --property=ActiveEnterTimestampMonotonic docker.service docker.socket); requires=$(sudo -n systemctl show --no-pager --property=Requires --value openshell-gateway.service); after=$(sudo -n systemctl show --no-pager --property=After --value openshell-gateway.service); docker_wants=$(sudo -n systemctl show --no-pager --property=Wants --value docker.service); printf "%s\n" "$state" | sed -e "s/^ActiveEnterTimestampMonotonic=/active-enter-us: /" -e "s/=/ : /"; if printf "%s\n" "$requires" | tr " " "\n" | grep -Fxq docker.service; then printf "gateway service requires Docker service: present\n"; else printf "gateway service requires Docker service: absent\n"; fi; if printf "%s\n" "$after" | tr " " "\n" | grep -Fxq docker.service; then printf "gateway service ordered after Docker service: present\n"; else printf "gateway service ordered after Docker service: absent\n"; fi; if printf "%s\n" "$docker_wants" | tr " " "\n" | grep -Fxq openshell-gateway.service; then printf "Docker service wants gateway service: present\n"; else printf "Docker service wants gateway service: absent\n"; fi; printf "boot-uptime-seconds "; cut -d. -f1 /proc/uptime; sudo -n stat --printf="gateway-state-dir type=%F uid=%u gid=%g mode=%a\n" /var/lib/brev/openshell-gateway'
  report_full_e2e_failure_diagnostic "platform state" "$diagnostic_status" "$diagnostic_output"

  # The remote shell expands the single-quoted command.
  # shellcheck disable=SC2016
  run_budgeted_diagnostic_probe "$deadline" diagnostic_output diagnostic_status \
    ssh "${SSH_PROBE_OPTIONS[@]}" "$INSTANCE_NAME" \
    'set -eu; events=$(sudo -n journalctl --boot --unit=openshell-gateway.service --no-pager --lines=120 --output=json 2>/dev/null) || exit 41; classified=$(printf "%s\n" "$events" | jq -rs "def lifecycle: (.MESSAGE // \"\" | tostring) as \$message | (if (\$message | test(\"Start request repeated too quickly\"; \"i\")) then \"start-limit-hit\" elif (\$message | test(\"Scheduled restart job\"; \"i\")) then \"restart-scheduled\" elif (\$message | test(\"Main process exited\"; \"i\")) then \"main-exited\" elif (\$message | test(\"Failed with result\"; \"i\")) then \"failed-result\" elif (\$message | test(\"Dependency failed\"; \"i\")) then \"dependency-failed\" elif (\$message | test(\"^Starting \")) then \"starting\" elif (\$message | test(\"^Started \")) then \"started\" elif (\$message | test(\"^Stopping \")) then \"stopping\" elif (\$message | test(\"Deactivated successfully\"; \"i\")) then \"deactivated\" elif (\$message | test(\"^Stopped \")) then \"stopped\" else \"other-systemd-event\" end) as \$event | [.__MONOTONIC_TIMESTAMP // \"unknown\", \$event] | @tsv; def bind_result(\$scope; \$message): if (\$message | test(\"\\\\(os error 98\\\\)\"; \"i\")) then (if \$scope == \"primary\" then \"primary address in use\" else \"callback address in use\" end) elif (\$message | test(\"\\\\(os error 99\\\\)\"; \"i\")) and \$scope == \"callback\" then \"callback address unavailable\" elif (\$message | test(\"\\\\(os error [0-9]+\\\\)\"; \"i\")) then \"bind failure unclassified\" else null end; def bind_continuation_result(\$scope; \$message): if (\$message | test(\"^[[:space:]]*(?:Address already )?in use \\\\(os error 98\\\\)[[:space:]]*$\"; \"i\")) then (if \$scope == \"primary\" then \"primary address in use\" else \"callback address in use\" end) elif \$scope == \"callback\" and (\$message | test(\"^[[:space:]]*(?:Cannot assign requested )?address \\\\(os error 99\\\\)[[:space:]]*$\"; \"i\")) then \"callback address unavailable\" else null end; def child_bind: reduce (.[] | select(._SYSTEMD_UNIT == \"openshell-gateway.service\" and ._EXE == \"/usr/local/bin/openshell-gateway\") | (.MESSAGE // \"\" | tostring)) as \$message ({attempt_seen:false,primary_bound:false,pending_scope:null,last_result:null}; if (\$message | test(\"^Starting OpenShell server(?:[[:space:]]|$)\")) then .last_result = (if .pending_scope == null then .last_result else \"bind failure unclassified\" end) | .attempt_seen=true | .primary_bound=false | .pending_scope=null elif .pending_scope != null then (bind_continuation_result(.pending_scope; \$message)) as \$result | .last_result=(\$result // \"bind failure unclassified\") | .pending_scope=null elif .attempt_seen and (\$message | test(\"^Gateway listener bound(?:[[:space:]]|$)\")) and (\$message | test(\"listener_purpose=[^[:alnum:]]*primary[^[:alnum:]]*(?:[[:space:]]|$)\")) then .primary_bound=true elif (\$message | test(\"transport error: failed to bind to \"; \"i\")) then if .attempt_seen then .pending_scope=(if .primary_bound then \"callback\" else \"primary\" end) | (bind_result(.pending_scope; \$message)) as \$result | if \$result == null then . else .last_result=\$result | .pending_scope=null end else .last_result=\"bind failure unclassified\" end else . end) | .last_result // (if .pending_scope == null then \"no bind failure\" else \"bind failure unclassified\" end); . as \$events | ((\$events | map(select(((._PID // \"\") | tostring) == \"1\") | lifecycle) | .[-16:][]), (\"gateway-child-bind\\t\" + (\$events | child_bind)))" 2>/dev/null) || exit 42; last_line=$(printf "%s\n" "$classified" | tail -n 1); label=$(printf "%s\n" "$last_line" | cut -f1); category=$(printf "%s\n" "$last_line" | cut -f2); [ "$label" = gateway-child-bind ] || exit 43; case "$category" in "primary address in use"|"callback address in use"|"callback address unavailable"|"bind failure unclassified"|"no bind failure") ;; *) exit 43 ;; esac; printf "%s\n" "$classified"'
  report_full_e2e_failure_diagnostic "gateway lifecycle" "$diagnostic_status" "$diagnostic_output"

  # The remote shell expands the single-quoted command.
  # shellcheck disable=SC2016
  run_budgeted_diagnostic_probe "$deadline" diagnostic_output diagnostic_status \
    ssh "${SSH_PROBE_OPTIONS[@]}" "$INSTANCE_NAME" \
    'set -eu; events=$(sudo -n journalctl --boot _PID=1 --unit=docker.service --unit=docker.socket --no-pager --lines=80 --output=json); classified=$(printf "%s\n" "$events" | jq -r "((.UNIT // ._SYSTEMD_UNIT // \"\") | if . == \"docker.service\" then \"docker-service\" elif . == \"docker.socket\" then \"docker-socket\" else \"docker-unit\" end) as \$unit | (.MESSAGE // \"\" | tostring) as \$message | (if (\$message | test(\"Start request repeated too quickly\"; \"i\")) then \"start-limit-hit\" elif (\$message | test(\"Scheduled restart job\"; \"i\")) then \"restart-scheduled\" elif (\$message | test(\"Main process exited\"; \"i\")) then \"main-exited\" elif (\$message | test(\"Failed with result\"; \"i\")) then \"failed-result\" elif (\$message | test(\"Dependency failed\"; \"i\")) then \"dependency-failed\" elif (\$message | test(\"^Starting \")) then \"starting\" elif (\$message | test(\"^Started \")) then \"started\" elif (\$message | test(\"^Stopping \")) then \"stopping\" elif (\$message | test(\"Deactivated successfully\"; \"i\")) then \"deactivated\" elif (\$message | test(\"^Stopped \")) then \"stopped\" else \"other-systemd-event\" end) as \$event | [.__MONOTONIC_TIMESTAMP // \"unknown\", \$unit, \$event] | @tsv"); printf "%s\n" "$classified" | tail -n 16'
  report_full_e2e_failure_diagnostic "Docker lifecycle" "$diagnostic_status" "$diagnostic_output"

  # The remote shell expands the single-quoted command.
  # shellcheck disable=SC2016
  run_budgeted_diagnostic_probe "$deadline" diagnostic_output diagnostic_status \
    ssh "${SSH_PROBE_OPTIONS[@]}" "$INSTANCE_NAME" \
    'set -eu; state=$(sudo -n systemctl show --no-pager --property=Id --property=LoadState --property=ActiveState --property=SubState --property=Result --property=ExecMainCode --property=ExecMainStatus --property=ActiveEnterTimestampMonotonic --property=InactiveEnterTimestampMonotonic cloud-final.service); printf "%s\n" "$state" | sed -e "s/^ActiveEnterTimestampMonotonic=/active-enter-us: /" -e "s/^InactiveEnterTimestampMonotonic=/inactive-enter-us: /" -e "s/=/ : /"'
  report_full_e2e_failure_diagnostic "cloud-final state" "$diagnostic_status" "$diagnostic_output"

  # The remote shell classifies the listener without returning guest-controlled
  # process labels or socket details.
  # shellcheck disable=SC2016
  run_budgeted_diagnostic_probe "$deadline" diagnostic_output diagnostic_status \
    ssh "${SSH_PROBE_OPTIONS[@]}" "$INSTANCE_NAME" \
    'set -eu; listeners=$(sudo -n ss -H -ltnp "sport = :8080"); if [ -z "$listeners" ]; then printf "listener presence: absent\n"; else printf "listener presence: present\n"; pids=; if parsed_pids=$(printf "%s\n" "$listeners" | awk "function reject(){bad=1;exit} { marker=\"users:(\"; at=index(\$0,marker); if(!at) reject(); s=substr(\$0,at+length(marker)); sub(/[[:space:]]+\$/, \"\", s); parsed=0; while(match(s,/^\\(\"[^\"]*\",pid=[0-9]+,fd=[0-9]+\\)/)){ tuple=substr(s,1,RLENGTH); pid=tuple; sub(/^.*\",pid=/,\"\",pid); sub(/,fd=.*/,\"\",pid); seen[pid]=1; total++; parsed++; s=substr(s,RLENGTH+1); if(s==\")\"){s=\"\";break} if(substr(s,1,1)!=\",\") reject(); s=substr(s,2) } if(!parsed||s!=\"\") reject() } END{if(bad||!total) exit 1; for(pid in seen) print pid}"); then pids=$parsed_pids; fi; gateway_cgroup=$(sudo -n systemctl show --no-pager --property=ControlGroup --value openshell-gateway.service); if [ -z "$pids" ] || [ -z "$gateway_cgroup" ]; then printf "listener owner: unavailable\n"; else gateway_owner=0; other_owner=0; unavailable_owner=0; for pid in $pids; do if cgroup=$(sudo -n cat "/proc/$pid/cgroup" 2>/dev/null); then if printf "%s\n" "$cgroup" | awk -F: -v wanted="$gateway_cgroup" "\$3 == wanted || (wanted != \"/\" && index(\$3, wanted \"/\") == 1) { found=1 } END { exit !found }"; then gateway_owner=1; else other_owner=1; fi; else unavailable_owner=1; fi; done; if [ "$unavailable_owner" -eq 1 ]; then printf "listener owner: unavailable\n"; elif [ "$gateway_owner" -eq 1 ] && [ "$other_owner" -eq 1 ]; then printf "listener owner: mixed\n"; elif [ "$gateway_owner" -eq 1 ]; then printf "listener owner: openshell-gateway\n"; elif [ "$other_owner" -eq 1 ]; then printf "listener owner: unexpected\n"; else printf "listener owner: unavailable\n"; fi; fi; fi'
  report_full_e2e_failure_diagnostic "port 8080 listener" "$diagnostic_status" "$diagnostic_output"
}

report_probe() {
  local label="$1" status="$2" error="$3"
  if [ "$status" = "not-run" ]; then
    log "Readiness probe $label: not run; status unavailable; error: $error"
  elif [ "$status" -eq 0 ]; then
    log "Readiness probe $label: success; status 0"
  else
    log "Readiness probe $label: failure; status $status; error: $error"
  fi
}

ssh_alias_status() {
  local deadline="$1" alias="$2" result_name="$3"
  local remaining
  local -a pipeline_status
  remaining=$((deadline - SECONDS))
  if [ "$remaining" -le 0 ]; then
    printf -v "$result_name" '%s' "not checked"
    return
  fi
  [ "$remaining" -le 2 ] || remaining=2
  set +e
  timeout "${remaining}s" ssh -G "$alias" 2>/dev/null \
    | awk -v alias="$alias" '
      tolower($1) == "hostname" && $2 != alias { configured = 1 }
      tolower($1) == "proxycommand" && tolower($2) != "none" { configured = 1 }
      tolower($1) == "proxyjump" && tolower($2) != "none" { configured = 1 }
      END { exit(configured ? 0 : 1) }
    ' >/dev/null
  pipeline_status=("${PIPESTATUS[@]}")
  set -e
  if [ "${pipeline_status[0]}" -ne 0 ]; then
    printf -v "$result_name" '%s' unavailable
  elif [ "${pipeline_status[1]}" -eq 0 ]; then
    printf -v "$result_name" '%s' configured
  else
    printf -v "$result_name" '%s' missing
  fi
}

run_connectivity_diagnostics() {
  local refresh_status="$1" timeout_seconds="$2"
  local exec_error exec_status ssh_error ssh_status
  local workspace_alias
  local deadline=$((SECONDS + timeout_seconds))

  log "Readiness diagnostics budget: up to $timeout_seconds seconds"

  ssh_alias_status "$deadline" "$INSTANCE_NAME" workspace_alias
  log "Readiness SSH alias $INSTANCE_NAME: $workspace_alias"

  run_budgeted_diagnostic_probe "$deadline" exec_error exec_status \
    brev exec "$INSTANCE_NAME" true
  run_budgeted_diagnostic_probe "$deadline" ssh_error ssh_status \
    ssh "${SSH_PROBE_OPTIONS[@]}" "$INSTANCE_NAME" true

  report_probe "brev exec" "$exec_status" "$exec_error"
  report_probe "direct SSH" "$ssh_status" "$ssh_error"

  if [ "$exec_status" = "not-run" ] || [ "$ssh_status" = "not-run" ]; then
    log "Readiness classification: incomplete diagnostics; inspect available bounded probe results"
  elif [ "$refresh_status" -ne 0 ]; then
    log "Readiness classification: Brev refresh/configuration failure"
  elif [ "$exec_status" -eq 0 ] && [ "$ssh_status" -ne 0 ]; then
    log "Readiness classification: Brev execution works but direct SSH fails"
  elif [ "$exec_status" -ne 0 ] && [ "$ssh_status" -ne 0 ]; then
    log "Readiness classification: workspace shell is unreachable"
  else
    log "Readiness classification: direct SSH recovered during diagnostics"
  fi
}

wait_for_workspace_ssh() {
  local timeout_seconds="${BREV_SSH_TIMEOUT_SECONDS:-900}"
  local diagnostic_timeout_seconds="${BREV_READINESS_DIAGNOSTIC_TIMEOUT_SECONDS:-30}"
  local poll_seconds="${POLL_SECONDS:-5}"
  local deadline=$((SECONDS + timeout_seconds))
  local remaining refresh_timeout sleep_seconds ssh_timeout refresh_error ssh_error
  local attempts=0
  local refresh_status=1 ssh_status=1
  local last_refresh_error="" last_refresh_failure_status=""
  local last_ssh_error="" last_ssh_failure_status=""
  log "Waiting up to $timeout_seconds seconds for workspace SSH access"

  remaining=$((deadline - SECONDS))
  [ "$remaining" -gt 0 ] || die "workspace SSH readiness timed out"
  refresh_timeout=$((remaining < 60 ? remaining : 60))
  run_bounded_probe "$refresh_timeout" refresh_error refresh_status brev refresh
  if [ "$refresh_status" -ne 0 ]; then
    last_refresh_error="$refresh_error"
    last_refresh_failure_status="$refresh_status"
  fi

  while [ "$SECONDS" -lt "$deadline" ]; do
    remaining=$((deadline - SECONDS))
    [ "$remaining" -gt 0 ] || break
    ssh_timeout=$((remaining < 15 ? remaining : 15))
    run_bounded_probe "$ssh_timeout" ssh_error ssh_status \
      ssh "${SSH_PROBE_OPTIONS[@]}" "$INSTANCE_NAME" true
    if [ "$ssh_status" -eq 0 ]; then
      log "SSH access to $INSTANCE_NAME succeeded"
      return 0
    fi
    attempts=$((attempts + 1))
    last_ssh_error="$ssh_error"
    last_ssh_failure_status="$ssh_status"

    if [ $((attempts % 5)) -eq 0 ]; then
      remaining=$((deadline - SECONDS))
      [ "$remaining" -gt 0 ] || break
      refresh_timeout=$((remaining < 60 ? remaining : 60))
      run_bounded_probe "$refresh_timeout" refresh_error refresh_status brev refresh
      if [ "$refresh_status" -ne 0 ]; then
        last_refresh_error="$refresh_error"
        last_refresh_failure_status="$refresh_status"
      fi
    fi

    remaining=$((deadline - SECONDS))
    [ "$remaining" -gt 0 ] || break
    sleep_seconds="$poll_seconds"
    sleep "$((sleep_seconds < remaining ? sleep_seconds : remaining))"
  done
  if [ -n "$last_refresh_failure_status" ]; then
    log "Readiness Brev refresh last failure: status $last_refresh_failure_status; error: $last_refresh_error"
  else
    log "Readiness Brev refresh last failure: none"
  fi
  if [ -n "$last_ssh_failure_status" ]; then
    log "Readiness direct SSH last failure: status $last_ssh_failure_status; error: $last_ssh_error"
  else
    log "Readiness direct SSH last failure: none"
  fi
  run_connectivity_diagnostics "$refresh_status" "$diagnostic_timeout_seconds"
  die "workspace SSH readiness timed out"
}

cleanup() {
  local record="" deadline absent=0 workspace_id="" last_inventory="unknown" cleanup_status
  local create_state="reconciled" delete_attempts=0 ownership_recorded=0
  local reconcile_deadline=0 workspace_observed=0
  ownership_receipt="${ownership_receipt:-${WORK_DIR}.workspace-owner}"
  if [ -f "$ownership_receipt" ]; then
    ownership_recorded=1
    create_state="$(jq -er --arg name "$INSTANCE_NAME" '
      select(.workspaceName == $name) | .createState |
      select(. == "pending" or . == "accepted" or . == "reconciled")' \
      "$ownership_receipt" 2>/dev/null || true)"
    if [ -z "$create_state" ]; then
      jq -n --arg workspaceName "$INSTANCE_NAME" \
        --arg checkedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '{workspaceName:$workspaceName,workspaceId:"",status:"UNKNOWN",checkedAt:$checkedAt}' \
        >"$WORK_DIR/cleanup.json"
      log "FAILED: cleanup refused because the workspace ownership receipt is invalid" >&2
      return 1
    fi
    delete_attempts="$(jq -er --arg name "$INSTANCE_NAME" '
      select(.workspaceName == $name) | .deleteAttempts |
      select(type == "number" and floor == . and . >= 0 and . <= 1)' \
      "$ownership_receipt" 2>/dev/null || true)"
    if [ -z "$delete_attempts" ]; then
      jq -n --arg workspaceName "$INSTANCE_NAME" \
        --arg checkedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '{workspaceName:$workspaceName,workspaceId:"",status:"UNKNOWN",checkedAt:$checkedAt}' \
        >"$WORK_DIR/cleanup.json"
      log "FAILED: cleanup refused because the workspace ownership receipt is invalid" >&2
      return 1
    fi
  fi
  if [ "$create_state" != reconciled ]; then
    reconcile_deadline=$((SECONDS + ${BREV_CREATE_RECONCILE_SECONDS:-120}))
  fi
  if [ -f "$WORK_DIR/cleanup.json" ]; then
    workspace_id="$(jq -r '.workspaceId // ""' "$WORK_DIR/cleanup.json" 2>/dev/null || true)"
  fi
  deadline=$((SECONDS + ${BREV_DELETE_TIMEOUT_SECONDS:-600}))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if record="$(workspace)"; then
      last_inventory="known"
      if [ -z "$record" ]; then
        if [ "$create_state" != reconciled ] \
          && [ "$workspace_observed" -eq 0 ] \
          && [ "$SECONDS" -lt "$reconcile_deadline" ]; then
          absent=0
        else
          absent=$((absent + 1))
        fi
        if [ "$absent" -ge 2 ]; then
          jq -n --arg workspaceName "$INSTANCE_NAME" --arg workspaceId "$workspace_id" \
            --argjson deleteAttempts "$delete_attempts" \
            --arg verifiedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
            '{workspaceName:$workspaceName,workspaceId:$workspaceId,status:"ABSENT",
              deleteAttempts:$deleteAttempts,verifiedAt:$verifiedAt}' \
            >"$WORK_DIR/cleanup.json"
          if [ -f "$ownership_receipt" ]; then
            write_workspace_ownership reconciled
          fi
          log "Workspace $INSTANCE_NAME is absent"
          return 0
        fi
      else
        absent=0
        workspace_observed=1
        [ -n "$workspace_id" ] || workspace_id="$(jq -r '.id // ""' <<<"$record")"
        if [ "$delete_attempts" -eq 0 ]; then
          create_state="reconciled"
          delete_attempts=$((delete_attempts + 1))
          if [ "$ownership_recorded" -eq 1 ]; then
            if ! write_workspace_ownership "$create_state" "$delete_attempts"; then
              log "FAILED: cleanup could not record the workspace delete attempt" >&2
              return 1
            fi
          fi
          log "Workspace cleanup delete attempt $delete_attempts of 1"
          timeout 60s brev delete "$INSTANCE_NAME" || true
        fi
      fi
    else
      last_inventory="unknown"
      absent=0
    fi
    timeout 30s brev refresh >/dev/null 2>&1 || true
    sleep "${POLL_SECONDS:-15}"
  done
  if [ "$last_inventory" = "known" ] && [ -n "$record" ]; then
    cleanup_status="PRESENT"
  else
    cleanup_status="UNKNOWN"
  fi
  jq -n --arg workspaceName "$INSTANCE_NAME" --arg workspaceId "$workspace_id" \
    --arg status "$cleanup_status" --argjson deleteAttempts "$delete_attempts" \
    --arg checkedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{workspaceName:$workspaceName,workspaceId:$workspaceId,status:$status,
      deleteAttempts:$deleteAttempts,checkedAt:$checkedAt}' \
    >"$WORK_DIR/cleanup.json"
  log "FAILED: workspace $INSTANCE_NAME cleanup ended with $cleanup_status" >&2
  return 1
}

finish() {
  local status=$?
  trap - EXIT INT TERM
  if [ "$cleanup_required" -eq 1 ]; then
    if [ "${NEMOCLAW_BREV_DEFER_CLEANUP:-0}" = 1 ]; then
      log "Workspace cleanup is reserved for the workflow cleanup step"
    elif ! cleanup; then
      status=1
    fi
  fi
  rm -f "${diagnostic_capture:-}" "${raw_log:-}"
  if [ -n "${raw_log_directory:-}" ]; then
    rm -f "$raw_log_directory/full-e2e.raw"
    rmdir "$raw_log_directory" 2>/dev/null || true
  fi
  exit "$status"
}

trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "${1:-}" = "cleanup-owned-workspace" ]; then
  [ "$#" -eq 1 ] || die "cleanup-owned-workspace accepts no additional arguments"
  for name in WORK_DIR INSTANCE_NAME; do
    require "$name"
  done
  for tool in brev jq timeout; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool is required"
  done
  [[ "$INSTANCE_NAME" =~ ^[a-z][a-z0-9-]{0,62}$ ]] \
    || die "workspace name must start with a lowercase letter and use at most 63 lowercase letters, digits, or hyphens"
  if [ "${POLL_SECONDS+x}" = x ] && ! [[ "$POLL_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
    die "POLL_SECONDS must be a positive integer"
  fi
  if [ "${BREV_DELETE_TIMEOUT_SECONDS+x}" = x ] \
    && ! [[ "$BREV_DELETE_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
    die "BREV_DELETE_TIMEOUT_SECONDS must be a positive integer"
  fi
  if [ "${BREV_CREATE_RECONCILE_SECONDS+x}" = x ] \
    && ! [[ "$BREV_CREATE_RECONCILE_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
    die "BREV_CREATE_RECONCILE_SECONDS must be a positive integer"
  fi
  : >>"$WORK_DIR/lane.log"
  ownership_receipt="${WORK_DIR}.workspace-owner"
  if [ ! -f "$ownership_receipt" ]; then
    if [ ! -f "$WORK_DIR/cleanup.json" ]; then
      jq -n --arg workspaceName "$INSTANCE_NAME" \
        --arg checkedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '{workspaceName:$workspaceName,workspaceId:"",status:"NOT_OWNED",checkedAt:$checkedAt}' \
        >"$WORK_DIR/cleanup.json"
    fi
    log "No workflow-owned workspace requires cleanup"
    exit 0
  fi
  if ! jq -e --arg name "$INSTANCE_NAME" '
    .workspaceName == $name and
    (.createState == "pending" or .createState == "accepted" or .createState == "reconciled") and
    (.deleteAttempts | type == "number" and floor == . and . >= 0 and . <= 1)' \
    "$ownership_receipt" >/dev/null 2>&1; then
    jq -n --arg workspaceName "$INSTANCE_NAME" \
      --arg checkedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '{workspaceName:$workspaceName,workspaceId:"",status:"UNKNOWN",checkedAt:$checkedAt}' \
      >"$WORK_DIR/cleanup.json"
    die "cleanup refused because the ownership receipt does not match the run-attempt workspace"
  fi
  cleanup
  rm -f -- "$ownership_receipt"
  exit 0
elif [ "$#" -ne 0 ]; then
  die "only cleanup-owned-workspace is accepted as an argument"
fi

CORRELATION_ID="${CORRELATION_ID:-$(tr '[:upper:]' '[:lower:]' </proc/sys/kernel/random/uuid)}"
IMAGE_ONLY="${NEMOCLAW_BREV_LAUNCHABLE_IMAGE_ONLY:-0}"
IDENTITY_ONLY="${NEMOCLAW_BREV_LAUNCHABLE_IDENTITY_ONLY:-0}"
DEFER_CLEANUP="${NEMOCLAW_BREV_DEFER_CLEANUP:-0}"
[[ "$IMAGE_ONLY" =~ ^[01]$ ]] || die "NEMOCLAW_BREV_LAUNCHABLE_IMAGE_ONLY must be 0 or 1"
[[ "$IDENTITY_ONLY" =~ ^[01]$ ]] || die "NEMOCLAW_BREV_LAUNCHABLE_IDENTITY_ONLY must be 0 or 1"
[[ "$DEFER_CLEANUP" =~ ^[01]$ ]] || die "NEMOCLAW_BREV_DEFER_CLEANUP must be 0 or 1"
case "$IMAGE_ONLY:$IDENTITY_ONLY" in
  1:0) VALIDATION_MODE="image-only" ;;
  0:1) VALIDATION_MODE="identity-smoke" ;;
  0:0) VALIDATION_MODE="full-e2e" ;;
  *) die "image-only and identity-smoke modes are mutually exclusive" ;;
esac
[ "$DEFER_CLEANUP" = 0 ] || [ "$VALIDATION_MODE" = identity-smoke ] \
  || die "deferred cleanup is accepted only in identity-smoke mode"
for name in WORK_DIR CANDIDATE_SHA CORRELATION_ID GH_TOKEN GITHUB_RUN_ID \
  GITHUB_RUN_ATTEMPT; do
  require "$name"
done
for tool in gh jq; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required"
done
[[ "$CANDIDATE_SHA" =~ ^[0-9a-f]{40}$ ]] || die "candidate SHA is not canonical"
[[ "$CORRELATION_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] \
  || die "correlation ID is not a UUIDv4"
if [ "$VALIDATION_MODE" != image-only ]; then
  for name in BREV_LAUNCHABLE_ID INSTANCE_NAME; do
    require "$name"
  done
  for tool in awk brev mktemp python3 sed ssh timeout; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool is required"
  done
  [[ "$INSTANCE_NAME" =~ ^[a-z][a-z0-9-]{0,62}$ ]] \
    || die "workspace name must start with a lowercase letter and use at most 63 lowercase letters, digits, or hyphens"
  [[ "$BREV_LAUNCHABLE_ID" =~ ^env-[A-Za-z0-9]+$ ]] \
    || die "BREV_LAUNCHABLE_ID must start with env- and contain only letters or digits after the prefix"
  if [ "${BREV_SSH_TIMEOUT_SECONDS+x}" = x ] \
    && ! [[ "$BREV_SSH_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
    die "BREV_SSH_TIMEOUT_SECONDS must be a positive integer"
  fi
  if [ "${BREV_READINESS_DIAGNOSTIC_TIMEOUT_SECONDS+x}" = x ] \
    && ! [[ "$BREV_READINESS_DIAGNOSTIC_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
    die "BREV_READINESS_DIAGNOSTIC_TIMEOUT_SECONDS must be a positive integer"
  fi
  if [ "$VALIDATION_MODE" = full-e2e ]; then
    require NVIDIA_INFERENCE_API_KEY
  elif [ -n "${NVIDIA_INFERENCE_API_KEY:-}" ]; then
    die "identity-smoke mode must not receive NVIDIA_INFERENCE_API_KEY"
  fi
  if [ "$VALIDATION_MODE" = full-e2e ] \
    && [ "${FULL_E2E_FAILURE_DIAGNOSTIC_TIMEOUT_SECONDS+x}" = x ] \
    && ! [[ "$FULL_E2E_FAILURE_DIAGNOSTIC_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
    die "FULL_E2E_FAILURE_DIAGNOSTIC_TIMEOUT_SECONDS must be a positive integer"
  fi
  if [ "${POLL_SECONDS+x}" = x ] && ! [[ "$POLL_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
    die "POLL_SECONDS must be a positive integer"
  fi
  if [ "${BREV_CREATE_RECONCILE_SECONDS+x}" = x ] \
    && ! [[ "$BREV_CREATE_RECONCILE_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
    die "BREV_CREATE_RECONCILE_SECONDS must be a positive integer"
  fi
fi
: >"$WORK_DIR/lane.log"
log "Candidate $CANDIDATE_SHA"
if [ "$VALIDATION_MODE" = identity-smoke ]; then
  jq -n --arg workspaceName "$INSTANCE_NAME" \
    --arg checkedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{workspaceName:$workspaceName,workspaceId:"",status:"NOT_REQUIRED",checkedAt:$checkedAt}' \
    >"$WORK_DIR/cleanup.json"
fi

# Dispatch #80 once, then bind the uniquely correlated producer run.
requested_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
title="Build Launchable E2E image for NemoClaw $CANDIDATE_SHA ($CORRELATION_ID)"
gh api --method POST "repos/$IMAGE_REPOSITORY/actions/workflows/$IMAGE_WORKFLOW/dispatches" \
  -f ref=main -f "inputs[nemoclaw_sha]=$CANDIDATE_SHA" \
  -f "inputs[correlation_id]=$CORRELATION_ID" \
  -f "inputs[requester_workflow_run_id]=$GITHUB_RUN_ID" \
  -f "inputs[requester_workflow_run_attempt]=$GITHUB_RUN_ATTEMPT"
deadline=$((SECONDS + 300))
producer_run=""
while [ "$SECONDS" -lt "$deadline" ]; do
  runs="$(gh api --method GET "repos/$IMAGE_REPOSITORY/actions/workflows/$IMAGE_WORKFLOW/runs" \
    -f branch=main -f event=workflow_dispatch -f per_page=50)"
  matches="$(jq -c --arg title "$title" --arg since "$requested_at" \
    '[.workflow_runs[] | select(.display_title == $title and .head_branch == "main" and .created_at >= $since)]' \
    <<<"$runs")" || die "producer run inventory is malformed"
  [ "$(jq 'length' <<<"$matches")" -le 1 ] || die "correlation matched multiple producer runs"
  producer_run="$(jq -r '.[0].id // empty | tostring' <<<"$matches")"
  [ -z "$producer_run" ] || break
  sleep "${POLL_SECONDS:-15}"
done
[ -n "$producer_run" ] || die "producer run was not found"
log "Producer run $producer_run"

deadline=$((SECONDS + ${IMAGE_BUILD_TIMEOUT_SECONDS:-3600}))
while [ "$SECONDS" -lt "$deadline" ]; do
  run="$(gh api "repos/$IMAGE_REPOSITORY/actions/runs/$producer_run")"
  status="$(jq -r '.status // ""' <<<"$run")"
  if [ "$status" = completed ]; then
    [ "$(jq -r '.conclusion // ""' <<<"$run")" = success ] \
      || die "producer run $producer_run failed"
    break
  fi
  sleep "${POLL_SECONDS:-15}"
done
[ "${status:-}" = completed ] || die "producer run $producer_run timed out"
artifact="nemoclaw-image-handoff-v1-${producer_run}-1"
mkdir -m 700 "$WORK_DIR/handoff"
gh run download "$producer_run" --repo "$IMAGE_REPOSITORY" --name "$artifact" \
  --dir "$WORK_DIR/handoff"
manifest="$WORK_DIR/handoff/nemoclaw-image-manifest.v1.json"
[ -f "$manifest" ] || die "producer receipt is missing"
jq -e --arg sha "$CANDIDATE_SHA" --arg correlation "$CORRELATION_ID" \
  --arg requester "$GITHUB_RUN_ID" --argjson attempt "$GITHUB_RUN_ATTEMPT" --arg run "$producer_run" '
  .kind == "nemoclaw-exact-image-manifest" and .nemoclawSha == $sha and
  .correlationId == $correlation and .requesterWorkflowRunId == $requester and
  .requesterWorkflowRunAttempt == $attempt and .imageRepository == "brevdev/nemoclaw-image" and
  .producerWorkflow == ".github/workflows/build-launchable-e2e-image.yml" and
  .workflowRunId == $run and .workflowRunAttempt == 1 and .status == "READY" and
  .channel == "staging" and .variant == "cpu" and
  .observedFamily == "nemoclaw-brev-staging-cpu" and
  (.project | type) == "string" and (.project | length) > 0 and
  (.imageName | type) == "string" and (.imageName | length) > 0 and
  (.imageRepositorySha | test("^[0-9a-f]{40}$"))' \
  "$manifest" >/dev/null || die "producer receipt does not match the candidate"
expected_boot_image="projects/$(jq -er .project "$manifest")/global/images/$(jq -er .imageName "$manifest")"
image_repository_sha="$(jq -er .imageRepositorySha "$manifest")"
rm -rf "$WORK_DIR/handoff"

if [ "$VALIDATION_MODE" = image-only ]; then
  jq -n --arg candidateSha "$CANDIDATE_SHA" --arg producerRun "$producer_run" \
    --arg imageUri "$expected_boot_image" --arg imageRepositorySha "$image_repository_sha" '
    {
      schemaVersion: 1,
      kind: "nemoclaw-staging-launchable-image-v1",
      candidateSha: $candidateSha,
      producer: {
        repository: "brevdev/nemoclaw-image",
        workflow: ".github/workflows/build-launchable-e2e-image.yml",
        runId: $producerRun,
        status: "success"
      },
      image: {
        uri: $imageUri,
        family: "nemoclaw-brev-staging-cpu",
        imageRepositorySha: $imageRepositorySha
      },
      validation: {
        launchable: "not-run",
        runtime: "not-run",
        inference: "not-run"
      }
    }' >"$WORK_DIR/launchable-image.json"
  log "Published staging Launchable image $expected_boot_image"
  log "Launchable deployment, runtime, and inference validation did not run"
  exit 0
fi

# The standing Launchable resolves the staging family. Give that reference time to
# observe the family update before deploying it.
log "Waiting 300s for the Launchable image family to settle"
sleep 300

# The guest must boot the exact image and contain the exact clean candidate.
existing="$(workspace)" || die "Brev workspace inventory failed"
[ -z "$existing" ] || {
  if [ "$VALIDATION_MODE" = identity-smoke ]; then
    jq -n --arg workspaceName "$INSTANCE_NAME" \
      --arg workspaceId "$(jq -r '.id // ""' <<<"$existing")" \
      --arg checkedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '{workspaceName:$workspaceName,workspaceId:$workspaceId,status:"NOT_OWNED",checkedAt:$checkedAt}' \
      >"$WORK_DIR/cleanup.json"
  fi
  die "workspace name already exists"
}
cleanup_required=1
if [ "$VALIDATION_MODE" = identity-smoke ]; then
  write_workspace_ownership pending
fi
timeout 900s brev create "$INSTANCE_NAME" --launchable "$BREV_LAUNCHABLE_ID" --detached --timeout 900
if [ "$VALIDATION_MODE" = identity-smoke ]; then
  write_workspace_ownership accepted
fi
deadline=$((SECONDS + ${BREV_READY_TIMEOUT_SECONDS:-1200}))
ready=""
while [ "$SECONDS" -lt "$deadline" ]; do
  ready="$(workspace || true)"
  if jq -e '.status == "RUNNING" and (.shell_status // .shellStatus) == "READY" and
    (.build_status // .buildStatus) == "COMPLETED"' <<<"${ready:-null}" >/dev/null; then break; fi
  state="$(jq -r '(.status // "") + ":" + (.build_status // .buildStatus // "")' <<<"${ready:-null}")"
  [[ "$state" =~ FAILURE|FAILED|ERROR|CREATE_FAILED ]] && die "workspace entered $state"
  sleep "${POLL_SECONDS:-15}"
done
jq -e '.status == "RUNNING" and (.shell_status // .shellStatus) == "READY" and
  (.build_status // .buildStatus) == "COMPLETED"' \
  <<<"${ready:-null}" >/dev/null || die "workspace readiness timed out"
workspace_id="$(jq -r '.id // ""' <<<"$ready")"
log "Workspace $INSTANCE_NAME ($workspace_id) is ready"
wait_for_workspace_ssh

# Record the booted image before reading the baked runtime receipt so a stale
# Launchable image remains visible when the receipt is absent.
# The remote shell expands the single-quoted command.
# shellcheck disable=SC2016
boot_image="$(timeout 300s brev exec "$INSTANCE_NAME" 'set -euo pipefail
  boot_image=$(curl -fsS --max-time 10 -H "Metadata-Flavor: Google" \
    http://metadata.google.internal/computeMetadata/v1/instance/image)
  printf "NEMOCLAW_BOOT_IMAGE=%s\n" "$boot_image"' \
  | sed -n 's/^NEMOCLAW_BOOT_IMAGE=//p' | tail -n 1)"
[ -n "$boot_image" ] || die "booted image identity is missing"

if [ "$boot_image" = "$expected_boot_image" ]; then
  image_selection_status=passed
  reported_boot_image="$boot_image"
else
  image_selection_status=failed
  reported_boot_image="<redacted>"
fi
if [ "$VALIDATION_MODE" = identity-smoke ]; then
  launchable_evidence="$WORK_DIR/launchable-identity.json"
  jq -n --arg candidateSha "$CANDIDATE_SHA" --arg producerRun "$producer_run" \
    --arg bootImage "$reported_boot_image" --arg expectedBootImage "$expected_boot_image" \
    --arg imageRepositorySha "$image_repository_sha" \
    --arg imageSelectionStatus "$image_selection_status" \
    --arg workspaceName "$INSTANCE_NAME" --arg workspaceId "$workspace_id" '
    {
      schemaVersion: 1,
      kind: "nemoclaw-staging-launchable-identity-v1",
      candidateSha: $candidateSha,
      producer: {
        repository: "brevdev/nemoclaw-image",
        workflow: ".github/workflows/build-launchable-e2e-image.yml",
        runId: $producerRun,
        status: "success"
      },
      image: {uri:$expectedBootImage,imageRepositorySha:$imageRepositorySha},
      workspace: {name:$workspaceName,id:$workspaceId},
      validation: {
        workspaceReadiness: "passed",
        ssh: "passed",
        imageSelection: {
          status:$imageSelectionStatus,
          expected:$expectedBootImage,
          observed:$bootImage
        },
        runtimeIdentity: {status:"not-run",checks:[]},
        onboarding: "not-run",
        inference: "not-run",
        fullE2E: "not-run"
      }
    }' >"$launchable_evidence"
else
  launchable_evidence="$WORK_DIR/launchable-e2e.json"
  jq -n --arg candidateSha "$CANDIDATE_SHA" --arg producerRun "$producer_run" \
    --arg bootImage "$reported_boot_image" --arg expectedBootImage "$expected_boot_image" \
    --arg imageSelectionStatus "$image_selection_status" \
    --arg workspaceName "$INSTANCE_NAME" --arg workspaceId "$workspace_id" \
    '{candidateSha:$candidateSha,producer:{runId:$producerRun,status:"success"},boot:{bootImage:$bootImage},workspace:{name:$workspaceName,id:$workspaceId},fullE2e:"pending",validation:{imageSelection:{status:$imageSelectionStatus,expected:$expectedBootImage,observed:$bootImage},runtimeProvenance:{status:"not-run",checks:[]},fullE2E:"not-run"}}' \
    >"$launchable_evidence"
fi

[ "$image_selection_status" = passed ] || die "booted image does not match the producer handoff"

# Return the baked runtime receipt.
# shellcheck disable=SC2016
identity="$(timeout 300s brev exec "$INSTANCE_NAME" 'set -euo pipefail
  schema_version=$(sudo -n jq -er .schemaVersion /etc/nemoclaw/provision.json)
  source_repository=$(sudo -n jq -er .sourceRepository /etc/nemoclaw/provision.json)
  source_path=$(sudo -n jq -er .sourcePath /etc/nemoclaw/provision.json)
  provision_sha=$(sudo -n jq -er .gitSha /etc/nemoclaw/provision.json)
  image_repository_sha=$(sudo -n jq -er .imageRepositorySha /etc/nemoclaw/provision.json)
  repo_sha=$(git -C "$source_path" rev-parse HEAD)
  if [ -z "$(git -C "$source_path" status --porcelain --untracked-files=normal)" ]; then
    repo_clean=true
  else
    repo_clean=false
  fi
  if sudo -n test -e /etc/nemoclaw/runtime-overrides.json; then
    runtime_overrides=true
  else
    runtime_overrides=false
  fi
  printf "NEMOCLAW_IDENTITY="
  jq -cn --argjson schemaVersion "$schema_version" --arg sourceRepository "$source_repository" \
    --arg sourcePath "$source_path" \
    --arg repoSha "$repo_sha" --arg provisionSha "$provision_sha" \
    --arg imageRepositorySha "$image_repository_sha" --argjson repoClean "$repo_clean" \
    --argjson runtimeOverrides "$runtime_overrides" \
    "{schemaVersion:\$schemaVersion,sourceRepository:\$sourceRepository,sourcePath:\$sourcePath,repoSha:\$repoSha,provisionSha:\$provisionSha,imageRepositorySha:\$imageRepositorySha,repoClean:\$repoClean,runtimeOverrides:\$runtimeOverrides}"' \
  | sed -n 's/^NEMOCLAW_IDENTITY=//p' | tail -n 1)"
runtime_checks="$(jq -c --arg sha "$CANDIDATE_SHA" --arg imageRepositorySha "$image_repository_sha" '
  def reported($field; $observed):
    if $field == "schemaVersion" then
      if ($observed | type) == "number" and $observed == ($observed | floor) and
          $observed >= 0 and $observed <= 999 then $observed else "<redacted>" end
    elif $field == "sourceRepository" then
      if $observed == "NVIDIA/NemoClaw" then $observed else "<redacted>" end
    elif $field == "sourcePath" then
      if $observed == "/opt/nemoclaw-image/NemoClaw" then $observed else "<redacted>" end
    elif $field == "repoSha" or $field == "provisionSha" or $field == "imageRepositorySha" then
      if ($observed | type) == "string" and ($observed | test("^[0-9a-f]{40}$")) then $observed else "<redacted>" end
    elif $field == "repoClean" or $field == "runtimeOverrides" then
      if ($observed | type) == "boolean" then $observed else "<redacted>" end
    else "<redacted>"
    end;
  def check($field; $expected; $observed):
    {field:$field,expected:$expected,observed:reported($field; $observed),
      status:(if $observed == $expected then "passed" else "failed" end)};
  [
    check("schemaVersion"; 1; .schemaVersion),
    check("sourceRepository"; "NVIDIA/NemoClaw"; .sourceRepository),
    check("sourcePath"; "/opt/nemoclaw-image/NemoClaw"; .sourcePath),
    check("repoSha"; $sha; .repoSha),
    check("provisionSha"; $sha; .provisionSha),
    check("imageRepositorySha"; $imageRepositorySha; .imageRepositorySha),
    check("repoClean"; true; .repoClean),
    check("runtimeOverrides"; false; .runtimeOverrides)
  ]' <<<"$identity")" || die "booted image runtime identity is malformed"
runtime_status="$(jq -r 'if all(.status == "passed") then "passed" else "failed" end' \
  <<<"$runtime_checks")"
reported_identity="$(jq -c 'map({key:.field,value:.observed}) | from_entries' \
  <<<"$runtime_checks")"

if [ "$VALIDATION_MODE" = identity-smoke ]; then
  jq --arg status "$runtime_status" --argjson checks "$runtime_checks" '
    .validation.runtimeIdentity = {status:$status,checks:$checks}' \
    "$launchable_evidence" >"$WORK_DIR/launchable-identity.tmp"
  mv "$WORK_DIR/launchable-identity.tmp" "$launchable_evidence"
else
  jq --argjson identity "$reported_identity" --arg status "$runtime_status" \
    --argjson checks "$runtime_checks" '
    .boot += $identity | .validation.runtimeProvenance = {status:$status,checks:$checks}' \
    "$launchable_evidence" >"$WORK_DIR/launchable-e2e.tmp"
  mv "$WORK_DIR/launchable-e2e.tmp" "$launchable_evidence"
fi

if [ "$runtime_status" = failed ]; then
  while IFS= read -r mismatch; do
    if [ "$VALIDATION_MODE" = identity-smoke ]; then
      log "Runtime identity check failed: $mismatch"
    else
      log "Runtime provenance check failed: $mismatch"
    fi
  done < <(jq -r '.[] | select(.status == "failed") |
    "\(.field) expected \(.expected | tojson), observed \(.observed | tojson)"' \
    <<<"$runtime_checks")
  if [ "$VALIDATION_MODE" = identity-smoke ]; then
    die "booted image runtime identity failed"
  fi
  die "booted image runtime provenance failed"
fi
if [ "$VALIDATION_MODE" = identity-smoke ]; then
  log "Exact staging image boot and runtime identity passed"
  log "Onboarding, inference, and full E2E did not run"
  exit 0
fi
source_path="$(jq -er .sourcePath <<<"$identity")"

# Run the existing suite from the baked checkout; no source copy, install, or rebuild.
raw_log_directory="$(mktemp -d "${RUNNER_TEMP:-/tmp}/brev-launchable-e2e.XXXXXX")"
chmod 700 "$raw_log_directory"
raw_log="$raw_log_directory/full-e2e.raw"
(umask 077 && : >"$raw_log")
set +e
{
  printf 'export NVIDIA_INFERENCE_API_KEY=%q\n' "$NVIDIA_INFERENCE_API_KEY"
  printf 'export NEMOCLAW_SOURCE_PATH=%q\n' "$source_path"
  cat <<'REMOTE'
set -euo pipefail
sudo -n test ! -e /etc/nemoclaw/runtime-overrides.json
cd "$NEMOCLAW_SOURCE_PATH"
test -x ./node_modules/.bin/vitest
export CI=true GITHUB_ACTIONS=true E2E_TARGET_ID=staging-brev-launchable
export NEMOCLAW_E2E_SETUP_MODE=preinstalled-launchable NEMOCLAW_RUN_LIVE_E2E=1
export NEMOCLAW_MODEL="$(node /usr/local/lib/nemoclaw/launchable-config.mjs /usr/local/share/nemoclaw/launchable-agents.json openclaw cloudModel)"
export NEMOCLAW_SANDBOX_NAME=e2e-staging
./node_modules/.bin/vitest run --project e2e-live test/e2e/live/full-e2e.test.ts --silent=false --reporter=default
printf 'NEMOCLAW_FULL_E2E_PASSED\n'
REMOTE
} | timeout "${FULL_E2E_TIMEOUT_SECONDS:-3000}" ssh -T -o ConnectTimeout=10 -o LogLevel=ERROR \
  "$INSTANCE_NAME" 'bash -s' >"$raw_log" 2>&1
e2e_status=$?
set -e
NEMOCLAW_REDACTION_SECRET="$NVIDIA_INFERENCE_API_KEY" \
  python3 - "$raw_log" "$WORK_DIR/full-e2e.log" <<'PY'
import os
import sys
from pathlib import Path
source, target = sys.argv[1:]
secret = os.environ["NEMOCLAW_REDACTION_SECRET"]
Path(target).write_bytes(Path(source).read_bytes().replace(secret.encode(), b"[REDACTED]"))
Path(source).unlink(missing_ok=True)
PY
raw_log=""
if [ "$e2e_status" -ne 0 ] || ! grep -q '^NEMOCLAW_FULL_E2E_PASSED$' "$WORK_DIR/full-e2e.log"; then
  jq '.fullE2e = "failed" | .validation.fullE2E = "failed"' \
    "$WORK_DIR/launchable-e2e.json" >"$WORK_DIR/launchable-e2e.tmp"
  mv "$WORK_DIR/launchable-e2e.tmp" "$WORK_DIR/launchable-e2e.json"
  capture_full_e2e_failure_diagnostics
  die "full E2E failed"
fi
jq '.fullE2e = "passed" | .validation.fullE2E = "passed"' \
  "$WORK_DIR/launchable-e2e.json" >"$WORK_DIR/launchable-e2e.tmp"
mv "$WORK_DIR/launchable-e2e.tmp" "$WORK_DIR/launchable-e2e.json"
log "Full E2E passed"
