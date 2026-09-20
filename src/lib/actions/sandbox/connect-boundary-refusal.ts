// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type GatewayRestartFailureLayer,
  gatewayTerminalRepairLines,
  isGatewayTerminalRepairLayer,
} from "./gateway-restart";
import type { SecretBoundaryRefusalReason } from "./hermes-secret-boundary-recovery";

type ConnectBoundaryContext = "Probe" | "Connect";

/**
 * The probe path recovers quietly. Report the repair for a terminal transaction
 * or process state before generic gateway-log guidance hides it (#7801).
 * Returns false when the layer is a retryable failure, leaving the caller's
 * existing wedge diagnostics in charge.
 */
export function printGatewayTerminalRepairGuidance(
  sandboxName: string,
  layer: GatewayRestartFailureLayer | null | undefined,
): boolean {
  if (!isGatewayTerminalRepairLayer(layer)) return false;
  for (const line of gatewayTerminalRepairLines(sandboxName, layer)) {
    console.error(`  ${line}`);
  }
  return true;
}

export function exitOnSecretBoundaryRefusal(
  sandboxName: string,
  agentName: string,
  processCheck: Record<string, unknown>,
  contextLabel: ConnectBoundaryContext,
): never {
  console.error("");
  const reason =
    "secretBoundaryReason" in processCheck
      ? (processCheck.secretBoundaryReason as SecretBoundaryRefusalReason | undefined)
      : undefined;
  if (reason === "raw-secret") {
    console.error(
      `  ${contextLabel} failed: refused to confirm ${agentName} gateway in '${sandboxName}' — /sandbox/.hermes/.env contains raw secret-shaped values.`,
    );
    console.error(
      "  Replace raw secret values with openshell:resolve:env:<name> placeholders and re-run.",
    );
  } else if (reason === "exec-failed") {
    console.error(
      `  ${contextLabel} failed: could not execute the secret-boundary check for ${agentName} gateway in '${sandboxName}'.`,
    );
    console.error(
      "  Check sandbox connectivity, then re-run `nemoclaw <sandbox> recover` before connecting.",
    );
  } else if (reason === "validator-missing") {
    console.error(
      `  ${contextLabel} failed: the secret-boundary validator is missing from Hermes gateway in '${sandboxName}'.`,
    );
    console.error("  Re-image the sandbox with a current Hermes build before connecting.");
  } else if (reason === "agent-missing") {
    console.error(
      `  ${contextLabel} failed: the Hermes agent definition is unavailable for sandbox '${sandboxName}'.`,
    );
    console.error("  Repair the NemoClaw installation, then re-run recovery before connecting.");
  } else {
    console.error(
      `  ${contextLabel} failed: secret-boundary check did not complete for ${agentName} gateway in '${sandboxName}'.`,
    );
    console.error("  Inspect the validator output above and re-run `nemoclaw <sandbox> recover`.");
  }
  process.exit(1);
}
