// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  customAttachmentFromPrepared,
  prepareNativeCustomProfile,
} from "../inference/native-custom";
import type { NativeCustomApi, NativeCustomProvider } from "../inference/native-custom";
import type { SandboxEntry } from "../state/registry/types";
import {
  hasRetainedNativeCustomSelection,
  type RetainedNativeCustomSelection,
} from "./resume/native-custom";

async function fixture(
  provider: NativeCustomProvider = "compatible-endpoint",
  api: NativeCustomApi = "openai-completions",
) {
  const prepared = await prepareNativeCustomProfile({
    sandboxName: "custom-agent",
    provider,
    api,
    endpointUrl: "https://api.example.com/v1",
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
  });
  const receipt = customAttachmentFromPrepared(prepared, {
    schemaVersion: 1,
    profileId: prepared.profile.id,
    providerName: prepared.providerName,
    providerId: "retained-provider-id",
  });
  const recorded: SandboxEntry = {
    name: "custom-agent",
    gatewayName: "gateway",
    provider,
    nativeCustomProviderAttachment: receipt,
  };
  const input: RetainedNativeCustomSelection = {
    gatewayName: "gateway",
    sandboxName: "custom-agent",
    provider,
    endpointUrl: prepared.endpointUrl,
    api,
    credentialEnv: prepared.credentialEnv,
  };
  const deps = {
    getSandbox: vi.fn((): SandboxEntry | null => recorded),
    getNativeCustomProviderAuthority: vi.fn(() => receipt),
  };
  return { input, deps, recorded, receipt };
}

describe("retained native custom resume selection", () => {
  it.each([
    ["compatible-endpoint", "openai-completions"],
    ["compatible-endpoint", "openai-responses"],
    ["compatible-anthropic-endpoint", "anthropic-messages"],
  ] as const)("restores %s / %s using matching scoped receipts (#12636)", async (provider, api) => {
    const { input, deps, receipt } = await fixture(provider, api);
    expect(hasRetainedNativeCustomSelection(input, deps)).toBe(true);
    expect(deps.getSandbox).toHaveBeenCalledWith("custom-agent");
    expect(deps.getNativeCustomProviderAuthority).toHaveBeenCalledWith(
      "gateway",
      receipt.providerName,
    );
  });

  it.each([
    { gatewayName: "other-gateway" },
    { sandboxName: "other-sandbox" },
    { credentialEnv: "OTHER_API_KEY" },
    { endpointUrl: "https://other.example.com/v1" },
    { api: "openai-responses" },
  ])("rejects changed selection %j before native recovery (#12636)", async (changed) => {
    const { input, deps } = await fixture();
    expect(() => hasRetainedNativeCustomSelection({ ...input, ...changed }, deps)).toThrow();
  });

  it.each([null, {}])("rejects malformed sandbox authority %j (#12636)", async (invalid) => {
    const { input, deps, recorded } = await fixture();
    expect(() =>
      hasRetainedNativeCustomSelection(input, {
        ...deps,
        getSandbox: () =>
          ({ ...recorded, nativeCustomProviderAttachment: invalid }) as SandboxEntry,
      }),
    ).toThrow(/cannot authorize resume/);
  });

  it.each(["replaced", "malformed", "absent"] as const)(
    "rejects %s gateway authority (#12636)",
    async (kind) => {
      const { input, deps, receipt } = await fixture();
      const authorities = {
        replaced: { ...receipt, providerId: "replacement-provider-id" },
        malformed: { ...receipt, profileId: "foreign-profile" },
        absent: undefined,
      };
      expect(() =>
        hasRetainedNativeCustomSelection(input, {
          ...deps,
          getNativeCustomProviderAuthority: () => authorities[kind],
        }),
      ).toThrow(/authority disagree/);
    },
  );

  it("keeps legacy and fixed-provider recovery outside native custom selection (#12636)", async () => {
    const { input, deps, recorded } = await fixture();
    expect(hasRetainedNativeCustomSelection({ ...input, provider: "nvidia-prod" }, deps)).toBe(
      false,
    );
    expect(deps.getSandbox).not.toHaveBeenCalled();
    delete recorded.nativeCustomProviderAttachment;
    expect(hasRetainedNativeCustomSelection(input, deps)).toBe(false);
    expect(deps.getNativeCustomProviderAuthority).not.toHaveBeenCalled();
  });
});
