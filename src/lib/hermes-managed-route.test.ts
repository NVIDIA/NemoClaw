// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { applyHermesManagedRoute, HERMES_PROXY_REWRITE_SENTINEL } from "./hermes-managed-route";

const route = {
  upstreamProvider: "vllm-local",
  baseUrl: "http://host.openshell.internal:8000/v1",
  inferenceApi: "openai-completions",
  model: "selected-model",
};
const handle = "openshell:resolve:env:v7_NEMOCLAW_LOCAL_INFERENCE_TOKEN";

describe("Hermes native local credential projection", () => {
  it.each(["v7", "v8", `s${"a".repeat(64)}`])(
    "preserves issued %s identity in all managed slots without reading host credentials",
    (identity) => {
      const config: Record<string, unknown> = {};
      const issued = `openshell:resolve:env:${identity}_NEMOCLAW_LOCAL_INFERENCE_TOKEN`;
      applyHermesManagedRoute(config, { ...route, nativeCredentialHandle: issued });
      expect(config.model.api_key).toBe(issued);
      expect(config.providers[route.upstreamProvider].api_key).toBe(issued);
      expect(config.custom_providers[0].api_key).toBe(issued);
    },
  );

  it.each([
    {
      provider: "compatible-endpoint",
      baseUrl: "http://10.20.30.40:8080/v1",
      credential: "COMPATIBLE_API_KEY",
    },
    {
      provider: "compatible-endpoint",
      baseUrl: "https://hosted.example/v1",
      credential: "COMPATIBLE_API_KEY",
    },
    {
      provider: "compatible-endpoint",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      credential: "COMPATIBLE_API_KEY",
    },
    {
      provider: "compatible-endpoint",
      baseUrl: "http://host.openshell.internal:8000/v1",
      credential: "NEMOCLAW_LOCAL_INFERENCE_TOKEN",
    },
    {
      provider: "vllm-local",
      baseUrl: "http://10.20.30.40:8080/v1",
      credential: "NEMOCLAW_LOCAL_INFERENCE_TOKEN",
    },
  ])("writes all managed slots for $provider at $baseUrl", ({ provider, baseUrl, credential }) => {
    const config: Record<string, unknown> = {};
    applyHermesManagedRoute(config, { ...route, upstreamProvider: provider, baseUrl });
    const expected = `\${${credential}}`;
    expect(config.model.api_key).toBe(expected);
    expect(config.providers[provider].api_key).toBe(expected);
    expect(config.custom_providers[0].api_key).toBe(expected);
  });

  it.each(["http://10.20.30.40:8080/v1", "https://hosted.example/v1"])(
    "rejects a local handle on a custom-hosted route at %s without mutation",
    (baseUrl) => {
      const config = { keep: true };
      expect(() =>
        applyHermesManagedRoute(config, {
          ...route,
          upstreamProvider: "compatible-endpoint",
          baseUrl,
          nativeCredentialHandle: handle,
        }),
      ).toThrow();
      expect(config).toEqual({ keep: true });
    },
  );

  it("replaces every managed slot on a model switch and preserves unrelated providers and MCP state", () => {
    const unrelated = { name: "user-provider", api_key: "${USER_PROVIDER_KEY}" };
    const mcp = { example: { command: "example-mcp" } };
    const config: Record<string, unknown> = {
      providers: { user: unrelated },
      custom_providers: [unrelated],
      mcp_servers: mcp,
    };
    applyHermesManagedRoute(config, { ...route, nativeCredentialHandle: handle });
    const replacement = `openshell:resolve:env:s${"b".repeat(64)}_NEMOCLAW_LOCAL_INFERENCE_TOKEN`;
    applyHermesManagedRoute(config, {
      ...route,
      upstreamProvider: "ollama-local",
      model: "replacement-model",
      nativeCredentialHandle: replacement,
    });
    expect(config.model).toMatchObject({ default: "replacement-model", api_key: replacement });
    expect(config.providers).toEqual({
      user: unrelated,
      "ollama-local": expect.objectContaining({ api_key: replacement }),
    });
    expect(config.custom_providers).toEqual([
      unrelated,
      expect.objectContaining({ name: "ollama-local", api_key: replacement }),
    ]);
    expect(config.mcp_servers).toEqual(mcp);
    expect(JSON.stringify(config)).not.toContain(handle);
  });

  it.each([
    "",
    "synthetic-raw-secret",
    "openshell:resolve:env:NEMOCLAW_LOCAL_INFERENCE_TOKEN",
    "sk-OPENSHELL-RESOLVE-ENV-NEMOCLAW_LOCAL_INFERENCE_TOKEN",
    "openshell:resolve:env:v7_OPENAI_API_KEY",
    "openshell:resolve:env:v7_NVIDIA_INFERENCE_API_KEY",
    "openshell:resolve:env:sabc_NEMOCLAW_LOCAL_INFERENCE_TOKEN",
    `${handle}\n`,
    ` ${handle}`,
  ])(
    "rejects invalid reference case %# without changing the prior configuration or echoing input",
    (invalid) => {
      const config: Record<string, unknown> = {};
      applyHermesManagedRoute(config, { ...route, nativeCredentialHandle: handle });
      const before = structuredClone(config);
      expect(() =>
        applyHermesManagedRoute(config, { ...route, nativeCredentialHandle: invalid }),
      ).toThrow(
        new Error("Hermes native local route requires a provider-bound credential handle."),
      );
      expect(config).toEqual(before);
    },
  );

  it.each([
    "http://127.0.0.1:8000/v1",
    "http://public.example:8000/v1",
    "http://host.openshell.internal:80/v1",
    "http://host.openshell.internal:8000/v1?token=synthetic",
    "http://user:synthetic@host.openshell.internal:8000/v1",
    "http://host.openshell.internal:8000/v1\n",
    "https://inference.local/v1",
  ])("rejects a local handle at unqualified endpoint case %# before mutation", (baseUrl) => {
    const config = { keep: true };
    expect(() =>
      applyHermesManagedRoute(config, { ...route, baseUrl, nativeCredentialHandle: handle }),
    ).toThrow();
    expect(config).toEqual({ keep: true });
  });

  it("keeps the shared route when no native handle is requested", () => {
    const config: Record<string, unknown> = {};
    applyHermesManagedRoute(config, { ...route, baseUrl: "https://inference.local/v1" });
    expect(config.model.api_key).toBe(HERMES_PROXY_REWRITE_SENTINEL);
  });

  it("does not accept the local credential for a hosted provider", () => {
    expect(() =>
      applyHermesManagedRoute(
        {},
        {
          ...route,
          upstreamProvider: "nvidia-prod",
          baseUrl: "https://integrate.api.nvidia.com/v1",
          nativeCredentialHandle: handle,
        },
      ),
    ).toThrow("Hermes native NVIDIA route requires a provider-bound credential handle.");
  });
});
