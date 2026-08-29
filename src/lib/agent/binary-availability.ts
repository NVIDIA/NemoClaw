// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { shellQuote } from "../runner";
import type { AgentDefinition } from "./defs";

type RunCaptureOpenshell = (
  args: string[],
  opts?: { ignoreError?: boolean; includeStderr?: boolean },
) => string | { status?: number | null; output?: string | null } | null;

export type AgentBinaryAvailability =
  | { available: true }
  | {
      available: false;
      reason: "not_found" | "not_executable" | "path_mismatch" | "unobservable";
      binaryPath?: string;
      resolvedPath?: string;
      transportStatus?: number | null;
    };

const AGENT_BINARY_CHECK_PREFIX = "NEMOCLAW_AGENT_BINARY_CHECK:";

function agentExecutableName(agent: AgentDefinition): string {
  const configuredPath = typeof agent.binary_path === "string" ? agent.binary_path.trim() : "";
  return configuredPath.split("/").filter(Boolean).pop() || agent.name;
}

export function verifyAgentBinaryAvailable(
  sandboxName: string,
  agent: AgentDefinition,
  runCaptureOpenshell: RunCaptureOpenshell,
  gatewayName?: string,
): AgentBinaryAvailability {
  const executable = agentExecutableName(agent);
  const binaryPath = typeof agent.binary_path === "string" ? agent.binary_path.trim() : "";
  // Pi's fail-closed login profile verifies nproc as well as nofile. Ubuntu's
  // /bin/sh cannot inspect nproc, so it intentionally rejects that profile
  // before the binary probe runs. Bash is the image's declared login-shell
  // boundary and can enforce both limits.
  const shellPath = agent.name === "pi" ? "/bin/bash" : "/bin/sh";
  const script = binaryPath
    ? [
        `if [ -x ${shellQuote(binaryPath)} ]; then echo ${shellQuote(`${AGENT_BINARY_CHECK_PREFIX}ok`)}; exit 0; fi`,
        `if [ -e ${shellQuote(binaryPath)} ] && [ ! -x ${shellQuote(binaryPath)} ]; then echo ${shellQuote(`${AGENT_BINARY_CHECK_PREFIX}not_executable`)}; exit 0; fi`,
        `resolved="$(command -v ${shellQuote(executable)} 2>/dev/null || true)"`,
        `[ -n "$resolved" ] || { echo ${shellQuote(`${AGENT_BINARY_CHECK_PREFIX}not_found`)}; exit 0; }`,
        `[ -x "$resolved" ] || { printf '${AGENT_BINARY_CHECK_PREFIX}not_executable:%s\\n' "$resolved"; exit 0; }`,
        `printf '${AGENT_BINARY_CHECK_PREFIX}path_mismatch:%s\\n' "$resolved"`,
      ].join("; ")
    : [
        `resolved="$(command -v ${shellQuote(executable)} 2>/dev/null || true)"`,
        `[ -n "$resolved" ] && [ -x "$resolved" ] && echo ${shellQuote(`${AGENT_BINARY_CHECK_PREFIX}ok`)} || echo ${shellQuote(`${AGENT_BINARY_CHECK_PREFIX}not_found`)}`,
      ].join("; ");
  const result = runCaptureOpenshell(
    [
      "sandbox",
      "exec",
      "-n",
      sandboxName,
      ...(gatewayName ? ["-g", gatewayName] : []),
      "--no-tty",
      "--",
      shellPath,
      "-lc",
      script,
    ],
    { ignoreError: true, includeStderr: true },
  );
  if (typeof result !== "string" && result?.status !== 0) {
    return {
      available: false,
      reason: "unobservable",
      binaryPath: binaryPath || undefined,
      ...(result ? { transportStatus: result.status ?? null } : {}),
    };
  }
  const status = (typeof result === "string" ? result : result?.output)?.trim() ?? "";
  const marker = status
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith(AGENT_BINARY_CHECK_PREFIX));
  const checkStatus = marker?.slice(AGENT_BINARY_CHECK_PREFIX.length) ?? "";
  if (checkStatus === "ok") {
    return { available: true };
  }
  if (!marker) {
    return { available: false, reason: "unobservable", binaryPath: binaryPath || undefined };
  }
  if (binaryPath && checkStatus) {
    const mismatch = checkStatus.match(/^path_mismatch:(.+)$/);
    if (mismatch) {
      return {
        available: false,
        reason: "path_mismatch",
        binaryPath,
        resolvedPath: mismatch[1].trim(),
      };
    }
    if (checkStatus.startsWith("not_executable")) {
      return { available: false, reason: "not_executable", binaryPath };
    }
  }
  return { available: false, reason: "not_found", binaryPath: binaryPath || undefined };
}

export function describeAgentBinaryFailure(
  sandboxName: string,
  agent: AgentDefinition,
  result: Exclude<AgentBinaryAvailability, { available: true }>,
): string {
  const executable = agentExecutableName(agent);
  if (result.reason === "path_mismatch") {
    return `${agent.displayName} binary '${executable}' resolves to '${result.resolvedPath}', expected '${result.binaryPath}' inside sandbox '${sandboxName}'`;
  }
  if (result.reason === "not_executable") {
    return `${agent.displayName} configured binary '${result.binaryPath}' is not executable inside sandbox '${sandboxName}'`;
  }
  if (result.reason === "unobservable") {
    const status = Object.hasOwn(result, "transportStatus")
      ? ` (OpenShell exec status ${String(result.transportStatus)})`
      : "";
    return `${agent.displayName} binary availability could not be observed inside sandbox '${sandboxName}'${status}`;
  }
  return `${agent.displayName} binary '${executable}' is missing inside sandbox '${sandboxName}'`;
}
