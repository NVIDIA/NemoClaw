// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "vitest";

import {
  getGatewayConnectHost,
  getGatewayHttpEndpoint,
  getGatewayHttpsEndpoint,
  parseGatewayBindAddress,
} from "../../../dist/lib/core/gateway-address";

const ENV_KEY = "TEST_GATEWAY_BIND_ADDRESS";

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
