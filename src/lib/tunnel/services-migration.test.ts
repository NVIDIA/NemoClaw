// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isMcpLifecycleLockHeld } from "../state/mcp-lifecycle-lock-acquisition";
import type { CloudflaredState } from "./services";
import {
  getServiceStatuses,
  migrateLegacyCloudflaredState,
  resolveTunnelPidDir,
  showStatus,
  stopAll,
  type ProcessControl,
} from "./services";

describe("legacy tunnel state migration (#11628)", () => {
  const gatewayPort = 18_080;
  let home: string;
  let legacyRoot: string;
  let targetPidDir: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-migration-home-"));
    legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-migration-legacy-"));
    vi.stubEnv("HOME", home);
    targetPidDir = resolveTunnelPidDir({ gatewayPort });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(home, { force: true, recursive: true });
    fs.rmSync(legacyRoot, { force: true, recursive: true });
  });

  function createLegacyState(name: string, pid: number): string {
    const pidDir = path.join(legacyRoot, `nemoclaw-services-${name}`);
    fs.mkdirSync(pidDir);
    fs.writeFileSync(path.join(pidDir, "cloudflared.pid"), String(pid), { mode: 0o600 });
    return pidDir;
  }

  function writeRegistry(gatewayPort: number, sandboxName: string): void {
    const root = path.join(home, ".nemoclaw", "gateways", String(gatewayPort));
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      path.join(root, "sandboxes.json"),
      JSON.stringify({
        defaultSandbox: null,
        defaultSelectionRevision: 1,
        sandboxes: {
          [sandboxName]: { name: sandboxName, gatewayPort },
        },
      }),
    );
  }

  function liveCloudflaredProcess(pid: number): ProcessControl {
    return {
      isAlive: (candidate) => candidate === pid,
      commandLine: () => "cloudflared tunnel --url http://localhost:18789",
      signalCloudflared: () => "signaled",
    };
  }

  it("adopts one live legacy record when process identity cannot be inspected", () => {
    const legacyPidDir = createLegacyState("legacy", 4242);
    vi.spyOn(console, "log").mockImplementation(() => {});

    expect(
      migrateLegacyCloudflaredState(
        { gatewayPort },
        {
          legacyPidDirs: () => [legacyPidDir],
          registeredSandboxNames: () => ["legacy"],
          readState: (pidDir): CloudflaredState =>
            pidDir === legacyPidDir
              ? { kind: "unverified-pid-process", pid: 4242, reason: "inspection-unavailable" }
              : { kind: "stopped" },
        },
      ),
    ).toBe(true);

    expect(fs.readFileSync(path.join(targetPidDir, "cloudflared.pid"), "utf8")).toBe("4242");
    expect(fs.existsSync(path.join(legacyPidDir, "cloudflared.pid"))).toBe(false);
  });

  it("holds the gateway tunnel lifecycle lock throughout migration", () => {
    const legacyPidDir = createLegacyState("legacy", 4242);
    const lockName = `cloudflared-${createHash("sha256").update(path.resolve(targetPidDir)).digest("hex")}`;
    const lockObservations: boolean[] = [];
    vi.spyOn(console, "log").mockImplementation(() => {});

    expect(
      migrateLegacyCloudflaredState(
        { gatewayPort },
        {
          legacyPidDirs: () => [legacyPidDir],
          registeredSandboxNames: () => ["legacy"],
          readState: (pidDir): CloudflaredState => {
            lockObservations.push(isMcpLifecycleLockHeld(lockName));
            return pidDir === legacyPidDir
              ? { kind: "unverified-pid-process", pid: 4242, reason: "inspection-unavailable" }
              : { kind: "stopped" };
          },
        },
      ),
    ).toBe(true);

    expect(lockObservations.length).toBeGreaterThan(0);
    expect(lockObservations.every(Boolean)).toBe(true);
  });

  it("preserves both records when host identity is unverified and legacy is verified", () => {
    const legacyPidDir = createLegacyState("legacy", 4343);
    fs.mkdirSync(targetPidDir, { recursive: true });
    fs.writeFileSync(path.join(targetPidDir, "cloudflared.pid"), "4242", { mode: 0o600 });

    expect(() =>
      migrateLegacyCloudflaredState(
        { gatewayPort },
        {
          legacyPidDirs: () => [legacyPidDir],
          registeredSandboxNames: () => ["legacy"],
          readState: (pidDir): CloudflaredState =>
            pidDir === targetPidDir
              ? { kind: "unverified-pid-process", pid: 4242, reason: "inspection-unavailable" }
              : { kind: "running", pid: 4343 },
        },
      ),
    ).toThrow("Multiple live cloudflared PID records exist");

    expect(fs.readFileSync(path.join(targetPidDir, "cloudflared.pid"), "utf8")).toBe("4242");
    expect(fs.readFileSync(path.join(legacyPidDir, "cloudflared.pid"), "utf8")).toBe("4343");
  });

  it("fails closed when two gateway roots register the legacy sandbox name", () => {
    const legacyPidDir = createLegacyState("legacy", 4242);
    writeRegistry(gatewayPort, "legacy");
    writeRegistry(gatewayPort + 1, "legacy");

    expect(() =>
      migrateLegacyCloudflaredState(
        { gatewayPort },
        {
          legacyPidDirs: () => [legacyPidDir],
          readState: (pidDir): CloudflaredState =>
            pidDir === legacyPidDir
              ? { kind: "unverified-pid-process", pid: 4242, reason: "inspection-unavailable" }
              : { kind: "stopped" },
        },
      ),
    ).toThrow('sandbox "legacy" appears in multiple gateway registries');

    expect(fs.existsSync(path.join(targetPidDir, "cloudflared.pid"))).toBe(false);
    expect(fs.readFileSync(path.join(legacyPidDir, "cloudflared.pid"), "utf8")).toBe("4242");
  });

  it("resolves tunnel state from the sandbox owning gateway", () => {
    writeRegistry(gatewayPort, "legacy");

    expect(resolveTunnelPidDir({ sandboxName: "legacy" })).toBe(targetPidDir);
  });

  it("migrates tunnel state through the sandbox owning gateway", () => {
    const legacyPidDir = createLegacyState("legacy", 4242);
    writeRegistry(gatewayPort, "legacy");
    vi.spyOn(console, "log").mockImplementation(() => {});

    expect(
      migrateLegacyCloudflaredState(
        { sandboxName: "legacy" },
        {
          legacyPidDirs: () => [legacyPidDir],
          readState: (pidDir): CloudflaredState =>
            pidDir === legacyPidDir
              ? { kind: "unverified-pid-process", pid: 4242, reason: "inspection-unavailable" }
              : { kind: "stopped" },
        },
      ),
    ).toBe(true);

    expect(fs.readFileSync(path.join(targetPidDir, "cloudflared.pid"), "utf8")).toBe("4242");
    expect(fs.existsSync(path.join(legacyPidDir, "cloudflared.pid"))).toBe(false);
  });

  it("uses the environment-selected sandbox gateway for stop migration", () => {
    const sandboxName = `legacy-stop-${String(process.pid)}`;
    const legacyPidDir = createLegacyState(sandboxName, 4242);
    writeRegistry(gatewayPort, sandboxName);
    vi.stubEnv("NEMOCLAW_SANDBOX_NAME", sandboxName);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    let alive = true;
    const signalCloudflared = vi.fn(() => {
      alive = false;
      return "signaled" as const;
    });
    const processControl: ProcessControl = {
      isAlive: (pid) => pid === 4242 && alive,
      commandLine: () => "cloudflared tunnel --url http://localhost:18789",
      signalCloudflared,
    };

    stopAll(
      {
        processControl,
        cleanupOllamaModels: false,
        unmanagedCloudflaredPids: () => [],
      },
      {
        legacyPidDirs: () => [legacyPidDir],
        readState: (pidDir): CloudflaredState =>
          pidDir === legacyPidDir ? { kind: "running", pid: 4242 } : { kind: "stopped" },
      },
    );

    expect(signalCloudflared).toHaveBeenCalledWith(4242, "SIGTERM");
    expect(fs.existsSync(path.join(legacyPidDir, "cloudflared.pid"))).toBe(false);
    expect(fs.existsSync(path.join(targetPidDir, "cloudflared.pid"))).toBe(false);
  });

  it("migrates legacy state before tunnel status without contaminating stdout", () => {
    const legacyPidDir = createLegacyState("legacy", 4242);
    writeRegistry(gatewayPort, "legacy");
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

    showStatus(
      {
        sandboxName: "legacy",
        processControl: liveCloudflaredProcess(4242),
        unmanagedCloudflaredPids: () => [],
      },
      {
        legacyPidDirs: () => [legacyPidDir],
        readState: (pidDir): CloudflaredState =>
          pidDir === legacyPidDir ? { kind: "running", pid: 4242 } : { kind: "stopped" },
      },
    );

    expect(stdout.mock.calls.flat().join("\n")).toContain("PID 4242");
    expect(stdout.mock.calls.flat().join("\n")).not.toContain("Adopted legacy");
    expect(stderr.mock.calls.flat().join("\n")).toContain("Adopted legacy");
    expect(fs.readFileSync(path.join(targetPidDir, "cloudflared.pid"), "utf8")).toBe("4242");
    expect(fs.existsSync(path.join(legacyPidDir, "cloudflared.pid"))).toBe(false);
  });

  it("migrates legacy state before programmatic root status", () => {
    const legacyPidDir = createLegacyState("legacy", 4242);
    writeRegistry(gatewayPort, "legacy");
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

    const statuses = getServiceStatuses(
      {
        sandboxName: "legacy",
        processControl: liveCloudflaredProcess(4242),
        unmanagedCloudflaredPids: () => [],
      },
      {
        legacyPidDirs: () => [legacyPidDir],
        readState: (pidDir): CloudflaredState =>
          pidDir === legacyPidDir ? { kind: "running", pid: 4242 } : { kind: "stopped" },
      },
    );

    expect(statuses).toEqual([{ name: "cloudflared", running: true, pid: 4242 }]);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(targetPidDir, "cloudflared.pid"), "utf8")).toBe("4242");
    expect(fs.existsSync(path.join(legacyPidDir, "cloudflared.pid"))).toBe(false);
  });

  it("prefers the explicit gateway environment over sandbox ownership", () => {
    writeRegistry(gatewayPort + 1, "legacy");
    vi.stubEnv("NEMOCLAW_GATEWAY_PORT", String(gatewayPort));

    expect(resolveTunnelPidDir({ sandboxName: "legacy" })).toBe(targetPidDir);
  });

  it("fails closed when tunnel state lookup finds the sandbox in multiple gateway roots", () => {
    writeRegistry(gatewayPort, "legacy");
    writeRegistry(gatewayPort + 1, "legacy");

    expect(() => resolveTunnelPidDir({ sandboxName: "legacy" })).toThrow(
      'sandbox "legacy" appears in multiple gateway registries',
    );
  });

  it("adopts the selected destroy recovery record after its registry row is absent", () => {
    const legacyPidDir = createLegacyState("legacy", 4242);
    vi.spyOn(console, "log").mockImplementation(() => {});

    expect(
      migrateLegacyCloudflaredState(
        { gatewayPort },
        {
          legacyPidDirs: () => [legacyPidDir],
          recoverySandboxName: "legacy",
          readState: (pidDir): CloudflaredState =>
            pidDir === legacyPidDir
              ? { kind: "unverified-pid-process", pid: 4242, reason: "inspection-unavailable" }
              : { kind: "stopped" },
        },
      ),
    ).toBe(true);

    expect(fs.readFileSync(path.join(targetPidDir, "cloudflared.pid"), "utf8")).toBe("4242");
    expect(fs.existsSync(path.join(legacyPidDir, "cloudflared.pid"))).toBe(false);
  });

  it("preserves the recovery record when another gateway owns its sandbox name", () => {
    const legacyPidDir = createLegacyState("legacy", 4242);
    writeRegistry(gatewayPort + 1, "legacy");

    expect(() =>
      migrateLegacyCloudflaredState(
        { gatewayPort },
        {
          legacyPidDirs: () => [legacyPidDir],
          recoverySandboxName: "legacy",
          readState: (pidDir): CloudflaredState =>
            pidDir === legacyPidDir
              ? { kind: "unverified-pid-process", pid: 4242, reason: "inspection-unavailable" }
              : { kind: "stopped" },
        },
      ),
    ).toThrow("belongs to gateway port 18081");

    expect(fs.existsSync(path.join(targetPidDir, "cloudflared.pid"))).toBe(false);
    expect(fs.readFileSync(path.join(legacyPidDir, "cloudflared.pid"), "utf8")).toBe("4242");
  });
});
