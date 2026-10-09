// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, expect, it, vi } from "vitest";
import { nativeCompatibleEndpointIdentity } from "../inference/native-compatible/endpoint";

// Compile the registry graph before timing filesystem persistence assertions.
beforeAll(async () => {
  await import("./registry");
});

it("retains endpoint ownership after switching the sandbox away from compatible inference", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-compatible-state-"));
  vi.stubEnv("HOME", home);
  vi.resetModules();
  try {
    const registry = await import("./registry");
    const authority = await import("./registry/native-compatible-provider-authority");
    const identity = nativeCompatibleEndpointIdentity({
      addresses: ["93.184.216.34"],
      endpointUrl: "https://api.example.com/v1",
      api: "openai-completions",
    });
    const receipt = {
      schemaVersion: 1 as const,
      profileId: identity.profileId,
      providerName: identity.providerName,
      providerId: "owned-provider",
      addresses: ["93.184.216.34"],
      endpointUrl: identity.endpoint,
      api: identity.api,
    };
    authority.setNativeCompatibleProviderAuthority("gateway", receipt);
    registry.registerSandbox({
      name: "alpha",
      provider: "compatible-endpoint",
      model: "model-a",
      endpointUrl: identity.endpoint,
      preferredInferenceApi: identity.api,
      nativeCompatibleProviderAttachment: receipt,
      gatewayName: "gateway",
      gatewayPort: 8080,
    });
    expect(registry.getSandbox("alpha")?.nativeCompatibleProviderAttachment).toEqual(receipt);
    expect(() =>
      authority.clearNativeCompatibleProviderAuthority("gateway", {
        ...receipt,
        providerId: "replacement",
      }),
    ).toThrow("ownership changed");
    expect(registry.getSandbox("alpha")?.nativeCompatibleProviderAttachment).toEqual(receipt);
    authority.clearNativeCompatibleProviderAuthority("gateway", receipt);
    expect(registry.getSandbox("alpha")?.nativeCompatibleProviderAttachment).toBeUndefined();
    expect(
      registry.getNativeCompatibleProviderAuthority("gateway", receipt.profileId),
    ).toBeUndefined();
    authority.setNativeCompatibleProviderAuthority("gateway", receipt);
    registry.updateSandbox("alpha", { nativeCompatibleProviderAttachment: receipt });
    expect(registry.updateSandbox("alpha", { provider: "nvidia-prod", endpointUrl: null })).toBe(
      true,
    );
    expect(registry.getSandbox("alpha")?.nativeCompatibleProviderAttachment).toBeUndefined();
    expect(registry.getNativeCompatibleProviderAuthority("gateway", identity.profileId)).toEqual(
      receipt,
    );
    expect(
      registry.getNativeCompatibleProviderAuthority("other-gateway", identity.profileId),
    ).toBeUndefined();
    expect(() =>
      authority.setNativeCompatibleProviderAuthority("gateway", {
        ...receipt,
        providerId: "replacement",
      }),
    ).toThrow("identity changed");
    expect(registry.getNativeCompatibleProviderAuthority("gateway", identity.profileId)).toEqual(
      receipt,
    );
  } finally {
    vi.unstubAllEnvs();
    vi.resetModules();
    await fs.rm(home, { recursive: true, force: true });
  }
});

it("refuses a sandbox receipt for a different endpoint without writing the sandbox", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-compatible-state-"));
  vi.stubEnv("HOME", home);
  vi.resetModules();
  try {
    const registry = await import("./registry");
    const identity = nativeCompatibleEndpointIdentity({
      addresses: ["93.184.216.34"],
      endpointUrl: "https://api.example.com/v1",
      api: "openai-completions",
    });
    const receipt = {
      schemaVersion: 1 as const,
      profileId: identity.profileId,
      providerName: identity.providerName,
      providerId: "owned-provider",
      addresses: ["93.184.216.34"],
      endpointUrl: identity.endpoint,
      api: identity.api,
    };
    expect(() =>
      registry.registerSandbox({
        name: "alpha",
        provider: "compatible-endpoint",
        model: "model-a",
        endpointUrl: "https://other.example.com/v1",
        preferredInferenceApi: identity.api,
        nativeCompatibleProviderAttachment: receipt,
        gatewayName: "gateway",
      }),
    ).toThrow("selected endpoint");
    expect(registry.getSandbox("alpha")).toBeNull();
  } finally {
    vi.unstubAllEnvs();
    vi.resetModules();
    await fs.rm(home, { recursive: true, force: true });
  }
});

