// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  activateManagedStartupCorporateCaTrustAfterSandboxCreate,
  activateManagedStartupCorporateCaTrustBeforeIdentityRevalidation,
} from "./orchestration";

describe("managed startup corporate CA activation", () => {
  it("waits for OpenShell create completion before lifecycle activation", async () => {
    let completeCreate!: (created: string) => void;
    const create = new Promise<string>((resolve) => (completeCreate = resolve));
    const activate = vi.fn(async () => undefined);

    const completion = activateManagedStartupCorporateCaTrustAfterSandboxCreate({
      create,
      activate,
    });
    expect(activate).not.toHaveBeenCalled();

    completeCreate("created-sandbox");
    await expect(completion).resolves.toBe("created-sandbox");
    expect(activate).toHaveBeenCalledOnce();
  });

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
