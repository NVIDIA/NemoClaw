// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * SOURCE_OF_TRUTH
 * Invalid state: rebuild must remove the registered sandbox before recreation,
 * but a failed recreation would otherwise permanently lose the prior row and
 * default selection.
 * Source boundary: runRebuildDestroyPhase removes the registry row only after
 * OpenShell has successfully deleted (or confirms absence of) the old sandbox;
 * the rebuild pipeline restores that receipt if recreation then fails.
 * Source-fix constraint: OpenShell cannot yet create and verify a replacement
 * under a temporary name and atomically swap it with the existing sandbox.
 * Regression proof: registry-reversible-removal.test.ts covers receipt-based
 * restoration, default ownership revisions, and concurrent-write preservation.
 * Removal condition: delete this compatibility layer when OpenShell provides
 * an atomic build/verify/swap primitive for same-name sandbox replacement.
 */

type NamedRegistryEntry = {
  name: string;
};

type RegistryState<Entry extends NamedRegistryEntry> = {
  sandboxes: Record<string, Entry>;
  defaultSandbox: string | null;
  /** Internal operation revision for durable default-pointer ownership. */
  defaultSelectionRevision?: number;
};

export type RegistryRemovalReceipt<Entry extends NamedRegistryEntry> = {
  entry: Entry;
  /** Whether the removed row owned the default pointer. */
  wasDefault: boolean;
  /** The fallback selected by this removal when it moved the default pointer. */
  fallbackDefault: string | null;
  /** Default-pointer revision immediately after the removal was persisted. */
  postRemovalDefaultSelectionRevision: number;
};

type RegistryRemovalResult<Entry extends NamedRegistryEntry> = {
  registry: RegistryState<Entry>;
  receipt: RegistryRemovalReceipt<Entry> | null;
};

type RegistryRestoreResult<Entry extends NamedRegistryEntry> = {
  registry: RegistryState<Entry>;
  restored: boolean;
};

export type RegistryDefaultTransition = {
  readonly from: string | null;
  readonly to: string;
  readonly expectedRevision: number;
};

/** Migrate registries written before the default-selection revision existed. */
export function normalizeDefaultSelectionRevision(revision: unknown): number {
  if (revision === undefined) return 0;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
    throw new Error(
      "Sandbox registry default-selection revision must be a non-negative safe integer",
    );
  }
  return revision;
}

/** Advance the durable default-pointer operation revision without losing precision. */
export function incrementDefaultSelectionRevision(revision: number | undefined): number {
  const current = normalizeDefaultSelectionRevision(revision);
  if (current === Number.MAX_SAFE_INTEGER) {
    throw new Error("Sandbox registry default-selection revision is exhausted");
  }
  return current + 1;
}

/** Claim the default pointer when registering the first sandbox. */
export function claimInitialDefaultInRegistry<Entry extends NamedRegistryEntry>(
  registry: RegistryState<Entry>,
  name: string,
): RegistryState<Entry> {
  if (registry.defaultSandbox) return registry;
  return {
    ...registry,
    defaultSandbox: name,
    defaultSelectionRevision: incrementDefaultSelectionRevision(registry.defaultSelectionRevision),
  };
}

/** Apply an explicit default selection, including a same-value ownership revision. */
export function setDefaultInRegistry<Entry extends NamedRegistryEntry>(
  registry: RegistryState<Entry>,
  name: string,
): RegistryState<Entry> | null {
  if (!registry.sandboxes[name]) return null;
  return {
    ...registry,
    defaultSandbox: name,
    defaultSelectionRevision: incrementDefaultSelectionRevision(registry.defaultSelectionRevision),
  };
}

