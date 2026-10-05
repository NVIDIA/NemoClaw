// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { OpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter";
import { nativeCompatibleEndpointIdentity } from "../../inference/native-compatible/endpoint";
import { verifyNativeCompatibleAttachmentAfterCreate } from "./provider-publication";

const identity = nativeCompatibleEndpointIdentity({
  addresses: ["93.184.216.34"],
  endpointUrl: "https://93.184.216.34/v1",
  api: "openai-completions",
});
const expected = {
  schemaVersion: 1 as const,
  profileId: identity.profileId,
  providerName: identity.providerName,
  providerId: "provider-id",
  addresses: ["93.184.216.34"],
  endpointUrl: identity.endpoint,
  api: identity.api,
};

function fixture() {
  let attached = false;
  const adapter = {
    importProviderProfile: vi.fn(() => ({ ok: true })),
    getProvider: vi.fn(async () => ({
      ok: true,
      value: {
        name: identity.providerName,
        type: identity.profileId,
        credentialKeys: ["NEMOCLAW_COMPATIBLE_INFERENCE_API_KEY"],
        configKeys: [],
        revision: { id: "provider-id", resourceVersion: 1 },
      },
    })),
    listProviderAttachments: vi.fn(async (_input: { sandboxName: string }) => ({
      ok: true,
      value: { names: attached ? [identity.providerName] : [] },
    })),
    attachProvider: vi.fn(async () => {
      attached = true;
      return { ok: true };
    }),
    detachProvider: vi.fn(),
  };
  return {
    adapter,
    input: {
      sandboxName: "alpha",
      gatewayName: "gateway",
      inferenceProvider: identity.providerName,
      expected,
      deps: {
        providerAdapter: adapter as unknown as OpenShellProviderAdapter,
        runOpenshell: vi.fn(),
        cleanupCreateSources: vi.fn(),
      },
    },
  };
}

describe("native compatible post-create attachment", () => {
  it("attaches only the selected sandbox and confirms its provider", async () => {
    const f = fixture();
    await verifyNativeCompatibleAttachmentAfterCreate(f.input);
    expect(f.adapter.attachProvider).toHaveBeenCalledExactlyOnceWith({
      target: { kind: "named", gatewayName: "gateway" },
      sandboxName: "alpha",
      providerName: identity.providerName,
    });
    expect(
      f.adapter.listProviderAttachments.mock.calls.every(
        ([input]) => input.sandboxName === "alpha",
      ),
    ).toBe(true);
    expect(f.adapter.detachProvider).not.toHaveBeenCalled();
  });
  it("refuses a receipt for another provider before any mutation", async () => {
    const f = fixture();
    await expect(
      verifyNativeCompatibleAttachmentAfterCreate({
        ...f.input,
        expected: { ...expected, providerName: "other" },
      }),
    ).rejects.toThrow("matching");
    expect(f.adapter.importProviderProfile).not.toHaveBeenCalled();
    expect(f.adapter.attachProvider).not.toHaveBeenCalled();
  });
});
