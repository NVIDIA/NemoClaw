// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import YAML from "yaml";
import { describe, expect, it, vi } from "vitest";
import { createDeps } from "../../../../test/helpers/inference-set";
import type { OpenShellSandboxPolicyReader } from "../../adapters/openshell/sandbox-policy";
import { customNativeProvider } from "../../inference/native-provider/custom";
import { prepareNativeSelection } from "./native";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]),
}));

function fixture(
  host: string,
  endpoint: Record<string, unknown> | null,
  allowedIps: readonly string[] = ["8.8.8.8"],
  providerPolicies: Record<string, unknown> = {},
) {
  const definition = customNativeProvider({
    provider: "compatible-endpoint",
    endpointUrl: `https://${host}/v1`,
    api: "openai-completions",
    credentialEnv: "COMPATIBLE_API_KEY",
    allowedIps,
  });
  const document = YAML.stringify({
    version: 1,
    network_policies: {
      ...providerPolicies,
      ...(endpoint
        ? { existing_policy: { endpoints: [endpoint], binaries: [{ path: "/usr/bin/node" }] } }
        : {}),
    },
  });
  const readSandboxPolicy = vi.fn<OpenShellSandboxPolicyReader["readSandboxPolicy"]>(async () => ({
    ok: true,
    value: { document, appliedRevision: 1 },
  }));
  const deps = Object.assign(
    createDeps({
      config: {},
      entry: { name: "alpha", agent: "openclaw", provider: "nvidia-prod" },
    }),
    { sandboxPolicyReader: { readSandboxPolicy } },
  );
  let created = false;
  let attached = false;
  vi.spyOn(deps.providerAdapter, "importProviderProfile").mockResolvedValue({ ok: true });
  vi.spyOn(deps.providerAdapter, "getProvider").mockImplementation(async () =>
    created
      ? {
          ok: true,
          value: {
            name: definition.providerName,
            type: definition.profileId,
            credentialKeys: [definition.credentialEnv],
            configKeys: [],
            revision: { id: "owned-provider", resourceVersion: 1 },
          },
        }
      : { ok: false, error: { kind: "command", reason: "not_found", message: "absent" } },
  );
  const createProvider = vi
    .spyOn(deps.providerAdapter, "createProvider")
    .mockImplementation(async () => {
      created = true;
      return { ok: true };
    });
  const attachProvider = vi
    .spyOn(deps.providerAdapter, "attachProvider")
    .mockImplementation(async () => {
      attached = true;
      return { ok: true };
    });
  vi.spyOn(deps.providerAdapter, "listProviderAttachments").mockImplementation(async () => ({
    ok: true,
    value: { names: attached ? [definition.providerName] : [] },
  }));
  const beforeAttach = vi.fn(async () => {});
  const writeAuthority = vi.fn(deps.setNativeHostedProviderAuthority);
  deps.setNativeHostedProviderAuthority = writeAuthority;
  const select = () =>
    prepareNativeSelection({
      selectingNative: true,
      provider: "compatible-endpoint",
      gatewayName: "owning-gateway",
      sandboxName: "alpha",
      endpointUrl: definition.endpoint,
      credentialEnv: "COMPATIBLE_API_KEY",
      inferenceApi: definition.api,
      beforeAttach,
      deps,
    });
  return {
    select,
    deps,
    readSandboxPolicy,
    createProvider,
    attachProvider,
    beforeAttach,
    writeAuthority,
  };
}

