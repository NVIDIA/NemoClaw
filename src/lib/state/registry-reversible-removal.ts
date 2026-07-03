// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

type NamedRegistryEntry = {
  name: string;
};

type RegistryState<Entry extends NamedRegistryEntry> = {
  sandboxes: Record<string, Entry>;
  defaultSandbox: string | null;
};

export type RegistryRemovalReceipt<Entry extends NamedRegistryEntry> = {
  entry: Entry;
  /** Whether the removed row owned the default pointer. */
  wasDefault: boolean;
  /** The fallback selected by this removal when it moved the default pointer. */
  fallbackDefault: string | null;
};

type RegistryRemovalResult<Entry extends NamedRegistryEntry> = {
  registry: RegistryState<Entry>;
  receipt: RegistryRemovalReceipt<Entry> | null;
};

type RegistryRestoreResult<Entry extends NamedRegistryEntry> = {
  registry: RegistryState<Entry>;
  restored: boolean;
};

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

  return {
    registry: {
      ...registry,
      sandboxes,
      defaultSandbox: wasDefault ? fallbackDefault : registry.defaultSandbox,
    },
    receipt: { entry, wasDefault, fallbackDefault },
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
    receipt.wasDefault && registry.defaultSandbox === receipt.fallbackDefault;
  const defaultSandbox = shouldReclaimRemovedDefault
    ? entry.name
    : currentDefaultIsValid
      ? registry.defaultSandbox
      : entry.name;

  return {
    registry: { ...registry, sandboxes, defaultSandbox },
    restored: true,
  };
}
