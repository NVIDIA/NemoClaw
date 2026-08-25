// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { bestEffortForwardStopForSandbox } from "./forward-cleanup";
import { parseForwardList, type ForwardEntry } from "../state/sandbox-session";

export interface DashboardForwardOptions {
  rollbackSandboxOnFailure?: boolean;
  preserveSandboxPorts?: Array<number | string>;
  allowPortReallocation?: boolean;
}

export type PreservedDashboardForward = Pick<ForwardEntry, "bind" | "port" | "sandboxName">;

function isExactLiveForward(
  entries: readonly ForwardEntry[],
  expected: PreservedDashboardForward,
): boolean {
  return entries.some(
    (entry) =>
      entry.sandboxName === expected.sandboxName &&
      entry.bind === expected.bind &&
      entry.port === expected.port &&
      entry.status.includes("running"),
  );
}

/** Snapshot only live sibling forwards; pre-existing dead rows are not recovery authority. */
export function captureLiveSiblingDashboardForwards(
  output: string | null | undefined,
  sandboxName: string,
): PreservedDashboardForward[] {
  return parseForwardList(output)
    .filter((entry) => entry.sandboxName !== sandboxName && entry.status.includes("running"))
    .map(({ bind, port, sandboxName: owner }) => ({ bind, port, sandboxName: owner }));
}

/** Restore siblings lost during one forward start and prove the new owner remains live. */
export function reconcileSiblingDashboardForwards(input: {
  readonly preserved: readonly PreservedDashboardForward[];
  readonly target: PreservedDashboardForward;
  readonly fetch: () => string | null;
  readonly restore: (forward: PreservedDashboardForward) => {
    readonly ok: boolean;
    readonly diagnostic?: string;
  };
}): { readonly ok: true } | { readonly ok: false; readonly diagnostic: string } {
  for (const forward of input.preserved) {
    const snapshot = input.fetch();
    if (snapshot === null) {
      return { ok: false, diagnostic: "OpenShell forward ownership became unavailable." };
    }
    if (isExactLiveForward(parseForwardList(snapshot), forward)) continue;
    const restored = input.restore(forward);
    if (!restored.ok) {
      return {
        ok: false,
        diagnostic: `Could not restore ${forward.sandboxName}:${forward.port}: ${restored.diagnostic ?? "forward start failed"}`,
      };
    }
  }
  const finalSnapshot = input.fetch();
  if (finalSnapshot === null) {
    return { ok: false, diagnostic: "OpenShell forward ownership became unavailable." };
  }
  const finalEntries = parseForwardList(finalSnapshot);
  const missing = [...input.preserved, input.target].find(
    (forward) => !isExactLiveForward(finalEntries, forward),
  );
  return missing
    ? {
        ok: false,
        diagnostic: `Forward ${missing.sandboxName}:${missing.port} did not remain live after sibling reconciliation.`,
      }
    : { ok: true };
}

export function normalizeDashboardForwardOptions(options: DashboardForwardOptions = {}): {
  rollbackSandboxOnFailure: boolean;
  preservedPorts: Set<string>;
  allowPortReallocation: boolean;
} {
  return {
    rollbackSandboxOnFailure: options.rollbackSandboxOnFailure === true,
    preservedPorts: new Set((options.preserveSandboxPorts ?? []).map((port) => String(port))),
    allowPortReallocation: options.allowPortReallocation !== false,
  };
}

export function createSandboxForwardStopper(deps: {
  runOpenshell: Parameters<typeof bestEffortForwardStopForSandbox>[0];
  runCaptureOpenshell: (args: string[], opts?: Record<string, unknown>) => string | null;
  sandboxName: string;
}): (port: string | number) => ReturnType<typeof bestEffortForwardStopForSandbox> | null {
  const stoppedPorts = new Set<string>();
  return (port: string | number) => {
    const portKey = String(port);
    if (stoppedPorts.has(portKey)) return null;
    const result = bestEffortForwardStopForSandbox(
      deps.runOpenshell,
      (args, opts) => deps.runCaptureOpenshell(args, opts),
      port,
      deps.sandboxName,
    );
    if (result === "stopped" || result === "no-entry") {
      stoppedPorts.add(portKey);
    }
    return result;
  };
}
