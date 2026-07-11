// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const DCODE_AGENT_NAME = "langchain-deepagents-code";
export const DCODE_PROBE_PREFIX = "NEMOCLAW_DCODE_PROBE=";
export const DCODE_PROBE_STATE = {
  active: "active",
  idleDcodeRuntime: "idle",
  unverifiableDcodeRuntime: "unverifiable",
  noDcodeRuntime: "no-runtime",
} as const;
export type DcodeProbeState = (typeof DCODE_PROBE_STATE)[keyof typeof DCODE_PROBE_STATE];

export const DCODE_BUSY_PROBE_SCRIPT = String.raw`emit_dcode_probe_state() {
  printf 'NEMOCLAW_DCODE_PROBE=%s\n' "$1"
  exit 0
}
has_dcode_runtime=0
dc_bin="$(printf 'd%s' code)"
da_bin="$(printf 'deepagents-%s' code)"
home_dir="$HOME"
[ -n "$home_dir" ] || home_dir=/sandbox
[ -d /sandbox/.deepagents ] && has_dcode_runtime=1
[ -d "$home_dir/.deepagents" ] && has_dcode_runtime=1
command -v "$dc_bin" >/dev/null 2>&1 && has_dcode_runtime=1
command -v "$da_bin" >/dev/null 2>&1 && has_dcode_runtime=1
detect_dcode_processes() {
  awk '
/^[[:space:]]*[0-9]+[[:space:]]+([^[:space:]]*\/)?python[0-9.]*[[:space:]]+(-I[[:space:]]+)?-m[[:space:]]+deepagents[_]code([[:space:]]|$)/ {
  found = 1
}
/^[[:space:]]*[0-9]+[[:space:]]+([^[:space:]]*\/)?[d]code([[:space:]]|$)/ {
  found = 1
}
/^[[:space:]]*[0-9]+[[:space:]]+([^[:space:]]*\/)?deepagents[-_]code([[:space:]]|$)/ {
  found = 1
}
END { exit found ? 0 : 1 }
'
}
proc_root=/proc
processes="$(ps -eo pid=,args= 2>/dev/null)" || {
  processes=""
  saw_proc_process=0
  proc_scan_incomplete=0
  for cmdline in "$proc_root"/[0-9]*/cmdline; do
    [ -e "$cmdline" ] || continue
    [ -r "$cmdline" ] || {
      proc_scan_incomplete=1
      continue
    }
    pid="$(basename "$(dirname "$cmdline")")"
    command_line="$(tr '\000\n\r' '   ' < "$cmdline" 2>/dev/null)" || {
      proc_scan_incomplete=1
      continue
    }
    [ -n "$command_line" ] || {
      proc_scan_incomplete=1
      continue
    }
    saw_proc_process=1
    processes="$processes$pid $command_line
"
  done
  [ "$proc_scan_incomplete" -eq 0 ] || {
    [ "$has_dcode_runtime" -eq 1 ] && emit_dcode_probe_state unverifiable
    emit_dcode_probe_state no-runtime
  }
  [ "$saw_proc_process" -eq 1 ] || {
    [ "$has_dcode_runtime" -eq 1 ] && emit_dcode_probe_state unverifiable
    emit_dcode_probe_state no-runtime
  }
}
printf '%s\n' "$processes" | detect_dcode_processes
matched=$?
[ "$matched" -eq 0 ] && emit_dcode_probe_state active
[ "$matched" -ne 1 ] && {
  [ "$has_dcode_runtime" -eq 1 ] && emit_dcode_probe_state unverifiable
  emit_dcode_probe_state no-runtime
}
[ "$has_dcode_runtime" -eq 1 ] && emit_dcode_probe_state idle
emit_dcode_probe_state no-runtime
`;

/** Escape a probe literal before embedding it in a generated regular expression. */
function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Parse a single dcode probe sentinel from sandbox command output. */
export function parseDcodeProbeState(output: string): DcodeProbeState | null {
  const escapedPrefix = escapeRegexLiteral(DCODE_PROBE_PREFIX);
  const stateAlternation = Object.values(DCODE_PROBE_STATE).map(escapeRegexLiteral).join("|");
  const matches = [...output.matchAll(new RegExp(`^${escapedPrefix}(${stateAlternation})$`, "gm"))];
  if (matches.length !== 1) return null;
  return (matches[0][1] as DcodeProbeState | undefined) ?? null;
}
