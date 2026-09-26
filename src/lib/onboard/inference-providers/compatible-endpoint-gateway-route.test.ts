// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AUTOMATIC_GATEWAY_PORT_RANGE_END,
  AUTOMATIC_GATEWAY_PORT_RANGE_START,
  BEDROCK_RUNTIME_ADAPTER_PORT,
  DASHBOARD_PORT,
  DASHBOARD_PORT_RANGE_END,
  DASHBOARD_PORT_RANGE_START,
  DEFAULT_BEDROCK_RUNTIME_ADAPTER_PORT,
  DEFAULT_GATEWAY_PORT,
  DEFAULT_HTTPS_PIN_RUNTIME_ADAPTER_PORT,
  DEFAULT_MODEL_ROUTER_PORT,
  DEFAULT_OLLAMA_PROXY_PORT,
  DEFAULT_OPENROUTER_RUNTIME_ADAPTER_PORT,
  GATEWAY_PORT,
  HERMES_API_PORT_RANGE_END,
  HERMES_API_PORT_RANGE_START,
  HTTPS_PIN_RUNTIME_ADAPTER_PORT,
  OLLAMA_PROXY_PORT,
  OPENROUTER_RUNTIME_ADAPTER_PORT,
} from "../../core/ports";

import {
  assertLoopbackNoAuthCompatibleEndpointUrl,
  COMPATIBLE_ENDPOINT_GATEWAY_PORTS,
  gatewayReachableCompatibleEndpointUrl,
  isLoopbackNoAuthCompatibleEndpointUrl,
  reuseRegisteredProviderWithGatewayEndpoint,
} from "./compatible-endpoint-gateway-route";

