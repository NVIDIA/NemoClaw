// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDestroyHarness,
  resetDestroyModuleCache,
} from "../../../../test/helpers/destroy-flow-test-harness";
import { nativeCompatibleFixture } from "../../inference/native-compatible/switch.test-support";

import { nativeBedrockSwitchFixture } from "../../inference/native-bedrock/switch.test-support";
import {
  retireDestroyedSandboxCompatibleProvider,
  retireDestroyedSandboxBedrockProvider,
} from "../../onboard/sandbox-provider-cleanup";

describe("destroy compatible inference cleanup boundary", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "destroy-compatible-"));
    vi.stubEnv("HOME", home);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetDestroyModuleCache();
    fs.rmSync(home, { recursive: true, force: true });
  });
  it("retires after confirmed deletion and before removing recovery state", async () => {
    const { receipt } = await nativeCompatibleFixture();
    const h = createDestroyHarness({
      registryEntryOverrides: { nativeCompatibleProviderAttachment: receipt },
    });
    h.retireCompatibleProviderSpy.mockImplementation(async () => {
      expect(h.events).toContain("delete");
      expect(h.removeSandboxSpy).not.toHaveBeenCalled();
    });
    await h.destroySandbox("alpha", { yes: true, cleanupGateway: false });
    expect(h.retireCompatibleProviderSpy).toHaveBeenCalledWith(
      {
        deletionConfirmed: true,
        gatewayName: "nemoclaw-19080",
        expected: receipt,
      },
      { runOpenshell: expect.any(Function) },
    );
    expect(h.removeSandboxSpy).toHaveBeenCalledOnce();
  });
  it("keeps the registry and session when retirement remains uncertain", async () => {
    const { receipt } = await nativeCompatibleFixture();
    const h = createDestroyHarness({
      registryEntryOverrides: { nativeCompatibleProviderAttachment: receipt },
    });
    h.retireCompatibleProviderSpy.mockRejectedValue(new Error("removal not confirmed"));
    await expect(h.destroySandbox("alpha", { yes: true, cleanupGateway: false })).rejects.toThrow(
      "removal not confirmed",
    );
    expect(h.removeSandboxSpy).not.toHaveBeenCalled();
    expect(h.compareAndSwapSessionSpy).not.toHaveBeenCalled();
  });
  it.each(["compatible", "bedrock"] as const)(
    "retains recovery state when %s deletion reports an unexpected attachment",
    async (kind) => {
      const clearAuthority = vi.fn();
      const compatible = await nativeCompatibleFixture();
      const bedrock = nativeBedrockSwitchFixture("nemoclaw-19080");
      const h = createDestroyHarness({
        registryEntryOverrides:
          kind === "compatible"
            ? { nativeCompatibleProviderAttachment: compatible.receipt }
            : { nativeBedrockProviderAttachment: bedrock.receipt },
      });
      const selected = kind === "compatible" ? compatible : bedrock;
      vi.spyOn(selected.providerAdapter, "deleteProvider").mockResolvedValue({
        ok: false,
        error: {
          kind: "command",
          reason: "attached",
          message: "attached",
          attachedSandboxes: ["unregistered-peer"],
        },
      });
      h.retireCompatibleProviderSpy.mockImplementation((input) =>
        retireDestroyedSandboxCompatibleProvider(input, {
          providerAdapter: compatible.providerAdapter,
          getAuthority: () => compatible.receipt,
          clearAuthority,
        }),
      );
      h.retireBedrockProviderSpy.mockImplementation((input) =>
        retireDestroyedSandboxBedrockProvider(input, {
          providerAdapter: bedrock.providerAdapter,
          getAuthority: () => bedrock.receipt,
          clearAuthority,
        }),
      );
      await expect(h.destroySandbox("alpha", { yes: true, cleanupGateway: false })).rejects.toThrow(
        "remains attached",
      );
      expect(h.removeSandboxSpy).not.toHaveBeenCalled();
      expect(h.compareAndSwapSessionSpy).not.toHaveBeenCalled();
      expect(clearAuthority).not.toHaveBeenCalled();
    },
  );

  it.each(["compatible", "bedrock"] as const)(
    "retries %s cleanup after retirement succeeded and a later service stop failed",
    async (kind) => {
      const compatible = await nativeCompatibleFixture();
      const bedrock = nativeBedrockSwitchFixture("nemoclaw-19080");
      let compatibleAuthority: typeof compatible.receipt | undefined = compatible.receipt;
      let bedrockAuthority: typeof bedrock.receipt | undefined = bedrock.receipt;
      const h = createDestroyHarness({
        registeredSandboxCount: 1,
        registryEntryOverrides:
          kind === "compatible"
            ? { nativeCompatibleProviderAttachment: compatible.receipt }
            : { nativeBedrockProviderAttachment: bedrock.receipt },
      });
      h.retireCompatibleProviderSpy.mockImplementation((input) =>
        retireDestroyedSandboxCompatibleProvider(input, {
          providerAdapter: compatible.providerAdapter,
          getAuthority: () => compatibleAuthority,
          clearAuthority: () => {
            compatibleAuthority = undefined;
          },
        }),
      );
      h.retireBedrockProviderSpy.mockImplementation((input) =>
        retireDestroyedSandboxBedrockProvider(input, {
          providerAdapter: bedrock.providerAdapter,
          getAuthority: () => bedrockAuthority,
          clearAuthority: () => {
            bedrockAuthority = undefined;
          },
        }),
      );
      h.stopAllSpy.mockImplementationOnce(() => {
        throw new Error("service stop failed");
      });
      await expect(h.destroySandbox("alpha", { yes: true, cleanupGateway: false })).rejects.toThrow(
        "service stop failed",
      );
      const selected = kind === "compatible" ? compatible : bedrock;
      expect(selected.adapter.deleteProvider).toHaveBeenCalledOnce();
      expect(h.removeSandboxSpy).not.toHaveBeenCalled();
      expect(h.compareAndSwapSessionSpy).not.toHaveBeenCalled();
      await h.destroySandbox("alpha", { yes: true, cleanupGateway: false });
      expect(selected.adapter.deleteProvider).toHaveBeenCalledOnce();
      expect(h.removeSandboxSpy).toHaveBeenCalledOnce();
    },
  );

  it("retains provider access reserved by a pending peer after deleting the selected sandbox", async () => {
    const { receipt } = await nativeCompatibleFixture();
    const h = createDestroyHarness({
      registryEntryOverrides: { nativeCompatibleProviderAttachment: receipt },
    });
    vi.mocked(h.registry.listSandboxes).mockReturnValue({
      sandboxes: [
        h.registry.getSandbox("alpha")!,
        {
          name: "pending-peer",
          gatewayName: "nemoclaw-19080",
          pendingRouteReservation: true,
          nativeCompatibleProviderAttachment: receipt,
        },
      ],
      defaultSandbox: "alpha",
    });
    await h.destroySandbox("alpha", { yes: true, cleanupGateway: false });
    expect(h.retireCompatibleProviderSpy).not.toHaveBeenCalled();
    expect(h.removeSandboxSpy).toHaveBeenCalledOnce();
  });
});
