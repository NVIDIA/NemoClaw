// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { rollbackNativeBedrockSelection, retireUnusedBedrockProvider } from "./switch";
import { nativeBedrockSwitchFixture } from "./switch.test-support";

function fixture() {
  const f = nativeBedrockSwitchFixture();
  const deps = {
    listSandboxes: () => ({ sandboxes: [] }),
    providerAdapter: f.providerAdapter,
    resolveCredentialValue: vi.fn(() => ""),
    log: vi.fn(),
    verifyBedrockAdapterGeneration: vi.fn(async () => {}),
    clearNativeBedrockProviderAuthority: vi.fn(),
  };
  return { ...f, deps };
}

describe("Bedrock switch recovery", () => {
  it("restores the prior attachment when a departure fails before registry commit", async () => {
    const f = fixture();
    f.attachments.clear();
    await rollbackNativeBedrockSelection({
      committed: false,
      changed: false,
      previousDetached: true,
      previousAttachment: f.receipt,
      sandboxName: "alpha",
      deps: f.deps,
    });
    expect(f.attachments.has(f.receipt.providerName)).toBe(true);
    expect(f.deps.verifyBedrockAdapterGeneration).toHaveBeenCalledWith(f.receipt);
    expect(f.adapter.deleteProvider).not.toHaveBeenCalled();
    expect(f.deps.clearNativeBedrockProviderAuthority).not.toHaveBeenCalled();
  });

  it("restores the previous attachment after an ambiguous detach and retains ownership", async () => {
    const f = fixture();
    f.adapter.detachProvider.mockImplementationOnce(async () => {
      f.attachments.clear();
      throw new Error("detach transport failed");
    });
    await expect(
      rollbackNativeBedrockSelection({
        committed: false,
        changed: true,
        attachment: f.receipt,
        previousDetached: true,
        previousAttachment: f.receipt,
        sandboxName: "alpha",
        deps: f.deps,
      }),
    ).rejects.toThrow("detach transport failed");
    expect(f.attachments.has(f.receipt.providerName)).toBe(true);
    expect(f.adapter.attachProvider).toHaveBeenCalledOnce();
    expect(f.adapter.deleteProvider).not.toHaveBeenCalled();
    expect(f.deps.clearNativeBedrockProviderAuthority).not.toHaveBeenCalled();
  });

  it("does not roll back a committed selection when later config sync fails", async () => {
    const f = fixture();
    await rollbackNativeBedrockSelection({
      committed: true,
      changed: true,
      attachment: f.receipt,
      previousDetached: false,
      sandboxName: "alpha",
      deps: f.deps,
    });
    expect(f.adapter.detachProvider).not.toHaveBeenCalled();
    expect(f.adapter.deleteProvider).not.toHaveBeenCalled();
    expect(f.attachments.has(f.receipt.providerName)).toBe(true);
  });

  it("retains recovery authority when provider deletion cannot be confirmed", async () => {
    const f = fixture();
    f.adapter.deleteProvider.mockImplementationOnce(async () => ({ ok: true }));
    await retireUnusedBedrockProvider(f.receipt, f.deps);
    expect(f.adapter.getProvider).toHaveBeenCalledTimes(2);
    expect(f.deps.clearNativeBedrockProviderAuthority).not.toHaveBeenCalled();
    expect(f.deps.log).toHaveBeenCalledWith(expect.stringContaining("ownership is retained"));
    expect(f.adapter.detachProvider).not.toHaveBeenCalled();
  });
});