const tempHomes: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const home of tempHomes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe("compatible endpoint gateway routing", () => {
  it("recognizes protected no-auth proxy sources on unprivileged loopback ports", () => {
    expect(
      isLoopbackNoAuthCompatibleEndpointUrl("compatible-endpoint", "http://localhost:12500/v1"),
    ).toBe(true);
    expect(
      isLoopbackNoAuthCompatibleEndpointUrl("compatible-endpoint", "http://127.0.0.1:19999/v1"),
    ).toBe(true);
    expect(
      isLoopbackNoAuthCompatibleEndpointUrl("compatible-endpoint", "http://[::1]:12500/v1"),
    ).toBe(true);
    expect(
      isLoopbackNoAuthCompatibleEndpointUrl("compatible-endpoint", "http://localhost:1024/v1"),
    ).toBe(true);
    expect(
      isLoopbackNoAuthCompatibleEndpointUrl("compatible-endpoint", "http://localhost:65535/v1"),
    ).toBe(true);
  });

  it.each([
    ["default gateway", DEFAULT_GATEWAY_PORT],
    ["gateway", GATEWAY_PORT],
    ["automatic gateway range start", AUTOMATIC_GATEWAY_PORT_RANGE_START],
    ["automatic gateway range interior", AUTOMATIC_GATEWAY_PORT_RANGE_START + 1],
    ["automatic gateway range end", AUTOMATIC_GATEWAY_PORT_RANGE_END],
    ["dashboard", DASHBOARD_PORT],
    ["dashboard range start", DASHBOARD_PORT_RANGE_START],
    ["dashboard range end", DASHBOARD_PORT_RANGE_END],
    ["Hermes API range start", HERMES_API_PORT_RANGE_START],
    ["Hermes API range interior", HERMES_API_PORT_RANGE_START + 1],
    ["Hermes API range end", HERMES_API_PORT_RANGE_END],
    ["Model Router", DEFAULT_MODEL_ROUTER_PORT],
    ["configured proxy", OLLAMA_PROXY_PORT],
    ["default proxy", DEFAULT_OLLAMA_PROXY_PORT],
    ["configured Bedrock adapter", BEDROCK_RUNTIME_ADAPTER_PORT],
    ["default Bedrock adapter", DEFAULT_BEDROCK_RUNTIME_ADAPTER_PORT],
    ["configured OpenRouter adapter", OPENROUTER_RUNTIME_ADAPTER_PORT],
    ["default OpenRouter adapter", DEFAULT_OPENROUTER_RUNTIME_ADAPTER_PORT],
    ["configured HTTPS-pin adapter", HTTPS_PIN_RUNTIME_ADAPTER_PORT],
    ["default HTTPS-pin adapter", DEFAULT_HTTPS_PIN_RUNTIME_ADAPTER_PORT],
  ])("rejects the protected NemoClaw %s port", (_label, port) => {
    expect(
      isLoopbackNoAuthCompatibleEndpointUrl("compatible-endpoint", `http://localhost:${port}/v1`),
    ).toBe(false);
  });

  it("permits only an authorized recorded route on the moved proxy's old default port", async () => {
    vi.stubEnv("NEMOCLAW_OLLAMA_PROXY_PORT", "12435");
    vi.resetModules();
    const { assertLoopbackNoAuthCompatibleEndpointUrl } =
      await import("./compatible-endpoint-gateway-route");

    expect(() => assertLoopbackNoAuthCompatibleEndpointUrl("http://localhost:11435/v1")).toThrow(
      /no longer eligible/,
    );
    expect(() =>
      assertLoopbackNoAuthCompatibleEndpointUrl("http://localhost:11435/v1", {
        allowLegacyRecordedEndpoint: true,
      }),
    ).not.toThrow();
    expect(() =>
      assertLoopbackNoAuthCompatibleEndpointUrl("http://localhost:12435/v1", {
        allowLegacyRecordedEndpoint: true,
      }),
    ).toThrow(/no longer eligible/);
  });

  it("rejects a non-default gateway port recorded by another host gateway", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-recorded-gateway-port-"));
    tempHomes.push(home);
    fs.mkdirSync(path.join(home, ".nemoclaw", "gateways", "18080"), { recursive: true });
    vi.stubEnv("HOME", home);

    expect(
      isLoopbackNoAuthCompatibleEndpointUrl("compatible-endpoint", "http://localhost:18080/v1"),
    ).toBe(false);
  });

  it.each([
    ["wrong provider", "http://localhost:12500/v1", "compatible-anthropic-endpoint"],
    ["remote host", "http://10.0.0.1:12500/v1"],
    ["public host", "https://inference.example.test/v1"],
    ["HTTPS loopback", "https://localhost:12500/v1"],
    ["default port", "http://localhost/v1"],
    ["privileged port", "http://localhost:999/v1"],
    ["out-of-range port", "http://localhost:65536/v1"],
    ["userinfo", "http://user@localhost:12500/v1"],
    ["query", "http://localhost:12500/v1?tenant=other"],
    ["fragment", "http://localhost:12500/v1#models"],
    ["dotted loopback", "http://localhost.:12500/v1"],
    ["encoded control", "http://localhost:12500/v1%0ax"],
    ["malformed URL", "not a URL"],
  ])(
    "rejects an unsafe no-auth proxy source: %s",
    (_label, endpointUrl, provider = "compatible-endpoint") => {
      expect(isLoopbackNoAuthCompatibleEndpointUrl(provider, endpointUrl)).toBe(false);
    },
  );

  it("rejects dotted loopback at the final proxy mutation boundary", () => {
    expect(() => assertLoopbackNoAuthCompatibleEndpointUrl("http://localhost.:12500/v1")).toThrow(
      /no longer eligible/,
    );
  });

  it.each(["localhost", "127.0.0.1", "[::1]"])(
    "rewrites exact HTTP loopback hosts on bundled local-inference ports [case %#] (#5744)",
    (host) => {
      expect(
        COMPATIBLE_ENDPOINT_GATEWAY_PORTS.every((port) =>
          Object.is(
            gatewayReachableCompatibleEndpointUrl(
              "compatible-endpoint",
              `http://${host}:${port}/v1/`,
            ),
            `http://host.openshell.internal:${port}/v1`,
          ),
        ),
      ).toBe(true);
    },
  );

  it("leaves a generic compatible-endpoint loopback URL unchanged on port 8081 (#8161)", () => {
    expect(
      gatewayReachableCompatibleEndpointUrl("compatible-endpoint", "http://127.0.0.1:8081/v1"),
    ).toBe("http://127.0.0.1:8081/v1");
  });

  it("rewrites only fixed loopback port 8081 for llama.cpp attachment (#8161)", () => {
    expect(
      gatewayReachableCompatibleEndpointUrl("llama-cpp-local", "http://127.0.0.1:8081/v1"),
    ).toBe("http://host.openshell.internal:8081/v1");
    expect(
      gatewayReachableCompatibleEndpointUrl("llama-cpp-local", "http://127.0.0.1:8000/v1"),
    ).toBe("http://127.0.0.1:8000/v1");
  });

  it("preserves query strings and fragments for root and non-root routes (#5744)", () => {
    expect(
      gatewayReachableCompatibleEndpointUrl(
        "compatible-endpoint",
        "http://localhost:8000/?tenant=local#models",
      ),
    ).toBe("http://host.openshell.internal:8000?tenant=local#models");
    expect(
      gatewayReachableCompatibleEndpointUrl(
        "compatible-endpoint",
        "http://localhost:8000/v1/?tenant=local#models",
      ),
    ).toBe("http://host.openshell.internal:8000/v1?tenant=local#models");
  });

  it("leaves default, privileged, unsupported, and adjacent URL shapes unchanged (#5744)", () => {
    const unchanged = [
      "http://localhost/v1",
      "http://localhost:80/v1",
      "http://localhost:1023/v1",
      "http://localhost:9000/v1",
      "https://localhost:8000/v1",
      "http://user@localhost:8000/v1",
      "http://localhost.example:8000/v1",
      "http://localhost.:8000/v1",
      "http://127.1:8000/v1",
      "http://2130706433:8000/v1",
      "http://127.0.0.2:8000/v1",
      "http://host.openshell.internal:8000/v1",
      "not a URL",
    ];

    expect(
      unchanged.every((endpointUrl) =>
        Object.is(
          gatewayReachableCompatibleEndpointUrl("compatible-endpoint", endpointUrl),
          endpointUrl,
        ),
      ),
    ).toBe(true);
    expect(
      gatewayReachableCompatibleEndpointUrl(
        "compatible-anthropic-endpoint",
        "http://localhost:8000/v1",
      ),
    ).toBe("http://localhost:8000/v1");
    expect(gatewayReachableCompatibleEndpointUrl("compatible-endpoint", null)).toBeNull();
    expect(gatewayReachableCompatibleEndpointUrl("compatible-endpoint", undefined)).toBeUndefined();
  });
});

