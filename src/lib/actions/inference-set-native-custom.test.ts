// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { OpenShellProviderAdapter } from "../adapters/openshell/provider-adapter";
import {
  customAttachmentFromPrepared,
  prepareNativeCustomProfile,
  type NativeCustomProviderAttachment,
} from "../inference/native-custom";
import { prepareNativeCustomSelection } from "./inference-set/native-custom";

const profile = (endpointUrl = "https://api.example.com/v1") =>
  prepareNativeCustomProfile({
    sandboxName: "selected",
    provider: "compatible-endpoint",
    endpointUrl,
    api: "openai-completions",
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
  });

describe("native custom selection ownership (#12636)", () => {
  it("persists ownership before attaching only the selected sandbox", async () => {
    const prepared = await profile();
    const events: string[] = [];
    let stored: NativeCustomProviderAttachment | undefined;
    let attached = false;
    const metadata = {
      name: prepared.providerName,
      type: prepared.profile.id,
      credentialKeys: [prepared.credentialEnv],
      configKeys: [],
      revision: { id: "created-id", resourceVersion: 1 },
    };
    const getProvider = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: { kind: "command", reason: "not_found", message: "missing" },
      })
      .mockResolvedValue({ ok: true, value: metadata });
    const attachProvider = vi.fn(async () => {
      events.push("attach");
      attached = true;
      return { ok: true };
    });
    const createProvider = vi.fn(async () => {
      events.push("create");
      return { ok: true };
    });
    const adapter = {
      importProviderProfile: vi.fn(async () => ({ ok: true })),
      ensureProviderPolicyComposition: vi.fn(async () => ({ ok: true })),
      getProvider,
      createProvider,
      attachProvider,
      listProviderAttachments: vi.fn(async () => ({
        ok: true,
        value: { names: attached ? [prepared.providerName] : [] },
      })),
    } as unknown as OpenShellProviderAdapter;
    const result = await prepareNativeCustomSelection({
      prepared,
      gatewayName: "nemoclaw",
      sandboxName: "selected",
      adapter,
      credentialValue: "host-only-test-secret",
      readAuthority: () => stored,
      writeAuthority: (_gateway, receipt) => {
        events.push("persist");
        stored = receipt;
      },
    });
    expect(events).toEqual(["create", "persist", "attach"]);
    expect(result).toEqual({ attachment: stored, attachmentChanged: true });
    expect(attachProvider).toHaveBeenCalledWith({
      target: { kind: "named", gatewayName: "nemoclaw" },
      sandboxName: "selected",
      providerName: prepared.providerName,
    });
    expect(createProvider).toHaveBeenCalledOnce();
    expect(JSON.stringify(stored)).not.toContain("host-only-test-secret");
  });

  it("rejects conflicting immutable receipts before provider mutation", async () => {
    const prepared = await profile();
    const gateway = customAttachmentFromPrepared(prepared, {
      schemaVersion: 1,
      profileId: prepared.profile.id,
      providerName: prepared.providerName,
      providerId: "gateway-id",
    });
    const importProviderProfile = vi.fn();
    await expect(
      prepareNativeCustomSelection({
        prepared,
        gatewayName: "nemoclaw",
        sandboxName: "selected",
        adapter: { importProviderProfile } as unknown as OpenShellProviderAdapter,
        credentialValue: "test",
        recordedAttachment: { ...gateway, providerId: "other-id" },
        readAuthority: () => gateway,
        writeAuthority: vi.fn(),
      }),
    ).rejects.toThrow(/authority disagree/);
    expect(importProviderProfile).not.toHaveBeenCalled();
  });

  it("rejects authority for another endpoint even when stored under the selected name", async () => {
    const prepared = await profile();
    const other = await profile("https://other.example.com/v1");
    const receipt = customAttachmentFromPrepared(other, {
      schemaVersion: 1,
      profileId: other.profile.id,
      providerName: other.providerName,
      providerId: "same-looking-id",
    });
    const importProviderProfile = vi.fn();
    await expect(
      prepareNativeCustomSelection({
        prepared,
        gatewayName: "nemoclaw",
        sandboxName: "selected",
        adapter: { importProviderProfile } as unknown as OpenShellProviderAdapter,
        credentialValue: "test",
        readAuthority: () => receipt,
        writeAuthority: vi.fn(),
      }),
    ).rejects.toThrow(/authority disagree/);
    expect(importProviderProfile).not.toHaveBeenCalled();
  });
});
