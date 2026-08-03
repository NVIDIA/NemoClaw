// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const sparkRecovery = vi.hoisted(() => ({ endpoint: vi.fn() }));

vi.mock("./serving/spark-runtime-receipt", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./serving/spark-runtime-receipt")>()),
  recoverInstalledDualSparkVllmEndpoint: sparkRecovery.endpoint,
}));

import {
  isNemoClawManagedVllmRunning,
  persistConfiguredDualStationVllmRuntimeReceipt,
  persistConfiguredManagedVllmRuntimeReceipt,
} from "./vllm";

describe("managed vLLM Spark recovery", () => {
  beforeEach(() => {
    sparkRecovery.endpoint.mockReset();
  });

  it("recognizes and confirms an installer-owned Spark receipt", async () => {
    sparkRecovery.endpoint.mockReturnValue({
      baseUrl: "http://10.40.0.1:8000",
      apiKey: "a".repeat(64),
    });

    expect(isNemoClawManagedVllmRunning()).toBe(true);
    await expect(persistConfiguredManagedVllmRuntimeReceipt()).resolves.toEqual({
      ok: true,
      persisted: true,
    });
    await expect(persistConfiguredDualStationVllmRuntimeReceipt()).resolves.toEqual({
      ok: true,
      persisted: true,
    });
  });

  it("fails closed instead of falling through when Spark receipt recovery is unsafe", async () => {
    sparkRecovery.endpoint.mockImplementation(() => {
      throw new Error("receipt-owned container IDs changed");
    });

    await expect(persistConfiguredManagedVllmRuntimeReceipt()).resolves.toEqual({
      ok: false,
      reason: "managed vLLM recovery failed: receipt-owned container IDs changed",
    });
  });
});
