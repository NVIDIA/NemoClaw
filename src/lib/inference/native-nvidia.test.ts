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
  NativeNvidiaProviderError,
  NVIDIA_HOSTED_CREDENTIAL_ENV,
  NVIDIA_HOSTED_NATIVE_PROFILE_ID,
  NVIDIA_HOSTED_NATIVE_PROVIDER,
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
