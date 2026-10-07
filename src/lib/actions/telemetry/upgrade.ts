// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxEntry } from "../../state/registry/types";
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
    if (
      (outcome === "no_change" || outcome === "checked") &&
      previous &&
      (previous.outcome === "failed" ||
        previous.outcome === "unverified" ||
        previous.state === "partial" ||
        previous.state === "pending")
    )
      return;
    recordTelemetryTarget({ scope: "sandbox", sandboxName, ...binding, outcome, state });
  };
  return {
    recordTarget,
    recordUntargeted(excluded: readonly ReadonlySet<string>[], check: boolean): void {
      for (const sandbox of sandboxes) {
        if (excluded.some((names) => names.has(sandbox.name))) continue;
        recordTarget(sandbox.name, check ? "checked" : "no_change", "unchanged");
      }
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
