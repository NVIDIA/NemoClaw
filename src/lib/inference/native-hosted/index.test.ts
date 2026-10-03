// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";

import type { OpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter";
import { parseCheckedInProviderProfileContract } from "../../adapters/openshell/provider-profile";
import {
  ensureNativeHostedProvider,
  ensureNativeHostedProviderAttached,
  nativeHostedProviderProfilePath,
  NativeHostedProviderError,
  verifyNativeHostedProviderAttachment,
} from "./index";

import { NATIVE_HOSTED_PROFILES } from "./profiles";

const target = { kind: "named", gatewayName: "nemoclaw" } as const;

describe.each(
  NATIVE_HOSTED_PROFILES.filter((profile) => profile.logicalProvider !== "nvidia-prod"),
)("native $label OpenShell provider", (profile) => {
  function metadata(overrides: Record<string, unknown> = {}) {
    return {
      name: profile.providerName,
      type: profile.profileId,
      credentialKeys: [profile.credentialEnv],
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
        value: { names: [profile.providerName] },
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

  it("limits the profile to its fixed TLS endpoint and exact executable paths (#12589)", () => {
    const source = fs.readFileSync(nativeHostedProviderProfilePath(profile), "utf8");
    const contract = parseCheckedInProviderProfileContract(source);

    expect(contract?.profileId).toBe(profile.profileId);
    expect(contract?.boundary.endpoints).toHaveLength(1);
    expect(contract?.boundary.endpoints[0]).toMatchObject({
      host: new URL(profile.endpoint).hostname,
      port: 443,
      enforcement: "enforce",
    });
    expect(contract?.boundary.binaries).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/[?*]/u)]),
    );
  });

  it("refuses a receipt for another profile before mutation (#12589)", async () => {
    const other = NATIVE_HOSTED_PROFILES.find(
      (candidate) => candidate.profileId !== profile.profileId,
    )!;
    const providerAdapter = adapter();
    const expected = {
      schemaVersion: 1 as const,
      profileId: other.profileId,
      providerName: other.providerName,
      providerId: "provider-id",
    };
    await expect(
      ensureNativeHostedProvider({
        profile,
        adapter: providerAdapter,
        target,
        credentialValue: "opaque-secret",
        expected,
      }),
    ).rejects.toThrow("does not match the selected profile");
    await expect(
      ensureNativeHostedProviderAttached({
        profile,
        adapter: providerAdapter,
        target,
        sandboxName: "alpha",
        expected,
      }),
    ).rejects.toThrow("does not match the selected profile");
    expect(providerAdapter.importProviderProfile).not.toHaveBeenCalled();
    expect(providerAdapter.updateProvider).not.toHaveBeenCalled();
    expect(providerAdapter.attachProvider).not.toHaveBeenCalled();
  });

  it("refuses to attach a replacement provider before mutation (#12589)", async () => {
    const providerAdapter = adapter({
      getProvider: vi.fn<OpenShellProviderAdapter["getProvider"]>(async () => ({
        ok: true,
        value: metadata({ revision: { id: "replacement", resourceVersion: 2 } }),
      })),
      listProviderAttachments: vi.fn<OpenShellProviderAdapter["listProviderAttachments"]>(
        async () => ({ ok: true, value: { names: [] } }),
      ),
    });
    await expect(
      ensureNativeHostedProviderAttached({
        profile,
        adapter: providerAdapter,
        target,
        sandboxName: "alpha",
        expected: {
          schemaVersion: 1,
          profileId: profile.profileId,
          providerName: profile.providerName,
          providerId: "original",
        },
      }),
    ).rejects.toThrow("changed identity before attachment");
    expect(providerAdapter.attachProvider).not.toHaveBeenCalled();
    expect(providerAdapter.detachProvider).not.toHaveBeenCalled();
  });

  it("rejects provider replacement observed after credential update (#12589)", async () => {
    const getProvider = vi
      .fn<OpenShellProviderAdapter["getProvider"]>()
      .mockResolvedValueOnce({ ok: true, value: metadata() })
      .mockResolvedValueOnce({
        ok: true,
        value: metadata({ revision: { id: "replacement", resourceVersion: 1 } }),
      });
    await expect(
      ensureNativeHostedProvider({
        profile,
        adapter: adapter({ getProvider }),
        target,
        credentialValue: "opaque-test-secret",
      }),
    ).rejects.toThrow("changed identity during its credential update");
  });

  it("creates the internal provider once and records its immutable identity (#12589)", async () => {
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
      ensureNativeHostedProvider({
        profile,
        adapter: providerAdapter,
        target,
        credentialValue: "opaque-test-secret",
      }),
    ).resolves.toEqual({
      schemaVersion: 1,
      profileId: profile.profileId,
      providerName: profile.providerName,
      providerId: "provider-id",
    });
    expect(createProvider).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        name: profile.providerName,
        type: profile.profileId,
        credentials: [{ name: profile.credentialEnv, value: "opaque-test-secret" }],
        config: [],
      }),
    );
  });

  it("observes an ambiguous create result without issuing a second mutation (#12589)", async () => {
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
      ensureNativeHostedProvider({
        profile,
        adapter: adapter({ getProvider, createProvider }),
        target,
        credentialValue: "opaque-test-secret",
      }),
    ).resolves.toMatchObject({ providerId: "provider-id" });
    expect(createProvider).toHaveBeenCalledOnce();
  });

  it("creates from an existing gateway credential when recreation has no local key (#12589)", async () => {
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
      ensureNativeHostedProvider({
        profile,
        adapter: adapter({ getProvider, createProvider }),
        target,
        credentialValue: null,
        reuseExistingCredential: true,
      }),
    ).resolves.toMatchObject({ providerId: "provider-id" });
    expect(createProvider).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        name: profile.providerName,
        credentials: [],
        fromExisting: true,
      }),
    );
  });

  it("refuses a replaced provider before rotating its credential (#12589)", async () => {
    const updateProvider = vi.fn<OpenShellProviderAdapter["updateProvider"]>();

    await expect(
      ensureNativeHostedProvider({
        profile,
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
          profileId: profile.profileId,
          providerName: profile.providerName,
          providerId: "recorded-id",
        },
      }),
    ).rejects.toThrow(/changed identity.*No provider was changed/u);
    expect(updateProvider).not.toHaveBeenCalled();
  });

  it("refuses to replace a recorded provider that is missing (#12589)", async () => {
    const createProvider = vi.fn<OpenShellProviderAdapter["createProvider"]>();

    await expect(
      ensureNativeHostedProvider({
        profile,
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
          profileId: profile.profileId,
          providerName: profile.providerName,
          providerId: "recorded-id",
        },
      }),
    ).rejects.toThrow(/is missing.*No provider was changed/u);
    expect(createProvider).not.toHaveBeenCalled();
  });

  it("fails before provider mutation when the profile collides (#12589)", async () => {
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
      ensureNativeHostedProvider({
        profile,
        adapter: providerAdapter,
        target,
        credentialValue: "opaque-test-secret",
      }),
    ).rejects.toThrow(/conflicts with NemoClaw's checked-in security boundary/u);
    expect(createProvider).not.toHaveBeenCalled();
  });

  it("requires the exact provider attachment before native inference is published (#12589)", async () => {
    const providerAdapter = adapter({
      listProviderAttachments: vi.fn<OpenShellProviderAdapter["listProviderAttachments"]>(
        async () => ({ ok: true, value: { names: [] } }),
      ),
    });

    await expect(
      verifyNativeHostedProviderAttachment({
        profile,
        adapter: providerAdapter,
        target,
        sandboxName: "alpha",
      }),
    ).rejects.toThrow(NativeHostedProviderError);
    await expect(
      verifyNativeHostedProviderAttachment({
        profile,
        adapter: providerAdapter,
        target,
        sandboxName: "alpha",
      }),
    ).rejects.toThrow(/does not have its native .* inference provider attached/u);
  });

  it("removes a newly attached provider when attachment verification fails (#12589)", async () => {
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
      ensureNativeHostedProviderAttached({
        profile,
        adapter: providerAdapter,
        target,
        sandboxName: "alpha",
        expected: {
          schemaVersion: 1,
          profileId: profile.profileId,
          providerName: profile.providerName,
          providerId: "provider-id",
        },
      }),
    ).rejects.toThrow(/does not have its native .* inference provider attached/u);
    expect(detachProvider).toHaveBeenCalledExactlyOnceWith({
      target,
      sandboxName: "alpha",
      providerName: profile.providerName,
    });
  });

  it("preserves verification and cleanup failures after a new attachment (#12589)", async () => {
    const listProviderAttachments = vi
      .fn<OpenShellProviderAdapter["listProviderAttachments"]>()
      .mockResolvedValueOnce({ ok: true, value: { names: [] } })
      .mockResolvedValueOnce({ ok: true, value: { names: [] } })
      .mockResolvedValueOnce({
        ok: true,
        value: { names: [profile.providerName] },
      });

    await expect(
      ensureNativeHostedProviderAttached({
        profile,
        adapter: adapter({ listProviderAttachments }),
        target,
        sandboxName: "alpha",
        expected: {
          schemaVersion: 1,
          profileId: profile.profileId,
          providerName: profile.providerName,
          providerId: "provider-id",
        },
      }),
    ).rejects.toThrow(
      /does not have its native .* inference provider attached[\s\S]*did not confirm removal/u,
    );
  });
});
