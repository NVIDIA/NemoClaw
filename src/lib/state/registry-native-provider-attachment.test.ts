// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

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
    const authority = await import("./registry/native-nvidia-provider-authority");
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
  ["native resume", "http://127.0.0.1:11434/v1", "nemoclaw", false, true],
  ["hosted compatible switch", "https://api.example.com/v1", "nemoclaw", false, false],
  ["different local endpoint", "http://127.0.0.1:8000/v1", "nemoclaw", false, false],
  ["different gateway", "http://127.0.0.1:11434/v1", "other-gateway", false, false],
  ["explicit native replacement", "http://127.0.0.1:8000/v1", "nemoclaw", true, true],
] as const)(
  "retains only matching native route attachments during %s",
  async (_scenario, endpointUrl, gatewayName, replacement, retained) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-local-attachment-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      const authority = await import("./registry/native-local-provider-authority");
      const { nativeLocalIdentity } = await import("../inference/native-local/contract");
      const binding = {
        provider: "compatible-endpoint",
        endpointUrl: "http://host.openshell.internal:11434/v1",
        credentialEnv: "NEMOCLAW_LOCAL_INFERENCE_TOKEN",
        authMode: "authenticated",
        gatewayName: "nemoclaw",
        sandboxName: "alpha",
      } as const;
      const receipt = {
        ...binding,
        ...nativeLocalIdentity(binding),
        schemaVersion: 1 as const,
        providerId: "original-provider",
      };
      authority.setNativeLocalProviderAuthority(receipt);
      registry.registerSandbox({
        name: "alpha",
        provider: binding.provider,
        model: "model-a",
        endpointUrl: "http://127.0.0.1:11434/v1",
        gatewayName: binding.gatewayName,
        nativeLocalProviderAttachment: receipt,
      });
      const nextBinding = {
        ...binding,
        endpointUrl: endpointUrl.replace("127.0.0.1", "host.openshell.internal"),
        gatewayName,
      };
      const nextReceipt = replacement
        ? {
            ...nextBinding,
            ...nativeLocalIdentity(nextBinding),
            schemaVersion: 1 as const,
            providerId: "replacement-provider",
          }
        : undefined;
      registry.reserveSandboxInferenceRoute("alpha", {
        provider: binding.provider,
        model: "model-b",
        credentialEnv: null,
        preferredInferenceApi: "openai-completions",
        endpointUrl,
        gatewayName,
        ...(nextReceipt ? { nativeLocalProviderAttachment: nextReceipt } : {}),
      });
      const entry = registry.getSandbox("alpha")!;
      expect(entry.nativeLocalProviderAttachment).toEqual(
        retained ? (nextReceipt ?? receipt) : undefined,
      );
      expect(authority.getNativeLocalProviderAuthority(receipt.providerName)).toEqual(receipt);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  },
);

it("enumerates cleanup authority only for the exact sandbox and gateway (#12558)", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-native-cleanup-"));
  vi.stubEnv("HOME", home);
  vi.resetModules();
  try {
    const authority = await import("./registry/native-local-provider-authority");
    const { nativeLocalIdentity } = await import("../inference/native-local/contract");
    const binding = {
      provider: "ollama-local",
      endpointUrl: "http://host.openshell.internal:11434/v1",
      credentialEnv: "NEMOCLAW_LOCAL_INFERENCE_TOKEN",
      authMode: "sentinel",
      gatewayName: "selected",
      sandboxName: "alpha",
    } as const;
    const own = {
      ...binding,
      ...nativeLocalIdentity(binding),
      schemaVersion: 1 as const,
      providerId: "own",
    };
    const siblingBinding = { ...binding, sandboxName: "beta" };
    const sibling = {
      ...siblingBinding,
      ...nativeLocalIdentity(siblingBinding),
      schemaVersion: 1 as const,
      providerId: "sibling",
    };
    const otherBinding = { ...binding, gatewayName: "other" };
    const other = {
      ...otherBinding,
      ...nativeLocalIdentity(otherBinding),
      schemaVersion: 1 as const,
      providerId: "other",
    };
    authority.setNativeLocalProviderAuthority(own);
    authority.setNativeLocalProviderAuthority(sibling);
    authority.setNativeLocalProviderAuthority(other);
    expect(authority.listNativeLocalProviderAuthorities("alpha", "selected")).toEqual([own]);
    expect(authority.getNativeLocalProviderAuthority(sibling.providerName)).toEqual(sibling);
    expect(authority.getNativeLocalProviderAuthority(other.providerName)).toEqual(other);
  } finally {
    vi.unstubAllEnvs();
    vi.resetModules();
    await fs.rm(home, { recursive: true, force: true });
  }
});
