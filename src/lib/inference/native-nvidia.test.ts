// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCheckedInProviderProfileContract } from "../adapters/openshell/provider-profile";
import {
  NVIDIA_HOSTED_NATIVE_PROFILE_ID,
  NVIDIA_HOSTED_NATIVE_PROVIDER,
  normalizeNativeNvidiaProviderAttachment,
} from "./native-nvidia/contract";
import {
  nativeHostedProviderProfilePath,
  normalizeNativeHostedProviderAttachment,
} from "./native-hosted";
import { nativeHostedProfile } from "./native-hosted/profiles";

const profile = nativeHostedProfile("nvidia-prod")!;

describe("native NVIDIA receipt compatibility", () => {
  it("ships a profile limited to the native models and chat-completions operations (#12558)", () => {
    const source = fs.readFileSync(nativeHostedProviderProfilePath(profile), "utf8");
    const contract = parseCheckedInProviderProfileContract(source);

    expect(contract?.profileId).toBe(NVIDIA_HOSTED_NATIVE_PROFILE_ID);
    expect(contract?.boundary.endpoints).toEqual([
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
    expect(contract?.boundary.binaries).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/[?*]/u)]),
    );
  });

  it("preserves a Slice 1 receipt in both receipt readers", () => {
    const receipt = {
      schemaVersion: 1,
      profileId: NVIDIA_HOSTED_NATIVE_PROFILE_ID,
      providerName: NVIDIA_HOSTED_NATIVE_PROVIDER,
      providerId: "legacy-provider-id",
    };
    expect(normalizeNativeNvidiaProviderAttachment(receipt)).toEqual(receipt);
    expect(normalizeNativeHostedProviderAttachment(receipt)).toEqual(receipt);
  });

  it("rejects a hosted vendor receipt in the legacy NVIDIA reader", () => {
    const openai = nativeHostedProfile("openai-api")!;
    const receipt = {
      schemaVersion: 1,
      profileId: openai.profileId,
      providerName: openai.providerName,
      providerId: "openai-id",
    };
    expect(normalizeNativeNvidiaProviderAttachment(receipt)).toBeUndefined();
    expect(normalizeNativeHostedProviderAttachment(receipt)).toEqual(receipt);
  });
});
