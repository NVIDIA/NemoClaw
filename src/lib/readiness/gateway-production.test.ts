// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { isDockerDriverGatewayProcessIdentity } from "../onboard/docker-driver-gateway-process-identity";
import type { GatewayOwner } from "../onboard/gateway-ownership";
import { resetTraceForTests, TRACE_FILE_ENV } from "../trace";

const subprocess = vi.hoisted(() => ({
  spawnSync: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: subprocess.spawnSync,
}));

afterEach(() => {
  resetTraceForTests();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

import {
  buildGatewayReadinessProbeEnv,
  classifyManagedGatewayEndpointBinding,
  classifyManagedGatewayPortConflict,
  classifyManagedGatewayVersionDrift,
  classifyManagedGatewayVersionSource,
  createProductionGatewayReadinessDependencies,
  gatewayProcessIdentityMatchesTrustedBinary,
  gatewayProcessSamplesMatchTrustedBinary,
  parseDarwinLsofExecutable,
} from "./gateway-production";

function commandResult(stdout = "", status = 1) {
  return { status, stdout, stderr: "", signal: null, pid: 1, output: [] };
}

function managedOwner(gatewayPort: number): GatewayOwner {
  return {
    gatewayName: "nemoclaw-readiness-test",
    gatewayPort,
    mode: "nemoclaw-managed",
    source: "standalone",
    endpoint: null,
    stateDir: null,
    supervisor: null,
    requiredCapabilities: [],
  };
}

function externalOwner(gatewayPort: number): GatewayOwner {
  return {
    gatewayName: "nemoclaw-readiness-test",
    gatewayPort,
    mode: "externally-supervised",
    source: "declared",
    endpoint: `http://127.0.0.1:${gatewayPort}`,
    stateDir: "/var/lib/openshell/gateway",
    supervisor: {
      kind: "systemd-system",
      serviceName: "openshell-gateway.service",
      execPath: "/opt/platform/gatewayd",
    },
    requiredCapabilities: ["gateway.health"],
  };
}

describe("managed gateway port readiness (#7411)", () => {
  it("omits ambient credentials from every read-only gateway probe environment", () => {
    const env = buildGatewayReadinessProbeEnv(
      {
        HOME: "/home/test",
        PATH: "/usr/bin",
        DOCKER_HOST: "unix:///run/user/1000/docker.sock",
        XDG_RUNTIME_DIR: "/run/user/1000",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
        GITHUB_TOKEN: "github-secret",
        NVIDIA_INFERENCE_API_KEY: "nvidia-secret",
        OPENSHELL_GATEWAY: "ambient-wrong-gateway",
        OPENSHELL_GATEWAY_AUTH_TOKEN: "gateway-secret",
        OPENSHELL_OIDC_CLIENT_SECRET: "oidc-secret",
        OPENSHELL_SANDBOX_TOKEN: "sandbox-secret",
        OPENSHELL_TOKEN: "openshell-secret",
        LC_CLIENT_SECRET: "locale-prefix-secret",
        XDG_API_TOKEN: "xdg-prefix-secret",
      },
      {
        gatewayName: "nemoclaw-readiness-test",
        localTlsDir: "/var/lib/nemoclaw/gateway/tls",
      },
    );

    expect(env).toEqual({
      HOME: "/home/test",
      PATH: "/usr/bin",
      DOCKER_HOST: "unix:///run/user/1000/docker.sock",
      XDG_RUNTIME_DIR: "/run/user/1000",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      OPENSHELL_GATEWAY: "nemoclaw-readiness-test",
      OPENSHELL_LOCAL_TLS_DIR: "/var/lib/nemoclaw/gateway/tls",
    });
  });

  it("omits unsupported remote Docker endpoints from readiness children", () => {
    expect(
      buildGatewayReadinessProbeEnv({ DOCKER_HOST: "tcp://attacker.example:2375" }).DOCKER_HOST,
    ).toBeUndefined();
  });

  it("rejects a spoofed listener path without executing its binary", () => {
    subprocess.spawnSync.mockClear();
    const trusted = "/opt/openshell/bin/openshell-gateway";
    const spoofed = "/tmp/spoof/openshell-gateway --name nemoclaw-readiness-test --port 8080";

    expect(
      gatewayProcessIdentityMatchesTrustedBinary(spoofed, trusted, "nemoclaw-readiness-test", 8080),
    ).toBe(false);
    expect(subprocess.spawnSync).not.toHaveBeenCalled();
  });

  it("rejects trusted-looking argv when the Linux process executable is foreign", () => {
    subprocess.spawnSync.mockClear();
    const trusted = "/opt/openshell/bin/openshell-gateway";
    const spoofedArgv = `${trusted} --name nemoclaw-readiness-test --port 8080`;

    expect(
      gatewayProcessIdentityMatchesTrustedBinary(
        spoofedArgv,
        trusted,
        "nemoclaw-readiness-test",
        8080,
        "/tmp/foreign-gateway",
        "linux",
      ),
    ).toBe(false);
    expect(
      gatewayProcessIdentityMatchesTrustedBinary(
        spoofedArgv,
        trusted,
        "nemoclaw-readiness-test",
        8080,
        trusted,
        "linux",
      ),
    ).toBe(true);
    expect(subprocess.spawnSync).not.toHaveBeenCalled();
  });

  it("accepts the owned gateway tag with trusted Linux executable and environment evidence (#8755)", () => {
    const trusted = "/opt/openshell/bin/openshell-gateway";
    const input = {
      pid: 999_999,
      gatewayBin: trusted,
      captureProcessArgs: () => "openshell-gateway[nemoclaw=nemoclaw;port=8080]",
      processIdentityMatchesGatewayBinary: (identity: string) =>
        gatewayProcessIdentityMatchesTrustedBinary(
          identity,
          trusted,
          "nemoclaw",
          8080,
          trusted,
          "linux",
        ),
      requireDockerDriverEnv: true,
      hasDockerDriverGatewayEnv: () => false,
    };

    expect(isDockerDriverGatewayProcessIdentity(input)).toBe(false);
    expect(
      isDockerDriverGatewayProcessIdentity({
        ...input,
        hasDockerDriverGatewayEnv: () => true,
      }),
    ).toBe(true);
  });

  it.each([
    [
      "a foreign executable",
      "openshell-gateway[nemoclaw=nemoclaw;port=8080]",
      "/tmp/foreign-gateway",
      "linux",
    ],
    [
      "a different gateway target",
      "openshell-gateway[nemoclaw=nemoclaw-8081;port=8081]",
      "/opt/openshell/bin/openshell-gateway",
      "linux",
    ],
    ["no executable evidence", "openshell-gateway[nemoclaw=nemoclaw;port=8080]", null, "linux"],
    [
      "a macOS direct listener",
      "openshell-gateway[nemoclaw=nemoclaw;port=8080]",
      "/opt/openshell/bin/openshell-gateway",
      "darwin",
    ],
  ] as const)("rejects the owned gateway tag with %s (#8755)", (_case, identity, executable, platform) => {
    const trusted = "/opt/openshell/bin/openshell-gateway";

    expect(
      gatewayProcessIdentityMatchesTrustedBinary(
        identity,
        trusted,
        "nemoclaw",
        8080,
        executable,
        platform,
      ),
    ).toBe(false);
  });

  it("rejects trusted-looking argv on macOS without package-service identity", () => {
    const trusted = "/opt/homebrew/opt/openshell/bin/openshell-gateway";
    const spoofedArgv = `${trusted} --name nemoclaw-readiness-test --port 8080`;

    expect(
      gatewayProcessIdentityMatchesTrustedBinary(
        spoofedArgv,
        trusted,
        "nemoclaw-readiness-test",
        8080,
        trusted,
        "darwin",
      ),
    ).toBe(false);
  });

  it("rejects a listener when Linux process samples change (#8755)", () => {
    const trusted = "/opt/openshell/bin/openshell-gateway";

    expect(gatewayProcessSamplesMatchTrustedBinary("41", "41", trusted, trusted, trusted)).toBe(
      true,
    );
    expect(
      gatewayProcessSamplesMatchTrustedBinary("41", "41", trusted, "/tmp/foreign-gateway", trusted),
    ).toBe(false);
    expect(
      gatewayProcessSamplesMatchTrustedBinary("41", "41", "/tmp/foreign-gateway", trusted, trusted),
    ).toBe(false);
    expect(gatewayProcessSamplesMatchTrustedBinary("41", "42", trusted, trusted, trusted)).toBe(
      false,
    );
    expect(gatewayProcessSamplesMatchTrustedBinary(null, null, trusted, trusted, trusted)).toBe(
      false,
    );
  });

  it("uses the main macOS executable vnode before dyld or later mappings", () => {
    expect(
      parseDarwinLsofExecutable(
        "p4242\nftxt\nn/opt/homebrew/Cellar/openshell/1/bin/gateway\nftxt\nn/usr/lib/dyld\n",
      ),
    ).toBe("/opt/homebrew/Cellar/openshell/1/bin/gateway");
    expect(
      parseDarwinLsofExecutable(
        "p4242\nftxt\nn/tmp/foreign-gateway\nftxt\nn/opt/homebrew/Cellar/openshell/1/bin/gateway\n",
      ),
    ).toBe("/tmp/foreign-gateway");
  });

  it("does not compare a package-service listener against a different CLI sibling binary", () => {
    const listenerScan = { pids: [41], unverifiedPids: [] };

    expect(classifyManagedGatewayVersionSource(false, listenerScan, new Set())).toBeNull();
    expect(classifyManagedGatewayVersionSource(false, listenerScan, new Set([41]))).toBe(
      "host-process",
    );
  });

  it.each([
    [true, { pids: [], unverifiedPids: [], complete: true }, "missing", "none"],
    [true, { pids: [], unverifiedPids: [], complete: true }, "healthy", "unknown"],
    [true, { pids: [], unverifiedPids: [], complete: true }, "active-unnamed", "unknown"],
    [false, { pids: [41], unverifiedPids: [], complete: true }, "healthy", "none"],
    [false, { pids: [41], unverifiedPids: [], complete: true }, "stale", "none"],
    [false, { pids: [41], unverifiedPids: [], complete: true }, "active-unnamed", "none"],
    [false, { pids: [41], unverifiedPids: [], complete: true }, "missing", "none"],
    [false, { pids: [41], unverifiedPids: [], complete: true }, "foreign-active", "owner-mismatch"],
    [false, { pids: [41, 42], unverifiedPids: [], complete: true }, "healthy", "multiple-owners"],
    [false, { pids: [], unverifiedPids: [41], complete: true }, "stale", "owner-mismatch"],
    [false, { pids: [], unverifiedPids: [], complete: false }, "healthy", "unknown"],
  ] as const)("maps portAvailable=%s, listeners=%o, reuse=%s to %s", (portAvailable, listeners, reuseState, expected) => {
    expect(classifyManagedGatewayPortConflict(portAvailable, listeners, reuseState)).toBe(expected);
  });

  it.each([
    ["https://127.0.0.1:8080", 8080, "match"],
    ["http://localhost:8080", 8080, "match"],
    ["https://127.0.0.1:9090", 8080, "mismatch"],
    ["https://gateway.example:8080", 8080, "mismatch"],
  ] as const)("binds managed endpoint %s to port %s as %s", (endpoint, port, expected) => {
    expect(classifyManagedGatewayEndpointBinding([`Gateway endpoint: ${endpoint}`], port)).toBe(
      expected,
    );
  });

  it("rejects healthy managed metadata bound to another endpoint", () => {
    const listener = { pids: [41], unverifiedPids: [], complete: true };

    expect(classifyManagedGatewayPortConflict(false, listener, "healthy", false, "mismatch")).toBe(
      "owner-mismatch",
    );
    expect(classifyManagedGatewayPortConflict(false, listener, "healthy", false, "unknown")).toBe(
      "unknown",
    );
    expect(
      classifyManagedGatewayPortConflict(false, listener, "healthy", false, "mismatch", true),
    ).toBe("owner-mismatch");
  });

  it("accepts a target-bound listener when managed endpoint text is unavailable (#8755)", () => {
    const listener = { pids: [41], unverifiedPids: [], complete: true };

    expect(
      classifyManagedGatewayPortConflict(false, listener, "healthy", false, "unknown", true),
    ).toBe("none");
  });

  it("accepts one legacy Docker proxy only when the exact cluster endpoint owns the port", () => {
    const proxy = { pids: [], unverifiedPids: [41], complete: true };

    expect(classifyManagedGatewayPortConflict(false, proxy, "healthy", true)).toBe("none");
    expect(classifyManagedGatewayPortConflict(false, proxy, "healthy", false)).toBe(
      "owner-mismatch",
    );
    expect(
      classifyManagedGatewayPortConflict(
        false,
        { pids: [], unverifiedPids: [41, 42], complete: true },
        "healthy",
        true,
      ),
    ).toBe("multiple-owners");
  });

  it("rejects simultaneous legacy-cluster and host-process ownership evidence", () => {
    expect(
      classifyManagedGatewayPortConflict(
        false,
        { pids: [41], unverifiedPids: [], complete: true },
        "healthy",
        true,
      ),
    ).toBe("owner-mismatch");
  });

  it.each([
    [false, "healthy", "compatible", "not-detected"],
    [false, "healthy", "drift", "detected"],
    [false, "healthy", "unknown", "unknown"],
    [true, "healthy", null, "unknown"],
    [true, "stale", null, "not-detected"],
    [false, "missing", "compatible", "not-detected"],
    [false, "missing", "drift", "detected"],
    [false, "missing", null, "unknown"],
    [false, "foreign-active", null, "not-detected"],
  ] as const)("maps portAvailable=%s, reuse=%s, version=%s to %s", (portAvailable, reuseState, compatibility, expected) => {
    expect(classifyManagedGatewayVersionDrift(portAvailable, reuseState, compatibility)).toBe(
      expected,
    );
  });

  it("collects production port evidence without attempting sudo", async () => {
    vi.stubEnv("GITHUB_TOKEN", "github-secret");
    vi.stubEnv("OPENSHELL_GATEWAY_AUTH_TOKEN", "gateway-secret");
    subprocess.spawnSync.mockImplementation((command: string, args: readonly string[] = []) => {
      const resolvesLsof = command === "sh" && args.includes('command -v "$1"');
      return resolvesLsof ? commandResult("/usr/bin/lsof\n", 0) : commandResult();
    });

    const gatewayPort = 0;
    const deps = createProductionGatewayReadinessDependencies({
      gatewayName: () => "nemoclaw-readiness-test",
      gatewayPort: () => gatewayPort,
    });

    await deps.observeManagedGateway(managedOwner(gatewayPort));

    expect(subprocess.spawnSync.mock.calls.some(([command]) => command === "lsof")).toBe(true);
    expect(subprocess.spawnSync.mock.calls.some(([command]) => command === "sudo")).toBe(false);
    for (const [, , options] of subprocess.spawnSync.mock.calls) {
      const env = options?.env as NodeJS.ProcessEnv | undefined;
      expect(env).toBeDefined();
      expect(env?.GITHUB_TOKEN).toBeUndefined();
      expect(env?.OPENSHELL_GATEWAY_AUTH_TOKEN).toBeUndefined();
      expect(env?.OPENSHELL_GATEWAY).toBe("nemoclaw-readiness-test");
    }
  });

  it("does not write an onboard trace for a public external attachment probe (#7411)", async () => {
    const traceDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-readiness-trace-"));
    const tracePath = path.join(traceDir, "unexpected.json");
    vi.stubEnv(TRACE_FILE_ENV, tracePath);
    vi.stubEnv("NEMOCLAW_REUSE_HEALTH_POLL_COUNT", "1");
    vi.stubEnv("NEMOCLAW_REUSE_HEALTH_POLL_INTERVAL", "0");
    resetTraceForTests();
    subprocess.spawnSync.mockImplementation(() => commandResult());

    try {
      const gatewayPort = 65_534;
      const deps = createProductionGatewayReadinessDependencies({
        gatewayName: () => "nemoclaw-readiness-test",
        gatewayPort: () => gatewayPort,
      });

      await deps.probeAttachment(externalOwner(gatewayPort));
      expect(fs.existsSync(tracePath)).toBe(false);
      vi.stubEnv(TRACE_FILE_ENV, "");
    } finally {
      resetTraceForTests();
      fs.rmSync(traceDir, { force: true, recursive: true });
    }
  });
});
