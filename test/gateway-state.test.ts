// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Unit tests for gateway-state.ts classifiers.
// Covers ARM64/non-TTY fallback paths where `openshell status` returns empty output.
// See: https://github.com/NVIDIA/NemoClaw/issues/1711

import { describe, it, expect } from "vitest";
import {
  isGatewayConnected,
  isGatewayHealthy,
  getGatewayReuseState,
  hasStaleGateway,
  hasActiveGatewayInfo,
  getReportedGatewayName,
} from "../src/lib/gateway-state.js";

// Realistic CLI outputs
const STATUS_CONNECTED = `
Server Status

Gateway: nemoclaw
Server: https://127.0.0.1:8080/
Connected
`;

const STATUS_SERVER_STATUS_ONLY = `
Server Status

Gateway: nemoclaw
Server: https://127.0.0.1:8080/
`;

const GW_INFO_NAMED = `
Gateway Info

Gateway: nemoclaw
Gateway endpoint: https://127.0.0.1:8080/
`;

const GW_INFO_ACTIVE = `
Gateway Info

Gateway: nemoclaw
Gateway endpoint: https://127.0.0.1:8080/
`;

const GW_INFO_MISSING = "No gateway metadata found";

describe("isGatewayConnected", () => {
  it("matches 'Connected' keyword", () => {
    expect(isGatewayConnected(STATUS_CONNECTED)).toBe(true);
  });

  it("matches 'Server Status' keyword (OpenShell 0.0.25+)", () => {
    expect(isGatewayConnected(STATUS_SERVER_STATUS_ONLY)).toBe(true);
  });

  it("returns false for empty string", () => {
    expect(isGatewayConnected("")).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isGatewayConnected()).toBe(false);
  });
});

describe("isGatewayHealthy", () => {
  it("returns true when status shows Connected and gateway name matches", () => {
    expect(isGatewayHealthy(STATUS_CONNECTED, GW_INFO_NAMED, GW_INFO_ACTIVE)).toBe(true);
  });

  it("returns true when status shows Server Status and gateway name matches", () => {
    expect(isGatewayHealthy(STATUS_SERVER_STATUS_ONLY, GW_INFO_NAMED, GW_INFO_ACTIVE)).toBe(true);
  });

  it("returns true via fallback when status is empty but gateway info confirms health (#1711)", () => {
    // ARM64 / non-TTY: openshell status returns ""
    expect(isGatewayHealthy("", GW_INFO_NAMED, GW_INFO_ACTIVE)).toBe(true);
  });

  it("returns false when nothing is available", () => {
    expect(isGatewayHealthy("", "", "")).toBe(false);
  });

  it("returns false when gateway info is missing", () => {
    expect(isGatewayHealthy("", GW_INFO_MISSING, "")).toBe(false);
  });

  it("returns false when gateway name does not match", () => {
    const wrongName = GW_INFO_ACTIVE.replace("nemoclaw", "other-gw");
    expect(isGatewayHealthy("", GW_INFO_NAMED, wrongName)).toBe(false);
  });
});

describe("getGatewayReuseState", () => {
  it("returns 'healthy' for normal connected state", () => {
    expect(getGatewayReuseState(STATUS_CONNECTED, GW_INFO_NAMED, GW_INFO_ACTIVE)).toBe("healthy");
  });

  it("returns 'healthy' via ARM64 fallback path (#1711)", () => {
    expect(getGatewayReuseState("", GW_INFO_NAMED, GW_INFO_ACTIVE)).toBe("healthy");
  });

  it("returns 'missing' when all outputs are empty", () => {
    expect(getGatewayReuseState("", "", "")).toBe("missing");
  });
});
