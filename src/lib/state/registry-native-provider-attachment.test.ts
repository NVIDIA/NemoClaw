// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { SandboxEntry } from "./registry/types";

it.each([
  {
    provider: "llama-cpp-local",
    endpointUrl: "http://host.openshell.internal:8000/v1",
    agent: undefined,
  },
  {
    provider: "compatible-endpoint",
    endpointUrl: "http://host.openshell.internal:12345/v1",
    agent: "pi",
  },
] as const)(
  "retains a $provider attachment even when an unrelated NIM marker is stale",
  async (selection) => {
    const { nativeLocalIdentity } = await import("../inference/native-local/contract");
    const { retainedNativeLocalProviderAttachment } = await import("./registry/route-reservation");
    const binding = {
      ...selection,
      credentialEnv: "NEMOCLAW_LOCAL_INFERENCE_TOKEN",
      authMode: "sentinel",
      gatewayName: "nemoclaw",
      sandboxName: "alpha",
    } as const;
    const attachment = {
      ...binding,
      ...nativeLocalIdentity(binding),
      schemaVersion: 1 as const,
      providerId: "llama-provider",
    };
    const existing = {
      name: "alpha",
      model: "model-a",
      ...binding,
      nimContainer: "stale-nim-marker",
      nativeLocalProviderAttachment: attachment,
    } as SandboxEntry;

    expect(retainedNativeLocalProviderAttachment(existing, binding)).toEqual(attachment);
  },
);

it("drops a stale vLLM attachment when reserving an owned Local NIM shared route", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-nim-attachment-"));
  vi.stubEnv("HOME", home);
  vi.resetModules();
  try {
    const registry = await import("./registry");
    const { nativeLocalIdentity } = await import("../inference/native-local/contract");
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
      schemaVersion: 1 as const,
      providerId: "stale-provider",
    };
    registry.registerSandbox({
      name: "alpha",
      provider: "vllm-local",
      model: "model-a",
      endpointUrl: "http://127.0.0.1:8000/v1",
      gatewayName: "nemoclaw",
      nimContainer: "nemoclaw-nim-owned",
      nativeLocalProviderAttachment: attachment,
    });
    registry.reserveSandboxInferenceRoute("alpha", {
      provider: "vllm-local",
      model: "model-b",
      endpointUrl: "http://127.0.0.1:8000/v1",
      credentialEnv: null,
      preferredInferenceApi: "openai-completions",
      gatewayName: "nemoclaw",
    });

    const entry = registry.getSandbox("alpha");
    expect(entry?.nimContainer).toBe("nemoclaw-nim-owned");
    expect(entry?.nativeLocalProviderAttachment).toBeUndefined();
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
});

it("admits a pending route reservation without per-sandbox provider authority", async () => {
  const { classifySandboxInferenceRouteReservation } = await import("./registry/route-reservation");
  const selection = {
    provider: "ollama-local",
    model: "qwen3-vl:4b",
    endpointUrl: "http://127.0.0.1:11434/v1",
    endpointSource: null,
    credentialEnv: null,
    preferredInferenceApi: "openai-completions",
    compatibleEndpointReasoning: null,
    compatibleEndpointReasoningEffort: null,
    nimContainer: null,
  } as const;
  const authority = {
    sandboxName: "alpha",
    gatewayName: "nemoclaw",
    sessionId: "session-owner",
    selection,
  };
  const disposition = classifySandboxInferenceRouteReservation(authority, {
    name: authority.sandboxName,
    gatewayName: authority.gatewayName,
    reservationSessionId: authority.sessionId,
    pendingRouteReservation: true,
    provider: selection.provider,
    model: selection.model,
    endpointUrl: selection.endpointUrl,
    endpointSource: selection.endpointSource,
    credentialEnv: selection.credentialEnv,
    preferredInferenceApi: selection.preferredInferenceApi,
  });

  expect(disposition.kind).toBe("owned");
});

