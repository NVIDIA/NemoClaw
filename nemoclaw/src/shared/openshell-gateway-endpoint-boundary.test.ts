// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  classifyManagedGatewayEndpointBinding,
  parseSingleManagedGatewayEndpoint,
  parseSingleManagedGatewayEndpointPort,
} from "./openshell-gateway-endpoint-boundary.cjs";

describe("OpenShell managed gateway endpoint boundary", () => {
  it.each([
    ["http://127.0.0.1:8080", 8080],
    ["https://localhost", 443],
    ["http://[::1]:9090", 9090],
  ])("accepts one credential-free loopback endpoint %s (#9833)", (endpoint, port) => {
    const output = `Gateway endpoint: ${endpoint}\n`;
    expect(parseSingleManagedGatewayEndpointPort(output)).toBe(port);
    expect(parseSingleManagedGatewayEndpoint(output).port).toBe(port);
    expect(classifyManagedGatewayEndpointBinding([output], port)).toBe("match");
  });

  it("returns the normalized loopback host for durable receipt binding (#9833)", () => {
    expect(parseSingleManagedGatewayEndpoint("Gateway endpoint: HTTP://LOCALHOST:8080\n")).toEqual({
      host: "localhost",
      port: 8080,
    });
  });

  it.each([
    "http://192.0.2.10:8080",
    "http://gateway.example.com:8080",
    "http://user:password@127.0.0.1:8080",
    "http://127.0.0.1:8080/path",
  ])("rejects substituted gateway endpoint %s (#9833)", (endpoint) => {
    const output = `Gateway endpoint: ${endpoint}\n`;
    expect(() => parseSingleManagedGatewayEndpointPort(output)).toThrow(
      "unsupported local gateway endpoint",
    );
    expect(classifyManagedGatewayEndpointBinding([output], 8080)).toBe("mismatch");
  });

  it("rejects ambiguous gateway endpoint output (#9833)", () => {
    const output = [
      "Gateway endpoint: http://127.0.0.1:8080",
      "Server: http://127.0.0.1:8080",
    ].join("\n");
    expect(() => parseSingleManagedGatewayEndpointPort(output)).toThrow(
      "did not report one gateway endpoint",
    );
  });

  it.each(["", "not-a-url"])(
    "rejects an empty or malformed gateway endpoint %j (#9833)",
    (endpoint) => {
      const output = `Gateway endpoint: ${endpoint}\n`;
      expect(() => parseSingleManagedGatewayEndpointPort(output)).toThrow(
        "invalid gateway endpoint",
      );
      expect(classifyManagedGatewayEndpointBinding([output], 8080)).toBe("mismatch");
    },
  );
});
