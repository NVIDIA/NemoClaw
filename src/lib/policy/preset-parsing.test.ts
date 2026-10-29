// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import YAML from "yaml";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSandbox: vi.fn(),
  listExtraProviders: vi.fn(),
  readSandboxProviderAttachments: vi.fn(),
  readSandboxProviderProfileType: vi.fn(),
}));

vi.mock("../state/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/registry")>()),
  getSandbox: mocks.getSandbox,
  listExtraProviders: mocks.listExtraProviders,
}));
vi.mock("../onboard/gateway-binding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../onboard/gateway-binding")>()),
  readSandboxProviderAttachments: mocks.readSandboxProviderAttachments,
  readSandboxProviderProfileType: mocks.readSandboxProviderProfileType,
}));

import { loadPresetForSandbox } from "./index";
import {
  applyWebSearchCredentialBinding,
  bindWebSearchPresetProviders,
  isWebSearchPolicyPreset,
  parseWebSearchEndpointContract,
  resolveWebSearchCredentialProvider,
  webSearchCredentialProviderCandidates,
} from "./preset-parsing";

const sandboxName = "alpha";
const tavilyPreset = `preset:\n  name: tavily\n  description: Tavily Search API access\nnetwork_policies:\n  tavily:\n    name: tavily\n    endpoints:\n      - host: api.tavily.com\n        port: 443\n        protocol: rest\n        enforcement: enforce\n        request_body_credential_rewrite: true\n        rules:\n          - allow: { method: POST, path: "/search" }\n`;

function tavilyEndpoints(content: string): Array<Record<string, unknown>> {
  return YAML.parse(content).network_policies.tavily.endpoints;
}

const tavilyContract = parseWebSearchEndpointContract(tavilyPreset, "tavily");

describe("web-search credential provider resolution", () => {
  it("classifies brave and tavily as web-search presets and rejects other presets", () => {
    expect(isWebSearchPolicyPreset("tavily")).toBe(true);
    expect(isWebSearchPolicyPreset("brave")).toBe(true);
    expect(isWebSearchPolicyPreset("weather")).toBe(false);
  });

  it("prefers the gateway-wide provider for Deep Agents", () => {
    expect(
      webSearchCredentialProviderCandidates("tavily", sandboxName, "langchain-deepagents-code"),
    ).toEqual(["tavily-search", `${sandboxName}-tavily-search`]);
  });

  it("prefers the sandbox-scoped provider for OpenClaw and Hermes", () => {
    expect(webSearchCredentialProviderCandidates("tavily", sandboxName, "openclaw")).toEqual([
      `${sandboxName}-tavily-search`,
      "tavily-search",
    ]);
    expect(webSearchCredentialProviderCandidates("brave", sandboxName, "hermes")).toEqual([
      `${sandboxName}-brave-search`,
      "brave-search",
    ]);
  });

  it("resolves only a provider that is recorded", () => {
    expect(
      resolveWebSearchCredentialProvider({
        presetName: "tavily",
        sandboxName,
        agentName: "langchain-deepagents-code",
        availableProviders: new Set(["tavily-search"]),
      }),
    ).toBe("tavily-search");
    expect(
      resolveWebSearchCredentialProvider({
        presetName: "tavily",
        sandboxName,
        agentName: "openclaw",
        availableProviders: new Set(["tavily-search"]),
      }),
    ).toBe("tavily-search");
    expect(
      resolveWebSearchCredentialProvider({
        presetName: "tavily",
        sandboxName,
        agentName: "openclaw",
        availableProviders: new Set(),
      }),
    ).toBeNull();
  });
});

