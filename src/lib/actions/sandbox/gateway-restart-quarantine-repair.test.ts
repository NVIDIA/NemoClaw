// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyGatewayRestartFailure,
  gatewayTerminalRepairLines,
  isGatewayTerminalRepairLayer,
  printGatewayRestartFailure,
} from "./gateway-restart";

// The exact lines the in-sandbox Hermes supervisor emits when it stops
// attempting relaunch. `scripts/managed-gateway-control.py` allowlists these
// before forwarding them to the host as `NEMOCLAW_START_LOG=` lines.
const QUARANTINE_LINES = [
  "[gateway] CRITICAL: 5 exits in 60s window — Hermes relaunch is stopped for this supervisor instance; correct the reported failure, then stop and start the sandbox; check /tmp/gateway.log",
  "[gateway] CRITICAL: exact Hermes replacement could not be stopped; managed supervisor is quarantined without another launch",
  "[CRITICAL] Unproven Hermes gateway child exited; relaunch is stopped for this supervisor instance; correct the reported failure, then stop and start the sandbox",
  "[CRITICAL] Newly launched Hermes gateway pid 4242 failed exact role identity capture; quarantining the managed startup supervisor without signaling the unproven child",
] as const;

const CRASH_LOOP_RESTART_OUTPUT = [
  "GATEWAY_HEALTH_TIMEOUT",
  "NEMOCLAW_CONTROL_STAGE=await-replacement",
  "NEMOCLAW_SUPERVISOR_PID=42",
  "NEMOCLAW_GATEWAY_PID=0",
  "NEMOCLAW_START_LOG=[gateway] CRITICAL: 5 exits in 60s window — Hermes relaunch is stopped for this supervisor instance; correct the reported failure, then stop and start the sandbox; check /tmp/gateway.log",
].join("\n");

function classify(stdout: string) {
  return classifyGatewayRestartFailure({ status: 1, stdout, stderr: "" });
}

function captureStderr(run: () => void): string[] {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((value?: unknown) => {
    lines.push(String(value));
  });
  run();
  spy.mockRestore();
  return lines;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("supervisor relaunch quarantine classification (#7801)", () => {
  it.each(QUARANTINE_LINES)("classifies %s as a relaunch quarantine", (line) => {
    expect(classify(line)).toMatchObject({ layer: "relaunch quarantined" });
  });

  it("classifies a crash-loop quarantine ahead of its health timeout", () => {
    expect(classify(CRASH_LOOP_RESTART_OUTPUT)).toMatchObject({
      layer: "relaunch quarantined",
    });
  });

  it("keeps the pre-existing layers for output without a quarantine line", () => {
    expect(classify("GATEWAY_HEALTH_TIMEOUT")).toMatchObject({ layer: "health timeout" });
    expect(classify("HERMES_MCP_CONFIG_DRIFT")).toMatchObject({
      layer: "MCP reconciliation refusal",
    });
    expect(classify("GATEWAY_CONFIG_HASH_MISMATCH")).toMatchObject({
      layer: "config hash mismatch",
    });
    expect(classify("SUPERVISOR_NOT_RUNNING")).toMatchObject({ layer: "supervisor not running" });
  });

  it("ignores an unrelated line that merely mentions the supervisor", () => {
    expect(classify("[gateway] Hermes gateway respawned (pid 18424)")).toMatchObject({
      layer: "launch failure",
    });
  });
});

describe("terminal restart repair guidance (#7801)", () => {
  it("recognizes the terminal repair layers", () => {
    expect(isGatewayTerminalRepairLayer("relaunch quarantined")).toBe(true);
    expect(isGatewayTerminalRepairLayer("config hash mismatch")).toBe(true);
    expect(isGatewayTerminalRepairLayer("health timeout")).toBe(false);
    expect(isGatewayTerminalRepairLayer("launch failure")).toBe(false);
    expect(isGatewayTerminalRepairLayer(null)).toBe(false);
    expect(isGatewayTerminalRepairLayer(undefined)).toBe(false);
  });

  it.each([
    "relaunch quarantined",
    "config hash mismatch",
  ] as const)("names the supported repair command for %s", (layer) => {
    const lines = gatewayTerminalRepairLines("repro-7801", layer).join("\n");
    expect(lines).toContain("nemoclaw repro-7801 rebuild --yes");
  });

  it("resets process quarantine without blaming mutable config (#11108)", () => {
    const lines = gatewayTerminalRepairLines("alpha", "relaunch quarantined").join("\n");
    expect(lines).toContain("repeated process or health failures");
    expect(lines).toContain("nemoclaw alpha stop");
    expect(lines).toContain("nemoclaw alpha start");
    expect(lines).not.toContain("config set");
  });

  it("keeps metadata repair separate from process quarantine", () => {
    const lines = gatewayTerminalRepairLines("alpha", "config hash mismatch").join("\n");
    expect(lines).toContain("integrity metadata");
    expect(lines).not.toContain("nemoclaw alpha stop");
  });
});

describe("printGatewayRestartFailure repair guidance (#7801)", () => {
  it("appends the repair to a quarantined restart failure", () => {
    const lines = captureStderr(() =>
      printGatewayRestartFailure("repro-7801", "relaunch quarantined", CRASH_LOOP_RESTART_OUTPUT),
    ).join("\n");
    expect(lines).toContain("Failure layer: relaunch quarantined");
    expect(lines).toContain("nemoclaw repro-7801 rebuild --yes");
  });

  it("still prints the repair when the controller returned no detail", () => {
    const lines = captureStderr(() =>
      printGatewayRestartFailure("repro-7801", "config hash mismatch", ""),
    ).join("\n");
    expect(lines).toContain("nemoclaw repro-7801 rebuild --yes");
  });

  it("leaves retryable failure layers without a rebuild instruction", () => {
    const timeout = captureStderr(() =>
      printGatewayRestartFailure("repro-7801", "health timeout", "GATEWAY_HEALTH_TIMEOUT"),
    ).join("\n");
    const launch = captureStderr(() =>
      printGatewayRestartFailure("repro-7801", "launch failure", "GATEWAY_FAILED"),
    ).join("\n");
    expect(timeout).not.toContain("rebuild --yes");
    expect(launch).not.toContain("rebuild --yes");
  });

  it("keeps the MCP reconciliation remediation it already emitted", () => {
    const lines = captureStderr(() =>
      printGatewayRestartFailure("repro-7801", "MCP reconciliation refusal", "mcp-integrity"),
    ).join("\n");
    expect(lines).toContain("nemoclaw repro-7801 mcp restart");
  });
});
