// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDestroyHarness,
  resetDestroyModuleCache,
} from "../../../../test/helpers/destroy-flow-test-harness";

const LOCAL_VLLM_SANDBOX = {
  provider: "vllm-local",
  endpointUrl: "http://host.openshell.internal:46145/v1",
};

function loggedLines(harness: ReturnType<typeof createDestroyHarness>): string {
  return harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n");
}

describe("destroySandbox managed vLLM retirement", () => {
  beforeEach(() => {
    vi.stubEnv("NEMOCLAW_KEEP_VLLM", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetDestroyModuleCache();
  });

  it("retires the managed vLLM container after the last Local vLLM sandbox is destroyed", async () => {
    const containerId = "b".repeat(64);
    const harness = createDestroyHarness(LOCAL_VLLM_SANDBOX);
    const retirementOrder: string[] = [];
    harness.withCurrentPortableHostFenceSpy.mockImplementation(async (operation) => {
      retirementOrder.push("host-fence-enter");
      try {
        return await operation();
      } finally {
        retirementOrder.push("host-fence-exit");
      }
    });
    harness.listHostGatewayRegistryEntriesSpy.mockImplementation(() => {
      retirementOrder.push("inventory");
      return [];
    });
    harness.retireHostLocalVllmRuntimeSpy.mockImplementation(() => {
      retirementOrder.push("retire");
      return {
        status: "removed",
        containerId,
        removed: [`container:${containerId}`],
      };
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

    expect(harness.retireHostLocalVllmRuntimeSpy).toHaveBeenCalledOnce();
    expect(harness.removeSandboxSpy.mock.invocationCallOrder[0]).toBeLessThan(
      harness.retireHostLocalVllmRuntimeSpy.mock.invocationCallOrder[0],
    );
    expect(retirementOrder).toEqual([
      "host-fence-enter",
      "host-fence-enter",
      "inventory",
      "retire",
      "host-fence-exit",
      "host-fence-exit",
    ]);
    expect(loggedLines(harness)).toContain(
      `Removed managed vLLM container 'nemoclaw-vllm' (${containerId.slice(0, 12)})`,
    );
  });

  it("keeps the managed vLLM container while another gateway registers a Local vLLM sandbox", async () => {
    const harness = createDestroyHarness(LOCAL_VLLM_SANDBOX);
    harness.listHostGatewayRegistryEntriesSpy.mockReturnValue([
      {
        entry: { name: "beta", provider: "vllm-local" },
        gatewayPort: 8091,
        registryFile: "/home/user/.nemoclaw/gateways/8091/sandboxes.json",
        stateRoot: "/home/user/.nemoclaw/gateways/8091",
      },
    ]);

    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

    expect(harness.retireHostLocalVllmRuntimeSpy).not.toHaveBeenCalled();
    expect(loggedLines(harness)).toContain(
      "preserved: 1 other registered sandbox(es) use Local vLLM",
    );
  });

  it("keeps the managed vLLM container when the destroy passes --keep-vllm", async () => {
    const harness = createDestroyHarness(LOCAL_VLLM_SANDBOX);

    await expect(
      harness.destroySandbox("alpha", { yes: true, keepVllm: true }),
    ).resolves.toBeUndefined();

    expect(harness.retireHostLocalVllmRuntimeSpy).not.toHaveBeenCalled();
    expect(loggedLines(harness)).toContain("preserved (--keep-vllm)");
  });

  it("keeps the managed vLLM container when NEMOCLAW_KEEP_VLLM=1 is set", async () => {
    vi.stubEnv("NEMOCLAW_KEEP_VLLM", "1");
    const harness = createDestroyHarness(LOCAL_VLLM_SANDBOX);

    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

    expect(harness.retireHostLocalVllmRuntimeSpy).not.toHaveBeenCalled();
    expect(loggedLines(harness)).toContain("preserved (--keep-vllm)");
  });

  it("does not touch the managed vLLM container for a sandbox that uses another provider", async () => {
    const harness = createDestroyHarness({ provider: "nvidia-prod" });

    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

    expect(harness.listHostGatewayRegistryEntriesSpy).not.toHaveBeenCalled();
    expect(harness.retireHostLocalVllmRuntimeSpy).not.toHaveBeenCalled();
  });

  it("does not retire the managed vLLM container when registry removal does not complete", async () => {
    const harness = createDestroyHarness({ ...LOCAL_VLLM_SANDBOX, removeSandboxResult: false });

    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

    expect(harness.removeSandboxSpy).toHaveBeenCalledWith("alpha");
    expect(harness.retireHostLocalVllmRuntimeSpy).not.toHaveBeenCalled();
  });

  it("warns and leaves the managed vLLM container in place when its ownership cannot be proven", async () => {
    const harness = createDestroyHarness(LOCAL_VLLM_SANDBOX);
    harness.retireHostLocalVllmRuntimeSpy.mockReturnValue({
      status: "preserved",
      reason: "the container does not carry the NemoClaw managed vLLM label",
      removed: [],
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

    expect(harness.warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("does not carry the NemoClaw managed vLLM label"),
    );
    expect(loggedLines(harness)).toContain("Sandbox 'alpha' destroyed");
  });
});
