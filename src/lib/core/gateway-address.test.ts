// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "vitest";

import {
  getGatewayConnectHost,
  getGatewayHttpEndpoint,
  getGatewayHttpsEndpoint,
  isExternalHttpGatewayOrigin,
  parseGatewayBindAddress,
} from "./gateway-address";

const ENV_KEY = "TEST_GATEWAY_BIND_ADDRESS";

describe("external HTTP gateway origins", () => {
  it("accepts the exact IPv4 loopback origin (#11861)", () => {
    expect(isExternalHttpGatewayOrigin("http://127.0.0.1:8080", 8080)).toBe(true);
  });

  it.each([
    "https://127.0.0.1:8080",
    "http://localhost:8080",
    "http://[::1]:8080",
    "http://127.0.0.1:8081",
    "http://169.254.169.254:8080",
    "http://0.0.0.0:8080",
    "http://user:secret@127.0.0.1:8080",
    "http://127.0.0.1:8080/",
    "http://127.0.0.1:8080/path",
    "http://127.0.0.1:8080?token=secret",
    "http://127.0.0.1:8080#fragment",
    "http://127.0.0.1:8080\n",
  ])("rejects a noncanonical or competing origin %s (#11861)", (endpoint) => {
    expect(isExternalHttpGatewayOrigin(endpoint, 8080)).toBe(false);
  });

  it.each([80, 0, 65536, 8080.5, Number.NaN])(
    "rejects unrepresentable external port %s (#11861)",
    (port) => {
      expect(isExternalHttpGatewayOrigin(`http://127.0.0.1:${port}`, port)).toBe(false);
    },
  );
});

afterEach(() => {
  delete process.env[ENV_KEY];
});

describe("parseGatewayBindAddress", () => {
  it("defaults to loopback", () => {
    expect(parseGatewayBindAddress(ENV_KEY)).toBe("127.0.0.1");
  });

  it("accepts loopback", () => {
    process.env[ENV_KEY] = "127.0.0.1";
    expect(parseGatewayBindAddress(ENV_KEY)).toBe("127.0.0.1");
  });

  it("accepts all IPv4 interfaces", () => {
    process.env[ENV_KEY] = "0.0.0.0";
    expect(parseGatewayBindAddress(ENV_KEY)).toBe("0.0.0.0");
  });

  it("rejects comma-separated addresses", () => {
    process.env[ENV_KEY] = "0.0.0.0,127.0.0.1";
    expect(() => parseGatewayBindAddress(ENV_KEY)).toThrow("must be either");
  });

  it.each(["localhost", "10.0.0.5", "::", "::1"])("rejects %s", (value) => {
    process.env[ENV_KEY] = value;
    expect(() => parseGatewayBindAddress(ENV_KEY)).toThrow("must be either");
  });
});

describe("gateway endpoint helpers", () => {
  it("keeps loopback endpoints unchanged", () => {
    expect(getGatewayConnectHost("127.0.0.1")).toBe("127.0.0.1");
    expect(getGatewayHttpEndpoint(8080, "127.0.0.1")).toBe("http://127.0.0.1:8080");
    expect(getGatewayHttpsEndpoint(8080, "127.0.0.1")).toBe("https://127.0.0.1:8080");
  });

  it("does not advertise wildcard bind addresses as client endpoints", () => {
    expect(getGatewayConnectHost("0.0.0.0")).toBe("127.0.0.1");
    expect(getGatewayHttpEndpoint(8990, "0.0.0.0")).toBe("http://127.0.0.1:8990");
    expect(getGatewayHttpsEndpoint(8990, "0.0.0.0")).toBe("https://127.0.0.1:8990");
  });
});
