// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import { expectShieldsUpRefusalBeforeMutation } from "../../../../test/helpers/destroy-flow-test-assertions";
import {
  createDestroyHarness,
  resetDestroyModuleCache,
} from "../../../../test/helpers/destroy-flow-test-harness";

describe("forced OpenClaw MCP destroy", () => {
  let exitSpy: MockInstance;
  let originalGatewayEnv: string | undefined;

  beforeEach(() => {
    originalGatewayEnv = process.env.OPENSHELL_GATEWAY;
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
  });

  afterEach(() => {
    originalGatewayEnv === undefined
      ? delete process.env.OPENSHELL_GATEWAY
      : (process.env.OPENSHELL_GATEWAY = originalGatewayEnv);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetDestroyModuleCache();
  });

  it("refuses a shields-up adapter mutation before destroy starts (#10469)", async () => {
    const harness = createDestroyHarness({
      agent: "openclaw",
      mcpServers: ["github"],
      shieldsDown: false,
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow(
      "has shields up or an unreadable shields posture",
    );

    expectShieldsUpRefusalBeforeMutation(harness);
  });

  it("lets --force continue to MCP preparation after the refusal (#10469)", async () => {
    const harness = createDestroyHarness({
      agent: "openclaw",
      mcpServers: ["github"],
      shieldsDown: false,
    });

    await expect(
      harness.destroySandbox("alpha", { yes: true, force: true }),
    ).resolves.toBeUndefined();

    expect(harness.prepareMcpBridgesForDestroySpy).toHaveBeenCalledWith("alpha", { force: true });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("does not open a rollback mutation window after a refused deletion (#10469)", async () => {
    const harness = createDestroyHarness({
      agent: "openclaw",
      deleteOutput: "delete failed",
      deleteStatus: 7,
      mcpAdapterScrubSkipped: true,
      mcpServers: ["github"],
      shieldsDown: false,
    });

    await expect(harness.destroySandbox("alpha", { yes: true, force: true })).rejects.toThrow(
      "process.exit(7)",
    );

    expect(harness.restoreMcpBridgesAfterDestroyAbortSpy).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ adapterScrubSkipped: true }),
    );
    expect(harness.shieldsDownSpy).not.toHaveBeenCalled();
    expect(harness.finalizeMcpBridgesAfterSandboxDeleteSpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(7);
  });
});
