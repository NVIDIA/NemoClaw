// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyGatewayRestartFailure,
  gatewayIntegrityRepairLines,
  isGatewayIntegrityRepairLayer,
  printGatewayRestartFailure,
} from "./gateway-restart";

// The exact lines the in-sandbox Hermes supervisor emits when it stops
// attempting relaunch. `scripts/managed-gateway-control.py` allowlists these
// before forwarding them to the host as `NEMOCLAW_START_LOG=` lines.
const QUARANTINE_LINES = [
  "[gateway] CRITICAL: 5 exits in 60s window — Hermes relaunch is quarantined until sandbox recreation; check /tmp/gateway.log",
  "[SECURITY] Hermes automatic respawn is quarantined until MCP integrity is restored by rebuilding the sandbox",
  "[gateway] CRITICAL: exact Hermes replacement could not be stopped; managed supervisor is quarantined without another launch",
  "[CRITICAL] Unproven Hermes gateway child exited; managed supervisor remains quarantined until sandbox recreation",
  "[CRITICAL] Newly launched Hermes gateway pid 4242 failed exact role identity capture; quarantining the managed startup supervisor without signaling the unproven child",
] as const;

// Verbatim controller output captured on a Hermes sandbox whose protected
// `config.yaml` was edited outside a supported command, then restarted.
const REPORTED_RESTART_OUTPUT = [
  "GATEWAY_HEALTH_TIMEOUT",
  "NEMOCLAW_CONTROL_STAGE=await-replacement",
  "NEMOCLAW_SUPERVISOR_PID=42",
  "NEMOCLAW_GATEWAY_PID=0",
  "NEMOCLAW_START_LOG=[gateway] Hermes gateway respawned (pid 18424)",
  "NEMOCLAW_START_LOG=[SECURITY] Hermes automatic respawn is quarantined until MCP integrity is restored by rebuilding the sandbox",
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

  it("classifies the reported restart output as a quarantine, not a health timeout", () => {
    expect(classify(REPORTED_RESTART_OUTPUT)).toMatchObject({ layer: "relaunch quarantined" });
  });

  it("prefers the quarantine over the MCP drift it is reported through", () => {
    const output = [
      "HERMES_MCP_CONFIG_DRIFT",
      "[SECURITY] Hermes automatic respawn is quarantined until MCP integrity is restored by rebuilding the sandbox",
    ].join("\n");
    expect(classify(output)).toMatchObject({ layer: "relaunch quarantined" });
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

describe("integrity repair guidance (#7801)", () => {
  it("treats both deterministic integrity refusals as repairable layers", () => {
    expect(isGatewayIntegrityRepairLayer("relaunch quarantined")).toBe(true);
    expect(isGatewayIntegrityRepairLayer("config hash mismatch")).toBe(true);
    expect(isGatewayIntegrityRepairLayer("health timeout")).toBe(false);
    expect(isGatewayIntegrityRepairLayer("launch failure")).toBe(false);
    expect(isGatewayIntegrityRepairLayer(null)).toBe(false);
    expect(isGatewayIntegrityRepairLayer(undefined)).toBe(false);
  });

  it.each([
    "relaunch quarantined",
    "config hash mismatch",
  ] as const)("names the supported repair command for %s", (layer) => {
    const lines = gatewayIntegrityRepairLines("repro-7801", layer).join("\n");
    expect(lines).toContain("nemoclaw repro-7801 rebuild --yes");
    expect(lines).toContain("Retrying the restart cannot clear it.");
    expect(lines).toContain("nemoclaw repro-7801 config set");
  });

  it("describes the two refusals differently", () => {
    const quarantined = gatewayIntegrityRepairLines("alpha", "relaunch quarantined")[0];
    const drifted = gatewayIntegrityRepairLines("alpha", "config hash mismatch")[0];
    expect(quarantined).not.toEqual(drifted);
    expect(drifted).toContain("integrity hash");
    expect(quarantined).toContain("quarantined");
  });
});

describe("printGatewayRestartFailure repair guidance (#7801)", () => {
  it("appends the repair to a quarantined restart failure", () => {
    const lines = captureStderr(() =>
      printGatewayRestartFailure("repro-7801", "relaunch quarantined", REPORTED_RESTART_OUTPUT),
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