describe("custom native provider policy admission", () => {
  const previousProviderPolicy = {
    _provider_nvidia_prod: { endpoints: [{ host: "integrate.api.nvidia.com", port: 443 }] },
  };

  it.each([null, { host: "integrate.api.nvidia.com", port: 443, allowed_ips: ["8.8.8.8"] }])(
    "replaces a generated NVIDIA rule with non-conflicting base rules (%j)",
    async (endpoint) => {
      const test = fixture(
        "integrate.api.nvidia.com",
        endpoint,
        ["8.8.8.8"],
        previousProviderPolicy,
      );
      await expect(test.select()).resolves.toMatchObject({ attachmentChanged: true });
      expect(test.createProvider).toHaveBeenCalledOnce();
      expect(test.beforeAttach).toHaveBeenCalledOnce();
      expect(test.attachProvider).toHaveBeenCalledOnce();
      expect(test.writeAuthority).toHaveBeenCalled();
    },
  );

  it("refuses retained base conflicts before replacing a generated NVIDIA rule", async () => {
    const test = fixture(
      "integrate.api.nvidia.com",
      { host: "*.api.nvidia.com", port: 443 },
      ["8.8.8.8"],
      previousProviderPolicy,
    );
    await expect(test.select()).rejects.toThrow(/existing_policy.*IP pins/);
    expect(test.createProvider).not.toHaveBeenCalled();
    expect(test.beforeAttach).not.toHaveBeenCalled();
    expect(test.attachProvider).not.toHaveBeenCalled();
    expect(test.writeAuthority).not.toHaveBeenCalled();
  });

  it.each(["integrate.api.nvidia.com", "openrouter.ai"])(
    "refuses an unpinned %s policy before creating a provider (#13904)",
    async (host) => {
      const test = fixture(host, { host, port: 443 });
      await expect(test.select()).rejects.toThrow(
        /existing_policy.*IP pins.*No provider was changed/,
      );
      expect(test.createProvider).not.toHaveBeenCalled();
      expect(test.attachProvider).not.toHaveBeenCalled();
      expect(test.beforeAttach).not.toHaveBeenCalled();
      expect(test.writeAuthority).not.toHaveBeenCalled();
      expect(test.readSandboxPolicy).toHaveBeenCalledExactlyOnceWith({
        target: { kind: "named", gatewayName: "owning-gateway" },
        sandboxName: "alpha",
        scope: "base",
      });
    },
  );

  it("refuses different IP pins before creating or detaching a provider", async () => {
    const test = fixture("openrouter.ai", {
      host: "openrouter.ai",
      port: 443,
      allowed_ips: ["1.1.1.1"],
    });
    await expect(test.select()).rejects.toThrow(/existing_policy.*conflicting IP pins/);
    expect(test.createProvider).not.toHaveBeenCalled();
    expect(test.beforeAttach).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "a ports list",
      host: "openrouter.ai",
      endpoint: { host: "openrouter.ai", ports: [443] },
      pins: ["8.8.8.8"],
    },
    {
      label: "a trailing dot",
      host: "openrouter.ai.",
      endpoint: { host: "openrouter.ai.", port: 443 },
      pins: ["8.8.8.8"],
    },
    {
      label: "IPv6",
      host: "[2001:4860:4860::8888]",
      endpoint: { host: "2001:4860:4860::8888", port: 443 },
      pins: ["2001:4860:4860::8888"],
    },
    {
      label: "expanded IPv6",
      host: "[2001:4860:4860::8888]",
      endpoint: { host: "2001:4860:4860:0:0:0:0:8888", port: 443 },
      pins: ["2001:4860:4860::8888"],
    },
    {
      label: "ports overriding port",
      host: "openrouter.ai",
      endpoint: { host: "openrouter.ai", port: 8443, ports: [443] },
      pins: ["8.8.8.8"],
    },
  ])("refuses conflicting pins with $label", async ({ host, endpoint, pins }) => {
    const test = fixture(host, endpoint, pins);
    await expect(test.select()).rejects.toThrow(/existing_policy.*conflicting IP pins/);
    expect(test.createProvider).not.toHaveBeenCalled();
    expect(test.beforeAttach).not.toHaveBeenCalled();
  });

  it.each([
    { host: "api.example.com", endpoint: { host: "*.example.com", port: 443 } },
    {
      host: "api.example.com",
      endpoint: { host: "*.example.com", port: 443, allowed_ips: ["1.1.1.1"] },
    },
    { host: "api.example.com", endpoint: { host: "*.EXAMPLE.COM.", ports: [443] } },
    { host: "api-us.example.com", endpoint: { host: "api-*.example.com", port: 443 } },
    { host: "deep.api.example.com", endpoint: { host: "**.example.com", port: 443 } },
    { host: "api.example.com", endpoint: { host: "api.*.com", port: 443 } },
    { host: "api.example.com", endpoint: { host: "", port: 443, allowed_ips: ["1.1.1.1"] } },
    { host: "api.example.com", endpoint: { port: 443, allowed_ips: ["1.1.1.1"] } },
  ])("refuses overlapping $endpoint before changing providers", async ({ host, endpoint }) => {
    const test = fixture(host, endpoint);
    await expect(test.select()).rejects.toThrow(/existing_policy.*conflicting IP pins/);
    expect(test.createProvider).not.toHaveBeenCalled();
    expect(test.attachProvider).not.toHaveBeenCalled();
    expect(test.beforeAttach).not.toHaveBeenCalled();
    expect(test.writeAuthority).not.toHaveBeenCalled();
  });

  it.each([
    {
      host: "api.example.com",
      endpoint: { host: "*.example.com", port: 443, allowed_ips: ["8.8.8.8"] },
    },
    {
      host: "api.example.com",
      endpoint: { host: "*.example.com", port: 443, allowed_ips: ["8.8.8.8", "8.8.8.8"] },
    },
    { host: "deep.api.example.com", endpoint: { host: "*.example.com", port: 443 } },
    { host: "example.com", endpoint: { host: "*.example.com", port: 443 } },
    { host: "example.com", endpoint: { host: "**.example.com", port: 443 } },
    { host: "api.example.com", endpoint: { host: "*.other.com", port: 443 } },
    { host: "api.example.com", endpoint: { host: "api[ab].other.com", port: 443 } },
    { host: "api.example.com", endpoint: { host: "*.example.com", port: 8443 } },
    { host: "api.example.com", endpoint: { port: 443, allowed_ips: ["8.8.8.8"] } },
  ])("preserves selection with non-conflicting $endpoint", async ({ host, endpoint }) => {
    const test = fixture(host, endpoint);
    await expect(test.select()).resolves.toMatchObject({ attachmentChanged: true });
    expect(test.createProvider).toHaveBeenCalledOnce();
    expect(test.attachProvider).toHaveBeenCalledOnce();
    expect(test.beforeAttach).toHaveBeenCalledOnce();
    expect(test.writeAuthority).toHaveBeenCalled();
  });

  it.each([
    {
      label: "matching pins",
      endpoint: { host: "openrouter.ai", port: 443, allowed_ips: ["8.8.8.8"] },
    },
    { label: "another host", endpoint: { host: "example.com", port: 443 } },
    { label: "another port", endpoint: { host: "openrouter.ai", port: 8443 } },
    {
      label: "an IP-only rule on another port",
      endpoint: { host: "", ports: [8443], allowed_ips: ["8.8.8.8"] },
    },
    { label: "non-overlapping ports", endpoint: { host: "openrouter.ai", ports: [80, 8443] } },
    {
      label: "ports overriding an unused port",
      endpoint: { host: "openrouter.ai", port: 443, ports: [8443] },
    },
    { label: "no endpoint rules", endpoint: null },
  ])("preserves provider selection with $label", async ({ endpoint }) => {
    const test = fixture("openrouter.ai", endpoint);
    await expect(test.select()).resolves.toMatchObject({ attachmentChanged: true });
    expect(test.createProvider).toHaveBeenCalledOnce();
    expect(test.attachProvider).toHaveBeenCalledOnce();
    expect(test.beforeAttach).toHaveBeenCalledOnce();
  });

  it.each([
    {
      kind: "authentication",
      message: "OpenShell could not authenticate the sandbox policy read.",
    },
    { kind: "timeout", message: "The OpenShell sandbox policy read timed out." },
    { kind: "schema", message: "The OpenShell CLI and gateway policy schemas do not match." },
    { kind: "transport", reason: "unreachable", message: "OpenShell gateway is unreachable." },
  ] as const)("reports the $kind policy-read failure without changing providers", async (error) => {
    const test = fixture("openrouter.ai", null);
    test.readSandboxPolicy.mockResolvedValue({
      ok: false,
      error,
    });
    await expect(test.select()).rejects.toThrow(error.message);
    expect(test.createProvider).not.toHaveBeenCalled();
    expect(test.attachProvider).not.toHaveBeenCalled();
    expect(test.beforeAttach).not.toHaveBeenCalled();
    expect(test.writeAuthority).not.toHaveBeenCalled();
  });

  it("redacts credentials from policy-read diagnostics before reporting them", async () => {
    const test = fixture("openrouter.ai", null);
    test.readSandboxPolicy.mockResolvedValue({
      ok: false,
      error: {
        kind: "authentication",
        message: "Policy authentication failed with Bearer synthetic-policy-credential",
      },
    });
    await expect(test.select()).rejects.toThrow(
      "Policy authentication failed with Bearer <REDACTED>",
    );
    expect(test.createProvider).not.toHaveBeenCalled();
    expect(test.attachProvider).not.toHaveBeenCalled();
    expect(test.beforeAttach).not.toHaveBeenCalled();
    expect(test.writeAuthority).not.toHaveBeenCalled();
  });

  it.each([
    "version: 1\nnetwork_policies: []\n",
    "version: 1\nnetwork_policies:\n  broken:\n    endpoints: unexpected\n",
    "version: 1\nnetwork_policies:\n  broken:\n    endpoints: [null]\n",
  ])("refuses malformed policy input before provider mutation", async (document) => {
    const test = fixture("openrouter.ai", null);
    test.readSandboxPolicy.mockResolvedValue({
      ok: true,
      value: { document, appliedRevision: 1 },
    });
    await expect(test.select()).rejects.toThrow();
    expect(test.createProvider).not.toHaveBeenCalled();
    expect(test.beforeAttach).not.toHaveBeenCalled();
    expect(test.writeAuthority).not.toHaveBeenCalled();
  });
});
