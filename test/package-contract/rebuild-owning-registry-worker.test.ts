// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { rebuildOwningRegistryDependencies } from "../../dist/lib/actions/sandbox/rebuild/owning-registry";

describe("compiled rebuild owning-registry worker", () => {
  it("executes the real pipeline and preserves its bounded failure", async () => {
    const expectedMessage = "toolDisclosure must be one of: progressive, direct.";
    let failure: unknown;

    try {
      await rebuildOwningRegistryDependencies.runWorker(
        {
          operation: "rebuild",
          sandboxName: "alpha",
          options: { yes: true, toolDisclosure: "invalid" } as never,
          executionOptions: {},
        },
        9000,
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(expectedMessage);
    expect((failure as Error).cause).toEqual({
      ok: false,
      operation: "rebuild",
      sandboxName: "alpha",
      gatewayPort: 9000,
      message: expectedMessage,
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
      ),
    ).rejects.toThrow();
  });

  it("terminates an unresponsive worker with an unknown-outcome recovery diagnostic", async () => {
    await expect(
      rebuildOwningRegistryDependencies.runWorker(
        {
          operation: "retire-recovery",
          sandboxName: "alpha",
          transactionId: "11111111-1111-4111-8111-111111111111",
          confirmDataRecovered: true,
        },
        9000,
        { timeoutMs: 1 },
      ),
    ).rejects.toThrow(
      "Delegated recovery retirement for sandbox 'alpha' on owning gateway port 9000 exceeded its 1 ms deadline. The worker was terminated, but the operation outcome is unknown. NemoClaw did not remove retained recovery state; inspect the sandbox and recovery state before retrying.",
    );
  });
});
