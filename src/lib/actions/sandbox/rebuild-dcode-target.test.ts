// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { nativeLocalIdentity } from "../../inference/native-local/contract";

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

describe("DCode native local rebuild authority", () => {
  const binding = {
    provider: "vllm-local",
    endpointUrl: "http://host.openshell.internal:8000/v1",
    credentialEnv: "NEMOCLAW_LOCAL_INFERENCE_TOKEN",
    authMode: "sentinel",
    gatewayName: "nemoclaw",
    sandboxName: "alpha",
  } as const;
  const attachment = {
    ...binding,
    ...nativeLocalIdentity(binding),
    schemaVersion: 1,
    providerId: "owned",
  };
  const entry = {
    name: "alpha",
    agent: "langchain-deepagents-code",
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
  };
  const config = { provider: binding.provider, model: "model", preferredInferenceApi: null };
  it.each([null, {}, { ...attachment, providerId: "" }, { ...attachment, schemaVersion: 2 }])(
    "rejects malformed local authority before selecting a target (%j)",
    (receipt) => {
      expect(() =>
        resolveDcodeRebuildTarget(
          { ...entry, nativeLocalProviderAttachment: receipt },
          config,
          8080,
        ),
      ).toThrow("Malformed native local provider attachment");
    },
  );
  it.each([attachment, undefined])(
    "preserves valid native local or absent legacy authority (%j)",
    (receipt) => {
      const result = resolveDcodeRebuildTarget(
        { ...entry, nativeLocalProviderAttachment: receipt },
        config,
        8080,
      );
      expect(result.nativeLocalProviderAttachment).toEqual(receipt);
    },
  );
});
