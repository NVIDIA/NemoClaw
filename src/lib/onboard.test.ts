// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../dist/lib/onboard", async () => {
  const actual = await vi.importActual<typeof import("../../dist/lib/onboard")>("../../dist/lib/onboard");
  return {
    ...actual,
    destroyGateway: vi.fn(),
    runOpenshell: vi.fn().mockReturnValue({ status: 0 }),
    run: vi.fn(),
  };
});

describe("lib/onboard — gateway cleanup on final failure", () => {
  let onboardModule: typeof import("../../dist/lib/onboard");
  let destroyGatewayMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    onboardModule = await import("../../dist/lib/onboard");
    destroyGatewayMock = (onboardModule as { destroyGateway: ReturnType<typeof vi.fn> }).destroyGateway;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls destroyGateway() in the catch block after diagnostic logs when retries are exhausted", async () => {
    const originalPRetry = await vi.importActual<{ default: typeof import("p-retry") }>("p-retry");

    const pRetrySpy = vi.spyOn(originalPRetry.default, "default").mockImplementation(async (fn, opts) => {
      const { onFailedAttempt({ } = opts || {};
      for (let attempt = 1; attempt <= (opts?.retries ?? 2) + 1; attempt++) {
        if (onFailedAttempt({) {
    await       onFailedAttempt({ attemptNumber: attempt, retriesLeft: Math.max(0, (opts?.retries ?? 2) + 1 - attempt), message: "Gateway start failed" } as Error & { attemptNumber: number; retriesLeft: number });
        }
      }
      throw new Error("Gateway failed to start");
    });

    const gpu = { name: "nvidia", memory_gb: 0, vram_gb: 0, cuda_version: "12.0" as const };
    let threw = false;
    try {
      await onboardModule.startGatewayWithOptions(gpu, { exitOnFailure: true });
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    expect(destroyGatewayMock).toHaveBeenCalled();
    pRetrySpy.mockRestore();
  });
});