it.each([
  { label: "malformed receipt", receiptPatch: { providerId: "" }, selectionPatch: {} },
  {
    label: "different endpoint",
    receiptPatch: {},
    selectionPatch: { endpointUrl: "https://other.example.com/v1" },
  },
  {
    label: "different API",
    receiptPatch: {},
    selectionPatch: { preferredInferenceApi: "anthropic-messages" },
  },
])(
  "rejects $label at registry load and save without replacing durable state",
  async ({ receiptPatch, selectionPatch }) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-compatible-state-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      const authority = await import("./registry/native-compatible-provider-authority");
      const persistence = await import("./registry/persistence");
      const identity = nativeCompatibleEndpointIdentity({
        addresses: ["93.184.216.34"],
        endpointUrl: "https://api.example.com/v1",
        api: "openai-completions",
      });
      const receipt = {
        schemaVersion: 1 as const,
        profileId: identity.profileId,
        providerName: identity.providerName,
        providerId: "owned-provider",
        addresses: ["93.184.216.34"],
        endpointUrl: identity.endpoint,
        api: identity.api,
      };
      authority.setNativeCompatibleProviderAuthority("gateway", receipt);
      registry.registerSandbox({
        name: "alpha",
        provider: "compatible-endpoint",
        model: "model-a",
        endpointUrl: identity.endpoint,
        preferredInferenceApi: identity.api,
        nativeCompatibleProviderAttachment: receipt,
        gatewayName: "gateway",
      });
      const durable = await fs.readFile(persistence.REGISTRY_FILE, "utf8");
      const invalid = persistence.load();
      Object.assign(invalid.sandboxes.alpha, selectionPatch, {
        nativeCompatibleProviderAttachment: { ...receipt, ...receiptPatch },
      });
      expect(() => persistence.save(invalid)).toThrow("selected endpoint");
      expect(await fs.readFile(persistence.REGISTRY_FILE, "utf8")).toBe(durable);
      await fs.writeFile(persistence.REGISTRY_FILE, JSON.stringify(invalid));
      expect(() => persistence.load()).toThrow("selected endpoint");
      expect(await fs.readFile(persistence.REGISTRY_FILE, "utf8")).toBe(JSON.stringify(invalid));
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
      await fs.rm(home, { recursive: true, force: true });
    }
  },
);

it("rejects rotated or invalid compatible receipts in an existing pending reservation", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-compatible-reservation-"));
  vi.stubEnv("HOME", home);
  vi.resetModules();
  try {
    const registry = await import("./registry");
    const identity = nativeCompatibleEndpointIdentity({
      addresses: ["93.184.216.34"],
      endpointUrl: "https://api.example.com/v1",
      api: "openai-completions",
    });
    const receipt = {
      schemaVersion: 1 as const,
      ...identity,
      endpointUrl: identity.endpoint,
      providerId: "owned",
      addresses: ["93.184.216.34"],
    };
    const route = {
      provider: "compatible-endpoint",
      model: "model-a",
      endpointUrl: identity.endpoint,
      preferredInferenceApi: identity.api,
      gatewayName: "gateway",
      reservationSessionId: "session",
      credentialEnv: "COMPATIBLE_API_KEY",
      nativeCompatibleProviderAttachment: receipt,
    };
    expect(registry.reserveSandboxInferenceRoute("alpha", route)).toBe(true);
    const before = registry.getSandbox("alpha");
    const rotated = nativeCompatibleEndpointIdentity({
      addresses: ["93.184.216.35"],
      endpointUrl: identity.endpoint,
      api: identity.api,
    });
    expect(() =>
      registry.reserveSandboxInferenceRoute("alpha", {
        ...route,
        nativeCompatibleProviderAttachment: {
          ...receipt,
          ...rotated,
          providerId: "rotated",
          addresses: ["93.184.216.35"],
        },
      }),
    ).toThrow("cannot change");
    expect(() =>
      registry.reserveSandboxInferenceRoute("alpha", {
        ...route,
        nativeCompatibleProviderAttachment: { ...receipt, providerId: "" },
      }),
    ).toThrow("selected endpoint");
    expect(registry.getSandbox("alpha")).toEqual(before);
  } finally {
    vi.unstubAllEnvs();
    vi.resetModules();
    await fs.rm(home, { recursive: true, force: true });
  }
});
