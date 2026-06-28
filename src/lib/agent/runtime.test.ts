// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentDefinition } from "./defs";
// Import source directly so tests cannot pass against a stale build.
import { buildRecoveryScript } from "./runtime";

function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: "test-agent",
    displayName: "Test Agent",
    binary_path: "/usr/local/bin/test-agent",
    gateway_command: "test-agent gateway run",
    healthProbe: { url: "http://127.0.0.1:19000/", port: 19000, timeout_seconds: 5 },
    forwardPort: 19000,
    dashboard: { kind: "ui", label: "UI", path: "/", healthPath: "/health", auth: "url_token" },
    webAuth: { method: "none", env: null },
    configPaths: {
      dir: "/tmp/agent",
      configFile: "/tmp/agent/config.yaml",
      envFile: null,
      format: "yaml",
    },
    inferenceProviderOptions: [],
    stateDirs: [],
    stateFiles: [],
    userManagedFiles: [],
    versionCommand: "test-agent --version",
    expectedVersion: null,
    hasDevicePairing: false,
    phoneHomeHosts: [],
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
const hermesAgent = makeAgent({
  name: "hermes",
  displayName: "Hermes Agent",
  binary_path: "/usr/local/bin/hermes",
  gateway_command: "hermes gateway run",
  healthProbe: { url: "http://localhost:8642/health", port: 8642, timeout_seconds: 90 },
  forwardPort: 8642,
  configPaths: {
    dir: "/sandbox/.hermes",
    configFile: "/sandbox/.hermes/config.yaml",
    envFile: "/sandbox/.hermes/.env",
    format: "yaml",
  },
});

function extractGatewayProcessPattern(script: string | null): string {
  const match = script?.match(/_GATEWAY_PROC_PATTERN='([^']+)'/);
  expect(match).toBeTruthy();
  return match?.[1] ?? "";
}

function toJsRegex(pattern: string): RegExp {
  return new RegExp(pattern.replaceAll("[[:space:]]", "\\s"));
}

