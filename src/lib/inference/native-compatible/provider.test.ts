// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter";
import {
  ensureNativeCompatibleProvider,
  ensureNativeCompatibleProviderAttached,
  prepareNativeCompatibleProfile,
  verifyNativeCompatibleProviderAttachment,
} from "./profile";

const input = {
  endpointUrl: "https://api.example.com/v1",
  api: "openai-responses",
  lookup: async () => [{ address: "93.184.216.34", family: 4 }],
  target: { kind: "selected" } as const,
};

async function fixture() {
  const profile = await prepareNativeCompatibleProfile(input);
  const metadata = {
    name: profile.providerName,
    type: profile.profileId,
    credentialKeys: [profile.credentialEnv],
    configKeys: [],
    revision: { id: "owned-provider", resourceVersion: 1 },
  };
  const getProvider = vi
    .fn<OpenShellProviderAdapter["getProvider"]>()
    .mockResolvedValue({ ok: true, value: metadata });
  const createProvider = vi
    .fn<OpenShellProviderAdapter["createProvider"]>()
    .mockResolvedValue({ ok: true });
  const updateProvider = vi
    .fn<OpenShellProviderAdapter["updateProvider"]>()
    .mockResolvedValue({ ok: true });
  const importProviderProfile = vi
    .fn<OpenShellProviderAdapter["importProviderProfile"]>()
    .mockReturnValue({ ok: true });
  const adapter = {
    getProvider,
    createProvider,
    updateProvider,
    importProviderProfile,
  } as unknown as OpenShellProviderAdapter;
  return {
    profile,
    metadata,
    adapter,
    getProvider,
    createProvider,
    updateProvider,
    importProviderProfile,
  };
}

describe("native compatible provider ownership", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("withholds invalid trust environment contents before any provider operation", async () => {
    const f = await fixture();
    vi.stubEnv("NEMOCLAW_TRUSTED_PRIVATE_HOSTS", "https://user:opaque-test-secret@example.com");
    await expect(
      ensureNativeCompatibleProvider({
        ...input,
        adapter: f.adapter,
        credentialValue: "opaque-credential",
      }),
    ).rejects.toThrow("Invalid trusted private inference host configuration.");
    expect(f.getProvider).not.toHaveBeenCalled();
    expect(f.importProviderProfile).not.toHaveBeenCalled();
  });

  it.each([
    ["attachment", ensureNativeCompatibleProviderAttached],
    ["verification", verifyNativeCompatibleProviderAttachment],
  ] as const)(
    "withholds invalid trust environment contents during %s",
    async (_name, operation) => {
      const f = await fixture();
      const inspectProviderProfile = vi.fn();
      const listProviderAttachments = vi.fn();
      const attachProvider = vi.fn();
      vi.stubEnv(
        "NEMOCLAW_TRUSTED_PRIVATE_INFERENCE_HOSTS",
        "https://user:opaque-test-secret@example.com",
      );
      await expect(
        operation({
          adapter: {
            ...f.adapter,
            inspectProviderProfile,
            listProviderAttachments,
            attachProvider,
          },
          target: input.target,
          sandboxName: "selected",
          expected: {
            schemaVersion: 1,
            profileId: f.profile.profileId,
            providerName: f.profile.providerName,
            providerId: "owned-provider",
            endpointUrl: f.profile.endpoint,
            api: f.profile.api,
            addresses: f.profile.addresses,
          },
        }),
      ).rejects.toThrow(new Error("Invalid trusted private inference host configuration."));
      expect(inspectProviderProfile).not.toHaveBeenCalled();
      expect(listProviderAttachments).not.toHaveBeenCalled();
      expect(attachProvider).not.toHaveBeenCalled();
      expect(f.importProviderProfile).not.toHaveBeenCalled();
    },
  );

  it("observes an ambiguous creation without repeating the mutation", async () => {
    const f = await fixture();
    f.getProvider.mockResolvedValueOnce({
      ok: false,
      error: { kind: "command", reason: "not_found", message: "absent" },
    });
    f.createProvider.mockResolvedValueOnce({
      ok: false,
      error: { kind: "timeout", message: "unknown result" },
    });
    const result = await ensureNativeCompatibleProvider({
      ...input,
      adapter: f.adapter,
      credentialValue: "test-secret",
    });
    expect(result.providerId).toBe("owned-provider");
    expect(f.createProvider).toHaveBeenCalledTimes(1);
    expect(f.getProvider).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain("test-secret");
  });

  it("refuses an existing provider without a matching ownership receipt", async () => {
    const f = await fixture();
    await expect(
      ensureNativeCompatibleProvider({
        ...input,
        adapter: f.adapter,
        credentialValue: "test-secret",
      }),
    ).rejects.toThrow("ownership receipt");
    expect(f.updateProvider).not.toHaveBeenCalled();
    expect(f.createProvider).not.toHaveBeenCalled();
  });

  it("refuses a receipt for another endpoint before importing a profile", async () => {
    const f = await fixture();
    await expect(
      ensureNativeCompatibleProvider({
        ...input,
        adapter: f.adapter,
        credentialValue: "test-secret",
        expected: {
          schemaVersion: 1,
          profileId: "other-profile",
          providerName: "other-provider",
          providerId: "owned-provider",
        },
      }),
    ).rejects.toThrow("selected profile");
    expect(f.importProviderProfile).not.toHaveBeenCalled();
    expect(f.createProvider).not.toHaveBeenCalled();
    expect(f.updateProvider).not.toHaveBeenCalled();
  });

  it("keeps credentials out of the temporary profile and removes it after success", async () => {
    const f = await fixture();
    let profilePath = "";
    f.importProviderProfile.mockImplementation((request) => {
      profilePath = request.profilePath;
      expect(fs.readFileSync(profilePath, "utf8")).not.toContain("test-secret");
      return { ok: true };
    });
    await ensureNativeCompatibleProvider({
      ...input,
      adapter: f.adapter,
      credentialValue: "test-secret",
      expected: {
        schemaVersion: 1,
        profileId: f.profile.profileId,
        providerName: f.profile.providerName,
        providerId: "owned-provider",
      },
    });
    expect(fs.existsSync(profilePath)).toBe(false);
    expect(f.updateProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: [{ name: f.profile.credentialEnv, value: "test-secret" }],
      }),
    );
  });
});

