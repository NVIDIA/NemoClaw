// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { SandboxEntry } from "../state/registry";
import {
  checkGatewayRouteCompatibility,
  formatGatewayRouteConflict,
  type GatewayInferenceRoute,
  preflightGatewayRouteDiscovery,
} from "./gateway-route-compatibility";

const route = (
  provider: string,
  model: string,
  overrides: Partial<GatewayInferenceRoute> = {},
): GatewayInferenceRoute => ({
  provider,
  model,
  endpointUrl: null,
  preferredInferenceApi: null,
  credentialEnv: null,
  ...overrides,
});

const discoveryRoute = (
  provider: string,
  overrides: Partial<GatewayInferenceRoute> = {},
): Omit<GatewayInferenceRoute, "model"> & { model: string | null } => ({
  ...route(provider, "discovery-pending", overrides),
  model: null,
});

const sandbox = (name: string, overrides: Partial<SandboxEntry> = {}): SandboxEntry => ({
  name,
  gatewayName: "nemoclaw",
  gatewayPort: 8080,
  provider: "nvidia-prod",
  model: "nvidia/model-a",
  ...overrides,
});

function check(requested: GatewayInferenceRoute, sandboxes: SandboxEntry[]) {
  return checkGatewayRouteCompatibility({
    gatewayName: "nemoclaw",
    sandboxName: "target",
    route: requested,
    sandboxes,
  });
}

function discover(
  requested: Omit<GatewayInferenceRoute, "model"> & { model: string | null },
  sandboxes: SandboxEntry[],
) {
  return preflightGatewayRouteDiscovery({
    gatewayName: "nemoclaw",
    sandboxName: "target",
    route: requested,
    sandboxes,
  });
}

