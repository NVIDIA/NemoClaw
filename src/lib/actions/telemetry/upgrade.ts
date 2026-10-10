// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxEntry } from "../../state/registry/types";
import { resolveSandboxGatewayName } from "../../onboard/gateway-binding/identity";
import {
  readSandboxTelemetryEntry,
  updateSandboxTelemetrySelections,
} from "../../state/registry/telemetry-selections";
import { restoreAppliedPolicySelection } from "../../policy/gateway-state";
import {
  finishTelemetryOperation,
  getTelemetryTarget,
  isTelemetryOperationActive,
  recordTelemetryTarget,
  setTelemetryOutcome,
} from "./operation";

export { finishTelemetryOperation, setTelemetryOutcome };

/** Bind anonymous bulk results to the private registry owner without weakening earlier receipts. */
export function createUpgradeTelemetry(
  sandboxes: readonly SandboxEntry[],
  resolveGateway: (sandbox: SandboxEntry) => string,
) {
  function getTargetBinding(sandboxName: string) {
    if (!isTelemetryOperationActive()) return null;
    const owner = sandboxes.find((sandbox) => sandbox.name === sandboxName);
    if (!owner) return null;
    try {
      return { gatewayName: resolveGateway(owner) };
    } catch {
      return null;
    }
  }
  const recordTarget = (
    sandboxName: string,
    outcome: Parameters<typeof recordTelemetryTarget>[0]["outcome"],
    state: Parameters<typeof recordTelemetryTarget>[0]["state"],
  ): void => {
    const binding = getTargetBinding(sandboxName);
    if (!binding) return;
    const previous = getTelemetryTarget(sandboxName, binding.gatewayName);
    if (outcome === "failed" && previous?.outcome === "failed") return;
    if (
      (outcome === "no_change" || outcome === "checked") &&
      previous &&
      (previous.outcome === "failed" ||
        previous.outcome === "unverified" ||
        previous.state === "applied" ||
        previous.state === "partial" ||
        previous.state === "pending")
    )
      return;
    recordTelemetryTarget({
      scope: "sandbox",
      sandboxName,
      ...binding,
      outcome,
      state:
        outcome === "failed" &&
        state === "unavailable" &&
        previous &&
        (previous.state === "applied" ||
          previous.state === "pending" ||
          previous.state === "partial")
          ? "partial"
          : state,
    });
  };
  return {
    recordTarget,
    recordUntargeted(excluded: readonly ReadonlySet<string>[], check: boolean): void {
      for (const sandbox of sandboxes) {
        if (excluded.some((names) => names.has(sandbox.name))) continue;
        recordTarget(sandbox.name, check ? "checked" : "no_change", "unchanged");
      }
    },
    recordCheckedTargets(unavailable: ReadonlySet<string>): void {
      for (const sandbox of sandboxes)
        recordTarget(
          sandbox.name,
          "checked",
          unavailable.has(sandbox.name) ? "unavailable" : "unchanged",
        );
    },
    verifyTarget(sandboxName: string): boolean {
      if (!isTelemetryOperationActive()) return true;
      const binding = getTargetBinding(sandboxName);
      const receipt = binding && getTelemetryTarget(sandboxName, binding.gatewayName);
      if (!receipt) recordTarget(sandboxName, "unverified", "unavailable");
      return Boolean(
        receipt &&
        (receipt.outcome === "completed" || receipt.outcome === "no_change") &&
        (receipt.state === "applied" || receipt.state === "unchanged"),
      );
    },
    finish(failed: number, unverified: number, skipped: number, applied: number): void {
      if (failed > 0) setTelemetryOutcome("failed", "partial");
      else if (unverified > 0) setTelemetryOutcome("unverified", "partial");
      else if (skipped > 0) setTelemetryOutcome("skipped", applied > 0 ? "partial" : "unchanged");
      else setTelemetryOutcome("completed", "applied");
    },
  };
}

/** Clear pending configuration only after verified rebuild completion and cleanup. */
export async function recordRebuildCompletion(
  sandboxName: string,
  accepted: boolean,
  cleanupOnly: boolean,
  previousEntry?: SandboxEntry,
  mutated = false,
): Promise<void> {
  let metadataComplete = true;
  let modelSelectionVerified = true;
  const metadataErrors: NonNullable<Parameters<typeof recordTelemetryTarget>[0]["metadataErrors"]> =
    [];
  if (accepted && !cleanupOnly) {
    try {
      if (isTelemetryOperationActive()) {
        const { verifySelectedAgentsManifest } =
          await import("../sandbox/agents/telemetry-verification");
        const selection = await verifySelectedAgentsManifest(sandboxName, undefined, previousEntry);
        metadataErrors.push(...(selection.metadataErrors ?? []));
        modelSelectionVerified = selection.verified;
        metadataComplete = selection.status !== "collection_error";
        if (!restoreAppliedPolicySelection(sandboxName, previousEntry)) {
          metadataComplete = false;
          metadataErrors.push({ category: "policy_tier" });
        }
      }
      const entry = modelSelectionVerified ? readSandboxTelemetryEntry(sandboxName) : null;
      if (entry?.configurationApplyPending === true) {
        let cleared = false;
        try {
          cleared = updateSandboxTelemetrySelections(entry, {
            configurationApplyPending: undefined,
          });
        } catch {
          /* Native completion remains valid when optional metadata cannot be saved. */
        }
        if (!cleared) {
          metadataComplete = false;
          metadataErrors.push({ category: "configuration_apply_state" });
        }
      }
    } catch {
      metadataComplete = false;
    }
  }
  let outcome: Parameters<typeof recordTelemetryTarget>[0]["outcome"] = "failed";
  if (accepted) outcome = cleanupOnly ? "no_change" : "completed";
  if (accepted && !modelSelectionVerified) outcome = "unverified";
  const state = accepted && modelSelectionVerified ? "applied" : mutated ? "partial" : "unchanged";
  let gatewayName: string | undefined;
  try {
    const entry = previousEntry ?? readSandboxTelemetryEntry(sandboxName);
    if (entry) gatewayName = resolveSandboxGatewayName(entry);
  } catch {
    /* Telemetry remains non-fatal when the gateway binding cannot be resolved. */
  }
  recordTelemetryTarget({
    scope: "sandbox",
    sandboxName,
    ...(gatewayName ? { gatewayName } : {}),
    outcome,
    state,
    verificationStatus: metadataComplete ? "reported" : "collection_error",
    ...(metadataErrors.length ? { metadataErrors } : {}),
  });
}
