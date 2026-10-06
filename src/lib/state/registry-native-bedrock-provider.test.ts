// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, expect, it, vi } from "vitest";
import { nativeBedrockIdentity } from "../inference/native-bedrock/contract";
import { BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL } from "../inference/bedrock-runtime";

beforeAll(async () => {
  await import("./registry");
});

it("retains generation authority across a provider switch, denies replacement and excludes secrets", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-bedrock-state-"));
  vi.stubEnv("HOME", home);
  vi.resetModules();
  try {
    const registry = await import("./registry");
    const binding = {
      endpointUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
      region: "us-east-1",
      adapterGeneration: "a".repeat(32),
      adapterBaseUrl: BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL,
      gatewayName: "gateway",
    };
    const receipt = {
      ...binding,
      ...nativeBedrockIdentity(binding),
      schemaVersion: 1 as const,
      providerId: "owned-id",
    };
    registry.setNativeBedrockProviderAuthority("gateway", {
      ...receipt,
      token: "never-persist",
      credentialHash: "never-persist",
    } as typeof receipt);
    const reservation = {
      provider: "compatible-anthropic-endpoint",
      model: "anthropic.claude",
      endpointUrl: binding.endpointUrl,
      preferredInferenceApi: "openai-completions",
      nativeBedrockProviderAttachment: receipt,
      gatewayName: "gateway",
      reservationSessionId: "run-one",
      credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
    };
    expect(registry.reserveSandboxInferenceRoute("pending", reservation)).toBe(true);
    expect(registry.reserveSandboxInferenceRoute("pending", reservation)).toBe(true);
    expect(() =>
      registry.reserveSandboxInferenceRoute("pending", {
        ...reservation,
        nativeBedrockProviderAttachment: { ...receipt, providerId: "replacement" },
      }),
    ).toThrow("cannot change");
    expect(registry.getSandbox("pending")?.nativeBedrockProviderAttachment).toEqual(receipt);
    registry.registerSandbox({
      name: "alpha",
      provider: "compatible-anthropic-endpoint",
      model: "anthropic.claude",
      endpointUrl: binding.endpointUrl,
      preferredInferenceApi: "openai-completions",
      nativeBedrockProviderAttachment: receipt,
      gatewayName: "gateway",
      gatewayPort: 8080,
    });
    expect(registry.getSandbox("alpha")?.nativeBedrockProviderAttachment).toEqual(receipt);
    expect(() => registry.setNativeBedrockProviderAuthority("other", receipt)).toThrow("invalid");
    expect(() =>
      registry.setNativeBedrockProviderAuthority("gateway", {
        ...receipt,
        providerId: "replacement",
      }),
    ).toThrow("identity changed");
    expect(() =>
      registry.updateSandbox("alpha", {
        endpointUrl: "https://bedrock-runtime.us-west-2.amazonaws.com",
      }),
    ).toThrow("does not match");
    expect(registry.getSandbox("alpha")?.endpointUrl).toBe(binding.endpointUrl);
    expect(registry.updateSandbox("alpha", { provider: "nvidia-prod", endpointUrl: null })).toBe(
      true,
    );
    expect(registry.getSandbox("alpha")?.nativeBedrockProviderAttachment).toBeUndefined();
    expect(registry.getNativeBedrockProviderAuthority("gateway", receipt.profileId)).toEqual(
      receipt,
    );
    expect(registry.getNativeBedrockProviderAuthority("other", receipt.profileId)).toBeUndefined();
    const { REGISTRY_FILE } = await import("./registry/persistence");
    expect(await fs.readFile(REGISTRY_FILE, "utf8")).not.toContain("never-persist");
  } finally {
    vi.unstubAllEnvs();
    vi.resetModules();
    await fs.rm(home, { recursive: true, force: true });
  }
});
