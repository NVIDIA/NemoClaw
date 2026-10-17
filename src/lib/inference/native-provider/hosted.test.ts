// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { OpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter";
import { parseCheckedInProviderProfileContract } from "../../adapters/openshell/provider-profile";
import { nativeProviderLifecycle } from "./index";
import { HOSTED_NATIVE_PROVIDERS, type HostedProviderDefinition } from "./hosted";

const target = { kind: "named", gatewayName: "test-gateway" } as const;
const notFound = {
  ok: false,
  error: { kind: "command", reason: "not_found", message: "not found" },
} as const;
const uncertain = { ok: false, error: { kind: "timeout", message: "timed out" } } as const;

function fixture(definition: HostedProviderDefinition) {
  const metadata = {
    name: definition.providerName,
    type: definition.profileId,
    credentialKeys: [definition.credentialEnv],
    configKeys: [],
    revision: { id: "immutable-provider-id", resourceVersion: 1 },
  };
  const receipt = {
    schemaVersion: 1,
    profileId: definition.profileId,
    providerName: definition.providerName,
    providerId: metadata.revision.id,
  } as const;
  const methods = {
    importProviderProfile: vi.fn<OpenShellProviderAdapter["importProviderProfile"]>(() => ({
      ok: true,
    })),
    ensureProviderPolicyComposition: vi.fn<
      OpenShellProviderAdapter["ensureProviderPolicyComposition"]
    >(async () => ({ ok: true, value: undefined })),
    getProvider: vi.fn<OpenShellProviderAdapter["getProvider"]>(async () => ({
      ok: true,
      value: metadata,
    })),
    createProvider: vi.fn<OpenShellProviderAdapter["createProvider"]>(async () => ({ ok: true })),
    updateProvider: vi.fn<OpenShellProviderAdapter["updateProvider"]>(async () => ({ ok: true })),
    attachProvider: vi.fn<OpenShellProviderAdapter["attachProvider"]>(async () => ({ ok: true })),
    detachProvider: vi.fn<OpenShellProviderAdapter["detachProvider"]>(async () => ({
      ok: true,
      value: { changed: true },
    })),
    listProviderAttachments: vi.fn<OpenShellProviderAdapter["listProviderAttachments"]>(
      async () => ({ ok: true, value: { names: [definition.providerName] } }),
    ),
  };
  return {
    methods,
    adapter: methods as unknown as OpenShellProviderAdapter,
    metadata,
    receipt,
    lifecycle: nativeProviderLifecycle(definition),
  };
}

const expectedPaths: Record<string, string[]> = {
  "openai-api": ["/v1/models", "/v1/chat/completions", "/v1/responses"],
  "anthropic-prod": ["/v1/models", "/v1/messages", "/v1/messages/count_tokens"],
  "gemini-api": ["/v1beta/openai/models", "/v1beta/openai/chat/completions"],
  "openrouter-api": ["/api/v1/models", "/api/v1/chat/completions"],
  "hermes-provider": ["/v1/models", "/v1/chat/completions"],
};

