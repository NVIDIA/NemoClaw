// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { nativeCompatibleEndpointIdentity } from "./endpoint";
import {
  normalizeNativeCompatibleProviderAttachment,
  nativeCompatibleSelectionIdentity,
  requireMatchingNativeCompatibleAttachment,
} from "./contract";

const identity = nativeCompatibleEndpointIdentity({
  addresses: ["93.184.216.34"],
  endpointUrl: "https://api.example.com/v1",
  api: "openai-completions",
});
const receipt = {
  schemaVersion: 1,
  profileId: identity.profileId,
  providerName: identity.providerName,
  providerId: "owned-provider",
  addresses: ["93.184.216.34"],
  endpointUrl: identity.endpoint,
  api: identity.api,
};

describe("native compatible provider receipt", () => {
  it("retains the endpoint and API bound to the provider identity", () => {
    expect(normalizeNativeCompatibleProviderAttachment(receipt)).toEqual(receipt);
  });
  it.each([
    { endpointUrl: "https://other.example.com/v1" },
    { api: "openai-responses" },
    { providerName: "nemoclaw-nvidia-prod-v1" },
    { endpointUrl: "https://user:secret@api.example.com/v1" },
    { providerId: " " },
    { addresses: undefined },
    { addresses: [] },
    { addresses: ["93.184.216.35"] },
    { addresses: ["invalid"] },
  ])("rejects a mismatched or invalid receipt", (changed) => {
    expect(normalizeNativeCompatibleProviderAttachment({ ...receipt, ...changed })).toBeUndefined();
  });
});

it("keeps the selected Anthropic-compatible OpenAI surface at v1", () => {
  const selected = nativeCompatibleSelectionIdentity({
    provider: "compatible-anthropic-endpoint",
    endpointUrl: "https://api.example.com",
    api: "openai-completions",
  });
  expect(selected.endpoint).toBe("https://api.example.com/v1");
  const pinned = nativeCompatibleEndpointIdentity({
    endpointUrl: selected.endpoint,
    api: selected.api,
    addresses: receipt.addresses,
  });
  const selectedReceipt = {
    ...receipt,
    profileId: pinned.profileId,
    providerName: pinned.providerName,
    endpointUrl: selected.endpoint,
    api: selected.api,
  };
  expect(
    requireMatchingNativeCompatibleAttachment(selectedReceipt, {
      provider: "compatible-anthropic-endpoint",
      endpointUrl: "https://api.example.com",
      preferredInferenceApi: "openai-completions",
    }),
  ).toEqual(selectedReceipt);
});
