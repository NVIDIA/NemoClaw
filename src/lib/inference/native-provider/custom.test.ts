// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import YAML from "yaml";
import { describe, expect, it, vi } from "vitest";
import type { OpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter";
import type { NativeProviderAttachment } from "./contract";
import { boundCustomNativeProfile, customNativeProvider } from "./custom";
import { recordedNativeProviderAttachment } from "./recorded-selection";
import { prepareCustomNativeProvider, usesCustomNativeOnboarding } from "./custom-setup";
import { requireHostedProviderAttachment } from "./hosted-attachment";
import { buildNativeHostedSandboxPolicy } from "./network-policy";
import { nativeProviderLifecycle } from "./index";
import { getSandboxInferenceConfig } from "../config";
import { nativeHostedAgentConfig } from "./agent-config";
import { createResumeProviderShim } from "../../onboard/machine/resume-provider-shim";
import { BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL } from "../bedrock-runtime";

const binding = {
  provider: "compatible-endpoint",
  endpointUrl: "https://custom.example/team/v1",
  api: "openai-completions",
  credentialEnv: "TEAM_KEY",
  allowedIps: ["8.8.8.8"],
} as const;

function harness() {
  let present = false;
  let receipt: NativeProviderAttachment | undefined;
  let definition = customNativeProvider(binding);
  const attachments = new Map<string, string[]>([["other", ["unrelated-provider"]]]);
  const adapter = {
    importProviderProfile: vi.fn<OpenShellProviderAdapter["importProviderProfile"]>(
      async ({ profilePath }) => {
        const profile = YAML.parse(fs.readFileSync(profilePath, "utf8"));
        expect(profile.id).toBe(definition.profileId);
        return { ok: true };
      },
    ),
    ensureProviderPolicyComposition: vi.fn(async () => ({ ok: true, value: undefined })),
    getProvider: vi.fn<OpenShellProviderAdapter["getProvider"]>(async () =>
      present
        ? {
            ok: true,
            value: {
              name: definition.providerName,
              type: definition.profileId,
              credentialKeys: [definition.credentialEnv],
              configKeys: [],
              revision: { id: "identity", resourceVersion: 1 },
            },
          }
        : { ok: false, error: { kind: "command", reason: "not_found", message: "absent" } },
    ),
    createProvider: vi.fn<OpenShellProviderAdapter["createProvider"]>(async () => {
      present = true;
      return { ok: true };
    }),
    updateProvider: vi.fn<OpenShellProviderAdapter["updateProvider"]>(),
    listProviderAttachments: vi.fn<OpenShellProviderAdapter["listProviderAttachments"]>(
      async ({ sandboxName }) => ({
        ok: true,
        value: { names: [...(attachments.get(sandboxName) ?? [])] },
      }),
    ),
    attachProvider: vi.fn<OpenShellProviderAdapter["attachProvider"]>(
      async ({ sandboxName, providerName }) => {
        attachments.set(sandboxName, [...(attachments.get(sandboxName) ?? []), providerName]);
        return { ok: true };
      },
    ),
    detachProvider: vi.fn<OpenShellProviderAdapter["detachProvider"]>(
      async ({ sandboxName, providerName }) => {
        attachments.set(
          sandboxName,
          (attachments.get(sandboxName) ?? []).filter((name) => name !== providerName),
        );
        return { ok: true, value: { changed: true } };
      },
    ),
  };
  const lookup = vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]);
  const writeAuthority = vi.fn(
    (_gateway: string, _provider: string, value: NativeProviderAttachment) => {
      receipt = value;
    },
  );
  const input = {
    gatewayName: "gateway",
    provider: binding.provider,
    endpointUrl: binding.endpointUrl,
    api: binding.api,
    credentialEnv: binding.credentialEnv,
    credentialValue: "synthetic-host-secret",
    lookup,
    adapter: adapter as unknown as OpenShellProviderAdapter,
    readAuthority: (_gateway: string, name: string) =>
      receipt?.providerName === name ? receipt : undefined,
    writeAuthority,
  };
  return {
    adapter,
    input,
    lookup,
    writeAuthority,
    attachments,
    select: (value: Parameters<typeof customNativeProvider>[0]) => {
      definition = customNativeProvider(value);
    },
  };
}