describe("recovered provider reuse", () => {
  const REGISTERED_URL = "http://host.openshell.internal:8000/v1";

  function createRunOpenshell() {
    const commands: string[] = [];
    const runOpenshell = vi.fn((args: string[]) => {
      commands.push(args.join(" "));
      return { status: 0, stdout: "", stderr: "" };
    });
    return { commands, runOpenshell };
  }

  const reuseArgs = {
    provider: "compatible-endpoint",
    providerType: "openai",
    credentialEnv: "COMPATIBLE_API_KEY",
    endpointUrl: REGISTERED_URL,
    gatewayEndpointUrl: REGISTERED_URL,
  };

  it("reuses an unchanged OpenAI gateway route without a compatibility-profile mutation", async () => {
    const { commands, runOpenshell } = createRunOpenshell();
    const upsertProvider = vi.fn(async () => ({ ok: true }));

    expect(
      await reuseRegisteredProviderWithGatewayEndpoint({
        ...reuseArgs,
        runOpenshell,
        upsertProvider,
      }),
    ).toEqual({ ok: true });

    expect(upsertProvider).not.toHaveBeenCalled();
    expect(commands).toEqual(["provider get compatible-endpoint"]);
  });

  it("leaves a non-openai recovered provider untouched", async () => {
    const { commands, runOpenshell } = createRunOpenshell();
    const upsertProvider = vi.fn(async () => ({ ok: true }));

    expect(
      await reuseRegisteredProviderWithGatewayEndpoint({
        ...reuseArgs,
        providerType: "anthropic",
        runOpenshell,
        upsertProvider,
      }),
    ).toEqual({ ok: true });

    expect(commands).toEqual(["provider get compatible-endpoint"]);
  });
});
