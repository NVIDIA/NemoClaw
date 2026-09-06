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
  gatewayIntegrityRepairLines,
  isGatewayIntegrityRepairLayer,
} from "./gateway-restart";
import type { SecretBoundaryRefusalReason } from "./hermes-secret-boundary-recovery";
import {
  hermesMcpReconciliationRemediationLines,
  sanitizeHermesMcpReconciliationDetail,
} from "./mcp-bridge-hermes-reconciliation";

type ConnectBoundaryContext = "Probe" | "Connect";

const IDENTITY_VALUE_MAX_LENGTH = 256;

/**
 * A managed recovery that failed on a deterministic integrity refusal cannot be
 * retried: every relaunch re-reads the same drifted protected configuration.
 * The probe path recovers quietly, so without this the operator only sees the
 * generic "check the gateway log" and never learns the supported repair (#7801).
 * Returns false when the layer is a retryable failure, leaving the caller's
 * existing wedge diagnostics in charge.
 */
export function printGatewayIntegrityRepairGuidance(
  sandboxName: string,
  layer: GatewayRestartFailureLayer | null | undefined,
): boolean {
  if (!isGatewayIntegrityRepairLayer(layer)) return false;
  for (const line of gatewayIntegrityRepairLines(sandboxName, layer)) {
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

export function exitOnMcpReconciliationRefusal(
  sandboxName: string,
  agentName: string,
  processCheck: Record<string, unknown>,
  contextLabel: ConnectBoundaryContext,
): never {
  const detail =
    "mcpReconciliationReason" in processCheck
      ? String(processCheck.mcpReconciliationReason)
      : "the effective Hermes MCP configuration does not match persisted managed intent";
  const sanitizedDetail = sanitizeHermesMcpReconciliationDetail(detail);
  console.error("");
  console.error(
    `  ${contextLabel} failed: refused to confirm ${agentName} gateway in '${sandboxName}' — ${sanitizedDetail}.`,
  );
  for (const line of hermesMcpReconciliationRemediationLines(sandboxName)) {
    console.error(`  ${line}`);
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

/**
 * Explain a terminal sandbox phase that follows from an unmatched container
 * identity rather than from a crashed sandbox. NemoClaw matches a docker-driver
 * sandbox only to a managed container that OpenShell named for it in the
 * default workspace, so a container that borrows the sandbox-name label with
 * another workspace is refused without any runtime fault (#10869). Returns null
 * when the sandbox is not on the docker driver, when a container matched, when
 * Docker could not be inspected, or when no container carries the label; the
 * caller then keeps its runtime-fault guidance.
 */
export function unmatchedSandboxContainerLines(
  sandboxName: string,
  rerunCommand: string,
): string[] | null {
  if (!isDockerDriverSandbox(sandboxName) || getSandboxDockerRuntime(sandboxName).containerName) {
    return null;
  }
  const observation = inspectDockerSandboxNameLabeledContainers(sandboxName);
  if (observation.status !== "observed") return null;
  const { malformedRows, rows } = observation;
  if (rows.length === 0 && malformedRows === 0) return null;
  const ownership = resolveOpenShellSandboxOwnershipLabel();
  const lines = [
    `No Docker container matches sandbox '${sandboxName}' in the default OpenShell workspace.`,
    `${String(rows.length)} container(s) carry the '${OPENSHELL_SANDBOX_NAME_LABEL}=${sandboxName}' label:`,
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
