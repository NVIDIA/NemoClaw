// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { SandboxEntry, SandboxRegistry } from "./registry";
import {
  removeSandboxFromRegistry,
  restoreSandboxIfMissingInRegistry,
  type RegistryRemovalReceipt,
} from "./registry-reversible-removal";

function entry(name: string, model?: string): SandboxEntry {
  return { name, model };
}

function registry(entries: SandboxEntry[], defaultSandbox: string | null): SandboxRegistry {
  return {
    sandboxes: Object.fromEntries(entries.map((sandbox) => [sandbox.name, sandbox])),
    defaultSandbox,
  };
}

function receipt(
  sandbox: SandboxEntry,
  options: { wasDefault?: boolean; fallbackDefault?: string | null } = {},
): RegistryRemovalReceipt<SandboxEntry> {
  return {
    entry: sandbox,
    wasDefault: options.wasDefault ?? false,
    fallbackDefault: options.fallbackDefault ?? null,
  };
}

describe("reversible registry removal", () => {
  it("returns the removed row without mutating its source registry", () => {
    const alpha = entry("alpha", "old-model");
    const source = registry([alpha, entry("beta")], "alpha");

    const result = removeSandboxFromRegistry(source, "alpha");

    expect(result.receipt).toEqual({ entry: alpha, wasDefault: true, fallbackDefault: "beta" });
    expect(result.registry).toEqual({
      sandboxes: { beta: entry("beta") },
      defaultSandbox: "beta",
    });
    expect(source).toEqual({
      sandboxes: { alpha, beta: entry("beta") },
      defaultSandbox: "alpha",
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
      },
      restored: true,
    });
    expect(concurrent).toEqual(registry([beta], "beta"));
  });

  it("restores two removals without letting the second restore clobber the reclaimed default", () => {
    const alpha = entry("alpha", "alpha-model");
    const beta = entry("beta", "beta-model");
    const removedAlpha = removeSandboxFromRegistry(registry([alpha, beta], "alpha"), "alpha");
    const removedBeta = removeSandboxFromRegistry(removedAlpha.registry, "beta");
    expect(removedAlpha.receipt).not.toBeNull();
    expect(removedBeta.receipt).not.toBeNull();
    expect(removedBeta.registry).toEqual({
      sandboxes: {},
      defaultSandbox: null,
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
    const alpha = entry("alpha", "old-model");
    const beta = entry("beta");
    const gamma = entry("gamma");
    const removed = removeSandboxFromRegistry(registry([alpha, beta, gamma], "alpha"), "alpha");
    expect(removed.receipt).toEqual({
      entry: alpha,
      wasDefault: true,
      fallbackDefault: "beta",
    });

    const reclaimed = restoreSandboxIfMissingInRegistry(removed.registry, removed.receipt!);
    expect(reclaimed.registry.defaultSandbox).toBe("alpha");

    const concurrentDefault = { ...removed.registry, defaultSandbox: "gamma" };
    const preserved = restoreSandboxIfMissingInRegistry(concurrentDefault, removed.receipt!);
    expect(preserved.registry.defaultSandbox).toBe("gamma");
  });
});
