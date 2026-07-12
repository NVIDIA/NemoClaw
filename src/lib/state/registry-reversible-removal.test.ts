// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { SandboxEntry, SandboxRegistry } from "./registry";
import {
  claimInitialDefaultInRegistry,
  clearRegistry,
  type RegistryRemovalReceipt,
  removeSandboxFromRegistry,
  restoreSandboxEntryInRegistry,
  restoreSandboxIfMissingInRegistry,
  setDefaultInRegistry,
} from "./registry-reversible-removal";

function entry(name: string, model?: string): SandboxEntry {
  return { name, model };
}

function registry(
  entries: SandboxEntry[],
  defaultSandbox: string | null,
  defaultSelectionRevision = 0,
): SandboxRegistry {
  return {
    sandboxes: Object.fromEntries(entries.map((sandbox) => [sandbox.name, sandbox])),
    defaultSandbox,
    defaultSelectionRevision,
  };
}

function receipt(
  sandbox: SandboxEntry,
  options: {
    wasDefault?: boolean;
    fallbackDefault?: string | null;
    postRemovalDefaultSelectionRevision?: number;
  } = {},
): RegistryRemovalReceipt<SandboxEntry> {
  return {
    entry: sandbox,
    wasDefault: options.wasDefault ?? false,
    fallbackDefault: options.fallbackDefault ?? null,
    postRemovalDefaultSelectionRevision: options.postRemovalDefaultSelectionRevision ?? 0,
  };
}

