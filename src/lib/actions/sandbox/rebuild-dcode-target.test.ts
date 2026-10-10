// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  prepareNativeCustomProfile,
  customAttachmentFromPrepared,
} from "../../inference/native-custom";
import { resolveDcodeRebuildTarget } from "./rebuild-dcode-target";

describe("resolveDcodeRebuildTarget", () => {
  it("resolves the terminal DCode target without importing dashboard metadata (#6195)", () => {
    const entry = {
      name: "dcode-workspace",
      agent: "langchain-deepagents-code",
      dashboardPort: 0,
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
    } as Parameters<typeof resolveDcodeRebuildTarget>[0];
    const resumeConfig = {
      provider: "compatible-endpoint",
      model: "nvidia/nemotron-3-super-120b-a12b",
      preferredInferenceApi: "openai-completions",
    } as Parameters<typeof resolveDcodeRebuildTarget>[1];

    const target = resolveDcodeRebuildTarget(entry, resumeConfig, 8080);

    expect(target).toEqual({
      agent: "langchain-deepagents-code",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      provider: "compatible-endpoint",
      model: "nvidia/nemotron-3-super-120b-a12b",
      preferredInferenceApi: "openai-completions",
    });
    expect(target).not.toHaveProperty("dashboardPort");
  });
});

it("carries the exact native custom endpoint authority into DCode rebuild probes (#12636)", async () => {
  const prepared = await prepareNativeCustomProfile({
    sandboxName: "alpha",
    provider: "compatible-endpoint",
    endpointUrl: "http://8.8.8.8/v1",
    api: "openai-completions",
  });
  const receipt = customAttachmentFromPrepared(prepared, {
    schemaVersion: 1,
    profileId: prepared.profile.id,
    providerName: prepared.providerName,
    providerId: "custom-id",
  });
  const entry = {
    name: "alpha",
    agent: "langchain-deepagents-code",
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    nativeCustomProviderAttachment: receipt,
  };
  const selection = {
    provider: "compatible-endpoint",
    model: "model",
    preferredInferenceApi: "openai-completions",
  };
  expect(resolveDcodeRebuildTarget(entry, selection).nativeCustomProviderAttachment).toEqual(
    receipt,
  );
  expect(() => resolveDcodeRebuildTarget({ ...entry, name: "peer" }, selection)).toThrow(
    "malformed",
  );
});
