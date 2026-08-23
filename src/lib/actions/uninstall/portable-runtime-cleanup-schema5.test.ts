// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { runPortableRuntimeCleanupTransaction } from "./portable-runtime-cleanup";

describe("Hermes Portable runtime uninstall cleanup", () => {
  it("orders schema-5 lifecycle locks before the process registry lock (#9608)", () => {
    const order: string[] = [];
    const continueLegacyOpenShell = vi.fn(() => true);
    const homeDir = path.resolve("test", "fixtures", "hermes-portable-uninstall");
    let registryHeld = false;

    const result = runPortableRuntimeCleanupTransaction(
      {
        env: {},
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        homeDir,
        registryFile: path.join(homeDir, ".nemoclaw", "sandboxes.json"),
        stateDir: path.join(homeDir, ".nemoclaw"),
      },
      continueLegacyOpenShell,
      {
        inspectHermesPortableSandboxNames: () => ["beta", "alpha"],
        runHermesPortableUninstall: () => {
          expect(registryHeld).toBe(true);
          order.push("transaction");
          return { phase: "completed", sandboxContainersRemoved: 2, targetCount: 2 };
        },
        withLifecycleLock: (sandboxName, operation) => {
          order.push(`acquire:${sandboxName}`);
          try {
            return operation();
          } finally {
            order.push(`release:${sandboxName}`);
          }
        },
        withRegistryLock: (_registryFile, operation) => {
          order.push("acquire:registry");
          registryHeld = true;
          try {
            return operation();
          } finally {
            registryHeld = false;
            order.push("release:registry");
          }
        },
      },
    );

    expect(result).toEqual({
      registryRemoved: false,
      sandboxContainersRemoved: 2,
      selectorsRemoved: [],
    });
    expect(continueLegacyOpenShell).not.toHaveBeenCalled();
    expect(order).toEqual([
      "acquire:alpha",
      "acquire:beta",
      "acquire:registry",
      "transaction",
      "release:registry",
      "release:beta",
      "release:alpha",
    ]);
  });
});
