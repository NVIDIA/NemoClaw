// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SpawnSyncOptions, type SpawnSyncReturns, spawnSync } from "node:child_process";

import { isStdinTty } from "../../../core/stdin";
import {
  openClawAgentIncompleteTurnSignal,
  type OpenClawIncompleteTurnSignal,
  openClawAgentJsonProvenanceLines,
} from "../../../openclaw/agent-json-provenance";
import { buildOpenshellExecArgs, computeExitCode, wrapExecCommandWithRuntimeEnv } from "../exec";
import { getKnownSandboxTargetGatewayName } from "../gateway-target";
import {
  agentDispatchStdio,
  isSilentAgentDispatch,
  SILENT_AGENT_DISPATCH_EXIT_CODE,
} from "./passthrough-dispatch";
import {
  writeIncompleteAgentTurnFailure,
  writeSilentAgentDispatchFailure,
} from "./passthrough-help";

const AGENT_JSON_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/** Exit code for a turn the payload itself marks incomplete or abandoned. */
export const INCOMPLETE_AGENT_TURN_EXIT_CODE = 1;

export type AgentJsonPassthroughProcess = {
  exit(code: number): never;
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
};

export type AgentJsonPassthroughDeps = {
  getOpenshellBinary?: () => string;
  getGatewayName?: (sandboxName: string) => string | null;
  stdinIsTty?: () => boolean;
  provenanceLines?: (raw: string) => string[];
  incompleteTurnSignal?: (raw: string) => OpenClawIncompleteTurnSignal | null;
  spawnSync?: (
    command: string,
    args: readonly string[],
    options: SpawnSyncOptions,
  ) => SpawnSyncReturns<string | Buffer>;
};

function text(value: string | Buffer | null | undefined): string {
  if (Buffer.isBuffer(value)) return value.toString("utf-8");
  return typeof value === "string" ? value : "";
}

export function defaultGetOpenshellBinary(): string {
  // Lazy require keeps this module unit-testable under Vitest's TS loader; the
  // OpenShell runtime imports runner/platform modules that only exist in built
  // CLI layouts.
  const runtime =
    require("../../../adapters/openshell/runtime") as typeof import("../../../adapters/openshell/runtime");
  return runtime.getOpenshellBinary();
}

function writeProvenanceBlock(
  proc: AgentJsonPassthroughProcess,
  stderr: string,
  lines: readonly string[],
): void {
  if (lines.length === 0) return;
  proc.stderr.write(`${stderr && !stderr.endsWith("\n") ? "\n" : ""}${lines.join("\n")}\n`);
}

export function runAgentJsonPassthrough(
  sandboxName: string,
  command: readonly string[],
  proc: AgentJsonPassthroughProcess = process,
  deps: AgentJsonPassthroughDeps = {},
): never {
  const binary = (deps.getOpenshellBinary ?? defaultGetOpenshellBinary)();
  const spawnSyncImpl = deps.spawnSync ?? spawnSync;
  const result = spawnSyncImpl(
    binary,
    buildOpenshellExecArgs(
      sandboxName,
      wrapExecCommandWithRuntimeEnv(command),
      { tty: false },
      (deps.getGatewayName ?? getKnownSandboxTargetGatewayName)(sandboxName) ?? undefined,
    ),
    {
      encoding: "utf-8",
      maxBuffer: AGENT_JSON_MAX_BUFFER_BYTES,
      stdio: agentDispatchStdio((deps.stdinIsTty ?? isStdinTty)()),
    },
  );
  const stdout = text(result.stdout);
  const stderr = text(result.stderr);

  // Ahead of the stdout write so machine-readable stdout stays byte-empty and
  // no provenance line is appended for a turn that never ran.
  if (isSilentAgentDispatch(result, stdout, stderr)) {
    writeSilentAgentDispatchFailure(proc, sandboxName, command);
    return proc.exit(SILENT_AGENT_DISPATCH_EXIT_CODE);
  }

  if (stdout) proc.stdout.write(stdout);
  if (stderr) proc.stderr.write(stderr);

  try {
    writeProvenanceBlock(
      proc,
      stderr,
      (deps.provenanceLines ?? openClawAgentJsonProvenanceLines)(stdout),
    );
  } catch {
    writeProvenanceBlock(proc, stderr, [
      "[openclaw provenance] skipped provenance extraction after parser failure.",
    ]);
  }

  const { code, errorMessage } = computeExitCode(result);
  if (errorMessage) {
    proc.stderr.write(`  Failed to invoke openshell: ${errorMessage}\n`);
    proc.stderr.write("  Ensure 'openshell' is installed and on PATH.\n");
  }

  // Last, so the partial trace and its provenance are already on the wire: a
  // turn the payload marks incomplete must not exit 0 just because the envelope
  // reported success. An upstream non-zero code is preserved as-is.
  const incompleteTurn = (deps.incompleteTurnSignal ?? openClawAgentIncompleteTurnSignal)(stdout);
  if (incompleteTurn && code === 0) {
    writeIncompleteAgentTurnFailure(proc, sandboxName, incompleteTurn.markers);
    return proc.exit(INCOMPLETE_AGENT_TURN_EXIT_CODE);
  }
  return proc.exit(code);
}
