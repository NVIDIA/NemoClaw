// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const managedClusterRecovery = vi.hoisted(() => ({ endpoint: vi.fn() }));

vi.mock("./serving/managed-cluster-runtime-receipt", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./serving/managed-cluster-runtime-receipt")>()),
  recoverInstalledManagedClusterVllmEndpoint: managedClusterRecovery.endpoint,
}));

import { isNemoClawManagedVllmRunning, persistConfiguredManagedVllmRuntimeReceipt } from "./vllm";

describe("managed vLLM cluster recovery", () => {
  beforeEach(() => {
    managedClusterRecovery.endpoint.mockReset();
  });

  it("recognizes and confirms an installer-owned managed cluster receipt", async () => {
    managedClusterRecovery.endpoint.mockReturnValue({
      baseUrl: "http://10.40.0.1:8000",
      apiKey: "a".repeat(64),
    });

    expect(isNemoClawManagedVllmRunning()).toBe(true);
    await expect(persistConfiguredManagedVllmRuntimeReceipt()).resolves.toEqual({
      ok: true,
      persisted: true,
    });
  });

  it("fails closed instead of falling through when managed cluster recovery is unsafe", async () => {
    managedClusterRecovery.endpoint.mockImplementation(() => {
      throw new Error("receipt-owned container IDs changed");
    });

    expect(isNemoClawManagedVllmRunning()).toBe(false);
    await expect(persistConfiguredManagedVllmRuntimeReceipt()).resolves.toEqual({
      ok: false,
      reason: "managed vLLM recovery failed: receipt-owned container IDs changed",
    });
  });
});
