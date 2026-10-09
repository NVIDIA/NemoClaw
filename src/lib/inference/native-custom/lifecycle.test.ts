// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { OpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter";
import {
  customAttachmentFromPrepared,
  normalizeNativeCustomProviderAttachment,
  prepareNativeCustomProfile,
  withNativeCustomLifecycle,
  verifyNativeCustomProviderAttachment,
} from "./index";

const target = { kind: "named", gatewayName: "gateway" } as const;
const prepare = () =>
  prepareNativeCustomProfile({
    sandboxName: "selected-sandbox",
    provider: "compatible-endpoint",
    endpointUrl: "https://api.example.com/v1",
    api: "openai-completions",
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
  });

describe("native custom provider ownership", () => {
  it("refuses name-only adoption before updating credentials (#12636)", async () => {
    const prepared = await prepare();
    const updateProvider = vi.fn();
    const adapter = {
      importProviderProfile: vi.fn(async () => ({ ok: true })),
      updateProvider,
      getProvider: vi.fn(async () => ({
        ok: true,
        value: {
          name: prepared.providerName,
          type: prepared.profile.id,
          credentialKeys: [prepared.credentialEnv],
          configKeys: [],
          revision: { id: "existing-id", resourceVersion: 1 },
        },
      })),
    } as unknown as OpenShellProviderAdapter;
    await expect(
      withNativeCustomLifecycle(prepared, (lifecycle) =>
        lifecycle.ensureProvider({
          adapter,
          target,
          credentialValue: "test-secret",
        }),
      ),
    ).rejects.toThrow(/ownership receipt/);
    expect(updateProvider).not.toHaveBeenCalled();
  });

  it("observes ambiguous creation once and removes its temporary profile source (#12636)", async () => {
    const prepared = await prepare();
    let profilePath = "";
    const createProvider = vi.fn(async () => ({
      ok: false,
      error: { kind: "timeout", message: "timeout" },
    }));
    const getProvider = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: { kind: "command", reason: "not_found", message: "missing" },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          name: prepared.providerName,
          type: prepared.profile.id,
          credentialKeys: [prepared.credentialEnv],
          configKeys: [],
          revision: { id: "created-id", resourceVersion: 1 },
        },
      });
    const adapter = {
      importProviderProfile: vi.fn(async (input) => {
        profilePath = input.profilePath;
        return { ok: fs.existsSync(profilePath) };
      }),
      ensureProviderPolicyComposition: vi.fn(async () => ({ ok: true })),
      getProvider,
      createProvider,
    } as unknown as OpenShellProviderAdapter;
    const receipt = await withNativeCustomLifecycle(prepared, (lifecycle) =>
      lifecycle.ensureProvider({
        adapter,
        target,
        credentialValue: "test-secret",
      }),
    );
    expect([
      receipt.providerId,
      createProvider.mock.calls.length,
      getProvider.mock.calls.length,
      fs.existsSync(profilePath),
    ]).toEqual(["created-id", 1, 2, false]);
    const attachment = customAttachmentFromPrepared(prepared, receipt);
    expect(normalizeNativeCustomProviderAttachment(attachment)).toEqual(attachment);
    expect(
      normalizeNativeCustomProviderAttachment({
        ...attachment,
        endpointUrl: "https://other.example.com/v1",
      }),
    ).toBeUndefined();
  });

  it("retains a created provider when authority persistence cannot be observed (#12636)", async () => {
    const prepared = await prepare();
    const deleteProvider = vi.fn();
    const adapter = { deleteProvider } as unknown as OpenShellProviderAdapter;
    await expect(
      withNativeCustomLifecycle(prepared, (lifecycle) =>
        lifecycle.persistProviderAuthority({
          adapter,
          target,
          gatewayName: "gateway",
          receipt: {
            schemaVersion: 1,
            profileId: prepared.profile.id,
            providerName: prepared.providerName,
            providerId: "created-id",
          },
          writeAuthority: () => {
            throw new Error("write failed");
          },
          readAuthority: () => {
            throw new Error("read failed");
          },
        }),
      ),
    ).rejects.toThrow(/retained/);
    expect(deleteProvider).not.toHaveBeenCalled();
  });
});

describe("custom attachment observation (#12636)", () => {
  it.each(["replaced", "wrong-sandbox"] as const)(
    "refuses %s provider authority before use",
    async (failure) => {
      const prepared = await prepare();
      const receipt = customAttachmentFromPrepared(prepared, {
        schemaVersion: 1,
        profileId: prepared.profile.id,
        providerName: prepared.providerName,
        providerId: "owned-id",
      });
      const listProviderAttachments = vi.fn(async () => ({
        ok: true,
        value: { names: failure === "wrong-sandbox" ? [] : [prepared.providerName] },
      }));
      const adapter = {
        importProviderProfile: vi.fn(async () => ({ ok: true })),
        getProvider: vi.fn(async () => ({
          ok: true,
          value: {
            name: prepared.providerName,
            type: prepared.profile.id,
            credentialKeys: [prepared.credentialEnv],
            configKeys: [],
            revision: {
              id: failure === "replaced" ? "replacement-id" : "owned-id",
              resourceVersion: 1,
            },
          },
        })),
        listProviderAttachments,
      } as unknown as OpenShellProviderAdapter;
      await expect(
        verifyNativeCustomProviderAttachment({
          adapter,
          target,
          sandboxName: "selected-sandbox",
          expected: receipt,
        }),
      ).rejects.toThrow(failure === "replaced" ? /changed identity/ : /does not have.*attached/);
      expect(listProviderAttachments.mock.calls).toEqual(
        failure === "replaced" ? [] : [[{ target, sandboxName: "selected-sandbox" }]],
      );
    },
  );
});