describe("shared gateway inference route compatibility", () => {
  it("allows unconstrained discovery when no configured same-gateway peer exists (#6315)", () => {
    expect(
      discover(discoveryRoute("nvidia-prod"), [
        sandbox("other", { gatewayName: "nemoclaw-9090", gatewayPort: 9090 }),
      ]),
    ).toEqual({
      ok: true,
      requiredModel: null,
      requiredEndpointUrl: null,
      requiredInferenceApi: null,
    });
  });

  it("constrains discovery to the durable same-gateway model (#6315)", () => {
    expect(discover(discoveryRoute("nvidia-prod"), [sandbox("stopped-peer")])).toEqual({
      ok: true,
      requiredModel: "nvidia/model-a",
      requiredEndpointUrl: null,
      requiredInferenceApi: null,
    });
  });

  it("constrains custom discovery to the durable endpoint and API family (#6315)", () => {
    expect(
      discover(discoveryRoute("compatible-endpoint"), [
        sandbox("custom-peer", {
          provider: "compatible-endpoint",
          model: "custom/model",
          endpointUrl: "https://example.test/v1",
          preferredInferenceApi: "openai-completions",
        }),
      ]),
    ).toEqual({
      ok: true,
      requiredModel: "custom/model",
      requiredEndpointUrl: "https://example.test/v1",
      requiredInferenceApi: "openai-completions",
    });
  });

  it("blocks conflicting or unprovable discovery before a provider probe (#6315)", () => {
    expect(discover(discoveryRoute("anthropic-prod"), [sandbox("stopped-peer")])).toMatchObject({
      ok: false,
      result: { conflicts: [{ sandboxName: "stopped-peer", reason: "provider-model" }] },
    });
    expect(
      discover(discoveryRoute("nvidia-prod"), [
        sandbox("unknown-gateway", { gatewayName: "not-a-nemoclaw-gateway", gatewayPort: null }),
      ]),
    ).toMatchObject({
      ok: false,
      result: {
        conflicts: [{ sandboxName: "unknown-gateway", reason: "invalid-gateway-binding" }],
      },
    });
    expect(
      discover(discoveryRoute("nvidia-prod"), [
        sandbox("recovered-live", { provider: null, model: null }),
      ]),
    ).toMatchObject({
      ok: false,
      result: {
        conflicts: [{ sandboxName: "recovered-live", reason: "incomplete-route" }],
      },
    });
  });

  it("allows identical routes and ignores the target sandbox itself (#6315)", () => {
    expect(
      check(route("nvidia-prod", "nvidia/model-a"), [
        sandbox("target", { provider: null, model: null }),
        sandbox("stopped-peer"),
      ]),
    ).toEqual({ ok: true });
  });

  it("blocks provider or model conflicts from every same-gateway registry row (#6315)", () => {
    const result = check(route("anthropic-prod", "claude-new"), [sandbox("stopped-peer")]);

    expect(result).toMatchObject({
      ok: false,
      conflicts: [{ sandboxName: "stopped-peer", reason: "provider-model" }],
    });
    expect(formatGatewayRouteConflict(result as Exclude<typeof result, { ok: true }>)).toContain(
      "Stopped sandboxes are included",
    );
  });

  it("allows different routes on different gateways (#6315)", () => {
    expect(
      check(route("anthropic-prod", "claude-new"), [
        sandbox("other-gateway", {
          gatewayName: "nemoclaw-9090",
          gatewayPort: 9090,
          provider: null,
          model: null,
        }),
      ]),
    ).toEqual({ ok: true });
  });

  it("normalizes equivalent custom endpoint URLs before comparison (#6315)", () => {
    expect(
      check(
        route("compatible-endpoint", "custom/model", {
          endpointUrl: "https://EXAMPLE.test/v1/?token=ignored",
          preferredInferenceApi: "openai-completions",
        }),
        [
          sandbox("custom-peer", {
            provider: "compatible-endpoint",
            model: "custom/model",
            endpointUrl: "https://example.test/v1",
            preferredInferenceApi: "openai-completions",
          }),
        ],
      ),
    ).toEqual({ ok: true });
  });

  it("normalizes Anthropic endpoint suffixes for custom route identity (#6315)", () => {
    expect(
      check(
        route("compatible-anthropic-endpoint", "anthropic/model", {
          endpointUrl: "https://example.test/v1/messages",
          preferredInferenceApi: "anthropic-messages",
        }),
        [
          sandbox("anthropic-peer", {
            provider: "compatible-anthropic-endpoint",
            model: "anthropic/model",
            endpointUrl: "https://example.test",
            preferredInferenceApi: "anthropic-messages",
          }),
        ],
      ),
    ).toEqual({ ok: true });
  });

  it("blocks Hermes OpenAI frontend against a recorded native Anthropic route", () => {
    const result = check(
      route("compatible-anthropic-endpoint", "anthropic/model", {
        endpointUrl: "https://example.test/v1",
        preferredInferenceApi: "openai-completions",
      }),
      [
        sandbox("legacy-anthropic-peer", {
          provider: "compatible-anthropic-endpoint",
          model: "anthropic/model",
          endpointUrl: "https://example.test",
          preferredInferenceApi: "anthropic-messages",
        }),
      ],
    );

    expect(result).toMatchObject({
      ok: false,
      conflicts: [{ sandboxName: "legacy-anthropic-peer", reason: "custom-api" }],
    });
  });

  it("ignores credential environment differences in route identity (#6315)", () => {
    expect(
      check(
        route("compatible-endpoint", "custom/model", {
          endpointUrl: "https://example.test/v1",
          preferredInferenceApi: "openai-completions",
          credentialEnv: "REQUESTED_KEY",
        }),
        [
          sandbox("custom-peer", {
            provider: "compatible-endpoint",
            model: "custom/model",
            endpointUrl: "https://example.test/v1",
            preferredInferenceApi: "openai-completions",
            credentialEnv: "RECORDED_KEY",
          }),
        ],
      ),
    ).toEqual({ ok: true });
  });

  it.each([
    [
      "endpoint",
      { endpointUrl: "https://other.test/v1", preferredInferenceApi: "openai-completions" },
      "custom-endpoint",
    ],
    [
      "API family",
      { endpointUrl: "https://example.test/v1", preferredInferenceApi: "openai-responses" },
      "custom-api",
    ],
  ] as const)("blocks custom %s conflicts (#6315)", (_label, recordedMetadata, reason) => {
    const result = check(
      route("compatible-endpoint", "custom/model", {
        endpointUrl: "https://example.test/v1",
        preferredInferenceApi: "openai-completions",
      }),
      [
        sandbox("custom-peer", {
          provider: "compatible-endpoint",
          model: "custom/model",
          ...recordedMetadata,
        }),
      ],
    );

    expect(result).toMatchObject({ ok: false, conflicts: [{ reason }] });
  });

  it.each([
    ["endpoint", null, "openai-completions"],
    ["API family", "https://example.test/v1", null],
  ] as const)("fails closed when legacy custom route %s metadata is missing (#6315)", (_label, endpointUrl, preferredInferenceApi) => {
    const result = check(
      route("compatible-endpoint", "custom/model", {
        endpointUrl: "https://example.test/v1",
        preferredInferenceApi: "openai-completions",
      }),
      [
        sandbox("legacy-custom", {
          provider: "compatible-endpoint",
          model: "custom/model",
          endpointUrl,
          preferredInferenceApi,
        }),
      ],
    );

    expect(result).toMatchObject({
      ok: false,
      conflicts: [
        {
          sandboxName: "legacy-custom",
          reason: "incomplete-custom-route",
          scope: "registered",
        },
      ],
    });
    expect(formatGatewayRouteConflict(result as Exclude<typeof result, { ok: true }>)).toContain(
      "remove and re-onboard that sandbox with complete custom-route metadata",
    );
  });

  it("fails closed when a requested custom route has no API metadata or peers (#6315)", () => {
    const result = check(
      route("compatible-endpoint", "custom/model", {
        endpointUrl: "https://example.test/v1",
        preferredInferenceApi: null,
      }),
      [],
    );

    expect(result).toMatchObject({
      ok: false,
      conflicts: [
        {
          sandboxName: "target",
          reason: "incomplete-custom-route",
          scope: "requested",
        },
      ],
    });
    expect(formatGatewayRouteConflict(result as Exclude<typeof result, { ok: true }>)).toContain(
      "requested custom route lacks durable endpoint or API-family metadata",
    );
  });

  it.each([
    ["provider and model", null, null],
    ["model", "nvidia-prod", null],
    ["provider", null, "nvidia/model-a"],
  ] as const)("fails closed when a same-gateway registry row lacks %s metadata (#6315)", (_missing, provider, model) => {
    const result = check(route("nvidia-prod", "nvidia/model-a"), [
      sandbox("recovered-live", { provider, model }),
    ]);

    expect(result).toMatchObject({
      ok: false,
      conflicts: [
        {
          sandboxName: "recovered-live",
          reason: "incomplete-route",
          scope: "registered",
        },
      ],
    });
    expect(formatGatewayRouteConflict(result as Exclude<typeof result, { ok: true }>)).toContain(
      "lacks durable provider or model metadata",
    );
  });

  it("fails closed when a registry row has an invalid gateway binding (#6315)", () => {
    const result = check(route("nvidia-prod", "nvidia/model-a"), [
      sandbox("unknown-gateway", { gatewayName: "not-a-nemoclaw-gateway", gatewayPort: null }),
    ]);

    expect(result).toMatchObject({
      ok: false,
      conflicts: [{ sandboxName: "unknown-gateway", reason: "invalid-gateway-binding" }],
    });
    expect(formatGatewayRouteConflict(result as Exclude<typeof result, { ok: true }>)).toContain(
      "restore its known-good gateway binding or remove and re-onboard that sandbox",
    );
  });
});
