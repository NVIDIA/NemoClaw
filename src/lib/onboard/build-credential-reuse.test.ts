// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, it, vi } from "vitest";
import * as credentials from "../credentials/store";
import { resolveNonInteractiveBuildCredential } from "./build-credential-reuse";

afterEach(() => vi.restoreAllMocks());

const attachment = {
  schemaVersion: 1,
  profileId: "nemoclaw-nvidia-inference-v1",
  providerName: "nemoclaw-nvidia-prod-v1",
  providerId: "recorded-provider-id",
};

it.each([
  ["native", attachment, "nemoclaw-nvidia-prod-v1"],
  ["legacy managed", undefined, "nvidia-prod"],
] as const)(
  "reuses the recorded %s registration during keyless recreation",
  async (_route, receipt, expected) => {
    vi.spyOn(credentials, "resolveProviderCredential").mockReturnValue(null);
    const getSandbox = vi.fn().mockReturnValue({
      name: "alpha",
      nativeNvidiaProviderAttachment: receipt,
    });
    const providerExistsInGateway = vi.fn((name: string) => name === expected);
    const result = await resolveNonInteractiveBuildCredential({
      helpUrl: "https://build.nvidia.com/settings/api-keys",
      recovery: { recoveredFromSandbox: true, sandboxName: "alpha" },
      getSandbox,
      providerExistsInGateway,
    });
    expect(result).toBe(true);
    expect(getSandbox).toHaveBeenCalledExactlyOnceWith("alpha");
    expect(providerExistsInGateway).toHaveBeenCalledExactlyOnceWith(expected);
  },
);

it("rejects malformed persisted native authority before looking up a provider", async () => {
  vi.spyOn(credentials, "resolveProviderCredential").mockReturnValue(null);
  const getSandbox = vi.fn().mockReturnValue({
    name: "alpha",
    nativeNvidiaProviderAttachment: { ...attachment, providerId: "" },
  });
  const providerExistsInGateway = vi.fn().mockResolvedValue(true);
  await expect(
    resolveNonInteractiveBuildCredential({
      helpUrl: null,
      recovery: { recoveredFromSandbox: true, sandboxName: "alpha" },
      getSandbox,
      providerExistsInGateway,
    }),
  ).rejects.toThrow("Malformed native NVIDIA provider attachment");
  expect(providerExistsInGateway).not.toHaveBeenCalled();
});
