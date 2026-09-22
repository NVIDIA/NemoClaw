// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  activateManagedStartupCorporateCaTrustAfterSandboxCreate,
  activateManagedStartupCorporateCaTrustBeforeIdentityRevalidation,
} from "./orchestration";

const verifiedBoundary = {
  sandboxName: "alpha",
  gatewayName: "owned-gateway",
  gatewayPort: 8080,
  lifecycleGeneration: "generation-1",
  lifecycleLiveIdentityFingerprint: "a".repeat(64),
  route: "none" as const,
};

describe("managed startup corporate CA activation", () => {
  it("waits for create completion and refresh completion", async () => {
    let completeCreate!: (created: string) => void;
    let completeRefresh!: () => void;
    const refreshCorporateCaTrust = vi.fn(
      () => new Promise<void>((resolve) => (completeRefresh = resolve)),
    );
    const completion = activateManagedStartupCorporateCaTrustAfterSandboxCreate({
      create: new Promise<string>((resolve) => (completeCreate = resolve)),
      corporateCaB64: "Y2EtYnVuZGxl",
      sandboxName: "alpha",
      requireVerifiedCreateBoundary: () => verifiedBoundary,
      refreshCorporateCaTrust,
      revalidateSandboxIdentity: vi.fn(),
      recordRecovery: vi.fn(),
    });
    expect(refreshCorporateCaTrust).not.toHaveBeenCalled();
    completeCreate("created-sandbox");
    await vi.waitFor(() => expect(refreshCorporateCaTrust).toHaveBeenCalledOnce());
    let settled = false;
    void completion.finally(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    completeRefresh();
    await expect(completion).resolves.toBe("created-sandbox");
  });

  it.each(["supervisor stop failed", "supervisor start failed"])(
    "retains recovery when %s",
    async (message) => {
      const recordRecovery = vi.fn();
      await expect(
        activateManagedStartupCorporateCaTrustAfterSandboxCreate({
          create: Promise.resolve("created-sandbox"),
          corporateCaB64: "Y2EtYnVuZGxl",
          sandboxName: "alpha",
          requireVerifiedCreateBoundary: () => verifiedBoundary,
          refreshCorporateCaTrust: async () => Promise.reject(new Error(message)),
          revalidateSandboxIdentity: vi.fn(),
          recordRecovery,
        }),
      ).rejects.toThrow(message);
      expect(recordRecovery).toHaveBeenCalledOnce();
    },
  );

  it("refreshes the exact sandbox before revalidation only when a corporate CA exists", async () => {
    let completeRefresh!: () => void;
    const refreshCorporateCaTrust = vi.fn(
      () => new Promise<void>((resolve) => (completeRefresh = resolve)),
    );
    const revalidateSandboxIdentity = vi.fn();
    const activate = (corporateCaB64: string | null) =>
      activateManagedStartupCorporateCaTrustBeforeIdentityRevalidation({
        corporateCaB64,
        sandboxName: "alpha",
        boundary: {
          gatewayName: "owned-gateway",
          lifecycleLiveIdentityFingerprint: "a".repeat(64),
        },
        refreshCorporateCaTrust,
        revalidateSandboxIdentity,
      });
    const activation = activate("Y2EtYnVuZGxl");
    expect(refreshCorporateCaTrust).toHaveBeenCalledExactlyOnceWith({
      sandboxName: "alpha",
      sandboxIdentityFingerprint: "a".repeat(64),
      target: { kind: "named", gatewayName: "owned-gateway" },
    });
    expect(revalidateSandboxIdentity).not.toHaveBeenCalled();
    completeRefresh();
    await activation;
    expect(revalidateSandboxIdentity).toHaveBeenCalledOnce();
    refreshCorporateCaTrust.mockClear();
    revalidateSandboxIdentity.mockClear();
    await activate(null);
    expect(refreshCorporateCaTrust).not.toHaveBeenCalled();
    expect(revalidateSandboxIdentity).toHaveBeenCalledOnce();
  });
});
