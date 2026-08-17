// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { cloneAndDeepFreeze } from "../../core/immutable";
import {
  isManagedImageAgent,
  MANAGED_IMAGE_REPOSITORIES,
  type ManagedImageAgent,
} from "../../onboard/managed-image/contract";
import { withLock } from "./lock";
import { load, save } from "./persistence";
import type { SandboxEntry, SandboxRegistry, SandboxWorkloadReceipt } from "./types";
import { cloneSandboxWorkloadReceipt } from "./workload";

type ManagedWorkloadReceipt = Extract<SandboxWorkloadReceipt, { readonly kind: "managed-image" }>;

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
  /**
   * Canonical digest of the complete durable row. Rebuild CAS must fail on
   * concurrent policy, messaging, MCP, inference, or other metadata changes,
   * rather than overwriting them from the caller's stale snapshot.
   */
  readonly entryRevisionSha256: string;
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
  return cloneAndDeepFreeze(cloned);
}

function requireReceiptAgent(
  agent: SandboxEntry["agent"],
  workload: ManagedWorkloadReceipt,
  label: string,
): ManagedImageAgent {
  if (
    typeof agent !== "string" ||
    !isManagedImageAgent(agent) ||
    !workload.reference.startsWith(`${MANAGED_IMAGE_REPOSITORIES[agent]}@sha256:`)
  ) {
    throw new SandboxRebuildAuthorityError(
      `${label} agent does not match its managed workload receipt`,
    );
  }
  return agent;
}

function cloneEntry(entry: SandboxEntry): SandboxEntry {
  return structuredClone(entry);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function sandboxEntryRevision(entry: SandboxEntry): string {
  return createHash("sha256").update(canonicalJson(entry), "utf8").digest("hex");
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
  requireReceiptAgent(entry.agent, workload, "authoritative");
  if (entry.imageTag !== workload.reference) {
    throw new SandboxRebuildAuthorityError(
      "image reference does not match the managed workload receipt",
    );
  }
  return cloneAndDeepFreeze({
    schemaVersion: 1 as const,
    sandboxName: entry.name,
    providerId,
    recordedDriver: entry.openshellDriver ?? null,
    lifecycleGeneration: entry.lifecycleGeneration,
    liveIdentityFingerprint: entry.lifecycleLiveIdentityFingerprint,
    entryRevisionSha256: sandboxEntryRevision(entry),
    workload,
  });
}

/**
 * Reconcile an ambiguous persistence result using the replacement's exact new
 * runtime identity. This deliberately ignores mutable non-authority fields:
 * after publication another writer may update those fields, but no different
 * rebuild may claim the same generation, live fingerprint, provider, and
 * workload receipt.
 */
export function sandboxRebuildReplacementMatchesEntry(
  replacement: SandboxEntry,
  entry: SandboxEntry | null | undefined,
): boolean {
  if (!entry) return false;
  return (
    entry.name === replacement.name &&
    (entry.openshellDriver ?? null) === (replacement.openshellDriver ?? null) &&
    entry.lifecycleGeneration === replacement.lifecycleGeneration &&
    entry.lifecycleLiveIdentityFingerprint === replacement.lifecycleLiveIdentityFingerprint &&
    entry.imageTag === replacement.imageTag &&
    entry.agent === replacement.agent &&
    isDeepStrictEqual(
      cloneSandboxWorkloadReceipt(entry.workload),
      cloneSandboxWorkloadReceipt(replacement.workload),
    )
  );
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
    throw new SandboxRebuildAuthorityError("replacement must have a distinct lifecycle generation");
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
  requireReceiptAgent(replacement.agent, workload, "replacement");
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
  replacementInput: SandboxEntry,
): SandboxRebuildAuthoritySwapResult {
  const replacement = validateReplacement(expected, replacementInput);
  return withLock(() => {
    const swapped = swapSandboxRebuildAuthorityInRegistry(load(), expected, replacement);
    if (swapped.result.status === "stale-authority") return swapped.result;

    try {
      save(swapped.registry);
    } catch (error) {
      try {
        const observed = load().sandboxes[expected.sandboxName] ?? null;
        if (sandboxRebuildReplacementMatchesEntry(replacement, observed)) {
          return { status: "committed", entry: cloneEntry(observed) };
        }
      } catch {
        // Preserve the original persistence failure when readback is itself
        // unavailable.
      }
      throw error;
    }
    return swapped.result;
  });
}