/** Clear every row while advancing the revision only when the pointer moves. */
export function clearRegistry<Entry extends NamedRegistryEntry>(
  registry: RegistryState<Entry>,
): RegistryState<Entry> {
  const defaultSelectionRevision =
    registry.defaultSandbox === null
      ? normalizeDefaultSelectionRevision(registry.defaultSelectionRevision)
      : incrementDefaultSelectionRevision(registry.defaultSelectionRevision);
  return { sandboxes: {}, defaultSandbox: null, defaultSelectionRevision };
}

/** Restore a row and reclaim its prior default only for the captured transition. */
export function restoreSandboxEntryInRegistry<Entry extends NamedRegistryEntry>(
  registry: RegistryState<Entry>,
  entry: Entry,
  defaultTransition?: RegistryDefaultTransition,
): RegistryState<Entry> {
  const sandboxes = { ...registry.sandboxes, [entry.name]: entry };
  if (
    !defaultTransition ||
    registry.defaultSandbox !== defaultTransition.from ||
    normalizeDefaultSelectionRevision(registry.defaultSelectionRevision) !==
      defaultTransition.expectedRevision ||
    !sandboxes[defaultTransition.to]
  ) {
    return { ...registry, sandboxes };
  }
  return {
    ...registry,
    sandboxes,
    defaultSandbox: defaultTransition.to,
    defaultSelectionRevision: incrementDefaultSelectionRevision(registry.defaultSelectionRevision),
  };
}

/** Derive the registry state and receipt for one atomic sandbox removal. */
export function removeSandboxFromRegistry<Entry extends NamedRegistryEntry>(
  registry: RegistryState<Entry>,
  name: string,
): RegistryRemovalResult<Entry> {
  const entry = registry.sandboxes[name];
  if (!entry) return { registry, receipt: null };

  const sandboxes = { ...registry.sandboxes };
  delete sandboxes[name];
  const fallbackDefault = Object.keys(sandboxes)[0] || null;
  const wasDefault = registry.defaultSandbox === name;
  const defaultSelectionRevision = wasDefault
    ? incrementDefaultSelectionRevision(registry.defaultSelectionRevision)
    : normalizeDefaultSelectionRevision(registry.defaultSelectionRevision);

  return {
    registry: {
      ...registry,
      sandboxes,
      defaultSandbox: wasDefault ? fallbackDefault : registry.defaultSandbox,
      defaultSelectionRevision,
    },
    receipt: {
      entry,
      wasDefault,
      fallbackDefault,
      postRemovalDefaultSelectionRevision: defaultSelectionRevision,
    },
  };
}

/**
 * Derive rollback state without replacing a row registered after removal.
 * Keep any valid current default; use the restored row only for an absent or
 * stale pointer.
 */
export function restoreSandboxIfMissingInRegistry<Entry extends NamedRegistryEntry>(
  registry: RegistryState<Entry>,
  receipt: RegistryRemovalReceipt<Entry>,
): RegistryRestoreResult<Entry> {
  const { entry } = receipt;
  if (registry.sandboxes[entry.name]) return { registry, restored: false };

  const sandboxes = { ...registry.sandboxes, [entry.name]: entry };
  const currentDefaultIsValid =
    registry.defaultSandbox !== null && sandboxes[registry.defaultSandbox] !== undefined;
  const shouldReclaimRemovedDefault =
    receipt.wasDefault &&
    registry.defaultSandbox === receipt.fallbackDefault &&
    normalizeDefaultSelectionRevision(registry.defaultSelectionRevision) ===
      receipt.postRemovalDefaultSelectionRevision;
  const defaultSandbox = shouldReclaimRemovedDefault
    ? entry.name
    : currentDefaultIsValid
      ? registry.defaultSandbox
      : entry.name;
  const defaultSelectionRevision =
    defaultSandbox === registry.defaultSandbox
      ? normalizeDefaultSelectionRevision(registry.defaultSelectionRevision)
      : incrementDefaultSelectionRevision(registry.defaultSelectionRevision);

  return {
    registry: { ...registry, sandboxes, defaultSandbox, defaultSelectionRevision },
    restored: true,
  };
}
