// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES.
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { nativeCompatibleFixture } from "./switch.test-support";
import { retireNativeCompatibleProvider } from "./retire";

describe("unused compatible provider retirement", () => {
  async function fixture() {
    const f = await nativeCompatibleFixture();
    const clearAuthority = vi.fn();
    const run = () =>
      retireNativeCompatibleProvider({
        adapter: f.providerAdapter,
        target: { kind: "named", gatewayName: "nemoclaw" },
        expected: f.receipt,
        clearAuthority,
      });
    return { ...f, clearAuthority, run };
  }
  it("observes confirmed removal before clearing ownership", async () => {
    const f = await fixture();
    await f.run();
    expect(f.adapter.deleteProvider).toHaveBeenCalledOnce();
    expect(f.adapter.getProvider).toHaveBeenCalledTimes(2);
    expect(f.clearAuthority).toHaveBeenCalledOnce();
  });
  it("retains peers without detaching them", async () => {
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
    expect(f.clearAuthority).not.toHaveBeenCalled();
    expect(f.adapter.detachProvider).not.toHaveBeenCalled();
  });
  it("refuses a replacement identity without deletion", async () => {
    const f = await fixture();
    f.metadata.revision.id = "replacement";
    await expect(f.run()).rejects.toThrow("identity changed");
    expect(f.adapter.deleteProvider).not.toHaveBeenCalled();
    expect(f.clearAuthority).not.toHaveBeenCalled();
  });
  it("retains ownership when deletion cannot be confirmed", async () => {
    const f = await fixture();
    f.adapter.deleteProvider.mockResolvedValue({ ok: true });
    await expect(f.run()).rejects.toThrow("not confirmed");
    expect(f.clearAuthority).not.toHaveBeenCalled();
  });
  it("reconciles ambiguous deletion once without retrying", async () => {
    const f = await fixture();
    const remove = f.adapter.deleteProvider.getMockImplementation()!;
    vi.spyOn(f.providerAdapter, "deleteProvider").mockImplementation(async () => {
      await remove();
      return {
        ok: false,
        error: { kind: "transport", reason: "connection_loss", message: "response lost" },
      };
    });
    await f.run();
    expect(f.adapter.deleteProvider).toHaveBeenCalledOnce();
    expect(f.clearAuthority).toHaveBeenCalledOnce();
  });
  it("clears an already absent identity without another mutation", async () => {
    const f = await fixture();
    await f.adapter.deleteProvider();
    f.adapter.deleteProvider.mockClear();
    await f.run();
    expect(f.adapter.deleteProvider).not.toHaveBeenCalled();
    expect(f.clearAuthority).toHaveBeenCalledOnce();
  });
});