describe("custom native endpoint ownership", () => {
  it.each([
    ["compatible-endpoint", "openai-completions", "/team/v1/chat/completions"],
    ["compatible-endpoint", "openai-responses", "/team/v1/responses"],
    ["compatible-anthropic-endpoint", "anthropic-messages", "/team/v1/messages"],
    ["compatible-anthropic-endpoint", "openai-completions", "/team/v1/chat/completions"],
    ["compatible-anthropic-endpoint", "openai-responses", "/team/v1/responses"],
  ])(
    "binds %s %s to the same agent, profile and health destination",
    (provider, api, requestPath) => {
      const endpointUrl =
        provider === "compatible-endpoint" ? binding.endpointUrl : "https://custom.example/team";
      const definition = customNativeProvider({ ...binding, endpointUrl, provider, api });
      const profile = YAML.parse(
        boundCustomNativeProfile(
          definition,
          nativeProviderLifecycle(definition).nativeProviderProfilePath(),
        ),
      );
      expect(profile.endpoints[0]).toMatchObject({
        host: "custom.example",
        port: 443,
        allowed_ips: binding.allowedIps,
        enforcement: "enforce",
        rules: expect.arrayContaining([{ allow: { method: "POST", path: requestPath } }]),
      });
      expect(
        profile.endpoints[0].rules.every(
          (rule: { allow: { path: string } }) => !rule.allow.path.includes("*"),
        ),
      ).toBe(true);
      expect(profile.endpoints[0]).not.toHaveProperty("tls");
      expect(profile.binaries).not.toContain("*");
      expect(profile.credentials[0].env_vars).toEqual([definition.credentialEnv]);
      const config = getSandboxInferenceConfig("selected-model", provider, api, true, endpointUrl);
      expect(config.inferenceBaseUrl).toBe(definition.endpointUrl);
      expect(config.inferenceApi).toBe(api);
      expect(config.primaryModelRef).toBe(
        `${api === "anthropic-messages" ? "anthropic" : "inference"}/selected-model`,
      );
      expect(nativeHostedAgentConfig(provider, config.inferenceBaseUrl)?.apiKey).toBe(
        `openshell:resolve:env:${definition.credentialEnv}`,
      );
    },
  );

  it.each([
    ["compatible-endpoint", "openai-completions", "https://custom.example/team/v1"],
    ["compatible-anthropic-endpoint", "anthropic-messages", "https://custom.example/team"],
  ])(
    "uses the native %s default API when selection is omitted (#13195)",
    (provider, api, endpointUrl) => {
      const definition = customNativeProvider({ ...binding, provider, api, endpointUrl });
      const config = getSandboxInferenceConfig("selected-model", provider, null, true, endpointUrl);
      expect(config).toMatchObject({
        inferenceApi: definition.api,
        inferenceBaseUrl: definition.endpointUrl,
        primaryModelRef: `${api === "anthropic-messages" ? "anthropic" : "inference"}/selected-model`,
      });
    },
  );

  it("rejects an unverified Anthropic bridge before provider mutation", async () => {
    const h = harness();
    const bridge = {
      ...binding,
      provider: "compatible-anthropic-endpoint",
      endpointUrl: "http://host.openshell.internal:49152",
      allowedIps: [],
    };
    await expect(prepareCustomNativeProvider({ ...h.input, ...bridge })).rejects.toThrow(
      "cannot use an unverified OpenShell host bridge endpoint",
    );
    expect(h.lookup).not.toHaveBeenCalled();
    expect(h.adapter.importProviderProfile).not.toHaveBeenCalled();
    expect(h.adapter.createProvider).not.toHaveBeenCalled();
  });

  it.each([
    "http://host.openshell.internal:80",
    "https://host.openshell.internal:49152",
    "http://host.docker.internal:49152",
    "http://host.openshell.internal:18789",
    "http://host.openshell.internal:8080",
  ])(
    "rejects unsupported or protected Anthropic bridge %s before mutation",
    async (endpointUrl) => {
      const h = harness();
      await expect(
        prepareCustomNativeProvider({
          ...h.input,
          provider: "compatible-anthropic-endpoint",
          endpointUrl,
        }),
      ).rejects.toThrow();
      expect(h.adapter.importProviderProfile).not.toHaveBeenCalled();
      expect(h.adapter.createProvider).not.toHaveBeenCalled();
    },
  );

  it("keeps endpoint, API, credential source and pin authorities distinct", () => {
    const names = [
      binding,
      { ...binding, endpointUrl: "https://other.example/team/v1" },
      { ...binding, api: "openai-responses" },
      { ...binding, credentialEnv: "OTHER_KEY" },
      { ...binding, allowedIps: ["1.1.1.1"] },
    ].map((value) => customNativeProvider(value).providerName);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each([
    "ftp://custom.example/v1",
    "https://user:secret@custom.example/v1",
    "https://custom.example/v1?key=secret",
    "https://custom.example/v1#fragment",
    "https://custom.example/%2e%2e/v1",
    "https://inference.local/v1",
    "https://127.0.0.1/v1",
  ])("rejects unsafe endpoint %s before resource mutation", async (endpointUrl) => {
    const h = harness();
    await expect(prepareCustomNativeProvider({ ...h.input, endpointUrl })).rejects.toThrow();
    expect(h.adapter.importProviderProfile).not.toHaveBeenCalled();
    expect(h.adapter.createProvider).not.toHaveBeenCalled();
  });

  it("rejects a private DNS answer and missing API credentials before import", async () => {
    const h = harness();
    await expect(
      prepareCustomNativeProvider({
        ...h.input,
        lookup: async () => [{ address: "169.254.169.254" }],
      }),
    ).rejects.toThrow("admission failed");
    await expect(
      prepareCustomNativeProvider({ ...h.input, credentialValue: null }),
    ).rejects.toThrow("A new credential is required");
    await expect(prepareCustomNativeProvider({ ...h.input, api: "unsupported" })).rejects.toThrow(
      "Invalid custom",
    );
    expect(h.adapter.importProviderProfile).not.toHaveBeenCalled();
  });

  it.each([
    ["https://custom.example/team/v1", ["10.0.0.8"], ["custom.example"]],
    ["https://8.8.8.8/team/v1", ["8.8.8.8"], []],
  ] as const)(
    "admits exact pins for %s without widening the host",
    async (endpointUrl, addresses, trustedPrivateHosts) => {
      const h = harness();
      h.select({ ...binding, endpointUrl, allowedIps: addresses });
      const result = await prepareCustomNativeProvider({
        ...h.input,
        endpointUrl,
        trustedPrivateHosts,
        lookup: async () => addresses.map((address) => ({ address })),
      });
      const policy = YAML.parse(
        buildNativeHostedSandboxPolicy("network_policies: {}", result.providerName, result),
      );
      expect(policy.network_policies.native_hosted_inference.endpoints[0].allowed_ips).toEqual(
        addresses,
      );
    },
  );

  it("reuses verified credentials without rotating them, even when a host key is present", async () => {
    const h = harness();
    const onCredentialPersisted = vi.fn();
    const first = await prepareCustomNativeProvider({ ...h.input, onCredentialPersisted });
    expect(onCredentialPersisted).toHaveBeenCalledExactlyOnceWith(
      binding.credentialEnv,
      "synthetic-host-secret",
    );
    onCredentialPersisted.mockClear();
    const second = await prepareCustomNativeProvider({
      ...h.input,
      recordedAttachment: first,
      credentialValue: "another-host-key",
      onCredentialPersisted,
      lookup: async () => {
        throw new Error("Do not re-resolve admitted pins");
      },
    });
    expect(second).toEqual(first);
    expect(onCredentialPersisted).not.toHaveBeenCalled();
    expect(h.adapter.createProvider).toHaveBeenCalledTimes(1);
    expect(h.adapter.updateProvider).not.toHaveBeenCalled();
    expect(JSON.stringify(h.writeAuthority.mock.calls)).not.toContain("synthetic-host-secret");
    expect(fs.existsSync(h.adapter.importProviderProfile.mock.calls[0][0].profilePath)).toBe(false);
    await expect(
      prepareCustomNativeProvider({
        ...h.input,
        recordedAttachment: first,
        credentialValue: null,
        api: "openai-responses",
      }),
    ).rejects.toThrow("A new credential is required");
    expect(h.adapter.createProvider).toHaveBeenCalledTimes(1);
  });

  it("reuses recorded authority after resume without a session credential (#13195)", async () => {
    const h = harness();
    const first = await prepareCustomNativeProvider(h.input);
    const replaceNamedCredential = vi.fn(async () => "unexpected");
    const shim = createResumeProviderShim({
      getSandbox: () => ({ nativeHostedProviderAttachment: first }),
      isNonInteractive: () => true,
      providerExistsInGateway: vi.fn(() => false),
      isRoutedInferenceProvider: () => false,
      replaceNamedCredential,
    });
    const recovery = await shim.ensureResumeProviderReady(
      h.input.gatewayName,
      binding.provider,
      null,
      undefined,
      { sandboxName: "alpha", endpointUrl: binding.endpointUrl },
    );
    const onCredentialPersisted = vi.fn();
    const resumed = await prepareCustomNativeProvider({
      ...h.input,
      recordedAttachment: first,
      credentialEnv: recovery.credentialEnv!,
      credentialValue: null,
      onCredentialPersisted,
    });
    expect(resumed).toEqual(first);
    expect(h.adapter.createProvider).toHaveBeenCalledTimes(1);
    expect(h.adapter.updateProvider).not.toHaveBeenCalled();
    expect(replaceNamedCredential).not.toHaveBeenCalled();
    expect(onCredentialPersisted).not.toHaveBeenCalled();
  });

  it.each([
    [
      "only the registry records ownership",
      false,
      /only the NemoClaw registry record for sandbox 'alpha'.*'nemoclaw alpha destroy'/su,
    ],
    ["the gateway records ownership", true, /complete uninstall without --keep-openshell/u],
  ])("explains a missing provider when %s", async (_case, gatewayOwned, message) => {
    const h = harness();
    const recorded = await prepareCustomNativeProvider(h.input);
    h.adapter.getProvider.mockResolvedValue({
      ok: false,
      error: { kind: "command", reason: "not_found", message: "absent" },
    });
    await expect(
      prepareCustomNativeProvider({
        ...h.input,
        recordedAttachment: recorded,
        recordedSandboxName: "alpha",
        readAuthority: (gateway, name) =>
          gatewayOwned ? h.input.readAuthority(gateway, name) : undefined,
      }),
    ).rejects.toThrow(message);
    expect(h.adapter.createProvider).toHaveBeenCalledTimes(1);
  });

  it("does not retire a credential when authority persistence fails", async () => {
    const h = harness();
    const onCredentialPersisted = vi.fn();
    await expect(
      prepareCustomNativeProvider({
        ...h.input,
        onCredentialPersisted,
        writeAuthority: () => {
          throw new Error("authority write failed");
        },
      }),
    ).rejects.toThrow("authority write failed");
    expect(onCredentialPersisted).not.toHaveBeenCalled();
  });

  it("removes a new attachment when its profile changes before verification", async () => {
    const h = harness();
    const receipt = await prepareCustomNativeProvider(h.input);
    const provider = nativeProviderLifecycle(customNativeProvider(binding));
    h.adapter.importProviderProfile.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({
      ok: false,
      error: { kind: "command", reason: "profile_incompatible", message: "collision" },
    });
    await expect(
      provider.ensureNativeProviderAttached({
        adapter: h.input.adapter,
        target: { kind: "named", gatewayName: "gateway" },
        sandboxName: "selected",
        expected: receipt,
      }),
    ).rejects.toThrow("conflicts with NemoClaw's checked-in security boundary");
    expect(h.adapter.attachProvider).toHaveBeenCalledOnce();
    expect(h.adapter.detachProvider).toHaveBeenCalledOnce();
    expect(h.attachments.get("selected")).toEqual([]);
    expect(h.attachments.get("other")).toEqual(["unrelated-provider"]);
  });

  it("rejects profile collisions before provider or attachment changes", async () => {
    const h = harness();
    h.adapter.importProviderProfile.mockResolvedValue({
      ok: false,
      error: { kind: "command", reason: "profile_incompatible", message: "collision" },
    });
    await expect(prepareCustomNativeProvider(h.input)).rejects.toThrow("conflicts");
    expect(h.adapter.createProvider).not.toHaveBeenCalled();
    expect(h.adapter.attachProvider).not.toHaveBeenCalled();
  });

  it("observes an ambiguous create once and changes access only on the selected sandbox", async () => {
    const h = harness();
    const create = h.adapter.createProvider.getMockImplementation()!;
    h.adapter.createProvider.mockImplementation(async (request) => {
      await create(request);
      return { ok: false, error: { kind: "timeout", message: "timeout" } } as Awaited<
        ReturnType<OpenShellProviderAdapter["createProvider"]>
      >;
    });
    const receipt = await prepareCustomNativeProvider(h.input);
    const lifecycle = nativeProviderLifecycle(customNativeProvider(binding));
    const operation = {
      adapter: h.input.adapter,
      target: { kind: "named", gatewayName: "gateway" } as const,
      sandboxName: "selected",
      expected: receipt,
    };
    await lifecycle.ensureNativeProviderAttached(operation);
    expect(h.attachments.get("selected")).toEqual([receipt.providerName]);
    expect(h.attachments.get("other")).toEqual(["unrelated-provider"]);
    await lifecycle.detachNativeProvider(operation);
    expect(h.attachments.get("selected")).toEqual([]);
    expect(h.attachments.get("other")).toEqual(["unrelated-provider"]);
    expect(h.adapter.createProvider).toHaveBeenCalledTimes(1);
  });

  it("keeps existing shared routes and rejects mismatched durable native selection", async () => {
    expect(usesCustomNativeOnboarding(binding.provider, binding.endpointUrl, "alpha", {})).toBe(
      false,
    );
    expect(usesCustomNativeOnboarding(binding.provider, binding.endpointUrl, "alpha", null)).toBe(
      true,
    );
    expect(
      usesCustomNativeOnboarding(binding.provider, "http://127.0.0.1:8080/v1", "alpha", null),
    ).toBe(false);
    const h = harness();
    const receipt = await prepareCustomNativeProvider(h.input);
    expect(
      recordedNativeProviderAttachment({
        provider: binding.provider,
        endpointUrl: binding.endpointUrl,
        credentialEnv: binding.credentialEnv,
        preferredInferenceApi: binding.api,
        nativeHostedProviderAttachment: receipt,
      }),
    ).toEqual(receipt);
    expect(() =>
      recordedNativeProviderAttachment({
        provider: binding.provider,
        preferredInferenceApi: "openai-responses",
        nativeHostedProviderAttachment: receipt,
      }),
    ).toThrow("does not match");
  });

  it("rejects altered receipts and unsafe recorded pins", async () => {
    const h = harness();
    const receipt = await prepareCustomNativeProvider(h.input);
    expect(() =>
      requireHostedProviderAttachment(
        { ...receipt, endpointUrl: "https://other.example/v1" },
        binding.provider,
      ),
    ).toThrow();
  });

  it.each([[[]], [["127.0.0.1"]], [["169.254.169.254"]], [["0.0.0.0/0"]]])(
    "rejects unsafe recorded pins %j",
    (allowedIps) => {
      expect(() => customNativeProvider({ ...binding, allowedIps })).toThrow();
    },
  );

  it("keeps Bedrock AWS credentials in the existing adapter and injects only its token", async () => {
    const h = harness();
    const onCredentialPersisted = vi.fn();
    const bedrock = {
      ...binding,
      provider: "compatible-anthropic-endpoint",
      endpointUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
      allowedIps: [],
      adapterEndpointUrl: BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL,
    };
    h.select(bedrock);
    const ensureBedrockAdapter = vi.fn(async () => ({
      baseUrl: BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL,
      token: "synthetic-adapter-token",
    })) as unknown as NonNullable<
      Parameters<typeof prepareCustomNativeProvider>[0]["ensureBedrockAdapter"]
    >;
    const receipt = await prepareCustomNativeProvider({
      ...h.input,
      provider: bedrock.provider,
      endpointUrl: bedrock.endpointUrl,
      ensureBedrockAdapter,
      onCredentialPersisted,
    });
    expect(h.adapter.createProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: [{ name: "COMPATIBLE_ANTHROPIC_API_KEY", value: "synthetic-adapter-token" }],
      }),
    );
    expect(receipt.endpointUrl).toBe(BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL);
    await prepareCustomNativeProvider({
      ...h.input,
      provider: bedrock.provider,
      endpointUrl: bedrock.endpointUrl,
      credentialValue: null,
      recordedAttachment: receipt,
      ensureBedrockAdapter,
    });
    expect(ensureBedrockAdapter).toHaveBeenCalledTimes(1);
    expect(h.adapter.updateProvider).not.toHaveBeenCalled();
    expect(JSON.stringify(receipt)).not.toContain("synthetic-");
    expect(h.lookup).not.toHaveBeenCalled();
    expect(onCredentialPersisted).not.toHaveBeenCalled();
  });
});
