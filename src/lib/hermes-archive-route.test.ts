// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { hermesManagedRouteReference, hermesRegisteredRoute } from "./hermes-archive-route";
import { applyHermesManagedRoute } from "./hermes-managed-route";
import { BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL } from "./inference/bedrock-runtime";
import { resolveManagedStartupInferenceRoute } from "./inference/gateway/route-contract";
import { hostedNativeProvider } from "./inference/native-provider/hosted";
import {
  customNativeProvider,
  customNativeProviderForSelection,
} from "./inference/native-provider/custom";

const routes = [
  ["compatible-endpoint", "openai-completions", "/team/v1", "/team/v1"],
  ["compatible-endpoint", "openai-responses", "/team/v1", "/team/v1"],
  ["compatible-anthropic-endpoint", "anthropic-messages", "/team", "/team"],
  ["compatible-anthropic-endpoint", "openai-completions", "/team", "/team/v1"],
  ["compatible-anthropic-endpoint", "openai-responses", "/team", "/team/v1"],
] as const;

function selectionFor(provider: string, api: string, logicalPath: string) {
  const endpointUrl = `https://host.example.test${logicalPath}`;
  const definition = customNativeProvider({
    provider,
    api,
    endpointUrl,
    credentialEnv: "TEAM_KEY",
    allowedIps: ["8.8.8.8"],
  });
  return {
    provider,
    endpointUrl,
    preferredInferenceApi: api,
    credentialEnv: "TEAM_KEY",
    nativeHostedProviderAttachment: {
      schemaVersion: 1 as const,
      profileId: definition.profileId,
      providerName: definition.providerName,
      providerId: "provider-id",
      endpointUrl: definition.endpointUrl,
      allowedIps: definition.allowedIps,
      custom: definition.custom,
    },
  };
}

describe("Hermes archive route authority", () => {
  it.each([
    "https://approved.invalid\\@other.invalid/../v1",
    "https://approved.invalid/ignored/../v1",
    "https://approved.invalid/v1?",
    "https://approved.invalid/v1#",
  ])("rejects ambiguous archive URL %s before normalization", (baseUrl) => {
    const provider = "compatible-endpoint";
    const registered = hermesRegisteredRoute({
      provider,
      endpointUrl: "https://approved.invalid/v1",
    });
    expect(hermesManagedRouteReference(provider, baseUrl, registered)).toBeNull();
    expect(hermesManagedRouteReference(provider, baseUrl)).toBeNull();
    expect(hermesRegisteredRoute({ provider, endpointUrl: baseUrl }).endpointUrl).toBeNull();
  });

  it("uses the fixed Hermes endpoint when its attachment omits the endpoint", () => {
    const provider = "hermes-provider";
    const fixed = hostedNativeProvider(provider)!;
    const attachment = {
      schemaVersion: 1 as const,
      profileId: fixed.profileId,
      providerName: fixed.providerName,
      providerId: "provider-id",
    };
    const registered = hermesRegisteredRoute({
      provider,
      nativeHostedProviderAttachment: attachment,
    });
    expect(hermesManagedRouteReference(provider, fixed.endpoint, registered)?.template).toBe(
      "${OPENAI_API_KEY}",
    );
    const conflict = hermesRegisteredRoute({
      provider,
      endpointUrl: "https://other.invalid/v1",
      nativeHostedProviderAttachment: attachment,
    });
    expect(hermesManagedRouteReference(provider, "https://other.invalid/v1", conflict)).toBeNull();
    expect(hermesManagedRouteReference(provider, fixed.endpoint, conflict)).toBeNull();
  });

  it("does not grant a hosted reference to a route written with a local credential", () => {
    const provider = "compatible-endpoint";
    const baseUrl = "http://host.openshell.internal:11434/v1";
    const config: Record<string, unknown> = {};
    applyHermesManagedRoute(config, {
      upstreamProvider: provider,
      baseUrl,
      model: "m",
      inferenceApi: "openai-completions",
    });
    expect(config.model.api_key).toBe("${NEMOCLAW_LOCAL_INFERENCE_TOKEN}");
    expect(
      hermesManagedRouteReference(
        provider,
        baseUrl,
        hermesRegisteredRoute({ provider, endpointUrl: baseUrl }),
      ),
    ).toBeNull();
  });

  it.each([
    ["https://host.example.test/team", "https://host.example.test/team/v1"],
    ["https://bedrock-runtime.us-east-1.amazonaws.com", BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL],
  ] as const)(
    "accepts only the Hermes writer endpoint for legacy Anthropic %s",
    (logicalEndpoint, agentEndpoint) => {
      const provider = "compatible-anthropic-endpoint";
      const preferredInferenceApi = "anthropic-messages";
      const route = resolveManagedStartupInferenceRoute(
        "hermes",
        provider,
        "m",
        preferredInferenceApi,
        true,
        logicalEndpoint,
      );
      expect(route.inferenceBaseUrl).toBe(agentEndpoint);
      const registered = hermesRegisteredRoute({
        provider,
        endpointUrl: logicalEndpoint,
        preferredInferenceApi,
      });
      expect(hermesManagedRouteReference(provider, route.inferenceBaseUrl, registered)).toEqual({
        endpoint: agentEndpoint,
        template: "${COMPATIBLE_ANTHROPIC_API_KEY}",
      });
      expect(hermesManagedRouteReference(provider, logicalEndpoint, registered)).toBeNull();
    },
  );

  it.each(routes)(
    "validates %s %s archives against the agent endpoint (#14300)",
    (provider, api, logicalPath, agentPath) => {
      const selection = selectionFor(provider, api, logicalPath);
      const definition = customNativeProviderForSelection(selection)!;
      const agentEndpointUrl = `https://host.example.test${agentPath}`;
      expect(definition.custom.endpointUrl).toBe(selection.endpointUrl);
      expect(definition.endpointUrl).toBe(agentEndpointUrl);
      const registered = hermesRegisteredRoute(selection);
      expect(registered).toEqual({ provider, endpointUrl: agentEndpointUrl });
      expect(hermesManagedRouteReference(provider, agentEndpointUrl, registered)).toEqual({
        endpoint: agentEndpointUrl,
        template: `\${${definition.credentialEnv}}`,
      });
    },
  );

  it.each(routes)(
    "rejects a conflicting logical endpoint for %s %s archives (#14300)",
    (provider, api, logicalPath, agentPath) => {
      const selection = selectionFor(provider, api, logicalPath);
      selection.endpointUrl = "https://other.example.test/team";
      const registered = hermesRegisteredRoute(selection);
      expect(registered).toEqual({ provider, endpointUrl: null });
      expect(
        hermesManagedRouteReference(provider, `https://host.example.test${agentPath}`, registered),
      ).toBeNull();
    },
  );

  it.each(["openai-completions", "openai-responses"])(
    "rejects the logical Anthropic endpoint in an archive using %s (#14300)",
    (api) => {
      const selection = selectionFor("compatible-anthropic-endpoint", api, "/team");
      const registered = hermesRegisteredRoute(selection);
      expect(
        hermesManagedRouteReference(selection.provider, selection.endpointUrl, registered),
      ).toBeNull();
    },
  );
});
