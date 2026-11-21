// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { hermesManagedRouteReference, hermesRegisteredRoute } from "./hermes-archive-route";
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
