// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition } from "./defs";

type RunCaptureOpenshell = (
  args: string[],
  opts?: { ignoreError?: boolean; timeout?: number },
) => string | { output?: string | null } | null;

const SMOKE_EXIT_MARKER = "NEMOCLAW_AGENT_SMOKE_EXIT:";

export type AgentSmokeCommandResult =
  | { ok: true }
  | { ok: false; command: string; output: string | null };

function getSmokeExitCode(output: string | null): number | null {
  if (!output) return null;
  const match = output.match(/(?:^|\n)NEMOCLAW_AGENT_SMOKE_EXIT:(\d+)(?:\n|$)/);
  return match ? Number.parseInt(match[1], 10) : null;
}

export function runAgentSmokeCommands(
  sandboxName: string,
  agent: AgentDefinition,
  runCaptureOpenshell: RunCaptureOpenshell,
): AgentSmokeCommandResult {
  // smoke_commands are shell-form commands from repository-shipped agents/*/manifest.yaml files.
  // Switch to argv-form commands before accepting custom or user-provided manifests here.
  const commands = agent.runtime?.smoke_commands ?? [];
  const smokeRunner = `sh -lc "$1"; rc=$?; printf '\\n${SMOKE_EXIT_MARKER}%s\\n' "$rc"; exit 0`;
  for (const command of commands) {
    const result = runCaptureOpenshell(
      [
        "sandbox",
        "exec",
        "-n",
        sandboxName,
        "--",
        "sh",
        "-lc",
        smokeRunner,
        "nemoclaw-agent-smoke",
        command,
      ],
      { ignoreError: true },
    );
    const output = typeof result === "string" ? result : (result?.output ?? null);
    const exitCode = getSmokeExitCode(output);
    if (exitCode !== 0) {
      return { ok: false, command, output };
    }
  }
  return { ok: true };
}