describe("web-search credential binding", () => {
  it("does not bind an endpoint that differs from the preset contract", () => {
    const substituted = tavilyPreset.replace("host: api.tavily.com", "host: operator.example");
    const bound = applyWebSearchCredentialBinding(
      substituted,
      "tavily",
      "tavily-search",
      tavilyContract,
    );
    expect(
      YAML.parse(bound).network_policies.tavily.endpoints[0].credential_binding,
    ).toBeUndefined();
    const withAddedField = tavilyPreset.replace(
      "        request_body_credential_rewrite: true\n",
      "        request_body_credential_rewrite: true\n        path: /custom\n",
    );
    expect(
      YAML.parse(
        applyWebSearchCredentialBinding(withAddedField, "tavily", "tavily-search", tavilyContract),
      ).network_policies.tavily.endpoints[0].credential_binding,
    ).toBeUndefined();
    expect(applyWebSearchCredentialBinding(tavilyPreset, "tavily", "tavily-search", null)).toBe(
      tavilyPreset,
    );
  });

  it("binds every unbound contract endpoint of the preset policy", () => {
    const bound = applyWebSearchCredentialBinding(
      tavilyPreset,
      "tavily",
      "tavily-search",
      tavilyContract,
    );
    expect(tavilyEndpoints(bound)).toEqual([
      expect.objectContaining({ credential_binding: { provider: "tavily-search" } }),
    ]);
  });

  it("leaves the preset unchanged when no provider is resolved", () => {
    expect(applyWebSearchCredentialBinding(tavilyPreset, "tavily", null, tavilyContract)).toBe(
      tavilyPreset,
    );
  });

  it("preserves an existing credential binding", () => {
    const existing = tavilyPreset.replace(
      "        request_body_credential_rewrite: true\n",
      "        request_body_credential_rewrite: true\n        credential_binding:\n          provider: operator-provider\n",
    );
    expect(
      applyWebSearchCredentialBinding(existing, "tavily", "tavily-search", tavilyContract),
    ).toBe(existing);
  });

  it("binds each web-search policy present in a sandbox policy document", () => {
    const document = `version: 1\nnetwork_policies:\n  tavily:\n    endpoints:\n      - host: api.tavily.com\n        port: 443\n        protocol: rest\n        enforcement: enforce\n        request_body_credential_rewrite: true\n        rules:\n          - allow: { method: POST, path: "/search" }\n  brave:\n    endpoints:\n      - host: api.search.brave.com\n        port: 443\n  weather:\n    endpoints:\n      - host: wttr.in\n        port: 443\n`;
    const bound = bindWebSearchPresetProviders({
      content: document,
      sandboxName,
      agentName: "langchain-deepagents-code",
      availableProviders: new Set(["tavily-search"]),
      contracts: { tavily: tavilyContract },
    });
    const parsed = YAML.parse(bound).network_policies;
    expect(parsed.tavily.endpoints[0].credential_binding).toEqual({ provider: "tavily-search" });
    expect(parsed.brave.endpoints[0].credential_binding).toBeUndefined();
    expect(parsed.weather.endpoints[0].credential_binding).toBeUndefined();

    const unattached = bindWebSearchPresetProviders({
      content: document,
      sandboxName,
      agentName: "langchain-deepagents-code",
      availableProviders: new Set(["tavily-search"]),
      attachedProviders: new Set(),
      contracts: { tavily: tavilyContract },
    });
    expect(
      YAML.parse(unattached).network_policies.tavily.endpoints[0].credential_binding,
    ).toBeUndefined();
    expect(
      bindWebSearchPresetProviders({
        content: document,
        sandboxName,
        agentName: "langchain-deepagents-code",
        availableProviders: new Set(["tavily-search"]),
        attachedProviders: null,
        contracts: { tavily: tavilyContract },
      }),
    ).toBe(document);
  });
});

