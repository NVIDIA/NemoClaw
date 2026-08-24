// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";

import {
  BUNDLED_LOCAL_INFERENCE_GATEWAY_PORTS,
  COMPATIBLE_ENDPOINT_GATEWAY_PORTS,
  gatewayReachableCompatibleEndpointUrl,
  reuseRegisteredProviderWithGatewayEndpoint,
} from "./compatible-endpoint-gateway-route";

describe("compatible endpoint gateway routing", () => {
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

describe("recovered provider reuse and the openai provider profile (#9895)", () => {
  const REGISTERED_URL = "http://host.openshell.internal:8000/v1";

  function createRunOpenshell(profileStatus: number) {
    const commands: string[] = [];
    const runOpenshell = vi.fn((args: string[]) => {
      commands.push(args.join(" "));
      return {
        status: args[1] === "profile" ? profileStatus : 0,
        stdout: "",
        stderr: "import refused",
      };
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

  it("declares the openai profile for an unchanged gateway route that performs no upsert", () => {
    const { commands, runOpenshell } = createRunOpenshell(0);
    const upsertProvider = vi.fn(() => ({ ok: true }));

    expect(
      reuseRegisteredProviderWithGatewayEndpoint({ ...reuseArgs, runOpenshell, upsertProvider }),
    ).toEqual({ ok: true });

    expect(upsertProvider).not.toHaveBeenCalled();
    expect(commands).toEqual([
      "provider get compatible-endpoint",
      expect.stringMatching(
        /^provider profile import --file .*\/provider-profiles\/openai\.yaml$/u,
      ),
    ]);
  });

  it("reports a failed profile import instead of reusing the recovered provider", () => {
    const { runOpenshell } = createRunOpenshell(1);
    const upsertProvider = vi.fn(() => ({ ok: true }));

    const result = reuseRegisteredProviderWithGatewayEndpoint({
      ...reuseArgs,
      runOpenshell,
      upsertProvider,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(1);
    expect(result.message).toContain(
      "could not import the checked-in 'openai' inference provider profile",
    );
    expect(result.message).not.toContain("import refused");
    expect(upsertProvider).not.toHaveBeenCalled();
  });

  it("leaves a non-openai recovered provider untouched", () => {
    const { commands, runOpenshell } = createRunOpenshell(1);
    const upsertProvider = vi.fn(() => ({ ok: true }));

    expect(
      reuseRegisteredProviderWithGatewayEndpoint({
        ...reuseArgs,
        providerType: "anthropic",
        runOpenshell,
        upsertProvider,
      }),
    ).toEqual({ ok: true });

    expect(commands).toEqual(["provider get compatible-endpoint"]);
  });
});
