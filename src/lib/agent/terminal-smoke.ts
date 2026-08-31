// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { DCODE_MANAGED_EXEC_LAUNCHER } from "../actions/sandbox/connect-inference-route-probe";
import type { AgentDefinition } from "./defs";

type RunCaptureOpenshell = (
  args: string[],
  opts?: { ignoreError?: boolean; timeout?: number },
) => string | { status?: number | null; output?: string | null } | null;

const SMOKE_EXIT_MARKER = "NEMOCLAW_AGENT_SMOKE_EXIT:";
const SMOKE_BEGIN_MARKER = "NEMOCLAW_AGENT_SMOKE_BEGIN";

export type AgentSmokeCommandResult =
  | { ok: true }
  | { ok: false; command: string; output: string | null };

function getSmokeExitCode(output: string | null, requireManagedBoundary: boolean): number | null {
  if (!output) return null;
  const exitMatches = [...output.matchAll(/(?:^|\n)NEMOCLAW_AGENT_SMOKE_EXIT:(\d+)(?=\n|$)/g)];
  if (!requireManagedBoundary) {
    const match = exitMatches[0];
    return match ? Number.parseInt(match[1]!, 10) : null;
  }
  const beginMatches = [...output.matchAll(/(?:^|\n)NEMOCLAW_AGENT_SMOKE_BEGIN(?=\n|$)/g)];
  if (
    beginMatches.length !== 1 ||
    exitMatches.length !== 1 ||
    beginMatches[0]!.index >= exitMatches[0]!.index
  ) {
    return null;
  }
  return Number.parseInt(exitMatches[0]![1]!, 10);
}

function smokeRunner(shell: "sh -c" | "sh -lc" | "/bin/bash -lc"): string {
  return `printf '${SMOKE_BEGIN_MARKER}\\n'; ${shell} "$1"; rc=$?; printf '\\n${SMOKE_EXIT_MARKER}%s\\n' "$rc"; exit 0`;
}

/**
 * Deep Agents Code smoke commands run through the same image-baked launcher the
 * managed route probe uses, without adding another login shell (#8624). The
 * OpenShell transport still starts its own login shell before this command; see
 * NVIDIA/OpenShell#2668. Rebuilt managed DCode images reserve that shell's
 * first-match profile as a root-owned file which skips sandbox startup state
 * for the image-baked launcher. Older images can still read a sandbox-user
 * profile before these requested-command environment assignments apply, so the
 * managed runner's single ordered begin/exit pair remains diagnostic rather
 * than a trust boundary. When the caller preserves OpenShell's process status,
 * a nonzero transport exit cannot be hidden by forged marker output. Every
 * other terminal agent keeps the existing nested shells because its smoke
 * commands rely on profile-provided PATH entries and retain legacy diagnostic
 * markers.
 */
export function buildAgentSmokeArgs(
  sandboxName: string,
  agent: AgentDefinition,
  command: string,
  gatewayName?: string,
): string[] {
  if (agent.name === "langchain-deepagents-code") {
    return [
      "sandbox",
      "exec",
      "-n",
      sandboxName,
      ...(gatewayName ? ["-g", gatewayName] : []),
      "--no-tty",
      "--env",
      "HOME=/usr/local/lib/nemoclaw",
      "--env",
      "BASH_ENV=",
      "--env",
      "ENV=",
      "--",
      DCODE_MANAGED_EXEC_LAUNCHER,
      "/bin/sh",
      "-c",
      smokeRunner("sh -c"),
      "nemoclaw-agent-smoke",
      command,
    ];
  }
  // Pi's login profile enforces an exact nproc limit, which Ubuntu /bin/sh
  // cannot inspect. Keep the profile active, but run it with the Bash shell
  // the Pi image provisions for this contract.
  const shellPath = agent.name === "pi" ? "/bin/bash" : "/bin/sh";
  const commandShell = agent.name === "pi" ? "/bin/bash -lc" : "sh -lc";
  return [
    "sandbox",
    "exec",
    "-n",
    sandboxName,
    ...(gatewayName ? ["-g", gatewayName] : []),
    "--",
    shellPath,
    "-lc",
    smokeRunner(commandShell),
    "nemoclaw-agent-smoke",
    command,
  ];
}

export function runAgentSmokeCommands(
  sandboxName: string,
  agent: AgentDefinition,
  runCaptureOpenshell: RunCaptureOpenshell,
  gatewayName?: string,
): AgentSmokeCommandResult {
  // smoke_commands are shell-form commands from repository-shipped agents/*/manifest.yaml files.
  // Switch to argv-form commands before accepting custom or user-provided manifests here.
  const commands = agent.runtime?.smoke_commands ?? [];
  for (const command of commands) {
    const result = runCaptureOpenshell(
      buildAgentSmokeArgs(sandboxName, agent, command, gatewayName),
      {
        ignoreError: true,
      },
    );
    const output = typeof result === "string" ? result : (result?.output ?? null);
    const requireManagedBoundary = agent.name === "langchain-deepagents-code";
    const exitCode = getSmokeExitCode(output, requireManagedBoundary);
    const transportFailed =
      requireManagedBoundary && (typeof result === "string" || result?.status !== 0);
    if (exitCode !== 0 || transportFailed) {
      return { ok: false, command, output };
    }
  }
  return { ok: true };
}
