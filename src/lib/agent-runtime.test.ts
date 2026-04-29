// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
// Import from compiled dist/ so coverage is attributed correctly.
import { buildRecoveryScript } from "../../dist/lib/agent-runtime";
import type { AgentDefinition } from "./agent-defs";

function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: "test-agent",
    displayName: "Test Agent",
    binary_path: "/usr/local/bin/test-agent",
    gateway_command: "test-agent gateway run",
    healthProbe: { url: "http://127.0.0.1:19000/", port: 19000, timeout_seconds: 5 },
    forwardPort: 19000,
    dashboard: { kind: "ui", label: "UI", path: "/" },
    configPaths: {
      immutableDir: "/tmp/agent/immutable",
      writableDir: "/tmp/agent/writable",
      configFile: "/tmp/agent/config.yaml",
      envFile: null,
      format: "yaml",
    },
    stateDirs: [],
    versionCommand: "test-agent --version",
    expectedVersion: null,
    hasDevicePairing: false,
    phoneHomeHosts: [],
    messagingPlatforms: [],
    dockerfileBasePath: null,
    dockerfilePath: null,
    startScriptPath: null,
    policyAdditionsPath: null,
    policyPermissivePath: null,
    pluginDir: null,
    legacyPaths: null,
    agentDir: "/tmp/agent",
    manifestPath: "/tmp/agent/manifest.yaml",
    ...overrides,
  };
}

const minimalAgent = makeAgent();

describe("buildRecoveryScript", () => {
  it("returns null for null agent (OpenClaw inline script handles it)", () => {
    expect(buildRecoveryScript(null, 18789)).toBeNull();
  });

  it("embeds the port in the gateway launch command (#1925)", () => {
    const script = buildRecoveryScript(minimalAgent, 19000);
    expect(script).toContain("--port 19000");
  });

  it("embeds the default port when called with default value", () => {
    const script = buildRecoveryScript(minimalAgent, 18789);
    expect(script).toContain("--port 18789");
  });

  it("launches the default gateway command through the validated agent binary", () => {
    const script = buildRecoveryScript(minimalAgent, 19000);
    expect(script).toContain("command -v 'test-agent'");
    expect(script).toContain('nohup "$AGENT_BIN" gateway run --port 19000');
  });

  it("falls back to openclaw gateway run when gateway_command is absent", () => {
    const agent = makeAgent({ gateway_command: undefined });
    const script = buildRecoveryScript(agent, 19000);
    expect(script).toContain('nohup "$AGENT_BIN" gateway run --port 19000');
  });

  it("validates and launches custom gateway commands explicitly", () => {
    const agent = makeAgent({ gateway_command: "custom-launch --mode recovery" });
    const script = buildRecoveryScript(agent, 19000);
    expect(script).toContain("GATEWAY_CMD_BIN='custom-launch'");
    expect(script).toContain('command -v "$GATEWAY_CMD_BIN" >/dev/null 2>&1');
    expect(script).toContain("nohup custom-launch --mode recovery --port 19000");
  });

  // Regression coverage for #2478. The recovery script must explicitly source
  // /tmp/nemoclaw-proxy-env.sh (single source of truth for NODE_OPTIONS
  // library guards) and warn — not silently continue — when the file is
  // missing or the safety-net preload is absent from NODE_OPTIONS. The pre-fix
  // recovery path swallowed sourcing errors via `2>/dev/null`, leaving
  // respawned gateways guard-less and crash-looping on the next library
  // error from ciao, model-pricing, or anything else hitting a sandboxed
  // syscall.
  describe("#2478 hardened library-guard preload chain", () => {
    it("explicitly sources the gateway env file", () => {
      const script = buildRecoveryScript(minimalAgent, 19000);
      expect(script).toContain(". /tmp/nemoclaw-proxy-env.sh");
    });

    it("warns when the gateway env file is missing instead of silently launching", () => {
      const script = buildRecoveryScript(minimalAgent, 19000);
      expect(script).toContain("/tmp/nemoclaw-proxy-env.sh missing");
      expect(script).toContain("#2478");
    });

    it("does not silence sourcing errors with 2>/dev/null", () => {
      const script = buildRecoveryScript(minimalAgent, 19000);
      expect(script).not.toContain(". ~/.bashrc 2>/dev/null");
      expect(script).not.toContain(". /tmp/nemoclaw-proxy-env.sh 2>/dev/null");
    });

    it("checks NODE_OPTIONS for the safety-net preload after sourcing", () => {
      const script = buildRecoveryScript(minimalAgent, 19000);
      expect(script).toContain("nemoclaw-sandbox-safety-net");
      expect(script).toContain("NODE_OPTIONS missing safety-net preload");
    });

    it("sources proxy-env.sh BEFORE launching the gateway binary", () => {
      const script = buildRecoveryScript(minimalAgent, 19000);
      expect(script).not.toBeNull();
      const sourceIdx = script!.indexOf("/tmp/nemoclaw-proxy-env.sh");
      const launchIdx = script!.indexOf("gateway run");
      expect(sourceIdx).toBeGreaterThanOrEqual(0);
      expect(launchIdx).toBeGreaterThanOrEqual(0);
      expect(sourceIdx).toBeLessThan(launchIdx);
    });

    it("writes the warning to gateway.log so it persists for sysadmin tail", () => {
      const script = buildRecoveryScript(minimalAgent, 19000);
      // Both warnings must end up in /tmp/gateway.log, not just stderr —
      // executeSandboxCommand silently discards stderr from the recovery
      // script, so a warning that only goes to stderr is invisible to
      // anyone debugging a crash-loop. (#2478)
      expect(script).toContain('echo "$_W" >> /tmp/gateway.log');
      // And the warning must be deferred until AFTER gateway.log is
      // freshly touched/chmod'd, otherwise the redirect targets a stale
      // file that gets removed seconds later.
      const touchIdx = script!.indexOf("touch /tmp/gateway.log");
      const warnIdx = script!.indexOf('echo "$_W" >> /tmp/gateway.log');
      expect(touchIdx).toBeLessThan(warnIdx);
    });

    it("appends (not truncates) gateway.log on launch so warnings survive", () => {
      const script = buildRecoveryScript(minimalAgent, 19000);
      // Truncating with `>` wipes the [gateway-recovery] WARNING that the
      // recovery script wrote moments earlier — meaning a sysadmin tailing
      // gateway.log would see the eventual crash without the explanation.
      expect(script).toContain(">> /tmp/gateway.log 2>&1 &");
      expect(script).not.toMatch(/[^>]> \/tmp\/gateway\.log 2>&1 &/);
    });
  });
});
