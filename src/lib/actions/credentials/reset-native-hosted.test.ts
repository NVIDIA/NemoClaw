// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { createCliOpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter-cli";
import {
  HOSTED_NATIVE_PROVIDERS,
  hostedNativeProvider,
} from "../../inference/native-provider/hosted";
import { resetNativeHostedProvider } from "./reset-native-hosted";

const target = { kind: "named", gatewayName: "gateway" } as const;
const absent = {
  ok: false,
  error: { kind: "command", reason: "not_found", message: "absent" },
} as const;
function fixture(provider = "openai-api") {
  const definition = hostedNativeProvider(provider)!;
  const receipt = {
    schemaVersion: 1 as const,
    profileId: definition.profileId,
    providerName: definition.providerName,
    providerId: "owned-id",
  };
  const metadata = {
    name: definition.providerName,
    type: definition.profileId,
    credentialKeys: [definition.credentialEnv],
    configKeys: [],
    revision: { id: "owned-id", resourceVersion: 1 },
  };
  const adapter = createCliOpenShellProviderAdapter();
  const get = vi.spyOn(adapter, "getProvider").mockResolvedValue(absent);
  const remove = vi.spyOn(adapter, "deleteProvider").mockResolvedValue({ ok: true });
  const detach = vi.spyOn(adapter, "detachProvider");
  const clear = vi.fn();
  const deps = {
    getNativeHostedProviderAuthority: () => receipt,
    getNativeHostedProviderAuthorityByName: () => receipt,
    clearNativeHostedProviderAuthority: clear,
    listNativeHostedProviderAttachmentSandboxNames: () => [],
  };
  return { definition, receipt, metadata, adapter, get, remove, detach, clear, deps };
}

describe("native hosted credential reset", () => {
  it.each(HOSTED_NATIVE_PROVIDERS)(
    "deletes only the owned $label resource and confirms absence",
    async (definition) => {
      const f = fixture(definition.logicalProvider);
      f.get
        .mockResolvedValueOnce(absent)
        .mockResolvedValueOnce({ ok: true, value: f.metadata })
        .mockResolvedValueOnce(absent);
      expect(
        (await resetNativeHostedProvider(definition.logicalProvider, target, f.adapter, f.deps))
          ?.exitCode,
      ).toBe(0);
      expect(f.remove).toHaveBeenCalledExactlyOnceWith({
        target,
        providerName: definition.providerName,
      });
      expect(f.clear).toHaveBeenCalledWith("gateway", f.receipt);
      expect(f.detach).not.toHaveBeenCalled();
    },
  );

  it("preserves a separate user-owned legacy provider when given the logical name", async () => {
    const f = fixture();
    f.get.mockResolvedValue({
      ok: true,
      value: { ...f.metadata, name: "openai-api", type: "openai" },
    });
    expect(
      (await resetNativeHostedProvider("openai-api", target, f.adapter, f.deps))?.failureLines.join(
        " ",
      ),
    ).toContain("preserved");
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.clear).not.toHaveBeenCalled();
  });

  it("keeps the legacy resource when the user selects the native name explicitly", async () => {
    const f = fixture();
    f.get.mockResolvedValueOnce({ ok: true, value: f.metadata }).mockResolvedValueOnce(absent);
    expect(
      (await resetNativeHostedProvider(f.definition.providerName, target, f.adapter, f.deps))
        ?.exitCode,
    ).toBe(0);
    expect(
      f.get.mock.calls.every(([request]) => request.providerName === f.definition.providerName),
    ).toBe(true);
  });

  it("refuses removal while another sandbox records the provider", async () => {
    const f = fixture();
    expect(
      (
        await resetNativeHostedProvider("openai-api", target, f.adapter, {
          ...f.deps,
          listNativeHostedProviderAttachmentSandboxNames: () => ["other"],
        })
      )?.exitCode,
    ).toBe(1);
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.clear).not.toHaveBeenCalled();
  });

  it("refuses an identity replacement without deleting or clearing authority", async () => {
    const f = fixture();
    f.get.mockResolvedValueOnce(absent).mockResolvedValueOnce({
      ok: true,
      value: { ...f.metadata, revision: { id: "foreign-id", resourceVersion: 1 } },
    });
    expect(
      (await resetNativeHostedProvider("openai-api", target, f.adapter, f.deps))?.exitCode,
    ).toBe(1);
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.clear).not.toHaveBeenCalled();
  });

  it("observes a timed-out delete without a second mutation", async () => {
    const f = fixture();
    f.get
      .mockResolvedValueOnce(absent)
      .mockResolvedValueOnce({ ok: true, value: f.metadata })
      .mockResolvedValueOnce(absent);
    f.remove.mockResolvedValue({ ok: false, error: { kind: "timeout", message: "unknown" } });
    expect(
      (await resetNativeHostedProvider("openai-api", target, f.adapter, f.deps))?.exitCode,
    ).toBe(0);
    expect(f.remove).toHaveBeenCalledTimes(1);
    expect(f.clear).toHaveBeenCalledTimes(1);
  });

  it("retains authority when deletion or its observation does not confirm absence", async () => {
    const f = fixture();
    f.get.mockResolvedValueOnce(absent).mockResolvedValue({ ok: true, value: f.metadata });
    expect(
      (await resetNativeHostedProvider("openai-api", target, f.adapter, f.deps))?.exitCode,
    ).toBe(1);
    expect(f.remove).toHaveBeenCalledTimes(1);
    expect(f.clear).not.toHaveBeenCalled();
    expect(f.detach).not.toHaveBeenCalled();
  });

  it("refuses a logical reset when the legacy lookup fails", async () => {
    const f = fixture();
    f.get.mockResolvedValue({ ok: false, error: { kind: "timeout", message: "unknown" } });
    expect(
      (await resetNativeHostedProvider("openai-api", target, f.adapter, f.deps))?.exitCode,
    ).toBe(1);
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.clear).not.toHaveBeenCalled();
  });
});
