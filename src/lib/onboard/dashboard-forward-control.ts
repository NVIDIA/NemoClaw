// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { bestEffortForwardStopForSandbox } from "./forward-cleanup";
import { load as loadRegistry } from "../state/registry/persistence";
import { isPublishedSandboxRegistration } from "../state/registry/route-reservation";
import type { SandboxEntry } from "../state/registry/types";
import { parseForwardList, type ForwardEntry } from "../state/sandbox-session";

const MAX_PRESERVED_SIBLING_FORWARDS = 128;

type DashboardForwardTarget = Pick<ForwardEntry, "bind" | "port" | "sandboxName">;

export type PreservedDashboardForward = DashboardForwardTarget & {
  readonly gatewayName: string;
  readonly lifecycleGeneration: string;
  readonly lifecycleLiveIdentityFingerprint: string;
  readonly openshellDriver: string;
  readonly pid: number;
};

export const dashboardForwardControlRuntime = {
  getSandbox: (name: string): SandboxEntry | null => loadRegistry().sandboxes[name] ?? null,
};

export interface DashboardForwardOptions {
  rollbackSandboxOnFailure?: boolean;
  gatewayName?: string;
  preserveSandboxPorts?: Array<number | string>;
  /** Exact siblings observed live before a long sandbox create/build begins. */
  preservedSiblingForwards?: readonly PreservedDashboardForward[];
  allowPortReallocation?: boolean;
  revalidateSandboxIdentity?: (operation: string) => void;
  onForwardStarted?: (port: number) => void;
}

function isExactLiveForward(
  entries: readonly ForwardEntry[],
  expected: DashboardForwardTarget,
): boolean {
  return entries.some(
    (entry) =>
      entry.sandboxName === expected.sandboxName &&
      entry.bind === expected.bind &&
      entry.port === expected.port &&
      entry.status === "running",
  );
}

function canonicalForwardEntry(entry: ForwardEntry): entry is ForwardEntry & { pid: number } {
  const port = Number(entry.port);
  return (
    (entry.bind === "127.0.0.1" || entry.bind === "0.0.0.0") &&
    Number.isInteger(port) &&
    port >= 1 &&
    port <= 65_535 &&
    String(port) === entry.port &&
    Number.isSafeInteger(entry.pid) &&
    (entry.pid ?? 0) > 0 &&
    entry.status === "running"
  );
}

function canonicalPreservedForward(forward: PreservedDashboardForward): boolean {
  const port = Number(forward.port);
  return (
    forward.sandboxName.length > 0 &&
    forward.sandboxName === forward.sandboxName.trim() &&
    (forward.bind === "127.0.0.1" || forward.bind === "0.0.0.0") &&
    Number.isInteger(port) &&
    port >= 1 &&
    port <= 65_535 &&
    String(port) === forward.port &&
    Number.isSafeInteger(forward.pid) &&
    forward.pid > 0 &&
    /^[A-Za-z0-9._:-]{1,128}$/u.test(forward.gatewayName) &&
    /^[A-Za-z0-9._:/=+-]{1,512}$/u.test(forward.lifecycleGeneration) &&
    /^[a-f0-9]{64}$/u.test(forward.lifecycleLiveIdentityFingerprint) &&
    /^[a-z][a-z0-9-]{0,62}$/u.test(forward.openshellDriver)
  );
}

function preservedForward(
  entry: ForwardEntry & { pid: number },
  owner: SandboxEntry | null | undefined,
): PreservedDashboardForward | null {
  if (
    !owner ||
    !isPublishedSandboxRegistration(owner) ||
    owner.name !== entry.sandboxName ||
    typeof owner.gatewayName !== "string" ||
    typeof owner.lifecycleGeneration !== "string" ||
    typeof owner.lifecycleLiveIdentityFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(owner.lifecycleLiveIdentityFingerprint) ||
    typeof owner.openshellDriver !== "string"
  ) {
    return null;
  }
  return {
    bind: entry.bind,
    gatewayName: owner.gatewayName,
    lifecycleGeneration: owner.lifecycleGeneration,
    lifecycleLiveIdentityFingerprint: owner.lifecycleLiveIdentityFingerprint,
    openshellDriver: owner.openshellDriver,
    pid: entry.pid,
    port: entry.port,
    sandboxName: entry.sandboxName,
  };
}