describe("buildRecoveryScript", () => {
  it("returns null for null agent because PID 1 owns OpenClaw recovery", () => {
    expect(buildRecoveryScript(null, 18789)).toBeNull();
  });

  it("returns null for Hermes because PID 1 owns Hermes recovery", () => {
    expect(buildRecoveryScript(hermesAgent, 8642)).toBeNull();
  });

  it("embeds the port in the gateway launch command (#1925)", () => {
    const script = buildRecoveryScript(minimalAgent, 19000);
    expect(script).toContain("--port 19000");
  });

  it("embeds the default port when called with default value", () => {
    const script = buildRecoveryScript(minimalAgent, 18789);
    expect(script).toContain("--port 18789");
  });

  it("derives the recovery port from agent metadata when omitted", () => {
    const script = buildRecoveryScript(minimalAgent);
    expect(script).toContain("--port 19000");
    expect(script).not.toContain("--port undefined");
  });

  it("launches the default gateway command through the validated agent binary", () => {
    const script = buildRecoveryScript(minimalAgent, 19000);
    expect(script).toContain("command -v 'test-agent'");
    expect(script).toContain('"$AGENT_BIN" gateway run --port 19000');
  });

  it("falls back to openclaw gateway run when gateway_command is absent", () => {
    const agent = makeAgent({ gateway_command: undefined });
    const script = buildRecoveryScript(agent, 19000);
    expect(script).toContain('"$AGENT_BIN" gateway run --port 19000');
  });

  it("validates and launches custom gateway commands explicitly", () => {
    const agent = makeAgent({ gateway_command: "custom-launch --mode recovery" });
    const script = buildRecoveryScript(agent, 19000);
    expect(script).toContain("GATEWAY_CMD_BIN='custom-launch'");
    expect(script).toContain('command -v "$GATEWAY_CMD_BIN" >/dev/null 2>&1');
    expect(script).toContain(
      "_GATEWAY_PROC_PATTERN='[c]ustom-launch[[:space:]]+--mode[[:space:]]+recovery([[:space:]]|$)'",
    );
    expect("custom-launch --mode recovery --port 19000").toMatch(
      toJsRegex(extractGatewayProcessPattern(script)),
    );
    expect(script).toContain("nohup custom-launch --mode recovery --port 19000");
  });

  // Regression coverage for #2478. The recovery script must validate
  // /tmp/nemoclaw-proxy-env.sh, then source a generated recovery env carrying
  // the critical NODE_OPTIONS library guards. The pre-fix recovery path
  // swallowed sourcing errors via `2>/dev/null`, leaving respawned gateways
  // guard-less and crash-looping on the next library error from ciao,
  // model-pricing, or anything else hitting a sandboxed syscall.
  describe("hardened library-guard preload chain (#2478)", () => {
    it("sources the generated recovery env after validating the gateway env file", () => {
      const script = buildRecoveryScript(minimalAgent, 19000);
      expect(script).toContain("_nemoclaw_validate_recovery_proxy_env /tmp/nemoclaw-proxy-env.sh");
      expect(script).toContain('. "$_NEMOCLAW_RECOVERY_SOURCE_ENV"');
    });

    it("warns and restores guards when the gateway env file is missing", () => {
      const script = buildRecoveryScript(minimalAgent, 19000);
      expect(script).toContain("/tmp/nemoclaw-proxy-env.sh missing");
      expect(script).toContain("restoring library guards from packaged preloads");
      expect(script).toContain("#2478");
      expect(script).not.toContain("gateway launching without library guards");
    });

    it("does not silence sourcing errors with 2>/dev/null", () => {
      const script = buildRecoveryScript(minimalAgent, 19000);
      expect(script).not.toContain(". ~/.bashrc 2>/dev/null");
      expect(script).not.toContain(". /tmp/nemoclaw-proxy-env.sh 2>/dev/null");
    });

    it("checks NODE_OPTIONS for the safety-net and ciao preloads after sourcing", () => {
      const script = buildRecoveryScript(minimalAgent, 19000);
      expect(script).toContain("nemoclaw-sandbox-safety-net");
      expect(script).toContain("nemoclaw-ciao-network-guard");
      expect(script).toContain("NODE_OPTIONS missing safety-net preload");
      expect(script).toContain("or ciao preload");
    });

    it("stops stale launcher and gateway processes before relaunch", () => {
      const script = buildRecoveryScript(minimalAgent, 19000);
      expect(script).toContain(
        "_GATEWAY_PROC_PATTERN='[t]est-agent[[:space:]]+gateway[[:space:]]+run([[:space:]]|$)'",
      );
      expect(script).toContain('pkill -TERM -f "$_GATEWAY_PROC_PATTERN"');
      expect(script).toContain('pkill -KILL -f "$_GATEWAY_PROC_PATTERN"');
      expect(script).toContain("GATEWAY_STALE_PROCESSES");
    });

    it("fails recovery when trusted guard restoration cannot install required guards", () => {
      const script = buildRecoveryScript(minimalAgent, 19000);
      expect(script).toContain("_NEMOCLAW_CRITICAL_GUARDS_READY");
      expect(script).toContain("refusing unguarded gateway relaunch");
      expect(script).toContain('echo "$_E" >> "$_GATEWAY_LOG"; exit 1');
    });

    it("writes the warning to gateway.log so it persists for sysadmin tail", () => {
      const script = buildRecoveryScript(minimalAgent, 19000);
      // Both warnings must end up in the selected gateway log, not just stderr —
      // executeSandboxCommand silently discards stderr from the recovery
      // script, so a warning that only goes to stderr is invisible to
      // anyone debugging a crash-loop. (#2478)
      expect(script).toContain('_nemoclaw_recovery_log "$_W"');
      expect(script).toContain('echo "$_msg" >> "$_GATEWAY_LOG"');
      // And the warning must be deferred until AFTER gateway.log is
      // safely opened with O_NOFOLLOW, otherwise the redirect targets a
      // stale or attacker-controlled file.
      const gatewayPrepIdx = script!.indexOf(" /tmp/gateway.log || exit 1;");
      const logSelectionIdx = script!.indexOf("_GATEWAY_LOG=/tmp/gateway.log");
      const warnIdx = script!.indexOf("_W=");
      expect(gatewayPrepIdx).toBeGreaterThanOrEqual(0);
      expect(logSelectionIdx).toBeGreaterThanOrEqual(0);
      expect(warnIdx).toBeGreaterThanOrEqual(0);
      expect(gatewayPrepIdx).toBeLessThan(logSelectionIdx);
      expect(logSelectionIdx).toBeLessThan(warnIdx);
    });

    it("appends (not truncates) gateway.log on launch so warnings survive", () => {
      const script = buildRecoveryScript(minimalAgent, 19000);
      // Truncating with `>` wipes the [gateway-recovery] WARNING that the
      // recovery script wrote moments earlier — meaning a sysadmin tailing
      // gateway.log would see the eventual crash without the explanation.
      expect(script).toContain('>> "$_GATEWAY_LOG" 2>&1 &');
      expect(script).not.toMatch(/[^>]> \/tmp\/gateway\.log 2>&1 &/);
    });

    it("does not force non-OpenClaw agents to run as the gateway user", () => {
      const script = buildRecoveryScript(minimalAgent, 19000);
      expect(script).not.toContain("chown gateway:gateway /tmp/gateway.log");
      expect(script).not.toContain("chown 'gateway:gateway' /tmp/gateway.log");
      expect(script).not.toContain("gosu gateway");
      expect(script).not.toContain("gosu 'gateway'");
    });
  });
});
