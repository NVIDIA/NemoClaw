// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import type {
  SandboxEntry,
  SandboxRegistry,
  SandboxWorkloadReceipt,
} from "./types";
import { withLock } from "./lock";
import { load, save } from "./persistence";
import { cloneSandboxWorkloadReceipt } from "./workload";

type ManagedWorkloadReceipt = Extract<
  SandboxWorkloadReceipt,
  { readonly kind: "managed-image" }
>;

const MAX_AUTHORITY_BYTES = 4096;

export interface SandboxRebuildAuthority {
  readonly schemaVersion: 1;
  readonly sandboxName: string;
  /** Selected RuntimeProviderBundle identity, validated before capture. */
  readonly providerId: string;
  /** Exact raw durable driver value; legacy Docker rows may record null. */
  readonly recordedDriver: string | null;
  readonly lifecycleGeneration: string;
  readonly liveIdentityFingerprint: string;
  readonly workload: ManagedWorkloadReceipt;
}

export type SandboxRebuildAuthoritySwapResult =
  | {
      readonly status: "committed";
      readonly entry: SandboxEntry;
    }
  | {
      readonly status: "stale-authority";
      readonly entry: SandboxEntry | null;
    };

export class SandboxRebuildAuthorityError extends Error {
  constructor(message: string) {
    super(`Invalid sandbox rebuild authority: ${message}`);
    this.name = "SandboxRebuildAuthorityError";
  }
}

function boundedIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    !value.includes("\0") &&
    Buffer.byteLength(value, "utf8") <= MAX_AUTHORITY_BYTES
  );
}

function clonedManagedReceipt(value: SandboxWorkloadReceipt | undefined): ManagedWorkloadReceipt {
  const cloned = cloneSandboxWorkloadReceipt(value);
  if (cloned?.kind !== "managed-image") {
    throw new SandboxRebuildAuthorityError(
      "a managed replacement requires a valid durable workload receipt",
    );
  }
  return cloned;
}

function cloneEntry(entry: SandboxEntry): SandboxEntry {
  return structuredClone(entry);
}

/**
 * Capture exact old-workload authority after the caller has resolved and
 * authorized one RuntimeProviderBundle. This receipt is suitable for an
 * atomic compare-and-swap; it is not a provider runtime handle.
 */
export function captureSandboxRebuildAuthority(
  entry: SandboxEntry,
  providerId: string,
): SandboxRebuildAuthority {
  if (!boundedIdentity(entry.name)) {
    throw new SandboxRebuildAuthorityError("sandbox name is missing or too large");
  }
  if (!boundedIdentity(providerId)) {
    throw new SandboxRebuildAuthorityError("provider identity is missing or too large");
  }
  if (entry.pendingRouteReservation === true) {
    throw new SandboxRebuildAuthorityError("route reservations cannot be rebuilt");
  }
  if (!boundedIdentity(entry.lifecycleGeneration)) {
    throw new SandboxRebuildAuthorityError("lifecycle generation is missing or invalid");
  }
  if (!boundedIdentity(entry.lifecycleLiveIdentityFingerprint)) {
    throw new SandboxRebuildAuthorityError("live identity fingerprint is missing or invalid");
  }
  const workload = clonedManagedReceipt(entry.workload);
  if (entry.imageTag !== workload.reference) {
    throw new SandboxRebuildAuthorityError(
      "image reference does not match the managed workload receipt",
    );
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    sandboxName: entry.name,
    providerId,
    recordedDriver: entry.openshellDriver ?? null,
    lifecycleGeneration: entry.lifecycleGeneration,
    liveIdentityFingerprint: entry.lifecycleLiveIdentityFingerprint,
    workload,
  });
}

export function sandboxRebuildAuthorityMatchesEntry(
  authority: SandboxRebuildAuthority,
  entry: SandboxEntry | null | undefined,
): boolean {
  if (!entry) return false;
  let current: SandboxRebuildAuthority;
  try {
    current = captureSandboxRebuildAuthority(entry, authority.providerId);
  } catch {
    return false;
  }
  return isDeepStrictEqual(current, authority);
}

function validateReplacement(
  expected: SandboxRebuildAuthority,
  replacement: SandboxEntry,
): SandboxEntry {
  if (replacement.name !== expected.sandboxName) {
    throw new SandboxRebuildAuthorityError("replacement changed the sandbox name");
  }
  if (replacement.pendingRouteReservation === true) {
    throw new SandboxRebuildAuthorityError("replacement is only a route reservation");
  }
  if (replacement.openshellDriver !== expected.providerId) {
    throw new SandboxRebuildAuthorityError(
      "replacement does not record the selected provider identity",
    );
  }
  if (
    !boundedIdentity(replacement.lifecycleGeneration) ||
    replacement.lifecycleGeneration === expected.lifecycleGeneration
  ) {
    throw new SandboxRebuildAuthorityError(
      "replacement must have a distinct lifecycle generation",
    );
  }
  if (
    !boundedIdentity(replacement.lifecycleLiveIdentityFingerprint) ||
    replacement.lifecycleLiveIdentityFingerprint === expected.liveIdentityFingerprint
  ) {
    throw new SandboxRebuildAuthorityError(
      "replacement must have a distinct live identity fingerprint",
    );
  }
  const workload = clonedManagedReceipt(replacement.workload);
  if (replacement.imageTag !== workload.reference) {
    throw new SandboxRebuildAuthorityError(
      "replacement image reference does not match its managed workload receipt",
    );
  }
  return cloneEntry({ ...replacement, workload });
}

/**
 * Pure CAS helper for tests and callers that already hold the registry lock.
 * A mismatch returns the original registry object and never overwrites a
 * same-name sandbox. No delete-by-name operation exists in this boundary.
 */
export function swapSandboxRebuildAuthorityInRegistry(
  registry: SandboxRegistry,
  expected: SandboxRebuildAuthority,
  replacementInput: SandboxEntry,
): {
  readonly registry: SandboxRegistry;
  readonly result: SandboxRebuildAuthoritySwapResult;
} {
  const replacement = validateReplacement(expected, replacementInput);
  const current = registry.sandboxes[expected.sandboxName] ?? null;
  if (!sandboxRebuildAuthorityMatchesEntry(expected, current)) {
    return {
      registry,
      result: {
        status: "stale-authority",
        entry: current === null ? null : cloneEntry(current),
      },
    };
  }
  const next: SandboxRegistry = {
    ...registry,
    sandboxes: {
      ...registry.sandboxes,
      [expected.sandboxName]: replacement,
    },
  };
  return {
    registry: next,
    result: { status: "committed", entry: cloneEntry(replacement) },
  };
}

/**
 * Atomically publish a Ready replacement only while the exact old generation,
 * live identity, provider recording, and managed workload receipt still own
 * the durable row.
 */
export function compareAndSwapSandboxRebuildAuthority(
  expected: SandboxRebuildAuthority,
  replacement: SandboxEntry,
): SandboxRebuildAuthoritySwapResult {
  return withLock(() => {
    const swapped = swapSandboxRebuildAuthorityInRegistry(load(), expected, replacement);
    if (swapped.result.status === "committed") save(swapped.registry);
    return swapped.result;
  });
}
