// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  SandboxEntry,
  SandboxRegistry,
  SandboxRemovalReceipt,
} from "../src/lib/state/registry";

const originalHome = process.env.HOME;
const restoreOriginalHome =
  originalHome === undefined
    ? () => Reflect.deleteProperty(process.env, "HOME")
    : () => {
        process.env.HOME = originalHome;
      };
let home: string;
let registryFile: string;
let registry: typeof import("../src/lib/state/registry");
let useCommand: typeof import("../src/lib/use-command-deps");

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-default-selection-revision-"));
  process.env.HOME = home;
  vi.resetModules();
  [registry, useCommand] = await Promise.all([
    import("../src/lib/state/registry"),
    import("../src/lib/use-command-deps"),
  ]);
  registryFile = path.join(home, ".nemoclaw", "sandboxes.json");
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  restoreOriginalHome();
  vi.resetModules();
});

function requireRemovalReceipt(receipt: SandboxRemovalReceipt | null): SandboxRemovalReceipt {
  expect(receipt).not.toBeNull();
  return receipt!;
}

function requireSandbox(entry: SandboxEntry | null): SandboxEntry {
  expect(entry).not.toBeNull();
  return entry!;
}

function readPersistedRegistry(): SandboxRegistry {
  return JSON.parse(fs.readFileSync(registryFile, "utf-8")) as SandboxRegistry;
}

