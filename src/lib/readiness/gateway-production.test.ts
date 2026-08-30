// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import type { AddressInfo } from "node:net";
import net from "node:net";
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
  subprocess.spawnSync.mockReset();
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
  describeGatewayPortOwners,
  gatewayPortConflictDetail,
  gatewayProcessIdentityMatchesTrustedBinary,
  gatewayProcessSamplesMatchTrustedBinary,
  parseDarwinLsofExecutable,
} from "./gateway-production";

function commandResult(stdout = "", status = 1, stderr = "") {
  return { status, stdout, stderr, signal: null, pid: 1, output: [] };
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
  ] as const)(
    "rejects the owned gateway tag with %s (#8755)",
    (_case, identity, executable, platform) => {
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
    },
  );

  it("accepts target-bound macOS argv only with matching executable vnode identity (#10369)", () => {
    const trusted = "/opt/homebrew/opt/openshell/bin/openshell-gateway";
    const targetBound = "openshell-gateway[nemoclaw=nemoclaw-18080;port=18080]";

    expect(
      gatewayProcessIdentityMatchesTrustedBinary(
        targetBound,
        trusted,
        "nemoclaw-18080",
        18080,
        trusted,
        "darwin",
      ),
    ).toBe(true);
    expect(
      gatewayProcessIdentityMatchesTrustedBinary(
        targetBound,
        trusted,
        "nemoclaw-18080",
        18080,
        "/tmp/foreign-gateway",
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
  ] as const)(
    "maps portAvailable=%s, listeners=%o, reuse=%s to %s",
    (portAvailable, listeners, reuseState, expected) => {
      expect(classifyManagedGatewayPortConflict(portAvailable, listeners, reuseState)).toBe(
        expected,
      );
    },
  );

  it.each([
    ["Gateway endpoint: https://127.0.0.1:8080", 8080, "match"],
    ["Gateway endpoint: http://localhost:8080", 8080, "match"],
    ["Server: https://127.0.0.1:8080", 8080, "match"],
    ["Server: https://127.0.0.1:9090", 8080, "mismatch"],
    ["Server: https://gateway.example:8080", 8080, "mismatch"],
    ["Server: ftp://127.0.0.1:8080", 8080, "mismatch"],
    ["Server: not-a-url", 8080, "mismatch"],
    ["Gateway endpoint:", 8080, "mismatch"],
    ["Server: https://127.0.0.1:8080 trailing-data", 8080, "mismatch"],
    ["DNS Server: https://127.0.0.1:8080", 8080, "unknown"],
  ] as const)(
    "classifies managed endpoint output %s for port %s as %s",
    (output, port, expected) => {
      expect(classifyManagedGatewayEndpointBinding([output], port)).toBe(expected);
    },
  );

  it("rejects conflicting managed endpoint output across OpenShell probes", () => {
    expect(
      classifyManagedGatewayEndpointBinding(
        ["Gateway endpoint: https://127.0.0.1:8080", "Server: https://127.0.0.1:9090"],
        8080,
      ),
    ).toBe("mismatch");
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
  ] as const)(
    "maps portAvailable=%s, reuse=%s, version=%s to %s",
    (portAvailable, reuseState, compatibility, expected) => {
      expect(classifyManagedGatewayVersionDrift(portAvailable, reuseState, compatibility)).toBe(
        expected,
      );
    },
  );

  it("preserves scoped stale gateway state from OpenShell connection errors", async () => {
    const statusConnectionRefused = [
      "Error:   × client error (Connect)",
      "  ├─▶ tcp connect error",
      "  ╰─▶ Connection refused (os error 111)",
    ].join("\n");
    const infoConnectionRefused = [
      "Error:   × transport error",
      "  ╰─▶ Connection refused (os error 111)",
    ].join("\n");
    const resultByInvocation = new Map([
      [
        ["sh", "-c", 'command -v "$1"', "--", "openshell"].join("\0"),
        commandResult("/usr/local/bin/openshell\n", 0),
      ],
      [
        ["/usr/local/bin/openshell", "status", "-g", "nemoclaw-readiness-test"].join("\0"),
        commandResult("", 1, statusConnectionRefused),
      ],
      [
        ["/usr/local/bin/openshell", "gateway", "info", "-g", "nemoclaw-readiness-test"].join("\0"),
        commandResult("", 1, infoConnectionRefused),
      ],
      [
        ["/usr/local/bin/openshell", "gateway", "info"].join("\0"),
        commandResult("", 1, infoConnectionRefused),
      ],
    ]);
    subprocess.spawnSync.mockImplementation((command: string, args: readonly string[] = []) => {
      return resultByInvocation.get([command, ...args].join("\0")) ?? commandResult();
    });

    const gatewayPort = 0;
    const deps = createProductionGatewayReadinessDependencies({
      gatewayName: () => "nemoclaw-readiness-test",
      gatewayPort: () => gatewayPort,
    });

    await expect(deps.observeManagedGateway(managedOwner(gatewayPort))).resolves.toMatchObject({
      reuseState: "stale",
      driftState: "not-detected",
      portConflictState: "none",
    });
    expect(subprocess.spawnSync).toHaveBeenCalledWith(
      "/usr/local/bin/openshell",
      ["status", "-g", "nemoclaw-readiness-test"],
      expect.objectContaining({
        env: expect.objectContaining({ OPENSHELL_GATEWAY: "nemoclaw-readiness-test" }),
      }),
    );
    expect(subprocess.spawnSync).toHaveBeenCalledWith(
      "/usr/local/bin/openshell",
      ["gateway", "info", "-g", "nemoclaw-readiness-test"],
      expect.any(Object),
    );
    expect(subprocess.spawnSync).toHaveBeenCalledWith(
      "/usr/local/bin/openshell",
      ["gateway", "info"],
      expect.any(Object),
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

    expect(
      subprocess.spawnSync.mock.calls.every(([, , options]) => {
        const env = options?.env as NodeJS.ProcessEnv | undefined;
        return (
          env !== undefined &&
          env.GITHUB_TOKEN === undefined &&
          env.OPENSHELL_GATEWAY_AUTH_TOKEN === undefined &&
          env.OPENSHELL_GATEWAY === "nemoclaw-readiness-test"
        );
      }),
    ).toBe(true);
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

  it("names the foreign listener and requires a fresh check before stopping it (#9118)", async () => {
    const foreignListener = net.createServer();
    await new Promise<void>((resolve, reject) => {
      foreignListener.once("error", reject);
      foreignListener.listen(0, "127.0.0.1", resolve);
    });
    const gatewayPort = (foreignListener.address() as AddressInfo).port;
    subprocess.spawnSync.mockImplementation((command: string, args: readonly string[] = []) => {
      const resolvesListener = command === "lsof" && args.includes("-ti");
      const resolvesName = command === "ps" && args.includes("comm=");
      return resolvesListener
        ? commandResult(`${process.pid}\n`, 0)
        : resolvesName
          ? commandResult("python3\n", 0)
          : commandResult();
    });

    try {
      const deps = createProductionGatewayReadinessDependencies({
        gatewayName: () => "nemoclaw-readiness-test",
        gatewayPort: () => gatewayPort,
      });

      const observed = await deps.observeManagedGateway(managedOwner(gatewayPort));

      expect(observed.portConflictState).not.toBe("none");
      expect(observed.portConflictDetail).toContain(`python3 (PID ${process.pid})`);
      expect(observed.portConflictDetail).toContain(
        `sudo lsof -i :${gatewayPort} -sTCP:LISTEN -P -n`,
      );
      expect(observed.portConflictDetail).toContain("matching PID from that fresh result");
      expect(observed.portConflictDetail).not.toContain(`sudo kill ${process.pid}`);
      expect(observed.portConflictDetail).not.toContain("occupied by unknown");
    } finally {
      await new Promise<void>((resolve) => foreignListener.close(() => resolve()));
    }
  });

  it("offers an inspection command when no listener could be resolved (#9118)", () => {
    const detail = gatewayPortConflictDetail(
      8080,
      { ok: false, process: "unknown", pid: null, reason: "port 8080 is in use (EADDRINUSE)" },
      "occupied",
      { stopPids: [], text: null },
    );

    expect(detail).toContain("is occupied by an unknown listener");
    expect(detail).toContain("sudo lsof -i :8080 -sTCP:LISTEN -P -n");
  });

  it("lists every listener and requires a fresh check before stopping an unverified listener (#9118)", () => {
    const processNames = new Map([
      [100, "openshell-gateway"],
      [200, "python3"],
    ]);
    const owners = describeGatewayPortOwners(
      { pids: [100], unverifiedPids: [200] },
      (pid) => processNames.get(pid) ?? null,
    );
    const detail = gatewayPortConflictDetail(
      8080,
      { ok: false, process: "unknown", pid: null, reason: "port 8080 is in use (EADDRINUSE)" },
      "multiple-owners",
      owners,
    );

    expect(detail).toContain("openshell-gateway (PID 100), python3 (PID 200)");
    expect(detail).toContain("Confirm PID 200 is not another NemoClaw gateway");
    expect(detail).toContain("sudo lsof -i :8080 -sTCP:LISTEN -P -n");
    expect(detail).toContain("signal only the matching PID from that fresh result");
    expect(detail).not.toContain("sudo kill 200");
    expect(detail).not.toContain("sudo kill 100");
  });

  it("requires fresh proof for every unverified listener before stopping multiple processes (#9118)", () => {
    const processNames = new Map([
      [200, "python3"],
      [300, "node"],
    ]);
    const owners = describeGatewayPortOwners(
      { pids: [], unverifiedPids: [200, 300] },
      (pid) => processNames.get(pid) ?? null,
    );
    const detail = gatewayPortConflictDetail(
      8080,
      { ok: false, process: "unknown", pid: null, reason: "port 8080 is in use (EADDRINUSE)" },
      "multiple-owners",
      owners,
    );

    expect(detail).toContain("python3 (PID 200), node (PID 300)");
    expect(detail).toContain("Confirm PIDs 200, 300 are not another NemoClaw gateway");
    expect(detail).toContain("sudo lsof -i :8080 -sTCP:LISTEN -P -n");
    expect(detail).toContain("signal only the matching PIDs from that fresh result");
    expect(detail).not.toContain("sudo kill");
  });

  it("recommends releasing a verified gateway environment without a process stop command (#9118)", () => {
    const owners = describeGatewayPortOwners(
      { pids: [100], unverifiedPids: [] },
      () => "openshell-gateway",
    );
    const detail = gatewayPortConflictDetail(
      8080,
      { ok: false, process: "unknown", pid: null, reason: "port 8080 is in use (EADDRINUSE)" },
      "owner-mismatch",
      owners,
    );

    expect(detail).toContain("openshell-gateway (PID 100)");
    expect(detail).toContain("NEMOCLAW_GATEWAY_PORT=8080 nemoclaw uninstall");
    expect(detail).not.toContain("sudo kill");
  });

  it("uses the invoked CLI name in verified gateway release guidance (#9118)", () => {
    vi.stubEnv("NEMOCLAW_INVOKED_AS", "nemohermes");
    const owners = describeGatewayPortOwners(
      { pids: [100], unverifiedPids: [] },
      () => "openshell-gateway",
    );

    const detail = gatewayPortConflictDetail(
      8080,
      { ok: false, process: "unknown", pid: null, reason: "port 8080 is in use (EADDRINUSE)" },
      "owner-mismatch",
      owners,
    );

    expect(detail).toContain("NEMOCLAW_GATEWAY_PORT=8080 nemohermes uninstall");
    expect(detail).not.toContain("nemoclaw uninstall");
  });
});
