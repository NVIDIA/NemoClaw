// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  OPENSHELL_SANDBOX_WORKSPACE_LABEL,
  type SandboxIdentityProbe,
  type SandboxNameLabeledContainer,
} from "../../adapters/docker/sandbox-identity";
import {
  OPENSHELL_MANAGED_BY_LABEL,
  OPENSHELL_MANAGED_BY_VALUE,
  OPENSHELL_SANDBOX_ID_LABEL,
  OPENSHELL_SANDBOX_NAME_LABEL,
} from "../../onboard/openshell-docker-sandbox-containers";

export {
  OPENSHELL_SANDBOX_WORKSPACE_LABEL,
  probeSandboxNameContainers,
  type SandboxIdentityProbe,
  type SandboxNameLabeledContainer,
} from "../../adapters/docker/sandbox-identity";

/**
 * Verdict for whether the `sandbox-name` a destroy targets maps to a single
 * unambiguous managed container identity.
 *
 * - `clear` — no labeled container, or exactly one managed identity. Destroy
 *   may proceed.
 * - `ambiguous` — a container claims the target `sandbox-name` but is not the
 *   single managed sandbox (a foreign container carrying the label, or managed
 *   containers spanning more than one workspace / sandbox-id). Destroy must
 *   fail closed so it never removes the real sandbox behind an impostor's name.
 * - `probe-failed` — Docker could not be queried, so ambiguity can neither be
 *   proven nor ruled out. The action fails closed on this: the lower layer can
 *   still delete through the gateway, so an unverifiable identity must not be
 *   allowed to proceed (#8999).
 */
export type DestroyContainerIdentityVerdict =
  | { status: "clear" }
  | { status: "probe-failed"; detail: string }
  | {
      status: "ambiguous";
      sandboxName: string;
      reason: string;
      foreign: SandboxNameLabeledContainer[];
      managed: SandboxNameLabeledContainer[];
    };

/**
 * Classify the containers a Docker probe found for a target `sandbox-name` and
 * decide whether the destroy resolves to a single managed identity.
 *
 * Pure over an explicit probe result — the Docker call and its output parsing
 * live in the `probeSandboxNameContainers` adapter, so this function makes only
 * the identity decision and is trivially dependency-free to test. A genuine
 * managed sandbox carries `managed-by=openshell` and one consistent
 * `sandbox-workspace` / `sandbox-id`; anything else sharing the name makes the
 * identity ambiguous.
 */
export function classifyDestroyContainerIdentity(
  sandboxName: string,
  probe: SandboxIdentityProbe,
): DestroyContainerIdentityVerdict {
  if (probe.status === "probe-failed") {
    return { status: "probe-failed", detail: probe.detail };
  }

  const rows = probe.rows;
  if (rows.length === 0) return { status: "clear" };

  const managed = rows.filter((row) => row.managedBy === OPENSHELL_MANAGED_BY_VALUE);
  const foreign = rows.filter((row) => row.managedBy !== OPENSHELL_MANAGED_BY_VALUE);

  if (foreign.length > 0) {
    return {
      status: "ambiguous",
      sandboxName,
      reason:
        `${String(foreign.length)} container(s) carry the '${OPENSHELL_SANDBOX_NAME_LABEL}=` +
        `${sandboxName}' label without the '${OPENSHELL_MANAGED_BY_LABEL}=` +
        `${OPENSHELL_MANAGED_BY_VALUE}' marker`,
      foreign,
      managed,
    };
  }

  const managedMissingLabels = managed.filter((row) => !row.workspace || !row.sandboxId);
  if (managedMissingLabels.length > 0) {
    return {
      status: "ambiguous",
      sandboxName,
      reason:
        `${String(managedMissingLabels.length)} managed container(s) for '${sandboxName}' are ` +
        `missing a required '${OPENSHELL_SANDBOX_WORKSPACE_LABEL}' or '${OPENSHELL_SANDBOX_ID_LABEL}' ` +
        "label, so the identity cannot be proven",
      foreign,
      managed,
    };
  }

  const workspaces = new Set(managed.map((row) => row.workspace));
  const sandboxIds = new Set(managed.map((row) => row.sandboxId));
  if (workspaces.size > 1 || sandboxIds.size > 1) {
    return {
      status: "ambiguous",
      sandboxName,
      reason:
        `managed containers for '${sandboxName}' span ${String(workspaces.size)} workspace(s) ` +
        `and ${String(sandboxIds.size)} sandbox-id(s)`,
      foreign,
      managed,
    };
  }

  return { status: "clear" };
}

/** Human-readable lines describing an ambiguous-identity refusal. */
export function formatAmbiguousDestroyIdentity(
  verdict: Extract<DestroyContainerIdentityVerdict, { status: "ambiguous" }>,
  cliName: string,
): string[] {
  const describe = (row: SandboxNameLabeledContainer): string =>
    `${row.id.slice(0, 12)} (${OPENSHELL_MANAGED_BY_LABEL}=${row.managedBy || "<none>"}, ` +
    `${OPENSHELL_SANDBOX_WORKSPACE_LABEL}=${row.workspace || "<none>"}, ` +
    `${OPENSHELL_SANDBOX_ID_LABEL}=${row.sandboxId || "<none>"})`;
  const lines = [
    `Refusing to destroy sandbox '${verdict.sandboxName}': ${verdict.reason}.`,
    "Destroy fails closed because the sandbox-name no longer identifies a single container, " +
      "so it cannot prove which container it would remove.",
  ];
  for (const row of verdict.foreign) {
    lines.push(`  Unexpected container: ${describe(row)}`);
  }
  for (const row of verdict.managed) {
    lines.push(`  Managed sandbox container: ${describe(row)}`);
  }
  lines.push(
    "Inspect, remove, or relabel the conflicting container(s), then re-run " +
      `'${cliName} ${verdict.sandboxName} destroy --yes'.`,
  );
  return lines;
}
