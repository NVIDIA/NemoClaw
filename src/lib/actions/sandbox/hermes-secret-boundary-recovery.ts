// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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

type GatewaySupervisorRequest = (
  sandboxName: string,
  action: "restart" | "recover" | "probe",
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
 * Re-run the Hermes env-file secret boundary through the authenticated PID 1
 * control path before a healthy recover returns. PID 1 owns the exact gateway
 * child, so a raw-secret refusal can stop the listener without regex matching
 * or a second process racing the supervisor.
 */
export function enforceHermesSecretBoundaryOnRunningGateway(
  sandboxName: string,
  agent: ReturnType<typeof agentRuntime.getSessionAgent>,
  requestGatewaySupervisorAction: GatewaySupervisorRequest,
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
  const result = requestGatewaySupervisorAction(sandboxName, "recover");
  if (!result) {
    console.error("");
    console.error(
      `  ${R}Secret-boundary check could not run against the Hermes gateway in '${sandboxName}'.${R}`,
    );
    console.error("  Refusing recovery to keep the validator-enforced boundary intact.");
    return { refused: true, reason: "exec-failed", stderr: "" };
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.status === 0 && result.stdout.includes("GATEWAY_PID=")) {
    return { refused: false };
  }
  if (output.includes("SECRET_BOUNDARY_REFUSED")) {
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
  if (output.includes("SECRET_BOUNDARY_VALIDATOR_MISSING")) {
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
