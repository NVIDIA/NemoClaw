// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { DockerSandboxIdentityRow } from "../../adapters/docker/inspect";
import {
  OPENSHELL_SANDBOX_ID_LABEL,
  OPENSHELL_SANDBOX_NAME_LABEL,
  OPENSHELL_SANDBOX_WORKSPACE_LABEL,
  inspectDockerSandboxNameLabeledContainers,
  resolveOpenShellSandboxOwnershipLabel,
} from "../../onboard/openshell-docker-sandbox-containers";
import { sanitizeReadinessText } from "../../readiness/sanitize";
import { getSandboxDockerRuntime, isDockerDriverSandbox } from "./docker-health";
import {
  type GatewayRestartFailureLayer,
  gatewayTerminalRepairLines,
  isGatewayTerminalRepairLayer,
} from "./gateway-restart";
import type { SecretBoundaryRefusalReason } from "./hermes-secret-boundary-recovery";

type ConnectBoundaryContext = "Probe" | "Connect";

const IDENTITY_VALUE_MAX_LENGTH = 256;

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

function describeSandboxNameLabeledContainer(
  row: DockerSandboxIdentityRow,
  ownershipLabel: string,
): string {
  const display = (value: string): string =>
    JSON.stringify(sanitizeReadinessText(value || "<none>", IDENTITY_VALUE_MAX_LENGTH));
  return (
    `${row.id.slice(0, 12)} (${ownershipLabel}=${display(row.managedBy)}, ` +
    `${OPENSHELL_SANDBOX_WORKSPACE_LABEL}=${display(row.workspace)}, ` +
    `${OPENSHELL_SANDBOX_ID_LABEL}=${display(row.sandboxId)})`
  );
}

/** Explain unmatched container identities only after Docker discovery succeeds. */
export function unmatchedSandboxContainerLines(
  sandboxName: string,
  rerunCommand: string,
): string[] | null {
  if (!isDockerDriverSandbox(sandboxName)) return null;
  const runtime = getSandboxDockerRuntime(sandboxName);
  if (runtime.containerName || runtime.containerObservationFailed) return null;
  const observation = inspectDockerSandboxNameLabeledContainers(sandboxName);
  if (observation.status !== "observed") return null;
  const { malformedRows, rows } = observation;
  if (rows.length === 0 && malformedRows === 0) return null;
  const ownership = resolveOpenShellSandboxOwnershipLabel();
  const lines = [
    `No Docker container matches sandbox '${sandboxName}' in the default OpenShell workspace.`,
    `${String(rows.length + malformedRows)} container(s) carry the '${OPENSHELL_SANDBOX_NAME_LABEL}=${sandboxName}' label:`,
    ...rows.map((row) => `  ${describeSandboxNameLabeledContainer(row, ownership.label)}`),
  ];
  if (malformedRows > 0) {
    lines.push(`Docker returned ${String(malformedRows)} malformed container identity row(s).`);
  }
  lines.push(
    "NemoClaw matches only a managed container that OpenShell named for this sandbox in the default workspace.",
    "Resolve each listed container through the workflow that owns it.",
    `Then rerun '${rerunCommand}'.`,
  );
  return lines;
}
