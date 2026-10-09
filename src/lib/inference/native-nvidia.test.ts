// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";

import type { OpenShellProviderAdapter } from "../adapters/openshell/provider-adapter";
import { parseCheckedInProviderProfileContract } from "../adapters/openshell/provider-profile";
import {
  ensureNativeNvidiaProvider,
  ensureNativeNvidiaProviderAttached,
  nativeNvidiaProviderProfilePath,
  type NativeNvidiaProviderAttachment,
  NativeNvidiaProviderError,
  NVIDIA_HOSTED_CREDENTIAL_ENV,
  NVIDIA_HOSTED_NATIVE_PROFILE_ID,
  NVIDIA_HOSTED_NATIVE_PROVIDER,
  persistNativeNvidiaProviderAuthority,
  verifyNativeNvidiaProviderAttachment,
} from "./native-nvidia";

const target = { kind: "named", gatewayName: "nemoclaw" } as const;

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    name: NVIDIA_HOSTED_NATIVE_PROVIDER,
    type: NVIDIA_HOSTED_NATIVE_PROFILE_ID,
    credentialKeys: [NVIDIA_HOSTED_CREDENTIAL_ENV],
    configKeys: [],
    revision: { id: "provider-id", resourceVersion: 1 },
    ...overrides,
  };
}

function adapter(overrides: Partial<OpenShellProviderAdapter> = {}): OpenShellProviderAdapter {
  return {
    ensureProviderPolicyComposition: vi.fn(async () => ({ ok: true, value: undefined })),
    importProviderProfile: vi.fn(() => ({ ok: true })),
    getProvider: vi.fn(async () => ({ ok: true, value: metadata() })),
    createProvider: vi.fn(async () => ({ ok: true })),
    updateProvider: vi.fn(async () => ({ ok: true })),
    listProviderAttachments: vi.fn(async () => ({
      ok: true,
      value: { names: [NVIDIA_HOSTED_NATIVE_PROVIDER] },
    })),
    listProviders: vi.fn(),
    inspectProviderProfile: vi.fn(),
    deleteProvider: vi.fn(),
    detachProvider: vi.fn(async () => ({ ok: true })),
    attachProvider: vi.fn(async () => ({ ok: true })),
    configureProviderRefresh: vi.fn(),
    getProviderRefreshStatus: vi.fn(),
    ...overrides,
  } as OpenShellProviderAdapter;
}

