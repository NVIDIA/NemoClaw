// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { SandboxEntry, SandboxRegistry } from "./registry";
import {
  removeSandboxFromRegistry,
  restoreSandboxIfMissingInRegistry,
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

describe("reversible registry removal", () => {
  it("returns the removed row without mutating its source registry", () => {
    const alpha = entry("alpha", "old-model");
    const source = registry([alpha, entry("beta")], "alpha");

    const result = removeSandboxFromRegistry(source, "alpha");

    expect(result.receipt).toEqual({ entry: alpha });
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

    const result = restoreSandboxIfMissingInRegistry(source, original);

    expect(result).toEqual({
      registry: {
        sandboxes: { beta: entry("beta"), alpha: original },
        defaultSandbox: "beta",
      },
      restored: true,
    });
    expect(source.sandboxes).toEqual({ beta: entry("beta") });
  });

  it.each([
    null,
    "missing",
  ])("makes the restored row default when the prior pointer is %s", (defaultSandbox) => {
    const result = restoreSandboxIfMissingInRegistry(
      registry([entry("beta")], defaultSandbox),
      entry("alpha"),
    );

    expect(result.registry.defaultSandbox).toBe("alpha");
  });

  it("keeps a replacement row and the original registry unchanged", () => {
    const replacement = entry("alpha", "replacement-model");
    const source = registry([replacement, entry("beta")], "beta");

    const result = restoreSandboxIfMissingInRegistry(source, entry("alpha", "old-model"));

    expect(result).toEqual({ registry: source, restored: false });
    expect(result.registry).toBe(source);
    expect(result.registry.sandboxes.alpha).toBe(replacement);
  });
});
