// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

import { resolveOpenshell } from "../../adapters/openshell/resolve";
import { buildOpenshellExecArgs } from "./exec";

const CGROUP_OOM_PROBE_SCRIPT = [
  "probe_cgroup_file() {",
  '  file="$1"',
  '  key="$2"',
  '  if [ ! -r "$file" ]; then',
  "    return 1",
  "  fi",
  "  while IFS=' ' read -r current value _rest; do",
  '    if [ "$current" = "$key" ]; then',
  '      case "$value" in ""|*[!0-9]*) exit 3 ;; esac',
  '      printf "oom_kill=%s\\nsource=%s\\n" "$value" "$file"',
  "      exit 0",
  "    fi",
  '  done < "$file"',
  "  exit 3",
  "}",
  "for f in /sys/fs/cgroup/memory.events.local /sys/fs/cgroup/memory.events; do",
  '  probe_cgroup_file "$f" oom_kill',
  "done",
  "for f in /sys/fs/cgroup/memory.oom_control /sys/fs/cgroup/memory/memory.oom_control; do",
  '  probe_cgroup_file "$f" oom_kill',
  "done",
  "exit 2",
].join("\n");

export type TerminalRuntimeOomProbeResult =
  | { kind: "ok"; oomKillCount: 0; source?: string }
  | { kind: "degraded"; oomKillCount: number; source?: string }
  | { kind: "unavailable"; detail?: string };

export type TerminalRuntimeOomProbeRunner = (
  binary: string,
  args: readonly string[],
) => {
  status: number | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  error?: Error;
};

export function parseTerminalRuntimeOomProbeOutput(
  stdout: string | Buffer | undefined,
): TerminalRuntimeOomProbeResult {
  const text = Buffer.isBuffer(stdout) ? stdout.toString("utf8") : (stdout ?? "");
  const countMatch = text.match(/^oom_kill=([^\n]+)$/m);
  if (!countMatch) return { kind: "unavailable", detail: "missing oom_kill counter" };
  if (!/^\d+$/.test(countMatch[1])) {
    return { kind: "unavailable", detail: "invalid oom_kill counter" };
  }
  const oomKillCount = Number(countMatch[1]);
  const source = text.match(/^source=(.+)$/m)?.[1];
  if (!Number.isFinite(oomKillCount)) {
    return { kind: "unavailable", detail: "invalid oom_kill counter" };
  }
  if (oomKillCount > 0) return { kind: "degraded", oomKillCount, source };
  return { kind: "ok", oomKillCount: 0, source };
}

export function probeTerminalRuntimeCgroupOom(
  sandboxName: string,
  options: {
    openshellBinary?: string | null;
    run?: TerminalRuntimeOomProbeRunner;
  } = {},
): TerminalRuntimeOomProbeResult {
  const binary = options.openshellBinary ?? resolveOpenshell();
  if (!binary) return { kind: "unavailable", detail: "openshell not found" };

  const run =
    options.run ??
    ((cmd, args) =>
      spawnSync(cmd, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }));
  const result = run(
    binary,
    buildOpenshellExecArgs(sandboxName, ["sh", "-lc", CGROUP_OOM_PROBE_SCRIPT], {
      timeoutSeconds: 5,
      tty: false,
    }),
  );
  if (result.error) return { kind: "unavailable", detail: result.error.message };
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString("utf8")
      : (result.stderr ?? "");
    return { kind: "unavailable", detail: stderr.trim() || `exit ${String(result.status)}` };
  }
  return parseTerminalRuntimeOomProbeOutput(result.stdout);
}