it("clears a stale native NVIDIA attachment when reserving a shared route", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-native-attachment-"));
  vi.stubEnv("HOME", home);
  vi.resetModules();
  try {
    const registry = await import("./registry");
    registry.registerSandbox({
      name: "alpha",
      provider: "nvidia-prod",
      model: "model-a",
      nativeNvidiaProviderAttachment: {
        schemaVersion: 1,
        profileId: "nemoclaw-nvidia-inference-v1",
        providerName: "nemoclaw-nvidia-prod-v1",
        providerId: "provider-id",
      },
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
    });
    expect(registry.getSandbox("alpha")).not.toHaveProperty("nativeNvidiaProviderAuthority");

    registry.reserveSandboxInferenceRoute("alpha", {
      provider: "anthropic-prod",
      model: "model-b",
      endpointUrl: null,
      credentialEnv: "ANTHROPIC_API_KEY",
      preferredInferenceApi: "anthropic-messages",
      gatewayName: "nemoclaw-9090",
    });

    expect(registry.getSandbox("alpha")?.nativeNvidiaProviderAttachment).toBeUndefined();
    expect(registry.getSandbox("alpha")).not.toHaveProperty("nativeNvidiaProviderAuthority");
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
});

it("lists registered sandboxes that retain native NVIDIA provider ownership", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-native-attachment-list-"));
  vi.stubEnv("HOME", home);
  vi.resetModules();
  try {
    const registry = await import("./registry");
    const authority = await import("./registry/native-provider-authority");
    registry.registerSandbox({
      name: "alpha",
      provider: "nvidia-prod",
      model: "model-a",
      nativeNvidiaProviderAttachment: {
        schemaVersion: 1,
        profileId: "nemoclaw-nvidia-inference-v1",
        providerName: "nemoclaw-nvidia-prod-v1",
        providerId: "provider-id",
      },
      gatewayName: "nemoclaw",
    });
    registry.registerSandbox({
      name: "beta",
      provider: "nvidia-prod",
      model: "model-b",
      nativeNvidiaProviderAttachment: {
        schemaVersion: 1,
        profileId: "nemoclaw-nvidia-inference-v1",
        providerName: "nemoclaw-nvidia-prod-v1",
        providerId: "provider-id",
      },
      gatewayName: "other-gateway",
    });

    expect(authority.listNativeNvidiaProviderAttachmentSandboxNames("nemoclaw")).toEqual(["alpha"]);
    expect(authority.listNativeNvidiaProviderAttachmentSandboxNames("other-gateway")).toEqual([
      "beta",
    ]);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
});

it.each([
  ["unchanged binding", {}, true],
  ["model change", { model: "model-b" }, true],
  ["endpoint change", { endpointUrl: "https://other.example/v1" }, false],
  ["API change", { preferredInferenceApi: "openai-responses" }, false],
  ["credential change", { credentialEnv: "OTHER_KEY" }, false],
  ["gateway change", { gatewayName: "other-gateway" }, false],
] as const)(
  "preserves custom native reservation authority only for its binding: %s",
  async (_label, changes, retained) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-custom-reservation-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      const { customNativeProvider } = await import("../inference/native-provider/custom");
      const route = {
        provider: "compatible-endpoint",
        model: "model-a",
        endpointUrl: "https://custom.example/v1",
        credentialEnv: "COMPATIBLE_API_KEY",
        preferredInferenceApi: "openai-completions",
        gatewayName: "nemoclaw",
      };
      const definition = customNativeProvider({
        provider: route.provider,
        endpointUrl: route.endpointUrl,
        credentialEnv: route.credentialEnv,
        api: route.preferredInferenceApi,
        allowedIps: ["8.8.8.8"],
      });
      const receipt = {
        schemaVersion: 1 as const,
        profileId: definition.profileId,
        providerName: definition.providerName,
        providerId: "owned-provider-id",
        endpointUrl: definition.endpointUrl,
        allowedIps: definition.allowedIps,
        custom: definition.custom,
      };
      registry.registerSandbox({
        name: "alpha",
        ...route,
        nativeHostedProviderAttachment: receipt,
      });
      expect(registry.reserveSandboxInferenceRoute("alpha", { ...route, ...changes })).toBe(true);
      expect(registry.getSandbox("alpha")?.nativeHostedProviderAttachment).toEqual(
        retained ? receipt : undefined,
      );
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  },
);