describe("reversible registry removal", () => {
  it("owns initial, explicit, and cleared default-pointer revisions", () => {
    const alpha = entry("alpha");
    const initial = registry([alpha], null, 4);

    const claimed = claimInitialDefaultInRegistry(initial, "alpha");
    expect(claimed).toEqual({
      sandboxes: { alpha },
      defaultSandbox: "alpha",
      defaultSelectionRevision: 5,
    });
    expect(initial.defaultSandbox).toBeNull();

    const explicitSameValue = setDefaultInRegistry(claimed, "alpha");
    expect(explicitSameValue?.defaultSelectionRevision).toBe(6);
    expect(setDefaultInRegistry(claimed, "missing")).toBeNull();

    const cleared = clearRegistry(explicitSameValue!);
    expect(cleared).toEqual({
      sandboxes: {},
      defaultSandbox: null,
      defaultSelectionRevision: 7,
    });
    expect(clearRegistry(cleared).defaultSelectionRevision).toBe(7);
  });

  it("restores a prepared row only for the captured default transition", () => {
    const alpha = entry("alpha", "preserved");
    const source = registry([entry("beta")], "beta", 8);
    const transition = { from: "beta", to: "alpha", expectedRevision: 8 };

    expect(restoreSandboxEntryInRegistry(source, alpha, transition)).toEqual({
      sandboxes: { beta: entry("beta"), alpha },
      defaultSandbox: "alpha",
      defaultSelectionRevision: 9,
    });
    expect(
      restoreSandboxEntryInRegistry({ ...source, defaultSelectionRevision: 9 }, alpha, transition),
    ).toEqual({
      sandboxes: { beta: entry("beta"), alpha },
      defaultSandbox: "beta",
      defaultSelectionRevision: 9,
    });
  });

  it("returns the removed row without mutating its source registry", () => {
    const alpha = entry("alpha", "old-model");
    const source = registry([alpha, entry("beta")], "alpha");

    const result = removeSandboxFromRegistry(source, "alpha");

    expect(result.receipt).toEqual({
      entry: alpha,
      wasDefault: true,
      fallbackDefault: "beta",
      postRemovalDefaultSelectionRevision: 1,
    });
    expect(result.registry).toEqual({
      sandboxes: { beta: entry("beta") },
      defaultSandbox: "beta",
      defaultSelectionRevision: 1,
    });
    expect(source).toEqual({
      sandboxes: { alpha, beta: entry("beta") },
      defaultSandbox: "alpha",
      defaultSelectionRevision: 0,
    });
  });

  it("keeps a different default and returns an unchanged registry for a missing row", () => {
    const source = registry([entry("alpha"), entry("beta")], "beta");

    const removed = removeSandboxFromRegistry(source, "alpha");
    const missing = removeSandboxFromRegistry(source, "missing");

    expect(removed.registry.defaultSandbox).toBe("beta");
    expect(missing).toEqual({ registry: source, receipt: null });
    expect(missing.registry).toBe(source);
  });

  it("restores the exact row while preserving a valid current default", () => {
    const original = entry("alpha", "old-model");
    const source = registry([entry("beta")], "beta");

    const result = restoreSandboxIfMissingInRegistry(source, receipt(original));

    expect(result).toEqual({
      registry: {
        sandboxes: { beta: entry("beta"), alpha: original },
        defaultSandbox: "beta",
        defaultSelectionRevision: 0,
      },
      restored: true,
    });
    expect(source.sandboxes).toEqual({ beta: entry("beta") });
  });

  it("restores a removed row after a concurrent add without clobbering the new default", () => {
    const alpha = entry("alpha", "old-model");
    const beta = entry("beta", "new-model");
    const removed = removeSandboxFromRegistry(registry([alpha], "alpha"), "alpha");
    expect(removed.receipt).not.toBeNull();

    const concurrent = registry([beta], "beta");
    const restored = restoreSandboxIfMissingInRegistry(concurrent, removed.receipt!);

    expect(restored).toEqual({
      registry: {
        sandboxes: { beta, alpha },
        defaultSandbox: "beta",
        defaultSelectionRevision: 0,
      },
      restored: true,
    });
    expect(concurrent).toEqual(registry([beta], "beta"));
  });

  it("restores two removals without letting the second restore clobber the reclaimed default", () => {
    // Interleaving 2: two removals restore in reverse order without the later
    // restore clobbering the default already reclaimed by the first.
    const alpha = entry("alpha", "alpha-model");
    const beta = entry("beta", "beta-model");
    const removedAlpha = removeSandboxFromRegistry(registry([alpha, beta], "alpha"), "alpha");
    const removedBeta = removeSandboxFromRegistry(removedAlpha.registry, "beta");
    expect(removedAlpha.receipt).not.toBeNull();
    expect(removedBeta.receipt).not.toBeNull();
    expect(removedBeta.registry).toEqual({
      sandboxes: {},
      defaultSandbox: null,
      defaultSelectionRevision: 2,
    });

    const restoredAlpha = restoreSandboxIfMissingInRegistry(
      removedBeta.registry,
      removedAlpha.receipt!,
    );
    const restoredBeta = restoreSandboxIfMissingInRegistry(
      restoredAlpha.registry,
      removedBeta.receipt!,
    );

    expect(restoredBeta.registry).toEqual({
      sandboxes: { alpha, beta },
      defaultSandbox: "alpha",
      defaultSelectionRevision: 3,
    });
  });

  it.each([
    null,
    "missing",
  ])("makes the restored row default when the prior pointer is %s", (defaultSandbox) => {
    const result = restoreSandboxIfMissingInRegistry(
      registry([entry("beta")], defaultSandbox),
      receipt(entry("alpha")),
    );

    expect(result.registry.defaultSandbox).toBe("alpha");
  });

  it("refuses a spoofed same-name recreation and keeps its replacement row", () => {
    const replacement = entry("alpha", "replacement-model");
    const source = registry([replacement, entry("beta")], "beta");

    const result = restoreSandboxIfMissingInRegistry(source, receipt(entry("alpha", "old-model")));

    expect(result).toEqual({ registry: source, restored: false });
    expect(result.registry).toBe(source);
    expect(result.registry.sandboxes.alpha).toBe(replacement);
  });

  it("reclaims the removed default only while its removal-selected fallback remains current", () => {
    // Interleaving 1: another write advances the selection revision, so the
    // removed default may be restored as a row but cannot reclaim ownership.
    const alpha = entry("alpha", "old-model");
    const beta = entry("beta");
    const gamma = entry("gamma");
    const removed = removeSandboxFromRegistry(registry([alpha, beta, gamma], "alpha"), "alpha");
    expect(removed.receipt).toEqual({
      entry: alpha,
      wasDefault: true,
      fallbackDefault: "beta",
      postRemovalDefaultSelectionRevision: 1,
    });

    const reclaimed = restoreSandboxIfMissingInRegistry(removed.registry, removed.receipt!);
    expect(reclaimed.registry.defaultSandbox).toBe("alpha");
    expect(reclaimed.registry.defaultSelectionRevision).toBe(2);

    const concurrentDefault = setDefaultInRegistry(removed.registry, "gamma");
    expect(concurrentDefault).not.toBeNull();
    const preserved = restoreSandboxIfMissingInRegistry(concurrentDefault!, removed.receipt!);
    expect(preserved.registry.defaultSandbox).toBe("gamma");
    expect(preserved.registry.defaultSelectionRevision).toBe(2);
  });

  it("preserves an explicit same-fallback choice made after removal", () => {
    // Interleaving 3: an explicit write re-selecting the same fallback still
    // advances the revision and must survive restoration of the removed row.
    const alpha = entry("alpha", "old-model");
    const beta = entry("beta");
    const removed = removeSandboxFromRegistry(registry([alpha, beta], "alpha", 7), "alpha");
    expect(removed.receipt?.postRemovalDefaultSelectionRevision).toBe(8);

    const explicitSameFallback = setDefaultInRegistry(removed.registry, "beta");
    expect(explicitSameFallback).not.toBeNull();
    const restored = restoreSandboxIfMissingInRegistry(explicitSameFallback!, removed.receipt!);

    expect(restored.registry.defaultSandbox).toBe("beta");
    expect(restored.registry.defaultSelectionRevision).toBe(9);
  });
});
