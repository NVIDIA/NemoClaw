// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import { withLock } from "./lock";
import { load, saveDurable } from "./persistence";
import { normalizeSandboxQuarantineFence } from "./quarantine";
import type { SandboxEntry, SandboxQuarantineFence, SandboxQuarantineTarget } from "./types";

export type BeginSandboxQuarantineResult =
  | { readonly status: "started" | "existing"; readonly fence: SandboxQuarantineFence }
  | { readonly status: "conflict"; readonly fence: SandboxQuarantineFence }
  | { readonly status: "missing" | "stale" };

function normalizedProviderId(entry: SandboxEntry): string {
  const value = entry.openshellDriver?.trim().toLowerCase();
  return !value || value === "vm" ? "docker" : value;
}

function persistedGatewayBindingMatches(
  entry: SandboxEntry,
  target: SandboxQuarantineTarget,
): boolean {
  return (
    typeof entry.gatewayPort === "number" &&
    typeof entry.gatewayName === "string" &&
    entry.gatewayPort === target.gatewayPort &&
    entry.gatewayName === target.gatewayName
  );
}

function registryAuthorityMatches(entry: SandboxEntry, fence: SandboxQuarantineFence): boolean {
  const target = fence.target;
  return (
    entry.name === target.sandboxName &&
    normalizedProviderId(entry) === target.providerId &&
    persistedGatewayBindingMatches(entry, target) &&
    entry.lifecycleGeneration === target.lifecycleGeneration &&
    entry.lifecycleLiveIdentityFingerprint === target.liveIdentityFingerprint
  );
}

export function getSandboxForQuarantine(name: string): SandboxEntry | null {
  return load().sandboxes[name] ?? null;
}

export class SandboxQuarantineError extends Error {
  constructor(
    readonly sandboxName: string,
    readonly fenceId: string,
    readonly phase: string,
    action: string,
  ) {
    super(
      `Sandbox '${sandboxName}' is quarantined (${phase}, fence ${fenceId}); ` +
        `'${action}' cannot reactivate or mutate it. Inspect status or evidence, destroy it, ` +
        `or run 'quarantine release --fence-id ${fenceId}' for sandbox '${sandboxName}'.`,
    );
    this.name = "SandboxQuarantineError";
  }
}

/** Recheck the durable restart fence at the lifecycle mutation boundary. */
export function assertSandboxActivationAllowed(
  sandboxName: string,
  action: string,
  getSandbox: (name: string) => SandboxEntry | null = getSandboxForQuarantine,
): void {
  const fence = getSandbox(sandboxName)?.quarantine;
  if (!fence) return;
  throw new SandboxQuarantineError(sandboxName, fence.fenceId, fence.phase, action);
}

/** Persist a new restart fence only while the exact registry authority is current. */
export function beginSandboxQuarantine(
  sandboxName: string,
  value: SandboxQuarantineFence,
): BeginSandboxQuarantineResult {
  const fence = normalizeSandboxQuarantineFence(value);
  if (!fence || fence.target.sandboxName !== sandboxName) {
    throw new Error("Cannot persist an invalid sandbox quarantine fence");
  }
  return withLock(() => {
    const data = load();
    const current = data.sandboxes[sandboxName];
    if (!current) return { status: "missing" };
    if (current.quarantine) {
      const sameRequest =
        current.quarantine.requestIdentity === fence.requestIdentity &&
        current.quarantine.reasonDigest === fence.reasonDigest &&
        isDeepStrictEqual(current.quarantine.target, fence.target);
      return sameRequest
        ? { status: "existing", fence: current.quarantine }
        : { status: "conflict", fence: current.quarantine };
    }
    if (!registryAuthorityMatches(current, fence)) return { status: "stale" };
    current.quarantine = fence;
    saveDurable(data);
    return { status: "started", fence };
  });
}

/** Replace the crash journal only for its exact still-active fence. */
export function updateSandboxQuarantine(
  sandboxName: string,
  value: SandboxQuarantineFence,
): boolean {
  const fence = normalizeSandboxQuarantineFence(value);
  if (!fence || fence.target.sandboxName !== sandboxName) {
    throw new Error("Cannot persist an invalid sandbox quarantine journal");
  }
  return withLock(() => {
    const data = load();
    const current = data.sandboxes[sandboxName];
    if (
      !current?.quarantine ||
      current.quarantine.fenceId !== fence.fenceId ||
      current.quarantine.requestIdentity !== fence.requestIdentity ||
      !registryAuthorityMatches(current, fence)
    ) {
      return false;
    }
    current.quarantine = fence;
    saveDurable(data);
    return true;
  });
}

/** Remove a fence without starting the sandbox, after exact authority revalidation. */
export function releaseSandboxQuarantine(sandboxName: string, fenceId: string): boolean {
  return withLock(() => {
    const data = load();
    const current = data.sandboxes[sandboxName];
    const fence = current?.quarantine;
    if (!current || !fence || fence.fenceId !== fenceId) return false;
    if (!registryAuthorityMatches(current, fence)) return false;
    current.quarantine = undefined;
    saveDurable(data);
    return true;
  });
}
