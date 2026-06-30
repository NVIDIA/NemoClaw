// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  buildHermesEnvFileBoundaryStandaloneCheck,
  SECRET_BOUNDARY_OK_MARKER,
  SECRET_BOUNDARY_REFUSED_MARKER,
  SECRET_BOUNDARY_VALIDATOR_MISSING_MARKER,
} from "../../agent/hermes-recovery-boundary";
import * as agentRuntime from "../../agent/runtime";
import { R } from "../../cli/terminal-style";
import * as registry from "../../state/registry";
import type { SandboxCommandResult } from "./process-recovery";

export type SecretBoundaryRefusalReason =
  | "raw-secret"
  | "exec-failed"
  | "validator-missing"
  | "unexpected-marker"
  | "agent-missing";

export type HermesSecretBoundaryEnforcement =
  | { refused: false }
  | { refused: true; reason: SecretBoundaryRefusalReason; stderr: string };

type SandboxExec = (
  sandboxName: string,
  command: string,
  timeout?: number,
) => SandboxCommandResult | null;

function isHermesAgent(agent: ReturnType<typeof agentRuntime.getSessionAgent>): boolean {
  return !!agent && agent.name === "hermes";
}

function printValidatorStderr(stderr: string): void {
  if (!stderr.trim()) return;
  for (const line of stderr.split(/\r?\n/)) {
    if (line.trim()) console.error(`  ${line}`);
  }
}

/**
 * Re-run the Hermes env-file secret-boundary validator against a running
 * gateway, before the probe path returns control to the caller.
 */
export function enforceHermesSecretBoundaryOnRunningGateway(
  sandboxName: string,
  agent: ReturnType<typeof agentRuntime.getSessionAgent>,
  executeSandboxExecCommand: SandboxExec,
): HermesSecretBoundaryEnforcement | null {
  const persistedAgent = registry.getSandbox(sandboxName)?.agent;
  if (persistedAgent !== "hermes") return null;
  if (!isHermesAgent(agent)) {
    console.error("");
    console.error(
      `  ${R}Hermes agent definition could not be loaded for sandbox '${sandboxName}'.${R}`,
    );
    console.error("  Refusing recovery to keep the validator-enforced boundary intact.");
    return { refused: true, reason: "agent-missing", stderr: "" };
  }
  const script = buildHermesEnvFileBoundaryStandaloneCheck();
  const result = executeSandboxExecCommand(sandboxName, script, 30000);
  if (!result) {
    console.error("");
    console.error(
      `  ${R}Secret-boundary check could not run against the Hermes gateway in '${sandboxName}'.${R}`,
    );
    console.error("  Refusing recovery to keep the validator-enforced boundary intact.");
    return { refused: true, reason: "exec-failed", stderr: "" };
  }
  const stdoutMarker = result.stdout
    .split(/\r?\n/)
    .reverse()
    .find((line) => line.trim().startsWith("SECRET_BOUNDARY_"));
  if (stdoutMarker === SECRET_BOUNDARY_REFUSED_MARKER) {
    printValidatorStderr(result.stderr);
    console.error("");
    console.error(
      `  ${R}Secret-boundary check refused recovery of Hermes gateway in '${sandboxName}'.${R}`,
    );
    console.error("  /sandbox/.hermes/.env contains raw secret-shaped values. Replace them with");
    console.error(
      "  openshell:resolve:env:<name> placeholders and re-run `nemoclaw <sandbox> recover`.",
    );
    return { refused: true, reason: "raw-secret", stderr: result.stderr };
  }
  if (stdoutMarker === SECRET_BOUNDARY_OK_MARKER) {
    return { refused: false };
  }
  if (stdoutMarker === SECRET_BOUNDARY_VALIDATOR_MISSING_MARKER) {
    printValidatorStderr(result.stderr);
    console.error("");
    console.error(
      `  ${R}Hermes secret-boundary validator missing in sandbox '${sandboxName}'.${R}`,
    );
    console.error(
      "  Refusing recovery because /sandbox/.hermes/.env could not be re-evaluated. Re-image the sandbox with a current Hermes build.",
    );
    return { refused: true, reason: "validator-missing", stderr: result.stderr };
  }
  printValidatorStderr(result.stderr);
  console.error("");
  console.error(
    `  ${R}Secret-boundary check did not complete cleanly for Hermes gateway in '${sandboxName}'.${R}`,
  );
  console.error(
    "  Refusing recovery; inspect the validator output above before re-running `nemoclaw <sandbox> recover`.",
  );
  return { refused: true, reason: "unexpected-marker", stderr: result.stderr };
}
