// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
// Import from compiled dist/ so coverage is attributed correctly.
import { buildOpenClawRecoveryScript, buildRecoveryScript } from "../../dist/lib/agent-runtime";
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
      dir: "/tmp/agent",
      configFile: "/tmp/agent/config.yaml",
      envFile: null,
      format: "yaml",
    },
    stateDirs: [],
    stateFiles: [],
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

function extractGatewayProcessPattern(script: string | null): string {
  const match = script?.match(/_GATEWAY_PROC_PATTERN='([^']+)'/);
  expect(match).toBeTruthy();
  return match?.[1] ?? "";
}

function toJsRegex(pattern: string): RegExp {
  return new RegExp(pattern.replaceAll("[[:space:]]", "\\s"));
}

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

    it("sources proxy-env.sh BEFORE launching the gateway binary", () => {
      const script = buildRecoveryScript(minimalAgent, 19000);
      expect(script).not.toBeNull();
      const staleStopIdx = script!.indexOf('pkill -TERM -f "$_GATEWAY_PROC_PATTERN"');
      const sourceIdx = script!.indexOf("then . /tmp/nemoclaw-proxy-env.sh");
      const launchIdx = script!.indexOf("nohup");
      expect(staleStopIdx).toBeGreaterThanOrEqual(0);
      expect(sourceIdx).toBeGreaterThanOrEqual(0);
      expect(launchIdx).toBeGreaterThanOrEqual(0);
      expect(staleStopIdx).toBeLessThan(sourceIdx);
      expect(sourceIdx).toBeLessThan(launchIdx);
    });

    it("fails recovery when an existing proxy-env.sh does not install required guards", () => {
      const script = buildRecoveryScript(minimalAgent, 19000);
      expect(script).toContain('if [ "$_PE_MISSING" = "0" ]');
      expect(script).toContain("refusing unguarded gateway relaunch");
      expect(script).toContain('echo "$_E" >> "$_GATEWAY_LOG"; exit 1');
    });

    it("writes the warning to gateway.log so it persists for sysadmin tail", () => {
      const script = buildRecoveryScript(minimalAgent, 19000);
      // Both warnings must end up in the selected gateway log, not just stderr —
      // executeSandboxCommand silently discards stderr from the recovery
      // script, so a warning that only goes to stderr is invisible to
      // anyone debugging a crash-loop. (#2478)
      expect(script).toContain('echo "$_W" >> "$_GATEWAY_LOG"');
      // And the warning must be deferred until AFTER gateway.log is
      // safely opened with O_NOFOLLOW, otherwise the redirect targets a
      // stale or attacker-controlled file.
      const gatewayPrepIdx = script!.indexOf(" /tmp/gateway.log || exit 1;");
      const logSelectionIdx = script!.indexOf("_GATEWAY_LOG=/tmp/gateway.log");
      const warnIdx = script!.indexOf('echo "$_W" >> "$_GATEWAY_LOG"');
      expect(gatewayPrepIdx).toBeGreaterThanOrEqual(0);
      expect(logSelectionIdx).toBeGreaterThanOrEqual(0);
      expect(warnIdx).toBeGreaterThanOrEqual(0);
      expect(gatewayPrepIdx).toBeLessThan(logSelectionIdx);
      expect(logSelectionIdx).toBeLessThan(warnIdx);
    });

    it("stops recovery when hardened log setup fails", () => {
      const script = buildOpenClawRecoveryScript(18789);
      expect(script).toContain(" /tmp/gateway.log 'gateway' || exit 1;");
      expect(script).toContain(" /tmp/auto-pair.log 'sandbox' || exit 1;");
    });

    it("appends (not truncates) gateway.log on launch so warnings survive", () => {
      const script = buildRecoveryScript(minimalAgent, 19000);
      // Truncating with `>` wipes the [gateway-recovery] WARNING that the
      // recovery script wrote moments earlier — meaning a sysadmin tailing
      // gateway.log would see the eventual crash without the explanation.
      expect(script).toContain('>> "$_GATEWAY_LOG" 2>&1 &');
      expect(script).not.toMatch(/[^>]> \/tmp\/gateway\.log 2>&1 &/);
    });

    it("preserves an existing gateway.log and has a writable fallback log", () => {
      const script = buildOpenClawRecoveryScript(18789);
      expect(script).not.toContain("rm -f /tmp/gateway.log");
      expect(script).toContain("_GATEWAY_LOG=/tmp/gateway.log");
      expect(script).toContain("_GATEWAY_LOG=/tmp/gateway-recovery.log");
      expect(script).toContain('echo "$_W" >> "$_GATEWAY_LOG"');
      expect(script).toContain('tail -5 "$_GATEWAY_LOG"');
      expect(script).not.toContain('echo "$_W" >> /tmp/gateway.log');
      expect(script).not.toContain("cat /tmp/gateway.log");
    });

    it("rejects a symlinked gateway.log before preparing the log", () => {
      const script = buildOpenClawRecoveryScript(18789);
      const noFollowIdx = script.indexOf("O_NOFOLLOW");
      const openIdx = script.indexOf("os.open(path, flags, 0o644)");
      const fchownIdx = script.indexOf("os.fchown(fd");
      expect(script).toContain("refusing to prepare symlinked /tmp/gateway.log");
      expect(script).toContain("sys.exit(1)");
      expect(script).not.toContain(": > /tmp/gateway.log");
      expect(script).not.toContain("chown 'gateway:gateway' /tmp/gateway.log");
      expect(noFollowIdx).toBeGreaterThanOrEqual(0);
      expect(openIdx).toBeGreaterThanOrEqual(0);
      expect(fchownIdx).toBeGreaterThanOrEqual(0);
      expect(noFollowIdx).toBeLessThan(openIdx);
      expect(openIdx).toBeLessThan(fchownIdx);
    });

    it("prepares gateway.log for the real gateway-owned sandbox log", () => {
      const script = buildOpenClawRecoveryScript(18789);
      expect(script).toContain("os.fchown(fd");
      expect(script).toContain("pw.pw_gid");
      expect(script).not.toContain("grp.getgrnam");
      expect(script).toContain("owner_mode = 0o644");
      expect(script).toContain("os.fchmod(fd, owner_mode)");
      expect(script).toContain("/tmp/gateway.log 'gateway'");
      expect(script).toContain("gosu 'gateway'");
    });

    it("terminates the conditional launch branch before capturing the gateway pid", () => {
      const script = buildOpenClawRecoveryScript(18789);
      expect(script).toContain(" fi; GPID=$!");
      expect(script).not.toContain(" fi GPID=$!");
    });

    it("prepares auto-pair.log without unlinking or following symlinks", () => {
      const script = buildOpenClawRecoveryScript(18789);
      expect(script).toContain("refusing to prepare symlinked /tmp/auto-pair.log");
      expect(script).toContain("/tmp/auto-pair.log 'sandbox'");
      expect(script).toContain("owner_mode = 0o600");
      expect(script).not.toContain("rm -f /tmp/auto-pair.log");
      expect(script).not.toContain(": > /tmp/auto-pair.log");
      expect(script).not.toContain("touch /tmp/auto-pair.log");
      expect(script).not.toContain("chown sandbox:sandbox /tmp/auto-pair.log");
      expect(script).not.toContain("chmod 600 /tmp/auto-pair.log");
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