describe.each(HOSTED_NATIVE_PROVIDERS)("native $label lifecycle", (definition) => {
  it("limits credentials and requests to the selected hosted endpoint (#12589)", () => {
    const { lifecycle } = fixture(definition);
    const profile = parseCheckedInProviderProfileContract(
      fs.readFileSync(lifecycle.nativeProviderProfilePath(), "utf8"),
    );
    expect(profile?.profileId).toBe(definition.profileId);
    expect(profile?.boundary.credentials).toEqual([
      expect.objectContaining({
        name: "api_key",
        env_vars: [definition.credentialEnv],
        required: true,
        auth_style: definition.logicalProvider === "anthropic-prod" ? "header" : "bearer",
        header_name:
          definition.logicalProvider === "anthropic-prod" ? "x-api-key" : "authorization",
      }),
    ]);
    expect(profile?.boundary.endpoints).toEqual([
      {
        host: new URL(definition.endpoint).hostname,
        port: 443,
        protocol: "rest",
        enforcement: "enforce",
        rules: expectedPaths[definition.logicalProvider].map((path) => ({
          allow: { method: path.endsWith("/models") ? "GET" : "POST", path },
        })),
      },
    ]);
    expect(profile?.boundary.binaries).toEqual([
      "/usr/local/bin/node",
      "/usr/bin/node",
      "/opt/hermes/.venv/bin/python",
      "/opt/hermes/.venv/bin/python3",
      "/opt/venv/bin/python3",
      "/usr/local/bin/curl",
      "/usr/bin/curl",
    ]);
  });

  it("refuses an existing provider without ownership proof before mutation (#12589)", async () => {
    const { lifecycle, adapter, methods } = fixture(definition);
    await expect(
      lifecycle.ensureNativeProvider({ adapter, target, credentialValue: "test-secret" }),
    ).rejects.toThrow(/without a matching.*ownership receipt/u);
    expect(methods.updateProvider).not.toHaveBeenCalled();
    expect(methods.ensureProviderPolicyComposition).not.toHaveBeenCalled();
    expect(methods.createProvider).not.toHaveBeenCalled();
  });

  it("rejects another profile's receipt even when its provider ID matches (#12589)", async () => {
    const { lifecycle, adapter, methods, receipt } = fixture(definition);
    await expect(
      lifecycle.ensureNativeProvider({
        adapter,
        target,
        credentialValue: "test-secret",
        expected: { ...receipt, profileId: "unrelated-profile" },
      }),
    ).rejects.toThrow(/Invalid ownership receipt/u);
    expect(methods.importProviderProfile).not.toHaveBeenCalled();
    expect(methods.updateProvider).not.toHaveBeenCalled();
  });

  it("refuses a conflicting exported profile without touching credentials (#12589)", async () => {
    const { lifecycle, adapter, methods, receipt } = fixture(definition);
    methods.importProviderProfile.mockReturnValue({
      ok: false,
      error: {
        kind: "command",
        reason: "profile_incompatible",
        message: "different endpoint",
      },
    });
    await expect(
      lifecycle.ensureNativeProvider({
        adapter,
        target,
        credentialValue: "test-secret",
        expected: receipt,
      }),
    ).rejects.toThrow(/checked-in security boundary/u);
    expect(methods.updateProvider).not.toHaveBeenCalled();
    expect(methods.createProvider).not.toHaveBeenCalled();
  });

  it("observes an uncertain create without repeating it or persisting a secret (#12589)", async () => {
    const { lifecycle, adapter, methods, receipt } = fixture(definition);
    methods.getProvider.mockResolvedValueOnce(notFound);
    methods.createProvider.mockResolvedValueOnce(uncertain);
    const result = await lifecycle.ensureNativeProvider({
      adapter,
      target,
      credentialValue: "test-secret",
    });
    expect(result).toEqual(receipt);
    expect(JSON.stringify(result)).not.toContain("test-secret");
    expect(methods.createProvider).toHaveBeenCalledExactlyOnceWith({
      target,
      name: definition.providerName,
      type: definition.profileId,
      credentials: [{ name: definition.credentialEnv, value: "test-secret" }],
      config: [],
      fromExisting: false,
    });
    expect(methods.getProvider).toHaveBeenCalledTimes(2);
  });

  it("reconciles an uncertain attachment on only the selected sandbox (#12589)", async () => {
    const { lifecycle, adapter, methods, receipt } = fixture(definition);
    methods.listProviderAttachments.mockResolvedValueOnce({
      ok: true,
      value: { names: ["unrelated-provider"] },
    });
    methods.attachProvider.mockResolvedValueOnce(uncertain);
    await expect(
      lifecycle.ensureNativeProviderAttached({
        adapter,
        target,
        sandboxName: "selected",
        expected: receipt,
      }),
    ).resolves.toEqual({ receipt, changed: true });
    expect(methods.attachProvider).toHaveBeenCalledExactlyOnceWith({
      target,
      sandboxName: "selected",
      providerName: definition.providerName,
    });
    expect(
      methods.listProviderAttachments.mock.calls.every(
        ([input]) => input.sandboxName === "selected",
      ),
    ).toBe(true);
    expect(methods.detachProvider).not.toHaveBeenCalled();
  });
});
