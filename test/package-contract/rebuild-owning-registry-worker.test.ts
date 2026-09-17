// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { rebuildOwningRegistryDependencies } from "../../dist/lib/actions/sandbox/rebuild/owning-registry";

describe("compiled rebuild owning-registry worker", () => {
  it("transfers the exact rebuild invocation over the private descriptor", async () => {
    const recoveryManifest = {
      sandboxName: "alpha",
      backupPath: "/backup/alpha",
    } as never;

    await expect(
      rebuildOwningRegistryDependencies.runWorker(
        {
          operation: "rebuild",
          sandboxName: "alpha",
          options: { yes: true, verbose: true },
          executionOptions: { recoveryManifest },
        },
        9000,
        { observeInvocation: true },
      ),
    ).resolves.toEqual({
      gatewayPort: "9000",
      sandboxName: "alpha",
      options: { yes: true, verbose: true },
      executionOptions: { recoveryManifest, throwOnError: true },
    });
  });

  it("rejects invalid descriptor input before the rebuild pipeline boundary", async () => {
    await expect(
      rebuildOwningRegistryDependencies.runWorker(
        {
          operation: "rebuild",
          sandboxName: "alpha",
          options: null,
          executionOptions: {},
        } as never,
        9000,
        { observeInvocation: true },
      ),
    ).rejects.toThrow();
  });
});
