// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { SandboxEntry } from "../state/registry";
import {
  checkGatewayRouteCompatibility,
  formatGatewayRouteConflict,
  type GatewayInferenceRoute,
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

describe("shared gateway inference route compatibility", () => {
  it("allows identical routes and ignores the target sandbox itself (#6315)", () => {
    expect(
      check(route("nvidia-prod", "nvidia/model-a"), [
        sandbox("target", { provider: "anthropic-prod", model: "claude-old" }),
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
      conflicts: [{ sandboxName: "legacy-custom", reason: "incomplete-custom-route" }],
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

  it("skips registry rows without a complete provider and model (#6315)", () => {
    expect(
      check(route("anthropic-prod", "claude-new"), [
        sandbox("empty", { provider: null, model: null }),
        sandbox("provider-only", { provider: "nvidia-prod", model: null }),
      ]),
    ).toEqual({ ok: true });
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
