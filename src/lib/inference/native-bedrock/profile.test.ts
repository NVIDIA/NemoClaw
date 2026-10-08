// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { OpenShellProviderAdapter } from "../../adapters/openshell/sandbox-observer";
import { parseCheckedInProviderProfileContract } from "../../adapters/openshell/provider-profile";
import { BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL } from "../bedrock-runtime";
import {
  nativeBedrockIdentity,
  normalizeNativeBedrockProviderAttachment,
  type NativeBedrockBinding,
} from "./contract";
import {
  ensureNativeBedrockProviderAttached,
  verifyNativeBedrockProviderAttachment,
  ensureNativeBedrockProvider,
  prepareNativeBedrockProfile,
} from "./profile";

const binding: NativeBedrockBinding = {
  endpointUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
  region: "us-east-1",
  adapterGeneration: "a".repeat(32),
  adapterBaseUrl: BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL,
  gatewayName: "selected-gateway",
};
function fixture() {
  const profile = prepareNativeBedrockProfile(binding);
  const metadata = {
    name: profile.providerName,
    type: profile.profileId,
    credentialKeys: [profile.credentialEnv],
    configKeys: [],
    revision: { id: "owned", resourceVersion: 1 },
  };
  const getProvider = vi
    .fn<OpenShellProviderAdapter["getProvider"]>()
    .mockResolvedValue({ ok: true, value: metadata });
  const createProvider = vi
    .fn<OpenShellProviderAdapter["createProvider"]>()
    .mockResolvedValue({ ok: true });
  const updateProvider = vi
    .fn<OpenShellProviderAdapter["updateProvider"]>()
    .mockResolvedValue({ ok: true });
  const importProviderProfile = vi
    .fn<OpenShellProviderAdapter["importProviderProfile"]>()
    .mockReturnValue({ ok: true });
  const adapter = {
    getProvider,
    createProvider,
    updateProvider,
    importProviderProfile,
    ensureProviderPolicyComposition: vi.fn().mockResolvedValue({ ok: true }),
  } as unknown as OpenShellProviderAdapter;
  return { profile, adapter, getProvider, createProvider, updateProvider, importProviderProfile };
}
describe("native Bedrock adapter profile", () => {
  it("grants only the fixed adapter REST surface and issued adapter token", () => {
    const profile = prepareNativeBedrockProfile(binding);
    expect(parseCheckedInProviderProfileContract(JSON.stringify(profile.document))).not.toBeNull();
    const endpoint = new URL(binding.adapterBaseUrl);
    expect(profile.document.endpoints).toEqual([
      {
        host: "host.openshell.internal",
        port: Number(endpoint.port),
        protocol: "rest",
        enforcement: "enforce",
        rules: [
          { allow: { method: "GET", path: "/v1/models" } },
          { allow: { method: "POST", path: "/v1/chat/completions" } },
        ],
      },
    ]);
    expect(profile.document.credentials).toEqual([
      {
        name: "api_key",
        env_vars: ["NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_TOKEN"],
        required: true,
        auth_style: "bearer",
        header_name: "authorization",
        query_param: "",
      },
    ]);
    expect(profile.document.binaries).toEqual([
      "/usr/local/bin/node",
      "/usr/bin/node",
      "/opt/hermes/.venv/bin/python",
      "/opt/hermes/.venv/bin/python3",
      "/opt/venv/bin/python3",
      "/usr/local/bin/curl",
      "/usr/bin/curl",
    ]);
    expect(JSON.stringify(profile.document)).not.toContain("AWS_");
  });
  it.each([
    { endpointUrl: "https://bedrock-runtime.us-west-2.amazonaws.com" },
    { region: "us-west-2" },
    { adapterGeneration: "b".repeat(32) },
    { gatewayName: "peer-gateway" },
  ])("binds resource identity to each upstream and generation field (%j)", (change) => {
    expect(nativeBedrockIdentity({ ...binding, ...change })).not.toEqual(
      nativeBedrockIdentity(binding),
    );
    const receipt = {
      schemaVersion: 1,
      providerId: "owned",
      ...binding,
      ...nativeBedrockIdentity(binding),
    };
    expect(normalizeNativeBedrockProviderAttachment({ ...receipt, ...change })).toBeUndefined();
  });
  it.each([
    { adapterBaseUrl: "http://attacker.example:11436/v1" },
    { adapterBaseUrl: "http://host.openshell.internal:1/v1" },
    { endpointUrl: "https://bedrock-runtime.us-east-1.amazonaws.com.attacker.example" },
    { endpointUrl: "https://user:secret@bedrock-runtime.us-east-1.amazonaws.com" },
    { adapterGeneration: "invalid" },
    { gatewayName: "" },
    { region: "bad region" },
  ])("refuses changed destinations or malformed binding before mutation (%j)", async (change) => {
    const f = fixture();
    await expect(
      ensureNativeBedrockProvider({
        binding: { ...binding, ...change },
        adapter: f.adapter,
        credentialValue: "private-token",
      }),
    ).rejects.toThrow("Invalid native Bedrock");
    expect(f.importProviderProfile).not.toHaveBeenCalled();
    expect(f.getProvider).not.toHaveBeenCalled();
    expect(f.createProvider).not.toHaveBeenCalled();
  });
  it("reconciles uncertain creation and returns only non-secret generation evidence", async () => {
    const f = fixture();
    f.getProvider.mockResolvedValueOnce({
      ok: false,
      error: { kind: "command", reason: "not_found", message: "absent" },
    });
    f.createProvider.mockResolvedValueOnce({
      ok: false,
      error: { kind: "timeout", message: "unknown" },
    });
    let importedPath = "";
    f.importProviderProfile.mockImplementation((request) => {
      importedPath = request.profilePath;
      expect(fs.readFileSync(importedPath, "utf8")).not.toContain("private-token");
      return { ok: true };
    });
    const receipt = await ensureNativeBedrockProvider({
      binding: { ...binding, ...{ token: "private-token", tokenHash: "private-hash" } },
      adapter: f.adapter,
      credentialValue: "private-token",
    });
    expect(receipt).toEqual({
      schemaVersion: 1,
      providerId: "owned",
      ...binding,
      ...nativeBedrockIdentity(binding),
    });
    expect(
      normalizeNativeBedrockProviderAttachment({
        ...receipt,
        token: "private-token",
        tokenHash: "private-hash",
      }),
    ).toEqual(receipt);
    expect(f.createProvider).toHaveBeenCalledTimes(1);
    expect(f.getProvider).toHaveBeenCalledTimes(2);
    expect(f.createProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: "named", gatewayName: binding.gatewayName },
        credentials: [{ name: "NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_TOKEN", value: "private-token" }],
      }),
    );
    expect(fs.existsSync(importedPath)).toBe(false);
  });
  it("refuses a collided provider without ownership and preserves peer resources", async () => {
    const f = fixture();
    await expect(
      ensureNativeBedrockProvider({
        binding,
        adapter: f.adapter,
        credentialValue: "private-token",
      }),
    ).rejects.toThrow("ownership receipt");
    expect(f.createProvider).not.toHaveBeenCalled();
    expect(f.updateProvider).not.toHaveBeenCalled();
  });
});

