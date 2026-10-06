// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { nativeCompatibleFixture } from "../inference/native-compatible/switch.test-support";
import { retireDestroyedSandboxCompatibleProvider } from "./sandbox-provider-cleanup";

describe("destroyed sandbox compatible provider retirement", () => {
  async function fixture() {
    const f = await nativeCompatibleFixture();
    const getAuthority = vi.fn(() => f.receipt);
    const clearAuthority = vi.fn();
    const run = (deletionConfirmed = true) =>
      retireDestroyedSandboxCompatibleProvider(
        {
          deletionConfirmed,
          gatewayName: "nemoclaw",
          expected: f.receipt,
        },
        { providerAdapter: f.providerAdapter, getAuthority, clearAuthority },
      );
    return { ...f, getAuthority, clearAuthority, run };
  }
  it("removes the exact unused identity after confirmed sandbox deletion", async () => {
    const f = await fixture();
    await f.run();
    expect(f.getAuthority).toHaveBeenCalledWith("nemoclaw", f.receipt.profileId);
    expect(f.adapter.deleteProvider).toHaveBeenCalledOnce();
    expect(f.clearAuthority).toHaveBeenCalledWith("nemoclaw", f.receipt);
  });
  it("does not retire resources during unconfirmed forced local cleanup", async () => {
    const f = await fixture();
    await f.run(false);
    expect(f.getAuthority).not.toHaveBeenCalled();
    expect(f.adapter.deleteProvider).not.toHaveBeenCalled();
    expect(f.clearAuthority).not.toHaveBeenCalled();
  });
  it("refuses replaced ownership before a remote mutation", async () => {
    const f = await fixture();
    f.getAuthority.mockReturnValue({ ...f.receipt, providerId: "replacement" });
    await expect(f.run()).rejects.toThrow("ownership changed");
    expect(f.adapter.getProvider).not.toHaveBeenCalled();
    expect(f.adapter.deleteProvider).not.toHaveBeenCalled();
    expect(f.clearAuthority).not.toHaveBeenCalled();
  });
  it("retains a provider and its authority while a peer uses it", async () => {
    const f = await fixture();
    vi.spyOn(f.providerAdapter, "deleteProvider").mockResolvedValue({
      ok: false,
      error: {
        kind: "command",
        reason: "attached",
        message: "attached",
        attachedSandboxes: ["peer"],
      },
    });
    await f.run();
    expect(f.adapter.detachProvider).not.toHaveBeenCalled();
    expect(f.clearAuthority).not.toHaveBeenCalled();
  });
  it("propagates uncertain deletion so the caller retains sandbox recovery state", async () => {
    const f = await fixture();
    f.adapter.deleteProvider.mockResolvedValue({ ok: true });
    await expect(f.run()).rejects.toThrow("not confirmed");
    expect(f.clearAuthority).not.toHaveBeenCalled();
  });
});
