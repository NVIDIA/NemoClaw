// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CloudflaredState } from "./services";
import { migrateLegacyCloudflaredState, resolveTunnelPidDir } from "./services";

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