describe("native Bedrock attachment observation", () => {
  it.each([ensureNativeBedrockProviderAttached, verifyNativeBedrockProviderAttachment])(
    "refuses a changed adapter before any provider or attachment effect",
    async (operation) => {
      const f = fixture();
      const expected = {
        ...binding,
        ...nativeBedrockIdentity(binding),
        schemaVersion: 1 as const,
        providerId: "owned",
      };
      const inspectProviderProfile = vi.fn();
      f.adapter.inspectProviderProfile = inspectProviderProfile;
      await expect(
        operation({
          adapter: f.adapter,
          sandboxName: "alpha",
          expected,
          verifyAdapterGeneration: async () => {
            throw new Error("adapter generation changed");
          },
        }),
      ).rejects.toThrow("adapter generation changed");
      expect(inspectProviderProfile).not.toHaveBeenCalled();
      expect(f.getProvider).not.toHaveBeenCalled();
      expect(f.createProvider).not.toHaveBeenCalled();
    },
  );
  it("observes the exact named-gateway attachment without touching peers or rewriting the profile", async () => {
    const f = fixture();
    const expected = {
      ...binding,
      ...nativeBedrockIdentity(binding),
      schemaVersion: 1 as const,
      providerId: "owned",
    };
    const inspectProviderProfile = vi.fn(async () => ({ ok: true as const }));
    const listProviderAttachments = vi.fn(async () => ({
      ok: true as const,
      value: { names: [expected.providerName] },
    }));
    Object.assign(f.adapter, { inspectProviderProfile, listProviderAttachments });
    const verifyAdapterGeneration = vi.fn(async () => undefined);
    await verifyNativeBedrockProviderAttachment({
      adapter: f.adapter,
      sandboxName: "alpha",
      expected,
      verifyAdapterGeneration,
    });
    expect(verifyAdapterGeneration).toHaveBeenCalledWith(expected);
    expect(listProviderAttachments).toHaveBeenCalledWith({
      target: { kind: "named", gatewayName: binding.gatewayName },
      sandboxName: "alpha",
    });
    expect(f.importProviderProfile).not.toHaveBeenCalled();
    expect(f.createProvider).not.toHaveBeenCalled();
  });
});
