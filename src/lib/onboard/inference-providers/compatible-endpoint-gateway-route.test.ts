// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";

import {
  BUNDLED_LOCAL_INFERENCE_GATEWAY_PORTS,
  COMPATIBLE_ENDPOINT_AUTH_MODE_ENV,
  compatibleEndpointAllowsMissingApiKey,
  gatewayReachableCompatibleEndpointUrl,
  selectCompatibleEndpointAuthMode,
} from "./compatible-endpoint-gateway-route";

describe("compatible endpoint gateway routing", () => {
  it.each([
    "http://localhost:8000/v1",
    "http://127.0.0.1:8080/v1",
    "http://[::1]:9000/v1",
    "https://localhost/v1",
  ])("allows a missing API key for the exact loopback endpoint %s (#7424)", (endpointUrl) => {
    expect(compatibleEndpointAllowsMissingApiKey(endpointUrl)).toBe(true);
  });

  it.each([
    "https://inference.example/v1",
    "http://localhost.example:8000/v1",
    "http://localhost.:8000/v1",
    "http://127.0.0.2:8000/v1",
    "http://user@localhost:8000/v1",
  ])("requires an API key for %s (#7424)", (endpointUrl) => {
    expect(compatibleEndpointAllowsMissingApiKey(endpointUrl)).toBe(false);
  });

  it("offers an explicit no-auth choice for an interactive loopback endpoint (#7424)", async () => {
    const log = vi.fn();
    const prompt = vi.fn(async () => "2");

    await expect(
      selectCompatibleEndpointAuthMode({
        endpointUrl: "http://localhost:8000/v1",
        nonInteractive: false,
        credentialAvailable: false,
        prompt,
        log,
      }),
    ).resolves.toBe("none");

    expect(log.mock.calls.flat()).toContain("    2) No authentication");
    expect(prompt).toHaveBeenCalledWith("  Choose [1]: ");
  });

  it("requires an explicit non-interactive no-auth selection (#7424)", async () => {
    const options = {
      endpointUrl: "http://127.0.0.1:8000/v1",
      nonInteractive: true,
      credentialAvailable: false,
      prompt: vi.fn(async () => ""),
      log: vi.fn(),
    };

    await expect(selectCompatibleEndpointAuthMode(options)).rejects.toThrow(
      `Set COMPATIBLE_API_KEY or ${COMPATIBLE_ENDPOINT_AUTH_MODE_ENV}=none`,
    );
    await expect(
      selectCompatibleEndpointAuthMode({ ...options, configuredMode: "none" }),
    ).resolves.toBe("none");
  });

  it("keeps a supplied loopback API key in API-key mode (#7424)", async () => {
    await expect(
      selectCompatibleEndpointAuthMode({
        endpointUrl: "http://[::1]:8000/v1",
        nonInteractive: true,
        credentialAvailable: true,
        prompt: vi.fn(async () => ""),
        log: vi.fn(),
      }),
    ).resolves.toBe("api-key");
  });

  it("requires an API key for non-interactive non-loopback endpoints (#7424)", async () => {
    await expect(
      selectCompatibleEndpointAuthMode({
        endpointUrl: "https://inference.example/v1",
        nonInteractive: true,
        credentialAvailable: false,
        prompt: vi.fn(async () => ""),
        log: vi.fn(),
      }),
    ).rejects.toThrow("Set COMPATIBLE_API_KEY in non-interactive mode.");
  });

  it("rejects no-auth mode for non-loopback endpoints (#7424)", async () => {
    await expect(
      selectCompatibleEndpointAuthMode({
        endpointUrl: "https://inference.example/v1",
        nonInteractive: true,
        credentialAvailable: false,
        configuredMode: "none",
        prompt: vi.fn(async () => ""),
        log: vi.fn(),
      }),
    ).rejects.toThrow("allowed only for an exact loopback endpoint");
  });

  // source-shape-contract: compatibility -- Bundled loopback routing must match the shipped host-gateway policy ports
  it("matches the bundled local-inference host-gateway ports (#5744)", () => {
    const policyPath = path.resolve(
      import.meta.dirname,
      "../../../../nemoclaw-blueprint/policies/presets/local-inference.yaml",
    );
    const policy = YAML.parse(fs.readFileSync(policyPath, "utf8"));
    const endpoints: Array<{ host?: string; port?: number }> =
      policy.network_policies.local_inference.endpoints;
    const hostGatewayPorts = endpoints
      .filter(({ host }) => host === "host.openshell.internal")
      .map(({ port }) => port)
      .sort((left, right) => (left ?? 0) - (right ?? 0));

    expect(hostGatewayPorts).toEqual(
      [...BUNDLED_LOCAL_INFERENCE_GATEWAY_PORTS].sort((left, right) => left - right),
    );
  });

  it("rewrites exact HTTP loopback hosts on bundled local-inference ports (#5744)", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      for (const port of BUNDLED_LOCAL_INFERENCE_GATEWAY_PORTS) {
        expect(
          gatewayReachableCompatibleEndpointUrl(
            "compatible-endpoint",
            `http://${host}:${port}/v1/`,
          ),
        ).toBe(`http://host.openshell.internal:${port}/v1`);
      }
    }
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

    for (const endpointUrl of unchanged) {
      expect(gatewayReachableCompatibleEndpointUrl("compatible-endpoint", endpointUrl)).toBe(
        endpointUrl,
      );
    }
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
