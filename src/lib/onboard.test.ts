// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("lib/onboard — gateway cleanup on final failure", () => {
  let destroyGatewaySpy: ReturnType<typeof vi.fn>;
  let runOpenshellSpy: ReturnType<typeof vi.fn>;
  let runSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    destroyGatewaySpy = vi.fn();
    runOpenshellSpy = vi.fn().mockReturnValue({ status: 0 });
    runSpy = vi.fn();

    vi.mock("../../dist/lib/onboard", async () => {
      const actual = await vi.importActual<typeof import("../../dist/lib/onboard")>("../../dist/lib/onboard");
      return {
        ...actual,
        destroyGateway: destroyGatewaySpy,
        runOpenshell: runOpenshellSpy,
        run: runSpy,
      };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls destroyGateway() when gateway start fails after exhausting retries", async () => {
    const onboardModule = await import("../../dist/lib/onboard");
    const originalPRetry = await vi.importActual<{ default: typeof import("p-retry") }>("p-retry");

    const pRetrySpy = vi.spyOn(originalPRetry.default, "default").mockImplementation(async (fn, opts) => {
      const { onFailedAttempt } = opts || {};
      for (let attempt = 1; attempt <= (opts?.retries ?? 2) + 1; attempt++) {
        if (onFailedAttempt) {
          onFailedAttempt({ attemptNumber: attempt, retriesLeft: Math.max(0, (opts?.retries ?? 2) + 1 - attempt), message: "Gateway start failed" } as Error & { attemptNumber: number; retriesLeft: number });
        }
      }
      throw new Error("Gateway failed to start");
    });

    const gpu = { name: "nvidia", memory_gb: 0, vram_gb: 0, cuda_version: "12.0" as const };

    try {
      await onboardModule.startGatewayWithOptions(gpu, { exitOnFailure: true });
    } catch {
      expect(destroyGatewaySpy).toHaveBeenCalled();
    }

    pRetrySpy.mockRestore();
  });
});