it("retains issued address pins during observation after DNS rotates", async () => {
  const f = await fixture();
  const expected = {
    schemaVersion: 1 as const,
    profileId: f.profile.profileId,
    providerName: f.profile.providerName,
    providerId: "owned-provider",
    endpointUrl: f.profile.endpoint,
    api: f.profile.api,
    addresses: f.profile.addresses,
  };
  const lookup = vi.fn(async () => [{ address: "93.184.216.35", family: 4 }]);
  const inspectProviderProfile = vi.fn().mockResolvedValue({ ok: true });
  const listProviderAttachments = vi.fn().mockResolvedValue({
    ok: true,
    value: { names: [expected.providerName] },
  });
  await verifyNativeCompatibleProviderAttachment({
    adapter: { ...f.adapter, inspectProviderProfile, listProviderAttachments },
    target: input.target,
    sandboxName: "selected",
    expected,
    lookup,
  });
  expect(lookup).not.toHaveBeenCalled();
  expect(inspectProviderProfile).toHaveBeenCalledWith(
    expect.objectContaining({
      profileType: expected.profileId,
    }),
  );
  expect(JSON.stringify(inspectProviderProfile.mock.calls[0])).toContain("93.184.216.34");
  expect(JSON.stringify(inspectProviderProfile.mock.calls[0])).not.toContain("93.184.216.35");
  expect(f.importProviderProfile).not.toHaveBeenCalled();
  expect(f.updateProvider).not.toHaveBeenCalled();
});

it("uses a separate immutable profile when a selection resolves a new address set", async () => {
  const oldProfile = await prepareNativeCompatibleProfile(input);
  const next = await prepareNativeCompatibleProfile({
    ...input,
    lookup: async () => [{ address: "93.184.216.35", family: 4 }],
  });
  expect(next.profileId).not.toBe(oldProfile.profileId);
  expect(next.providerName).not.toBe(oldProfile.providerName);
  const getProvider = vi
    .fn()
    .mockResolvedValueOnce({ ok: false, error: { kind: "command", reason: "not_found" } })
    .mockResolvedValue({
      ok: true,
      value: {
        name: next.providerName,
        type: next.profileId,
        credentialKeys: [next.credentialEnv],
        configKeys: [],
        revision: { id: "new-address-provider", resourceVersion: 1 },
      },
    });
  const createProvider = vi.fn().mockResolvedValue({ ok: true });
  const updateProvider = vi.fn();
  const importProviderProfile = vi.fn().mockResolvedValue({ ok: true });
  const resolveExpected = vi.fn().mockReturnValue(undefined);
  const receipt = await ensureNativeCompatibleProvider({
    ...input,
    lookup: async () => [{ address: "93.184.216.35", family: 4 }],
    adapter: {
      getProvider,
      createProvider,
      updateProvider,
      importProviderProfile,
    } as unknown as OpenShellProviderAdapter,
    credentialValue: "test-secret",
    resolveExpected,
  });
  expect(resolveExpected).toHaveBeenCalledWith(next.profileId);
  expect(receipt.addresses).toEqual(["93.184.216.35"]);
  expect(receipt.profileId).toBe(next.profileId);
  expect(updateProvider).not.toHaveBeenCalled();
  expect(createProvider).toHaveBeenCalledTimes(1);
});