/** Snapshot only live sibling forwards; pre-existing dead rows are not recovery authority. */
export function captureLiveSiblingDashboardForwards(
  output: string | null | undefined,
  sandboxName: string,
  getSandbox: (
    name: string,
  ) => SandboxEntry | null | undefined = dashboardForwardControlRuntime.getSandbox,
): PreservedDashboardForward[] {
  const captured = parseForwardList(output)
    .filter(canonicalForwardEntry)
    .filter((entry) => entry.sandboxName !== sandboxName)
    .flatMap((entry) => preservedForward(entry, getSandbox(entry.sandboxName)) ?? []);
  if (captured.length > MAX_PRESERVED_SIBLING_FORWARDS) {
    throw new Error("Live sibling dashboard-forward snapshot exceeds its bound.");
  }
  return captured;
}

/** Revalidate the exact published sandbox owner and original forward process before mutation. */
export function revalidatePreservedDashboardForward(
  forward: PreservedDashboardForward,
  output: string | null,
  getSandbox: (
    name: string,
  ) => SandboxEntry | null | undefined = dashboardForwardControlRuntime.getSandbox,
): boolean {
  if (!revalidatePreservedDashboardOwner(forward, getSandbox)) return false;
  return parseForwardList(output).some(
    (entry) =>
      entry.sandboxName === forward.sandboxName &&
      entry.bind === forward.bind &&
      entry.port === forward.port &&
      entry.pid === forward.pid,
  );
}

export function revalidatePreservedDashboardOwner(
  forward: PreservedDashboardForward,
  getSandbox: (
    name: string,
  ) => SandboxEntry | null | undefined = dashboardForwardControlRuntime.getSandbox,
): boolean {
  if (!canonicalPreservedForward(forward)) return false;
  const owner = getSandbox(forward.sandboxName);
  if (!owner) return false;
  return (
    isPublishedSandboxRegistration(owner) &&
    owner.gatewayName === forward.gatewayName &&
    owner.lifecycleGeneration === forward.lifecycleGeneration &&
    owner.lifecycleLiveIdentityFingerprint === forward.lifecycleLiveIdentityFingerprint &&
    owner.openshellDriver === forward.openshellDriver
  );
}

/** Combine pre-create and finalization observations without duplicating one exact forward. */
export function mergePreservedDashboardForwards(
  ...groups: readonly (readonly PreservedDashboardForward[])[]
): PreservedDashboardForward[] {
  const merged = new Map<string, PreservedDashboardForward>();
  for (const group of groups) {
    for (const forward of group) {
      if (!canonicalPreservedForward(forward)) {
        throw new Error("Preserved sibling dashboard-forward authority is invalid.");
      }
      const key = `${forward.sandboxName}\0${forward.lifecycleGeneration}\0${forward.lifecycleLiveIdentityFingerprint}\0${forward.bind}\0${forward.port}\0${String(forward.pid)}`;
      if (!merged.has(key)) {
        if (merged.size >= MAX_PRESERVED_SIBLING_FORWARDS) {
          throw new Error("Merged sibling dashboard-forward snapshot exceeds its bound.");
        }
        merged.set(key, forward);
      }
    }
  }
  return [...merged.values()];
}

/** Restore siblings lost during one forward start and prove the new owner remains live. */
export function reconcileSiblingDashboardForwards(input: {
  readonly preserved: readonly PreservedDashboardForward[];
  readonly target: DashboardForwardTarget;
  readonly fetch: () => string | null;
  readonly revalidateLive: (forward: PreservedDashboardForward, snapshot: string) => boolean;
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
    if (isExactLiveForward(parseForwardList(snapshot), forward)) {
      if (!input.revalidateLive(forward, snapshot)) {
        return {
          ok: false,
          diagnostic: `Forward ${forward.sandboxName}:${forward.port} changed live ownership.`,
        };
      }
      continue;
    }
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
  preservedSiblingForwards: readonly PreservedDashboardForward[];
  allowPortReallocation: boolean;
} {
  return {
    rollbackSandboxOnFailure: options.rollbackSandboxOnFailure === true,
    preservedPorts: new Set((options.preserveSandboxPorts ?? []).map((port) => String(port))),
    preservedSiblingForwards: options.preservedSiblingForwards ?? [],
    allowPortReallocation: options.allowPortReallocation !== false,
  };
}

export function createSandboxForwardStopper(deps: {
  runOpenshell: Parameters<typeof bestEffortForwardStopForSandbox>[0];
  runCaptureOpenshell: (args: string[], opts?: Record<string, unknown>) => string | null;
  sandboxName: string;
  revalidateSandboxIdentity?: (operation: string) => void;
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
      () =>
        deps.revalidateSandboxIdentity?.(
          `stop dashboard forward ${String(port)} for sandbox '${deps.sandboxName}'`,
        ),
    );
    if (result === "stopped" || result === "no-entry") {
      stoppedPorts.add(portKey);
    }
    return result;
  };
}