describe("native NVIDIA OpenShell provider", () => {
  it("ships a profile limited to the native models and chat-completions operations (#12558)", () => {
    const source = fs.readFileSync(nativeNvidiaProviderProfilePath(), "utf8");
    const profile = parseCheckedInProviderProfileContract(source);

    expect(profile?.profileId).toBe(NVIDIA_HOSTED_NATIVE_PROFILE_ID);
    expect(profile?.boundary.endpoints).toEqual([
      expect.objectContaining({
        host: "integrate.api.nvidia.com",
        port: 443,
        enforcement: "enforce",
        rules: [
          { allow: { method: "GET", path: "/v1/models" } },
          { allow: { method: "POST", path: "/v1/chat/completions" } },
        ],
      }),
    ]);
    expect(profile?.boundary.binaries).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/[?*]/u)]),
    );
  });

  it("creates the internal provider once and records its immutable identity (#12558)", async () => {
    const getProvider = vi
      .fn<OpenShellProviderAdapter["getProvider"]>()
      .mockResolvedValueOnce({
        ok: false,
        error: { kind: "command", reason: "not_found", message: "not found" },
      })
      .mockResolvedValueOnce({ ok: true, value: metadata() });
    const createProvider = vi.fn<OpenShellProviderAdapter["createProvider"]>(async () => ({
      ok: true,
    }));
    const providerAdapter = adapter({ getProvider, createProvider });

    await expect(
      ensureNativeNvidiaProvider({
        adapter: providerAdapter,
        target,
        credentialValue: "opaque-test-secret",
      }),
    ).resolves.toEqual({
      schemaVersion: 1,
      profileId: NVIDIA_HOSTED_NATIVE_PROFILE_ID,
      providerName: NVIDIA_HOSTED_NATIVE_PROVIDER,
      providerId: "provider-id",
    });
    expect(createProvider).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        name: NVIDIA_HOSTED_NATIVE_PROVIDER,
        type: NVIDIA_HOSTED_NATIVE_PROFILE_ID,
        credentials: [{ name: NVIDIA_HOSTED_CREDENTIAL_ENV, value: "opaque-test-secret" }],
        config: [],
      }),
    );
  });

  it("removes a new provider when authority persistence fails (#12562)", async () => {
    let providerPresent = true;
    const getProvider = vi.fn<OpenShellProviderAdapter["getProvider"]>(async () =>
      providerPresent
        ? { ok: true, value: metadata() }
        : {
            ok: false,
            error: { kind: "command", reason: "not_found", message: "not found" },
          },
    );
    const deleteProvider = vi.fn<OpenShellProviderAdapter["deleteProvider"]>(async () => {
      providerPresent = false;
      return { ok: true };
    });
    const receipt = {
      schemaVersion: 1,
      profileId: NVIDIA_HOSTED_NATIVE_PROFILE_ID,
      providerName: NVIDIA_HOSTED_NATIVE_PROVIDER,
      providerId: "provider-id",
    } as const;

    await expect(
      persistNativeNvidiaProviderAuthority({
        adapter: adapter({ getProvider, deleteProvider }),
        target,
        gatewayName: "nemoclaw",
        receipt,
        readAuthority: () => undefined,
        writeAuthority: () => {
          throw new Error("state directory is read-only");
        },
      }),
    ).rejects.toThrow(/newly created provider was removed.*state directory is read-only/su);
    expect(deleteProvider).toHaveBeenCalledExactlyOnceWith({
      target,
      providerName: NVIDIA_HOSTED_NATIVE_PROVIDER,
    });
  });

  it("keeps a provider when a failed write persisted its authority (#12562)", async () => {
    const receipt = {
      schemaVersion: 1,
      profileId: NVIDIA_HOSTED_NATIVE_PROFILE_ID,
      providerName: NVIDIA_HOSTED_NATIVE_PROVIDER,
      providerId: "provider-id",
    } as const;
    let authority: NativeNvidiaProviderAttachment | undefined;
    const deleteProvider = vi.fn<OpenShellProviderAdapter["deleteProvider"]>();

    await expect(
      persistNativeNvidiaProviderAuthority({
        adapter: adapter({ deleteProvider }),
        target,
        gatewayName: "nemoclaw",
        receipt,
        readAuthority: () => authority,
        writeAuthority: (_gatewayName, value) => {
          authority = value;
          throw new Error("directory sync failed");
        },
      }),
    ).resolves.toBeUndefined();
    expect(deleteProvider).not.toHaveBeenCalled();
  });

  it("refuses cleanup when the provider identity changed after a failed write (#12562)", async () => {
    const deleteProvider = vi.fn<OpenShellProviderAdapter["deleteProvider"]>();

    await expect(
      persistNativeNvidiaProviderAuthority({
        adapter: adapter({
          getProvider: vi.fn<OpenShellProviderAdapter["getProvider"]>(async () => ({
            ok: true,
            value: metadata({
              revision: { id: "replacement-id", resourceVersion: 2 },
            }),
          })),
          deleteProvider,
        }),
        target,
        gatewayName: "nemoclaw",
        receipt: {
          schemaVersion: 1,
          profileId: NVIDIA_HOSTED_NATIVE_PROFILE_ID,
          providerName: NVIDIA_HOSTED_NATIVE_PROVIDER,
          providerId: "provider-id",
        },
        readAuthority: () => undefined,
        writeAuthority: () => {
          throw new Error("state directory is read-only");
        },
      }),
    ).rejects.toThrow(/credentials reset nvidia-prod.*identity changed/su);
    expect(deleteProvider).not.toHaveBeenCalled();
  });

  it("observes an ambiguous create result without issuing a second mutation (#12558)", async () => {
    const getProvider = vi
      .fn<OpenShellProviderAdapter["getProvider"]>()
      .mockResolvedValueOnce({
        ok: false,
        error: { kind: "command", reason: "not_found", message: "not found" },
      })
      .mockResolvedValueOnce({ ok: true, value: metadata() });
    const createProvider = vi.fn<OpenShellProviderAdapter["createProvider"]>(async () => ({
      ok: false,
      error: { kind: "timeout", message: "timed out" },
    }));

    await expect(
      ensureNativeNvidiaProvider({
        adapter: adapter({ getProvider, createProvider }),
        target,
        credentialValue: "opaque-test-secret",
      }),
    ).resolves.toMatchObject({ providerId: "provider-id" });
    expect(createProvider).toHaveBeenCalledOnce();
  });

  it("creates from an existing gateway credential when recreation has no local key (#12558)", async () => {
    const getProvider = vi
      .fn<OpenShellProviderAdapter["getProvider"]>()
      .mockResolvedValueOnce({
        ok: false,
        error: { kind: "command", reason: "not_found", message: "not found" },
      })
      .mockResolvedValueOnce({ ok: true, value: metadata() });
    const createProvider = vi.fn<OpenShellProviderAdapter["createProvider"]>(async () => ({
      ok: true,
    }));

    await expect(
      ensureNativeNvidiaProvider({
        adapter: adapter({ getProvider, createProvider }),
        target,
        credentialValue: null,
        reuseExistingCredential: true,
      }),
    ).resolves.toMatchObject({ providerId: "provider-id" });
    expect(createProvider).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        name: NVIDIA_HOSTED_NATIVE_PROVIDER,
        credentials: [],
        fromExisting: true,
      }),
    );
  });

  it("refuses a replaced provider before rotating its credential (#12558)", async () => {
    const updateProvider = vi.fn<OpenShellProviderAdapter["updateProvider"]>();

    await expect(
      ensureNativeNvidiaProvider({
        adapter: adapter({
          getProvider: vi.fn<OpenShellProviderAdapter["getProvider"]>(async () => ({
            ok: true,
            value: metadata({ revision: { id: "replacement-id", resourceVersion: 1 } }),
          })),
          updateProvider,
        }),
        target,
        credentialValue: "opaque-test-secret",
        expected: {
          schemaVersion: 1,
          profileId: NVIDIA_HOSTED_NATIVE_PROFILE_ID,
          providerName: NVIDIA_HOSTED_NATIVE_PROVIDER,
          providerId: "recorded-id",
        },
      }),
    ).rejects.toThrow(/changed identity.*No provider was changed/u);
    expect(updateProvider).not.toHaveBeenCalled();
  });

  it("refuses an existing provider without an ownership receipt before mutation (#12558)", async () => {
    const updateProvider = vi.fn<OpenShellProviderAdapter["updateProvider"]>();
    const attachProvider = vi.fn<OpenShellProviderAdapter["attachProvider"]>();

    await expect(
      ensureNativeNvidiaProvider({
        adapter: adapter({ updateProvider, attachProvider }),
        target,
        credentialValue: "opaque-test-secret",
      }),
    ).rejects.toThrow(/already exists without a matching NemoClaw ownership receipt/u);
    expect(updateProvider).not.toHaveBeenCalled();
    expect(attachProvider).not.toHaveBeenCalled();
  });

  it("does not record a receipt after an ambiguous credential update (#12558)", async () => {
    const getProvider = vi.fn<OpenShellProviderAdapter["getProvider"]>(async () => ({
      ok: true,
      value: metadata(),
    }));
    const updateProvider = vi.fn<OpenShellProviderAdapter["updateProvider"]>(async () => ({
      ok: false,
      error: { kind: "timeout", message: "timed out" },
    }));

    await expect(
      ensureNativeNvidiaProvider({
        adapter: adapter({ getProvider, updateProvider }),
        target,
        credentialValue: "replacement-secret",
        expected: {
          schemaVersion: 1,
          profileId: NVIDIA_HOSTED_NATIVE_PROFILE_ID,
          providerName: NVIDIA_HOSTED_NATIVE_PROVIDER,
          providerId: "provider-id",
        },
      }),
    ).rejects.toThrow(/did not confirm.*credential update.*No provider receipt was recorded/u);
    expect(updateProvider).toHaveBeenCalledOnce();
    expect(getProvider).toHaveBeenCalledOnce();
  });

  it("refuses to replace a recorded provider that is missing (#12558)", async () => {
    const createProvider = vi.fn<OpenShellProviderAdapter["createProvider"]>();

    await expect(
      ensureNativeNvidiaProvider({
        adapter: adapter({
          getProvider: vi.fn<OpenShellProviderAdapter["getProvider"]>(async () => ({
            ok: false,
            error: { kind: "command", reason: "not_found", message: "not found" },
          })),
          createProvider,
        }),
        target,
        credentialValue: "opaque-test-secret",
        expected: {
          schemaVersion: 1,
          profileId: NVIDIA_HOSTED_NATIVE_PROFILE_ID,
          providerName: NVIDIA_HOSTED_NATIVE_PROVIDER,
          providerId: "recorded-id",
        },
      }),
    ).rejects.toThrow(/is missing.*No provider was changed/u);
    expect(createProvider).not.toHaveBeenCalled();
  });

  it("fails before provider mutation when the profile collides (#12558)", async () => {
    const createProvider = vi.fn<OpenShellProviderAdapter["createProvider"]>();
    const providerAdapter = adapter({
      importProviderProfile: vi.fn<OpenShellProviderAdapter["importProviderProfile"]>(() => ({
        ok: false,
        error: {
          kind: "command",
          reason: "profile_incompatible",
          message: "different profile",
        },
      })),
      createProvider,
    });

    await expect(
      ensureNativeNvidiaProvider({
        adapter: providerAdapter,
        target,
        credentialValue: "opaque-test-secret",
      }),
    ).rejects.toThrow(/conflicts with NemoClaw's checked-in security boundary/u);
    expect(createProvider).not.toHaveBeenCalled();
  });

  it("requires the exact provider attachment before native inference is published (#12558)", async () => {
    const providerAdapter = adapter({
      listProviderAttachments: vi.fn<OpenShellProviderAdapter["listProviderAttachments"]>(
        async () => ({ ok: true, value: { names: [] } }),
      ),
    });

    await expect(
      verifyNativeNvidiaProviderAttachment({
        adapter: providerAdapter,
        target,
        sandboxName: "alpha",
      }),
    ).rejects.toThrow(NativeNvidiaProviderError);
    await expect(
      verifyNativeNvidiaProviderAttachment({
        adapter: providerAdapter,
        target,
        sandboxName: "alpha",
      }),
    ).rejects.toThrow(/does not have its native NVIDIA inference provider attached/u);
  });

  it("rejects a matching attachment when the live provider profile exceeds the checked-in boundary (#12562)", async () => {
    const getProvider = vi.fn<OpenShellProviderAdapter["getProvider"]>(async () => ({
      ok: true,
      value: metadata(),
    }));
    const listProviderAttachments = vi.fn<OpenShellProviderAdapter["listProviderAttachments"]>(
      async () => ({
        ok: true,
        value: { names: [NVIDIA_HOSTED_NATIVE_PROVIDER] },
      }),
    );
    const providerAdapter = adapter({
      importProviderProfile: vi.fn<OpenShellProviderAdapter["importProviderProfile"]>(() => ({
        ok: false,
        error: {
          kind: "command",
          reason: "profile_incompatible",
          message: "live endpoint rules are wider than the checked-in profile",
        },
      })),
      getProvider,
      listProviderAttachments,
    });

    await expect(
      verifyNativeNvidiaProviderAttachment({
        adapter: providerAdapter,
        target,
        sandboxName: "alpha",
        expected: {
          schemaVersion: 1,
          profileId: NVIDIA_HOSTED_NATIVE_PROFILE_ID,
          providerName: NVIDIA_HOSTED_NATIVE_PROVIDER,
          providerId: "provider-id",
        },
      }),
    ).rejects.toThrow(/conflicts with NemoClaw's checked-in security boundary/u);
    expect(getProvider).not.toHaveBeenCalled();
    expect(listProviderAttachments).not.toHaveBeenCalled();
  });

  it("refuses to attach through a live provider profile that exceeds the checked-in boundary (#12562)", async () => {
    const attachProvider = vi.fn<OpenShellProviderAdapter["attachProvider"]>();
    const providerAdapter = adapter({
      importProviderProfile: vi.fn<OpenShellProviderAdapter["importProviderProfile"]>(() => ({
        ok: false,
        error: {
          kind: "command",
          reason: "profile_incompatible",
          message: "live endpoint rules are wider than the checked-in profile",
        },
      })),
      attachProvider,
    });

    await expect(
      ensureNativeNvidiaProviderAttached({
        adapter: providerAdapter,
        target,
        sandboxName: "alpha",
        expected: {
          schemaVersion: 1,
          profileId: NVIDIA_HOSTED_NATIVE_PROFILE_ID,
          providerName: NVIDIA_HOSTED_NATIVE_PROVIDER,
          providerId: "provider-id",
        },
      }),
    ).rejects.toThrow(/conflicts with NemoClaw's checked-in security boundary/u);
    expect(attachProvider).not.toHaveBeenCalled();
  });

  it("removes a newly attached provider when attachment verification fails (#12558)", async () => {
    const listProviderAttachments = vi
      .fn<OpenShellProviderAdapter["listProviderAttachments"]>()
      .mockResolvedValueOnce({ ok: true, value: { names: [] } })
      .mockResolvedValueOnce({ ok: true, value: { names: [] } })
      .mockResolvedValueOnce({ ok: true, value: { names: [] } });
    const detachProvider = vi.fn<OpenShellProviderAdapter["detachProvider"]>(async () => ({
      ok: true,
      value: { changed: true },
    }));
    const providerAdapter = adapter({ listProviderAttachments, detachProvider });

    await expect(
      ensureNativeNvidiaProviderAttached({
        adapter: providerAdapter,
        target,
        sandboxName: "alpha",
        expected: {
          schemaVersion: 1,
          profileId: NVIDIA_HOSTED_NATIVE_PROFILE_ID,
          providerName: NVIDIA_HOSTED_NATIVE_PROVIDER,
          providerId: "provider-id",
        },
      }),
    ).rejects.toThrow(/does not have its native NVIDIA inference provider attached/u);
    expect(detachProvider).toHaveBeenCalledExactlyOnceWith({
      target,
      sandboxName: "alpha",
      providerName: NVIDIA_HOSTED_NATIVE_PROVIDER,
    });
  });

  it("preserves verification and cleanup failures after a new attachment (#12558)", async () => {
    const listProviderAttachments = vi
      .fn<OpenShellProviderAdapter["listProviderAttachments"]>()
      .mockResolvedValueOnce({ ok: true, value: { names: [] } })
      .mockResolvedValueOnce({ ok: true, value: { names: [] } })
      .mockResolvedValueOnce({
        ok: true,
        value: { names: [NVIDIA_HOSTED_NATIVE_PROVIDER] },
      });

    await expect(
      ensureNativeNvidiaProviderAttached({
        adapter: adapter({ listProviderAttachments }),
        target,
        sandboxName: "alpha",
        expected: {
          schemaVersion: 1,
          profileId: NVIDIA_HOSTED_NATIVE_PROFILE_ID,
          providerName: NVIDIA_HOSTED_NATIVE_PROVIDER,
          providerId: "provider-id",
        },
      }),
    ).rejects.toThrow(
      /does not have its native NVIDIA inference provider attached[\s\S]*did not confirm removal/u,
    );
  });
});

it("does not publish credentials when native provider policy is unavailable", async () => {
  const providerAdapter = adapter({
    ensureProviderPolicyComposition: vi.fn<
      OpenShellProviderAdapter["ensureProviderPolicyComposition"]
    >(async () => ({
      ok: false,
      error: { kind: "command", reason: "conflict", message: "disabled by administrator" },
    })),
  });
  await expect(
    ensureNativeNvidiaProvider({
      adapter: providerAdapter,
      target,
      credentialValue: "opaque-test-secret",
      expected: {
        schemaVersion: 1,
        profileId: NVIDIA_HOSTED_NATIVE_PROFILE_ID,
        providerName: NVIDIA_HOSTED_NATIVE_PROVIDER,
        providerId: "provider-id",
      },
    }),
  ).rejects.toThrow("disabled by administrator");
  expect(providerAdapter.createProvider).not.toHaveBeenCalled();
  expect(providerAdapter.updateProvider).not.toHaveBeenCalled();
});
