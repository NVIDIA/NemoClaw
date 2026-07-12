// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as agentForwardStop from "./agent-forward-stop";
import * as gatewayStop from "./gateway-stop";
import * as sandboxGatewayStop from "./sandbox-gateway-stop";
import { stopAll } from "./services";

const SANDBOX_ENV_NAMES = ["NEMOCLAW_SANDBOX", "NEMOCLAW_SANDBOX_NAME", "SANDBOX_NAME"] as const;

function restoreSandboxEnv(saved: Record<(typeof SANDBOX_ENV_NAMES)[number], string | undefined>) {
  for (const name of SANDBOX_ENV_NAMES) {
    const value = saved[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

describe("stopAll with sandbox channels", () => {
  let pidDir: string;
  let stopSandboxChannels: ReturnType<typeof vi.spyOn>;
  let savedEnv: Record<(typeof SANDBOX_ENV_NAMES)[number], string | undefined>;

  beforeEach(() => {
    pidDir = mkdtempSync(join(tmpdir(), "nemoclaw-svc-sandbox-test-"));
    savedEnv = Object.fromEntries(
      SANDBOX_ENV_NAMES.map((name) => [name, process.env[name]]),
    ) as typeof savedEnv;
    for (const name of SANDBOX_ENV_NAMES) delete process.env[name];
    stopSandboxChannels = vi
      .spyOn(sandboxGatewayStop, "stopSandboxChannels")
      .mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(pidDir, { recursive: true, force: true });
    restoreSandboxEnv(savedEnv);
    vi.restoreAllMocks();
  });

  it("stops in-sandbox channels when sandboxName is provided", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    stopAll({ pidDir, sandboxName: "test-sb" });

    expect(stopSandboxChannels).toHaveBeenCalledWith("test-sb", {
      info: expect.any(Function),
      warn: expect.any(Function),
    });
    expect(logSpy.mock.calls.map((call) => call[0]).join("\n")).toContain("All services stopped");
  });

  it("warns when no sandbox name is available", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    stopAll({ pidDir });

    expect(stopSandboxChannels).not.toHaveBeenCalled();
    const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
    expect(output).toContain("No sandbox name available");
    expect(output).toContain("All services stopped");
  });

  it("still stops cloudflared when in-sandbox shutdown cannot stop a process", () => {
    writeFileSync(join(pidDir, "cloudflared.pid"), "999999999");

    stopAll({ pidDir, sandboxName: "test-sb" });

    expect(stopSandboxChannels).toHaveBeenCalledTimes(1);
    expect(existsSync(join(pidDir, "cloudflared.pid"))).toBe(false);
  });

  it("reads sandbox name from NEMOCLAW_SANDBOX env when not in opts", () => {
    process.env.NEMOCLAW_SANDBOX = "env-sandbox";

    stopAll({ pidDir });

    expect(stopSandboxChannels).toHaveBeenCalledWith("env-sandbox", expect.any(Object));
  });

  it("reads sandbox name from NEMOCLAW_SANDBOX_NAME when NEMOCLAW_SANDBOX is unset", () => {
    process.env.NEMOCLAW_SANDBOX_NAME = "named-sandbox";

    stopAll({ pidDir });

    expect(stopSandboxChannels).toHaveBeenCalledWith("named-sandbox", expect.any(Object));
  });

  it("prefers NEMOCLAW_SANDBOX_NAME over NEMOCLAW_SANDBOX", () => {
    process.env.NEMOCLAW_SANDBOX_NAME = "name-sandbox";
    process.env.NEMOCLAW_SANDBOX = "other-sandbox";

    stopAll({ pidDir });

    expect(stopSandboxChannels).toHaveBeenCalledWith("name-sandbox", expect.any(Object));
  });

  it("uses the effective env-selected sandbox with an explicit host pidDir", () => {
    const pidRoot = mkdtempSync(join(tmpdir(), "nemoclaw-services-pid-root-"));
    const effectivePidDir = join(pidRoot, "nemoclaw-services-name-sandbox");
    const lowerPriorityPidDir = join(pidRoot, "nemoclaw-services-other-sandbox");
    mkdirSync(effectivePidDir, { recursive: true, mode: 0o700 });
    mkdirSync(lowerPriorityPidDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(effectivePidDir, "cloudflared.pid"), "999999999");
    writeFileSync(join(lowerPriorityPidDir, "cloudflared.pid"), "999999999");
    process.env.NEMOCLAW_SANDBOX_NAME = "name-sandbox";
    process.env.NEMOCLAW_SANDBOX = "other-sandbox";

    try {
      stopAll({ pidDir: effectivePidDir });

      expect(stopSandboxChannels).toHaveBeenCalledWith("name-sandbox", expect.any(Object));
      expect(existsSync(join(effectivePidDir, "cloudflared.pid"))).toBe(false);
      expect(existsSync(join(lowerPriorityPidDir, "cloudflared.pid"))).toBe(true);
    } finally {
      rmSync(pidRoot, { recursive: true, force: true });
    }
  });

  it.each([
    "bad name",
    "../../etc/passwd",
  ])("rejects malformed env sandbox name %j before in-sandbox shutdown", (invalidName) => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    process.env.NEMOCLAW_SANDBOX_NAME = invalidName;

    stopAll({ pidDir });

    expect(stopSandboxChannels).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.map((call) => call[0]).join("\n")).toContain("Invalid sandbox name");
  });

  it("keeps host cleanup running for a malformed explicit sandbox name", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const stopAgentForwards = vi
      .spyOn(agentForwardStop, "stopAgentForwardPortsForStop")
      .mockImplementation(() => {});
    const releaseGateway = vi
      .spyOn(gatewayStop, "releaseGatewayPortForStop")
      .mockImplementation(() => {});
    writeFileSync(join(pidDir, "cloudflared.pid"), "999999999");

    expect(() =>
      stopAll({ pidDir, sandboxName: "bad name", releaseGatewayPort: true }),
    ).not.toThrow();

    expect(stopSandboxChannels).not.toHaveBeenCalled();
    expect(stopAgentForwards).not.toHaveBeenCalled();
    expect(releaseGateway).not.toHaveBeenCalled();
    expect(existsSync(join(pidDir, "cloudflared.pid"))).toBe(false);
    const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
    expect(output).toContain("Invalid sandbox name");
    expect(output).toContain("All services stopped");
  });

  it("does not stop default cloudflared for a malformed sandbox name without an explicit pidDir", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(() => stopAll({ sandboxName: "bad name" })).not.toThrow();

    expect(stopSandboxChannels).not.toHaveBeenCalled();
    const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
    expect(output).toContain("Invalid sandbox name without an explicit PID directory");
    expect(output).not.toContain("cloudflared was not running");
    expect(output).toContain("All services stopped");
  });
});