describe("registry default-selection revision", () => {
  it("persists a revision for explicit and automatic default-pointer operations", () => {
    registry.registerSandbox({ name: "alpha" });
    expect(registry.load().defaultSelectionRevision).toBe(1);

    expect(registry.setDefault("alpha")).toBe(true);
    expect(registry.load().defaultSelectionRevision).toBe(2);

    registry.registerSandbox({ name: "beta" });
    expect(registry.load().defaultSelectionRevision).toBe(2);

    const receipt = requireRemovalReceipt(registry.removeSandboxWithReceipt("alpha"));
    expect(receipt).toMatchObject({
      wasDefault: true,
      fallbackDefault: "beta",
      postRemovalDefaultSelectionRevision: 3,
    });
    expect(readPersistedRegistry()).toMatchObject({
      defaultSandbox: "beta",
      defaultSelectionRevision: 3,
    });

    expect(registry.restoreSandboxEntryIfMissing(receipt)).toBe(true);
    expect(readPersistedRegistry()).toMatchObject({
      defaultSandbox: "alpha",
      defaultSelectionRevision: 4,
    });
  });

  it("ordinary rollback preserves an explicit same-fallback default choice", () => {
    registry.registerSandbox({ name: "alpha", model: "original" });
    registry.registerSandbox({ name: "beta" });
    registry.setDefault("alpha");
    const receipt = requireRemovalReceipt(registry.removeSandboxWithReceipt("alpha"));
    expect(registry.getDefault()).toBe("beta");

    expect(useCommand.runUseCommand("beta", useCommand.buildUseCommandDeps())).toEqual({
      outcome: "already-default",
      sandboxName: "beta",
    });
    const explicitChoiceRevision = registry.load().defaultSelectionRevision;
    expect(explicitChoiceRevision).toBe(receipt.postRemovalDefaultSelectionRevision + 1);
    expect(registry.restoreSandboxEntryIfMissing(receipt)).toBe(true);

    expect(registry.getDefault()).toBe("beta");
    expect(registry.load().defaultSelectionRevision).toBe(explicitChoiceRevision);
    expect(registry.getSandbox("alpha")).toMatchObject({ model: "original" });
  });

  it("prepared rollback requires the captured fallback revision before reclaiming default", () => {
    registry.registerSandbox({ name: "alpha", model: "preserved" });
    registry.registerSandbox({ name: "beta" });
    registry.setDefault("alpha");
    const original = requireSandbox(registry.getSandbox("alpha"));
    const receipt = requireRemovalReceipt(registry.removeSandboxWithReceipt("alpha"));

    registry.restoreSandboxEntry(original, {
      defaultTransition: {
        from: receipt.fallbackDefault,
        to: "alpha",
        expectedRevision: receipt.postRemovalDefaultSelectionRevision,
      },
    });
    expect(registry.getDefault()).toBe("alpha");
    expect(registry.load().defaultSelectionRevision).toBe(
      receipt.postRemovalDefaultSelectionRevision + 1,
    );

    const secondReceipt = requireRemovalReceipt(registry.removeSandboxWithReceipt("alpha"));
    expect(registry.setDefault("beta")).toBe(true);
    const explicitChoiceRevision = registry.load().defaultSelectionRevision;
    registry.restoreSandboxEntry(original, {
      defaultTransition: {
        from: secondReceipt.fallbackDefault,
        to: "alpha",
        expectedRevision: secondReceipt.postRemovalDefaultSelectionRevision,
      },
    });

    expect(registry.getDefault()).toBe("beta");
    expect(registry.load().defaultSelectionRevision).toBe(explicitChoiceRevision);
  });

  it("migrates a legacy registry before the next default operation", () => {
    fs.mkdirSync(path.dirname(registryFile), { recursive: true });
    fs.writeFileSync(
      registryFile,
      `${JSON.stringify({
        sandboxes: { alpha: { name: "alpha" }, beta: { name: "beta" } },
        defaultSandbox: "alpha",
      })}\n`,
    );

    expect(registry.load().defaultSelectionRevision).toBe(0);
    expect(registry.setDefault("alpha")).toBe(true);
    expect(readPersistedRegistry()).toMatchObject({
      defaultSandbox: "alpha",
      defaultSelectionRevision: 1,
    });

    const receipt = requireRemovalReceipt(registry.removeSandboxWithReceipt("alpha"));
    expect(receipt.postRemovalDefaultSelectionRevision).toBe(2);
    expect(readPersistedRegistry()).toMatchObject({
      defaultSandbox: "beta",
      defaultSelectionRevision: 2,
    });
  });

  it.each([
    ["negative", -1],
    ["fractional", 1.25],
    ["string", "1"],
    ["null", null],
    ["above MAX_SAFE_INTEGER", Number.MAX_SAFE_INTEGER + 1],
  ])("rejects a present %s revision without changing the registry", (_label, invalidRevision) => {
    fs.mkdirSync(path.dirname(registryFile), { recursive: true });
    fs.writeFileSync(
      registryFile,
      `${JSON.stringify({
        sandboxes: { alpha: { name: "alpha" } },
        defaultSandbox: "alpha",
        defaultSelectionRevision: invalidRevision,
      })}\n`,
    );
    const before = fs.readFileSync(registryFile, "utf-8");

    expect(() => registry.setDefault("alpha")).toThrow(
      "Sandbox registry default-selection revision must be a non-negative safe integer",
    );

    expect(fs.readFileSync(registryFile, "utf-8")).toBe(before);
    expect(fs.existsSync(`${registryFile}.lock`)).toBe(false);
  });

  it("fails an exhausted revision increment without a partial write", () => {
    fs.mkdirSync(path.dirname(registryFile), { recursive: true });
    fs.writeFileSync(
      registryFile,
      `${JSON.stringify({
        sandboxes: { alpha: { name: "alpha" } },
        defaultSandbox: "alpha",
        defaultSelectionRevision: Number.MAX_SAFE_INTEGER,
      })}\n`,
    );
    const before = fs.readFileSync(registryFile, "utf-8");

    expect(() => registry.setDefault("alpha")).toThrow(
      "Sandbox registry default-selection revision is exhausted",
    );

    expect(fs.readFileSync(registryFile, "utf-8")).toBe(before);
    expect(fs.existsSync(`${registryFile}.lock`)).toBe(false);
  });
});
