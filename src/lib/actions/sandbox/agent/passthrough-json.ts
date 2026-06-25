// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from "node:child_process";

import { openClawAgentJsonProvenanceLines } from "../../../openclaw/agent-json-provenance";
import { buildOpenshellExecArgs, computeExitCode } from "../exec";

const AGENT_JSON_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export type AgentJsonPassthroughProcess = {
  exit(code: number): never;
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
};

export type AgentJsonPassthroughDeps = {
  getOpenshellBinary?: () => string;
  provenanceLines?: (raw: string) => string[];
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

function defaultGetOpenshellBinary(): string {
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
    buildOpenshellExecArgs(sandboxName, command, { tty: false }),
    {
      encoding: "utf-8",
      maxBuffer: AGENT_JSON_MAX_BUFFER_BYTES,
      stdio: ["inherit", "pipe", "pipe"],
    },
  );
  const stdout = text(result.stdout);
  const stderr = text(result.stderr);
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
  return proc.exit(code);
}
