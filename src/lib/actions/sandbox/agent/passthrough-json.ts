// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isStdinTty } from "../../../core/stdin";
import {
  openClawAgentIncompleteTurnSignal,
  type OpenClawIncompleteTurnSignal,
  openClawAgentJsonProvenanceLines,
} from "../../../openclaw/agent-json-provenance";
import {
  buildOpenshellExecArgs,
  computeExitCode,
  wrapOpenClawAgentCommandWithRuntimeEnv,
} from "../exec";
import { getKnownSandboxTargetGatewayName } from "../gateway-target";
import {
  type AgentDispatchRunner,
  agentDispatchDeadlineSeconds,
  isSilentAgentDispatch,
  runAgentDispatch,
  SILENT_AGENT_DISPATCH_EXIT_CODE,
} from "./passthrough-dispatch";
import {
  writeIncompleteAgentTurnFailure,
  writeSilentAgentDispatchFailure,
  writeTimedOutAgentTurnFailure,
} from "./passthrough-help";

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
  runDispatch?: AgentDispatchRunner;
};

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

export async function runAgentJsonPassthrough(
  sandboxName: string,
  command: readonly string[],
  proc: AgentJsonPassthroughProcess = process,
  deps: AgentJsonPassthroughDeps = {},
): Promise<never> {
  const binary = (deps.getOpenshellBinary ?? defaultGetOpenshellBinary)();
  const result = await (deps.runDispatch ?? runAgentDispatch)(
    binary,
    buildOpenshellExecArgs(
      sandboxName,
      wrapOpenClawAgentCommandWithRuntimeEnv(command),
      { tty: false, timeoutSeconds: agentDispatchDeadlineSeconds(command) },
      (deps.getGatewayName ?? getKnownSandboxTargetGatewayName)(sandboxName) ?? undefined,
    ),
    {
      stdinIsTty: (deps.stdinIsTty ?? isStdinTty)(),
    },
  );
  const { stderr, stdout } = result;

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
  // reported success. An upstream non-zero code is preserved as-is. A payload
  // that declares a timeout phase gets the deadline-specific guidance instead
  // of the generic incomplete-turn text; both are the same failure to the
  // caller and share one exit code.
  const incompleteTurn = (deps.incompleteTurnSignal ?? openClawAgentIncompleteTurnSignal)(stdout);
  if (incompleteTurn && code === 0) {
    if (incompleteTurn.timeoutPhase) {
      writeTimedOutAgentTurnFailure(proc, sandboxName, incompleteTurn.timeoutPhase);
    } else {
      writeIncompleteAgentTurnFailure(proc, sandboxName, incompleteTurn.markers);
    }
    return proc.exit(INCOMPLETE_AGENT_TURN_EXIT_CODE);
  }
  return proc.exit(code);
}
