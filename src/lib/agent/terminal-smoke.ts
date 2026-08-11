// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { DCODE_MANAGED_EXEC_LAUNCHER } from "../actions/sandbox/connect-inference-route-probe";
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
  const matches = [...output.matchAll(/(?:^|\n)NEMOCLAW_AGENT_SMOKE_EXIT:(\d+)(?=\n|$)/g)];
  // The managed runner emits exactly one result marker. Reject additional
  // markers from transport login-shell startup output or the smoke command
  // itself instead of allowing earlier output to forge success.
  return matches.length === 1 ? Number.parseInt(matches[0]![1], 10) : null;
}

function smokeRunner(loginShell: boolean): string {
  const shell = loginShell ? "sh -lc" : "sh -c";
  return `${shell} "$1"; rc=$?; printf '\\n${SMOKE_EXIT_MARKER}%s\\n' "$rc"; exit 0`;
}

/**
 * Deep Agents Code smoke commands run through the same image-baked launcher the
 * managed route probe uses, without adding another login shell (#8624). The
 * OpenShell transport still starts its own login shell before this command; see
 * NVIDIA/OpenShell#2668. Avoiding two nested login shells here prevents two
 * additional reads of sandbox-user startup files. Every other terminal agent
 * keeps the existing nested shells because its smoke commands rely on
 * profile-provided PATH entries.
 */
export function buildAgentSmokeArgs(
  sandboxName: string,
  agent: AgentDefinition,
  command: string,
): string[] {
  if (agent.name === "langchain-deepagents-code") {
    return [
      "sandbox",
      "exec",
      "-n",
      sandboxName,
      "--no-tty",
      "--env",
      "BASH_ENV=",
      "--env",
      "ENV=",
      "--",
      DCODE_MANAGED_EXEC_LAUNCHER,
      "/bin/sh",
      "-c",
      smokeRunner(false),
      "nemoclaw-agent-smoke",
      command,
    ];
  }
  return [
    "sandbox",
    "exec",
    "-n",
    sandboxName,
    "--",
    "sh",
    "-lc",
    smokeRunner(true),
    "nemoclaw-agent-smoke",
    command,
  ];
}

export function runAgentSmokeCommands(
  sandboxName: string,
  agent: AgentDefinition,
  runCaptureOpenshell: RunCaptureOpenshell,
): AgentSmokeCommandResult {
  // smoke_commands are shell-form commands from repository-shipped agents/*/manifest.yaml files.
  // Switch to argv-form commands before accepting custom or user-provided manifests here.
  const commands = agent.runtime?.smoke_commands ?? [];
  for (const command of commands) {
    const result = runCaptureOpenshell(buildAgentSmokeArgs(sandboxName, agent, command), {
      ignoreError: true,
    });
    const output = typeof result === "string" ? result : (result?.output ?? null);
    const exitCode = getSmokeExitCode(output);
    if (exitCode !== 0) {
      return { ok: false, command, output };
    }
  }
  return { ok: true };
}
