// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SecretBoundaryRefusalReason } from "./hermes-secret-boundary-recovery";
import {
  hermesMcpReconciliationRemediationLines,
  sanitizeHermesMcpReconciliationDetail,
} from "./mcp-bridge-hermes-reconciliation";

type ConnectBoundaryContext = "Probe" | "Connect";

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
