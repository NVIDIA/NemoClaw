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
  parseSandboxPhase,
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

const GW_INFO_BASE = `
Gateway Info

Gateway: nemoclaw
Gateway endpoint: https://127.0.0.1:8080/
`;

// Both aliases reference the same fixture — previously duplicated as
// GW_INFO_NAMED / GW_INFO_ACTIVE.
const GW_INFO_NAMED = GW_INFO_BASE;
const GW_INFO_ACTIVE = GW_INFO_BASE;

const GW_INFO_MISSING = "No gateway metadata found";

// Active endpoint without a "Gateway: <name>" line — unnamed gateway
const GW_INFO_UNNAMED_ENDPOINT = `
Gateway Info

Gateway endpoint: https://127.0.0.1:8080/
`;

// Status output with a foreign (non-nemoclaw) gateway name
const STATUS_FOREIGN = `
Server Status

Gateway: other-gw
Server: https://127.0.0.1:9090/
Connected
`;

describe("hasStaleGateway", () => {
  it("returns true when output contains the named gateway", () => {
    expect(hasStaleGateway(GW_INFO_NAMED)).toBe(true);
  });

  it("returns false for empty string", () => {
    expect(hasStaleGateway("")).toBe(false);
  });

  it("returns false when output says no gateway metadata found", () => {
    expect(hasStaleGateway(GW_INFO_MISSING)).toBe(false);
  });

  it("returns false when gateway name does not match", () => {
    const other = GW_INFO_NAMED.replace("nemoclaw", "other-gw");
    expect(hasStaleGateway(other)).toBe(false);
  });
});

describe("hasActiveGatewayInfo", () => {
  it("returns true when output contains Gateway endpoint", () => {
    expect(hasActiveGatewayInfo(GW_INFO_ACTIVE)).toBe(true);
  });

  it("returns true for unnamed endpoint output", () => {
    expect(hasActiveGatewayInfo(GW_INFO_UNNAMED_ENDPOINT)).toBe(true);
  });

  it("returns false for empty string", () => {
    expect(hasActiveGatewayInfo("")).toBe(false);
  });

  it("returns false when output says no gateway metadata found", () => {
    expect(hasActiveGatewayInfo(GW_INFO_MISSING)).toBe(false);
  });
});

describe("getReportedGatewayName", () => {
  it("extracts gateway name from status output", () => {
    expect(getReportedGatewayName(STATUS_CONNECTED)).toBe("nemoclaw");
  });

  it("extracts gateway name from gateway info output", () => {
    expect(getReportedGatewayName(GW_INFO_NAMED)).toBe("nemoclaw");
  });

  it("returns null for empty string", () => {
    expect(getReportedGatewayName("")).toBeNull();
  });

  it("returns null when no Gateway: line is present", () => {
    expect(getReportedGatewayName(GW_INFO_UNNAMED_ENDPOINT)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(getReportedGatewayName()).toBeNull();
  });
});

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

  it("does not trigger fallback when status is non-empty", () => {
    // Non-empty status that lacks Connected/Server Status should not fall through to fallback
    const nonEmptyStatus = "some unexpected output";
    expect(isGatewayHealthy(nonEmptyStatus, GW_INFO_NAMED, GW_INFO_ACTIVE)).toBe(false);
  });

  it("returns false for Disconnected status (regression)", () => {
    // Disconnected is non-empty, so fallback must not trigger
    expect(isGatewayHealthy("Disconnected", GW_INFO_NAMED, GW_INFO_ACTIVE)).toBe(false);
  });

  it("returns true via fallback when status contains only ANSI escapes", () => {
    // Some terminals emit bare ANSI codes with no readable text — should
    // be treated as empty after stripping, triggering the ARM64 fallback.
    const ansiOnly = "\x1b[0m\x1b[32m";
    expect(isGatewayHealthy(ansiOnly, GW_INFO_NAMED, GW_INFO_ACTIVE)).toBe(true);
  });
});

describe("parseSandboxPhase", () => {
  it("extracts Ready phase from sandbox get output", () => {
    const output = ["Sandbox:", "", "  Id: abc", "  Name: my-assistant", "  Phase: Ready"].join(
      "\n",
    );
    expect(parseSandboxPhase(output)).toBe("Ready");
  });

  it("extracts Provisioning phase from sandbox get output", () => {
    const output = [
      "Sandbox:",
      "",
      "  Id: abc",
      "  Name: my-assistant",
      "  Phase: Provisioning",
    ].join("\n");
    expect(parseSandboxPhase(output)).toBe("Provisioning");
  });

  it("strips ANSI codes before parsing", () => {
    const output = "  \x1b[1mPhase:\x1b[0m Ready";
    expect(parseSandboxPhase(output)).toBe("Ready");
  });

  it("returns null for empty string", () => {
    expect(parseSandboxPhase("")).toBeNull();
  });

  it("returns null when no Phase line is present", () => {
    expect(parseSandboxPhase("Sandbox:\n  Id: abc\n  Name: test")).toBeNull();
  });
});

describe("getGatewayReuseState", () => {
  it("returns 'healthy' for normal connected state", () => {
    expect(getGatewayReuseState(STATUS_CONNECTED, GW_INFO_NAMED, GW_INFO_ACTIVE)).toBe("healthy");
  });

  it("returns 'healthy' via ARM64 fallback path (#1711)", () => {
    expect(getGatewayReuseState("", GW_INFO_NAMED, GW_INFO_ACTIVE)).toBe("healthy");
  });

  it("returns 'foreign-active' when connected to a different gateway", () => {
    expect(getGatewayReuseState(STATUS_FOREIGN, "", "")).toBe("foreign-active");
  });

  it("returns 'stale' when named gateway exists but no active endpoint", () => {
    // gwInfo has "Gateway: nemoclaw" but activeGatewayInfo is empty — no live endpoint
    expect(getGatewayReuseState("", GW_INFO_NAMED, "")).toBe("stale");
  });

  it("returns 'active-unnamed' when endpoint exists without gateway name", () => {
    // No status, no gwInfo, but activeGatewayInfo has an endpoint without a Gateway: line
    expect(getGatewayReuseState("", "", GW_INFO_UNNAMED_ENDPOINT)).toBe("active-unnamed");
  });

  it("returns 'missing' when all outputs are empty", () => {
    expect(getGatewayReuseState("", "", "")).toBe("missing");
  });
});