describe("loadPresetForSandbox web-search binding", () => {
  beforeEach(() => {
    mocks.getSandbox.mockReset();
    mocks.listExtraProviders.mockReset();
    mocks.readSandboxProviderAttachments.mockReset();
    mocks.readSandboxProviderProfileType.mockReset();
  });

  it("binds the gateway-wide provider for a Deep Agents sandbox", async () => {
    mocks.getSandbox.mockReturnValue({
      name: sandboxName,
      agent: "langchain-deepagents-code",
      gatewayName: "nemoclaw",
    });
    mocks.listExtraProviders.mockReturnValue(["tavily-search"]);

    const content = await loadPresetForSandbox(sandboxName, "tavily", {
      attachedProviders: ["tavily-search"],
    });

    expect(content).not.toBeNull();
    expect(tavilyEndpoints(content!)).toEqual([
      expect.objectContaining({ credential_binding: { provider: "tavily-search" } }),
    ]);
  });

  it("binds the sandbox-scoped provider for an OpenClaw sandbox", async () => {
    mocks.getSandbox.mockReturnValue({
      name: sandboxName,
      agent: "openclaw",
      gatewayName: "nemoclaw",
    });
    mocks.listExtraProviders.mockReturnValue([`${sandboxName}-tavily-search`]);

    const content = await loadPresetForSandbox(sandboxName, "tavily", {
      attachedProviders: [`${sandboxName}-tavily-search`],
    });

    expect(tavilyEndpoints(content!)).toEqual([
      expect.objectContaining({ credential_binding: { provider: `${sandboxName}-tavily-search` } }),
    ]);
  });

  it("omits the binding when the recorded provider is not attached", async () => {
    mocks.getSandbox.mockReturnValue({
      name: sandboxName,
      agent: "langchain-deepagents-code",
      gatewayName: "nemoclaw",
    });
    mocks.listExtraProviders.mockReturnValue(["tavily-search"]);

    const content = await loadPresetForSandbox(sandboxName, "tavily", { attachedProviders: [] });

    expect(tavilyEndpoints(content!)).toEqual([
      expect.not.objectContaining({ credential_binding: expect.anything() }),
    ]);
  });

  it("omits the binding when the attached provider uses an endpoint-bearing profile", async () => {
    mocks.getSandbox.mockReturnValue({
      name: sandboxName,
      agent: "langchain-deepagents-code",
      gatewayName: "nemoclaw",
    });
    mocks.listExtraProviders.mockReturnValue(["tavily-search"]);

    const content = await loadPresetForSandbox(sandboxName, "tavily", {
      attachedProviders: ["tavily-search"],
      attachedProviderProfiles: { "tavily-search": "tavily" },
    });

    expect(tavilyEndpoints(content!)).toEqual([
      expect.not.objectContaining({ credential_binding: expect.anything() }),
    ]);
  });

  it("inspects both Tavily candidates and selects the compatible fallback when the preferred candidate is legacy", async () => {
    mocks.getSandbox.mockReturnValue({
      name: sandboxName,
      agent: "langchain-deepagents-code",
      gatewayName: "nemoclaw",
    });
    mocks.listExtraProviders.mockReturnValue(["tavily-search"]);
    mocks.readSandboxProviderAttachments.mockResolvedValue([
      "tavily-search",
      `${sandboxName}-tavily-search`,
    ]);
    mocks.readSandboxProviderProfileType.mockImplementation(async (provider: string) =>
      provider === "tavily-search" ? "tavily" : "tavily-policy-binding-v1",
    );

    const content = await loadPresetForSandbox(sandboxName, "tavily");

    expect(mocks.readSandboxProviderProfileType.mock.calls.map(([provider]) => provider)).toEqual([
      "tavily-search",
      `${sandboxName}-tavily-search`,
    ]);
    expect(tavilyEndpoints(content!)).toEqual([
      expect.objectContaining({ credential_binding: { provider: `${sandboxName}-tavily-search` } }),
    ]);
  });

  it("omits the binding when no web-search provider is recorded", async () => {
    mocks.getSandbox.mockReturnValue({
      name: sandboxName,
      agent: "langchain-deepagents-code",
      gatewayName: "nemoclaw",
    });
    mocks.listExtraProviders.mockReturnValue([]);

    const content = await loadPresetForSandbox(sandboxName, "tavily", {
      attachedProviders: ["tavily-search"],
    });

    expect(tavilyEndpoints(content!)).toEqual([
      expect.not.objectContaining({ credential_binding: expect.anything() }),
    ]);
  });

  it("leaves a non-web-search preset unbound", async () => {
    mocks.getSandbox.mockReturnValue({ name: sandboxName, agent: "openclaw" });
    mocks.listExtraProviders.mockReturnValue(["tavily-search"]);

    const content = await loadPresetForSandbox(sandboxName, "weather", {
      attachedProviders: ["tavily-search"],
    });

    expect(content).not.toBeNull();
    const endpoints = YAML.parse(content!).network_policies.weather.endpoints;
    expect(endpoints.length).toBeGreaterThan(0);
    expect(endpoints.some((endpoint: object) => "credential_binding" in endpoint)).toBe(false);
  });
});
