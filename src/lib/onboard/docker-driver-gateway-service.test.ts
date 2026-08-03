// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createVirtualClock } from "./__test-helpers__/virtual-clock";
import {
  getNemoclawOpenShellGatewayUserServicePath,
  getOpenShellGatewayManagedServiceLogCommand,
  getOpenShellGatewayUserServiceBinaryPaths,
  getOpenShellGatewayUserServicePaths,
  getOpenShellUserConfigHome,
  getTrustedActiveOpenShellGatewayUserServicePid,
  hasOpenShellGatewayUserService,
  NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER,
  OpenShellGatewayServiceTrustError,
  type SpawnSyncLikeResult,
  startOpenShellGatewayUserService,
  startPackageManagedDockerDriverGateway,
  stopOpenShellGatewayUserService,
} from "./docker-driver-gateway-service";

const STATUS_CONNECTED = `
Server Status

Gateway: nemoclaw
Server: https://127.0.0.1:8080/
Connected
`;

const GATEWAY_INFO = `
Gateway Info

Gateway: nemoclaw
Gateway endpoint: https://127.0.0.1:8080/
`;

function spawnResult(status = 0, stderr = "", stdout = ""): SpawnSyncLikeResult {
  return { status, stderr, stdout };
}

function trustedShowOutput(
  fragmentPath = "/lib/systemd/user/openshell-gateway.service",
  execPath = "/usr/bin/openshell-gateway",
): string {
  return [
    `FragmentPath=${fragmentPath}`,
    `ExecStart={ path=${execPath} ; argv[]=${execPath} ; }`,
  ].join("\n");
}

function officialFormulaInfo(): SpawnSyncLikeResult {
  return spawnResult(
    0,
    "",
    JSON.stringify({ formulae: [{ name: "openshell", tap: "nvidia/openshell" }] }),
  );
}

function officialRunningServiceInfo(
  overrides: Partial<{
    loaded: boolean;
    name: string;
    pid: number;
    running: boolean;
    service_name: string;
  }> = {},
): SpawnSyncLikeResult {
  return spawnResult(
    0,
    "",
    JSON.stringify([
      {
        loaded: true,
        name: "openshell",
        pid: 4242,
        running: true,
        service_name: "homebrew.mxcl.openshell",
        ...overrides,
      },
    ]),
  );
}

function nonSymlinkStat(): never {
  return { isSymbolicLink: () => false } as never;
}

function systemdSpawn(
  events: string[],
  fragmentPath = "/lib/systemd/user/openshell-gateway.service",
  execPath = "/usr/bin/openshell-gateway",
) {
  return vi.fn((_command: string, args: string[]) => {
    events.push(args.slice(1).join(" "));
    return args.includes("show")
      ? spawnResult(0, "", trustedShowOutput(fragmentPath, execPath))
      : spawnResult();
  });
}

describe("docker-driver-gateway-service", () => {
  it("selects trusted Linux and macOS service authorities (#6903)", () => {
    const linuxExists = (candidate: string) =>
      candidate === "/usr/lib/systemd/user/openshell-gateway.service";
    const brew = vi.fn((_command: string, args: string[]) =>
      args[0] === "info" ? officialFormulaInfo() : spawnResult(),
    );

    expect(hasOpenShellGatewayUserService({ existsSync: linuxExists, platform: "linux" })).toBe(
      true,
    );
    expect(
      hasOpenShellGatewayUserService({
        commandExists: (command) => command === "brew",
        platform: "darwin",
        spawnSyncImpl: brew,
      }),
    ).toBe(true);
    expect(hasOpenShellGatewayUserService({ commandExists: () => false, platform: "darwin" })).toBe(
      false,
    );
    expect(getOpenShellGatewayUserServicePaths()).toEqual([
      "/usr/local/lib/systemd/user/openshell-gateway.service",
      "/usr/lib/systemd/user/openshell-gateway.service",
      "/lib/systemd/user/openshell-gateway.service",
    ]);
    expect(getOpenShellGatewayUserServiceBinaryPaths()).toEqual([
      "/usr/local/bin/openshell-gateway",
      "/usr/bin/openshell-gateway",
    ]);
  });

  it("rejects a Homebrew formula outside the official tap (#6903)", () => {
    expect(() =>
      hasOpenShellGatewayUserService({
        commandExists: () => true,
        platform: "darwin",
        spawnSyncImpl: vi.fn((_command: string, args: string[]) =>
          args[0] === "info"
            ? spawnResult(
                0,
                "",
                JSON.stringify({ formulae: [{ name: "openshell", tap: "other/tap" }] }),
              )
            : spawnResult(),
        ),
      }),
    ).toThrow("must come from nvidia/openshell");
  });

  it("reports no managed service when the Homebrew formula is missing (#8104)", () => {
    expect(
      hasOpenShellGatewayUserService({
        commandExists: () => true,
        platform: "darwin",
        spawnSyncImpl: () => spawnResult(1, "formula not installed"),
      }),
    ).toBe(false);
  });

  it("uses the effective XDG config home and accepts only a marked regular unit (#6903)", () => {
    const home = "/home/nvidia";
    const env = { HOME: home, XDG_CONFIG_HOME: "/tmp/nemoclaw-config" };
    const servicePath = "/tmp/nemoclaw-config/systemd/user/nemoclaw-openshell-gateway.service";

    expect(getOpenShellUserConfigHome(home, env)).toBe("/tmp/nemoclaw-config");
    expect(getNemoclawOpenShellGatewayUserServicePath(home, env)).toBe(servicePath);
    expect(
      hasOpenShellGatewayUserService({
        env,
        existsSync: (candidate) => candidate === servicePath,
        home,
        lstatSync: nonSymlinkStat,
        platform: "linux",
        readFileSync: () => `# ${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER}\n`,
      }),
    ).toBe(true);

    for (const unsafe of [
      { lstatSync: nonSymlinkStat, readFileSync: () => "# foreign\n", error: "foreign" },
      {
        lstatSync: () => ({ isSymbolicLink: () => true }) as never,
        readFileSync: () => `# ${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER}\n`,
        error: "symlinked",
      },
    ]) {
      expect(() =>
        hasOpenShellGatewayUserService({
          env,
          existsSync: (candidate) => candidate === servicePath,
          home,
          platform: "linux",
          ...unsafe,
        }),
      ).toThrow(unsafe.error);
    }
  });

  it("validates, cuts over, and starts the NemoClaw systemd unit (#6903)", () => {
    const events: string[] = [];
    const home = "/home/nvidia";
    const servicePath = `${home}/.config/systemd/user/nemoclaw-openshell-gateway.service`;
    const gatewayBin = `${home}/.local/bin/openshell-gateway`;
    const result = startOpenShellGatewayUserService({
      commandExists: (command) => command === "systemctl",
      env: { HOME: home },
      existsSync: (candidate) => candidate === servicePath,
      home,
      lstatSync: nonSymlinkStat,
      platform: "linux",
      preparePortForServiceStart: () => events.push("prepare-port"),
      prepareServiceEnv: () => events.push("prepare-env"),
      readFileSync: () => `# ${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER}\n`,
      spawnSyncImpl: systemdSpawn(events, servicePath, gatewayBin),
      validatePortOwnerForServiceStart: () => events.push("validate-port"),
    });

    expect(result).toMatchObject({
      logCommand: "journalctl --user --unit nemoclaw-openshell-gateway --no-pager --lines=200",
      manager: "systemd",
      serviceName: "nemoclaw-openshell-gateway",
      started: true,
    });
    expect(events).toEqual([
      "daemon-reload",
      "show nemoclaw-openshell-gateway --property=FragmentPath --property=ExecStart",
      "validate-port",
      "prepare-env",
      "stop nemoclaw-openshell-gateway",
      "prepare-port",
      "enable nemoclaw-openshell-gateway",
      "restart nemoclaw-openshell-gateway",
      "is-active --quiet nemoclaw-openshell-gateway",
    ]);
  });

  it("trusts a NemoClaw systemd unit using an absolute XDG bin home (#6903)", () => {
    const home = "/home/nvidia";
    const xdgBinHome = "/opt/nvidia/user-bin";
    const servicePath = `${home}/.config/systemd/user/nemoclaw-openshell-gateway.service`;
    const gatewayBin = `${xdgBinHome}/openshell-gateway`;

    const result = startOpenShellGatewayUserService({
      commandExists: (command) => command === "systemctl",
      env: { HOME: home, XDG_BIN_HOME: xdgBinHome },
      existsSync: (candidate) => candidate === servicePath,
      home,
      lstatSync: nonSymlinkStat,
      platform: "linux",
      readFileSync: () => `# ${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER}\n`,
      spawnSyncImpl: systemdSpawn([], servicePath, gatewayBin),
    });

    expect(result).toMatchObject({
      manager: "systemd",
      serviceName: "nemoclaw-openshell-gateway",
      started: true,
    });
  });

  it("identifies the active trusted NemoClaw systemd gateway process (#6903)", () => {
    const home = "/home/nvidia";
    const servicePath = `${home}/.config/systemd/user/nemoclaw-openshell-gateway.service`;
    const gatewayBin = `${home}/.local/bin/openshell-gateway`;
    const spawnSyncImpl = vi.fn(() =>
      spawnResult(
        0,
        "",
        [trustedShowOutput(servicePath, gatewayBin), "ActiveState=active", "MainPID=4242"].join(
          "\n",
        ),
      ),
    );

    expect(
      getTrustedActiveOpenShellGatewayUserServicePid({
        commandExists: (command) => command === "systemctl",
        env: { HOME: home },
        existsSync: (candidate) => candidate === servicePath,
        home,
        lstatSync: nonSymlinkStat,
        platform: "linux",
        readFileSync: () => `# ${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER}\n`,
        spawnSyncImpl,
      }),
    ).toBe(4242);
    expect(spawnSyncImpl).toHaveBeenCalledWith(
      "systemctl",
      [
        "--user",
        "show",
        "nemoclaw-openshell-gateway",
        "--property=FragmentPath",
        "--property=ExecStart",
        "--property=ActiveState",
        "--property=MainPID",
      ],
      expect.any(Object),
    );
  });

  it("does not trust an inactive or foreign systemd gateway process (#6903)", () => {
    const existsSync = (candidate: string) =>
      candidate === "/lib/systemd/user/openshell-gateway.service";
    const query = (output: string) =>
      getTrustedActiveOpenShellGatewayUserServicePid({
        commandExists: () => true,
        existsSync,
        platform: "linux",
        spawnSyncImpl: () => spawnResult(0, "", output),
      });

    expect(
      query([trustedShowOutput(), "ActiveState=inactive", "MainPID=4242"].join("\n")),
    ).toBeNull();
    expect(
      query(
        [
          trustedShowOutput("/lib/systemd/user/openshell-gateway.service", "/tmp/gateway"),
          "ActiveState=active",
          "MainPID=4242",
        ].join("\n"),
      ),
    ).toBeNull();
  });

  it("identifies the active official Homebrew gateway process (#6903)", () => {
    const spawnSyncImpl = vi.fn((_command: string, args: string[]) => {
      if (args[0] === "info") return officialFormulaInfo();
      if (args[0] === "services") return officialRunningServiceInfo();
      return spawnResult();
    });

    expect(
      getTrustedActiveOpenShellGatewayUserServicePid({
        commandExists: (command) => command === "brew",
        platform: "darwin",
        spawnSyncImpl,
      }),
    ).toBe(4242);
    expect(spawnSyncImpl).toHaveBeenCalledWith(
      "brew",
      ["services", "info", "openshell", "--json"],
      expect.any(Object),
    );
  });

  it.each([
    ["inactive", officialRunningServiceInfo({ running: false })],
    ["foreign", officialRunningServiceInfo({ service_name: "other.openshell" })],
    ["malformed", spawnResult(0, "", "not-json")],
  ])("does not trust a %s Homebrew gateway process (#6903)", (_case, serviceInfo) => {
    expect(
      getTrustedActiveOpenShellGatewayUserServicePid({
        commandExists: () => true,
        platform: "darwin",
        spawnSyncImpl: vi.fn((_command: string, args: string[]) =>
          args[0] === "info" ? officialFormulaInfo() : serviceInfo,
        ),
      }),
    ).toBeNull();
  });

  it("removes a marked NemoClaw unit before activating an upstream systemd unit (#6903)", () => {
    const events: string[] = [];
    const removed: string[] = [];
    const servicePath = "/home/nvidia/.config/systemd/user/nemoclaw-openshell-gateway.service";
    const result = startOpenShellGatewayUserService({
      commandExists: () => true,
      env: { HOME: "/home/nvidia" },
      existsSync: (candidate) =>
        candidate === servicePath || candidate === "/lib/systemd/user/openshell-gateway.service",
      home: "/home/nvidia",
      lstatSync: nonSymlinkStat,
      platform: "linux",
      readFileSync: () => `# ${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER}\n`,
      rmSync: ((candidate: string) => removed.push(candidate)) as never,
      spawnSyncImpl: systemdSpawn(events),
    });

    expect(result.started).toBe(true);
    expect(events).toContain("disable --now nemoclaw-openshell-gateway");
    expect(removed).toEqual([servicePath]);
  });

  it("does not change service state when port ownership validation fails (#6903)", () => {
    const events: string[] = [];
    const result = startOpenShellGatewayUserService({
      commandExists: () => true,
      env: {},
      existsSync: (candidate) => candidate === "/lib/systemd/user/openshell-gateway.service",
      platform: "linux",
      spawnSyncImpl: systemdSpawn(events),
      validatePortOwnerForServiceStart: () => {
        throw new Error("unknown listener");
      },
    });

    expect(result).toMatchObject({
      logCommand: "journalctl --user --unit openshell-gateway --no-pager --lines=200",
      started: false,
    });
    expect(result.reason).toContain("unknown listener");
    expect(events.some((event) => /^(stop|enable|restart)/.test(event))).toBe(false);
  });

  it("restarts the official macOS Homebrew service after validation (#6903)", () => {
    const events: string[] = [];
    const result = startOpenShellGatewayUserService({
      commandExists: (command) => command === "brew",
      env: {},
      platform: "darwin",
      preparePortForServiceStart: () => events.push("prepare-port"),
      prepareServiceEnv: () => events.push("prepare-env"),
      spawnSyncImpl: vi.fn((_command: string, args: string[]) => {
        events.push(args.join(" "));
        return args[0] === "info" ? officialFormulaInfo() : spawnResult();
      }),
      validatePortOwnerForServiceStart: () => events.push("validate-port"),
    });

    expect(result).toMatchObject({
      logCommand:
        'tail -n 200 "$(brew --prefix)/var/log/openshell/openshell-gateway.out.log" "$(brew --prefix)/var/log/openshell/openshell-gateway.err.log"',
      manager: "homebrew",
      serviceName: "openshell",
      started: true,
    });
    expect(events).toEqual([
      "list --formula openshell",
      "info --json=v2 openshell",
      "validate-port",
      "prepare-env",
      "services stop openshell",
      "prepare-port",
      "services restart openshell",
    ]);
  });

  it.each([
    ["the manager is unavailable", "daemon-reload", "Failed to connect to bus", false],
    ["the executable is foreign", "show", "", true],
    ["the service is inactive", "is-active", "inactive", false],
  ])("reports the selected systemd log command when %s (#8104)", (_case, failedCommand, detail, standaloneFallbackBlocked) => {
    const result = startOpenShellGatewayUserService({
      commandExists: () => true,
      env: {},
      existsSync: (candidate) => candidate === "/lib/systemd/user/openshell-gateway.service",
      platform: "linux",
      spawnSyncImpl: vi.fn((_command: string, args: string[]) => {
        if (args.includes(failedCommand)) {
          if (failedCommand === "show") {
            return spawnResult(
              0,
              "",
              trustedShowOutput(
                "/lib/systemd/user/openshell-gateway.service",
                "/tmp/openshell-gateway",
              ),
            );
          }
          return spawnResult(1, detail);
        }
        return args.includes("show") ? spawnResult(0, "", trustedShowOutput()) : spawnResult();
      }),
    });

    expect(result).toMatchObject({
      logCommand: "journalctl --user --unit openshell-gateway --no-pager --lines=200",
      standaloneFallbackBlocked,
      started: false,
    });
  });

  it("selects the managed service log command without service validation (#8104)", () => {
    expect(getOpenShellGatewayManagedServiceLogCommand({ platform: "darwin" })).toContain(
      "openshell-gateway.err.log",
    );
    expect(
      getOpenShellGatewayManagedServiceLogCommand({
        existsSync: (candidate) => candidate === "/lib/systemd/user/openshell-gateway.service",
        platform: "linux",
      }),
    ).toBe("journalctl --user --unit openshell-gateway --no-pager --lines=200");
  });

  it("uses managed service only after metadata and direct gRPC health are ready (#6903)", async () => {
    const events: string[] = [];
    const clock = createVirtualClock();
    let registerCount = 0;

    await expect(
      startPackageManagedDockerDriverGateway({
        clearDockerDriverGatewayRuntimeFiles: () => events.push("clear"),
        exitOnFailure: false,
        gatewayName: "nemoclaw",
        hasOpenShellGatewayUserService: () => true,
        healthPollCount: 3,
        healthPollInterval: 1,
        isDockerDriverGatewayReady: async () => {
          events.push("ready");
          return true;
        },
        now: clock.now,
        registerDockerDriverGatewayEndpoint: () => {
          events.push("register");
          registerCount += 1;
          return registerCount >= 2;
        },
        runCaptureOpenshell: (args) => (args[0] === "status" ? STATUS_CONNECTED : GATEWAY_INFO),
        skipSandboxBridgeReachability: false,
        sleepSeconds: (seconds) => {
          events.push("sleep");
          clock.advance(seconds);
        },
        startOpenShellGatewayUserService: () => ({
          attempted: true,
          started: true,
          statusCommand: "systemctl --user status nemoclaw-openshell-gateway",
        }),
        verifySandboxBridgeGatewayReachableOrExit: async () => {
          events.push("verify");
        },
      }),
    ).resolves.toBe(true);

    expect(events).toEqual(["register", "sleep", "register", "ready", "clear", "verify"]);
  });

  it.each([
    [
      "systemd",
      "journalctl --user --unit nemoclaw-openshell-gateway --no-pager --lines=200",
      "systemd" as const,
      "nemoclaw-openshell-gateway",
    ],
    [
      "Homebrew",
      'tail -n 200 "$(brew --prefix)/var/log/openshell/openshell-gateway.out.log" "$(brew --prefix)/var/log/openshell/openshell-gateway.err.log"',
      "homebrew" as const,
      "openshell",
    ],
  ])("prints the %s log command before standalone fallback (#8104)", async (_case, logCommand, manager, serviceName) => {
    const register = vi.fn(() => true);
    const stopService = vi.fn(() => ({
      attempted: true,
      standaloneFallbackAllowed: false,
      stopped: true,
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      startPackageManagedDockerDriverGateway({
        clearDockerDriverGatewayRuntimeFiles: vi.fn(),
        exitOnFailure: false,
        gatewayName: "nemoclaw",
        hasOpenShellGatewayUserService: () => true,
        registerDockerDriverGatewayEndpoint: register,
        runCaptureOpenshell: vi.fn(),
        skipSandboxBridgeReachability: false,
        startOpenShellGatewayUserService: () => ({
          attempted: true,
          logCommand,
          manager,
          reason: "managed service failed",
          serviceName,
          started: false,
        }),
        stopOpenShellGatewayUserService: stopService,
        verifySandboxBridgeGatewayReachableOrExit: vi.fn(),
      }),
    ).resolves.toBe(false);
    expect(register).not.toHaveBeenCalled();
    expect(stopService).toHaveBeenCalledOnce();
    expect(warn.mock.calls.flat().join("\n")).toContain(`Logs: ${logCommand}`);
  });

  it("stops an unhealthy managed service before standalone fallback (#8104)", async () => {
    const clear = vi.fn();
    const clock = createVirtualClock();
    const stopService = vi.fn(() => ({
      attempted: true,
      standaloneFallbackAllowed: false,
      stopped: true,
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(
      startPackageManagedDockerDriverGateway({
        clearDockerDriverGatewayRuntimeFiles: clear,
        exitOnFailure: false,
        gatewayName: "nemoclaw",
        hasOpenShellGatewayUserService: () => true,
        healthPollCount: 1,
        healthPollInterval: 1,
        isDockerDriverGatewayReady: async () => false,
        now: clock.now,
        registerDockerDriverGatewayEndpoint: () => true,
        runCaptureOpenshell: (args) => (args[0] === "status" ? STATUS_CONNECTED : GATEWAY_INFO),
        skipSandboxBridgeReachability: false,
        sleepSeconds: clock.advance,
        startOpenShellGatewayUserService: () => ({
          attempted: true,
          logCommand: "journalctl --user --unit nemoclaw-openshell-gateway --no-pager --lines=200",
          started: true,
          statusCommand: "systemctl --user status nemoclaw-openshell-gateway",
        }),
        stopOpenShellGatewayUserService: stopService,
        verifySandboxBridgeGatewayReachableOrExit: vi.fn(),
      }),
    ).resolves.toBe(false);
    expect(clear).not.toHaveBeenCalled();
    expect(stopService).toHaveBeenCalledOnce();
    expect(warn.mock.calls.flat().join("\n")).toContain(
      "journalctl --user --unit nemoclaw-openshell-gateway --no-pager --lines=200",
    );
  });

  it("continues to standalone fallback when managed service cleanup fails (#8104)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      startPackageManagedDockerDriverGateway({
        clearDockerDriverGatewayRuntimeFiles: vi.fn(),
        exitOnFailure: false,
        gatewayName: "nemoclaw",
        hasOpenShellGatewayUserService: () => true,
        registerDockerDriverGatewayEndpoint: vi.fn(),
        runCaptureOpenshell: vi.fn(),
        skipSandboxBridgeReachability: false,
        startOpenShellGatewayUserService: () => ({
          attempted: true,
          reason: "restart failed",
          started: false,
        }),
        stopOpenShellGatewayUserService: () => {
          throw new Error("service manager unavailable");
        },
        verifySandboxBridgeGatewayReachableOrExit: vi.fn(),
      }),
    ).resolves.toBe(false);
    expect(warn.mock.calls.flat().join("\n")).toContain(
      "standalone startup will verify gateway port ownership",
    );
  });

  it("blocks standalone fallback after unsafe managed service preparation (#8104)", async () => {
    const stopService = vi.fn();

    await expect(
      startPackageManagedDockerDriverGateway({
        clearDockerDriverGatewayRuntimeFiles: vi.fn(),
        exitOnFailure: false,
        gatewayName: "nemoclaw",
        hasOpenShellGatewayUserService: () => true,
        registerDockerDriverGatewayEndpoint: vi.fn(),
        runCaptureOpenshell: vi.fn(),
        skipSandboxBridgeReachability: false,
        startOpenShellGatewayUserService: () => ({
          attempted: true,
          reason: "unsafe service environment",
          standaloneFallbackBlocked: true,
          started: false,
        }),
        stopOpenShellGatewayUserService: stopService,
        verifySandboxBridgeGatewayReachableOrExit: vi.fn(),
      }),
    ).rejects.toThrow("unsafe service environment");
    expect(stopService).not.toHaveBeenCalled();
  });

  it("uses standalone fallback when managed service inspection fails (#8104)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stopService = vi.fn(() => ({
      attempted: true,
      standaloneFallbackAllowed: false,
      stopped: true,
    }));

    await expect(
      startPackageManagedDockerDriverGateway({
        clearDockerDriverGatewayRuntimeFiles: vi.fn(),
        exitOnFailure: true,
        gatewayName: "nemoclaw",
        hasOpenShellGatewayUserService: () => {
          throw new Error("inspect failed");
        },
        managedServiceLogCommand:
          'tail -n 200 "$(brew --prefix)/var/log/openshell/openshell-gateway.out.log" "$(brew --prefix)/var/log/openshell/openshell-gateway.err.log"',
        registerDockerDriverGatewayEndpoint: vi.fn(),
        runCaptureOpenshell: vi.fn(),
        skipSandboxBridgeReachability: false,
        startOpenShellGatewayUserService: vi.fn(),
        stopOpenShellGatewayUserService: stopService,
        verifySandboxBridgeGatewayReachableOrExit: vi.fn(),
      }),
    ).resolves.toBe(false);
    expect(stopService).toHaveBeenCalledOnce();
    expect(warn.mock.calls.flat().join("\n")).toContain("openshell-gateway.err.log");
  });

  it("uses standalone fallback when Homebrew has no OpenShell formula (#8104)", async () => {
    const startService = vi.fn();

    await expect(
      startPackageManagedDockerDriverGateway({
        clearDockerDriverGatewayRuntimeFiles: vi.fn(),
        exitOnFailure: true,
        gatewayName: "nemoclaw",
        hasOpenShellGatewayUserService: () =>
          hasOpenShellGatewayUserService({
            commandExists: () => true,
            platform: "darwin",
            spawnSyncImpl: () => spawnResult(1, "formula not installed"),
          }),
        managedServiceLogCommand: getOpenShellGatewayManagedServiceLogCommand({
          platform: "darwin",
        }),
        registerDockerDriverGatewayEndpoint: vi.fn(),
        runCaptureOpenshell: vi.fn(),
        skipSandboxBridgeReachability: false,
        startOpenShellGatewayUserService: startService,
        stopOpenShellGatewayUserService: vi.fn(),
        verifySandboxBridgeGatewayReachableOrExit: vi.fn(),
      }),
    ).resolves.toBe(false);
    expect(startService).not.toHaveBeenCalled();
  });

  it("blocks standalone fallback when managed service inspection fails trust validation (#8104)", async () => {
    const startService = vi.fn();

    await expect(
      startPackageManagedDockerDriverGateway({
        clearDockerDriverGatewayRuntimeFiles: vi.fn(),
        exitOnFailure: false,
        gatewayName: "nemoclaw",
        hasOpenShellGatewayUserService: () => {
          throw new OpenShellGatewayServiceTrustError("foreign managed service");
        },
        managedServiceLogCommand:
          "journalctl --user --unit nemoclaw-openshell-gateway --no-pager --lines=200",
        registerDockerDriverGatewayEndpoint: vi.fn(),
        runCaptureOpenshell: vi.fn(),
        skipSandboxBridgeReachability: false,
        startOpenShellGatewayUserService: startService,
        stopOpenShellGatewayUserService: vi.fn(),
        verifySandboxBridgeGatewayReachableOrExit: vi.fn(),
      }),
    ).rejects.toThrow("foreign managed service");
    expect(startService).not.toHaveBeenCalled();
  });

  it("blocks standalone fallback when managed service cleanup fails trust validation (#8104)", async () => {
    await expect(
      startPackageManagedDockerDriverGateway({
        clearDockerDriverGatewayRuntimeFiles: vi.fn(),
        exitOnFailure: false,
        gatewayName: "nemoclaw",
        hasOpenShellGatewayUserService: () => true,
        registerDockerDriverGatewayEndpoint: vi.fn(),
        runCaptureOpenshell: vi.fn(),
        skipSandboxBridgeReachability: false,
        startOpenShellGatewayUserService: () => ({
          attempted: true,
          reason: "restart failed",
          started: false,
        }),
        stopOpenShellGatewayUserService: () => ({
          attempted: true,
          reason: "foreign managed service",
          standaloneFallbackAllowed: false,
          standaloneFallbackBlocked: true,
          stopped: false,
        }),
        verifySandboxBridgeGatewayReachableOrExit: vi.fn(),
      }),
    ).rejects.toThrow("foreign managed service");
  });

  it("exits when unhealthy managed service cleanup fails trust validation (#8104)", async () => {
    const clock = createVirtualClock();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit(1)");
    }) as typeof process.exit);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      startPackageManagedDockerDriverGateway({
        clearDockerDriverGatewayRuntimeFiles: vi.fn(),
        exitOnFailure: true,
        gatewayName: "nemoclaw",
        hasOpenShellGatewayUserService: () => true,
        healthPollCount: 1,
        healthPollInterval: 1,
        isDockerDriverGatewayReady: async () => false,
        now: clock.now,
        registerDockerDriverGatewayEndpoint: () => true,
        runCaptureOpenshell: (args) => (args[0] === "status" ? STATUS_CONNECTED : GATEWAY_INFO),
        skipSandboxBridgeReachability: false,
        sleepSeconds: clock.advance,
        startOpenShellGatewayUserService: () => ({ attempted: true, started: true }),
        stopOpenShellGatewayUserService: () => ({
          attempted: true,
          reason: "foreign managed service",
          standaloneFallbackAllowed: false,
          standaloneFallbackBlocked: true,
          stopped: false,
        }),
        verifySandboxBridgeGatewayReachableOrExit: vi.fn(),
      }),
    ).rejects.toThrow("process.exit(1)");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("uses standalone fallback when managed service startup fails unexpectedly (#8104)", async () => {
    const stopService = vi.fn(() => ({
      attempted: true,
      standaloneFallbackAllowed: false,
      stopped: true,
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      startPackageManagedDockerDriverGateway({
        clearDockerDriverGatewayRuntimeFiles: vi.fn(),
        exitOnFailure: true,
        gatewayName: "nemoclaw",
        hasOpenShellGatewayUserService: () => true,
        managedServiceLogCommand:
          "journalctl --user --unit nemoclaw-openshell-gateway --no-pager --lines=200",
        registerDockerDriverGatewayEndpoint: vi.fn(),
        runCaptureOpenshell: vi.fn(),
        skipSandboxBridgeReachability: false,
        startOpenShellGatewayUserService: () => {
          throw new Error("systemctl invocation failed");
        },
        stopOpenShellGatewayUserService: stopService,
        verifySandboxBridgeGatewayReachableOrExit: vi.fn(),
      }),
    ).resolves.toBe(false);
    expect(stopService).toHaveBeenCalledOnce();
    expect(warn.mock.calls.flat().join("\n")).toContain("journalctl --user --unit");
  });

  it("stops the trusted systemd gateway unit without disabling it (#7904)", () => {
    const events: string[] = [];
    const home = "/home/nvidia";
    const servicePath = `${home}/.config/systemd/user/nemoclaw-openshell-gateway.service`;
    const gatewayBin = `${home}/.local/bin/openshell-gateway`;

    const result = stopOpenShellGatewayUserService({
      commandExists: (command) => command === "systemctl",
      env: { HOME: home },
      existsSync: (candidate) => candidate === servicePath,
      home,
      lstatSync: nonSymlinkStat,
      platform: "linux",
      readFileSync: () => `# ${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER}\n`,
      spawnSyncImpl: systemdSpawn(events, servicePath, gatewayBin),
    });

    expect(result).toEqual({
      attempted: true,
      standaloneFallbackAllowed: false,
      manager: "systemd",
      serviceName: "nemoclaw-openshell-gateway",
      statusCommand: "systemctl --user status nemoclaw-openshell-gateway",
      stopped: true,
    });
    expect(events).toEqual([
      "show nemoclaw-openshell-gateway --property=FragmentPath --property=ExecStart",
      "stop nemoclaw-openshell-gateway",
    ]);
  });

  it("refuses to stop a systemd unit that no longer has the trusted identity (#7904)", () => {
    const events: string[] = [];
    const home = "/home/nvidia";
    const servicePath = `${home}/.config/systemd/user/nemoclaw-openshell-gateway.service`;

    const result = stopOpenShellGatewayUserService({
      commandExists: (command) => command === "systemctl",
      env: { HOME: home },
      existsSync: (candidate) => candidate === servicePath,
      home,
      lstatSync: nonSymlinkStat,
      platform: "linux",
      readFileSync: () => `# ${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER}\n`,
      spawnSyncImpl: systemdSpawn(
        events,
        `${home}/.config/systemd/user/unrelated.service`,
        "/usr/bin/unrelated",
      ),
    });

    expect(result).toMatchObject({
      attempted: true,
      standaloneFallbackBlocked: true,
      stopped: false,
    });
    expect(result.reason).toContain("service identity is not a trusted OpenShell gateway");
    expect(events).toEqual([
      "show nemoclaw-openshell-gateway --property=FragmentPath --property=ExecStart",
    ]);
  });

  it("stops the official Homebrew gateway service on macOS (#7904)", () => {
    const events: string[] = [];
    const brew = vi.fn((_command: string, args: string[]) => {
      events.push(args.join(" "));
      return args[0] === "info" ? officialFormulaInfo() : spawnResult();
    });

    const result = stopOpenShellGatewayUserService({
      commandExists: (command) => command === "brew",
      platform: "darwin",
      spawnSyncImpl: brew,
    });

    expect(result).toEqual({
      attempted: true,
      standaloneFallbackAllowed: false,
      manager: "homebrew",
      serviceName: "openshell",
      statusCommand: "brew services info openshell",
      stopped: true,
    });
    expect(events.at(-1)).toBe("services stop openshell");
  });

  it("reports the failing stop command when the gateway service survives (#7904)", () => {
    const home = "/home/nvidia";
    const servicePath = `${home}/.config/systemd/user/nemoclaw-openshell-gateway.service`;
    const gatewayBin = `${home}/.local/bin/openshell-gateway`;

    const result = stopOpenShellGatewayUserService({
      commandExists: (command) => command === "systemctl",
      env: { HOME: home },
      existsSync: (candidate) => candidate === servicePath,
      home,
      lstatSync: nonSymlinkStat,
      platform: "linux",
      readFileSync: () => `# ${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER}\n`,
      spawnSyncImpl: vi.fn((_command: string, args: string[]) =>
        args.includes("show")
          ? spawnResult(0, "", trustedShowOutput(servicePath, gatewayBin))
          : spawnResult(1, "Job for nemoclaw-openshell-gateway.service failed"),
      ),
    });

    expect(result).toMatchObject({
      attempted: true,
      stopped: false,
      statusCommand: "systemctl --user status nemoclaw-openshell-gateway",
    });
    expect(result.reason).toContain(
      "systemctl --user stop nemoclaw-openshell-gateway failed: Job for",
    );
  });

  it.each([
    [
      "no service is installed",
      { existsSync: () => false, platform: "linux" as const },
      "service not installed",
    ],
    ["the platform has no service manager", { platform: "win32" as const }, "unsupported platform"],
  ])("reports nothing to stop when %s (#7904)", (_case, opts, reason) => {
    expect(stopOpenShellGatewayUserService({ commandExists: () => true, ...opts })).toEqual({
      attempted: false,
      standaloneFallbackAllowed: false,
      reason,
      stopped: false,
    });
  });

  it("reports standalone fallback eligibility when the systemd user manager is unavailable", () => {
    const home = "/home/nvidia";
    const servicePath = `${home}/.config/systemd/user/nemoclaw-openshell-gateway.service`;

    const result = stopOpenShellGatewayUserService({
      commandExists: (command) => command === "systemctl",
      env: { HOME: home },
      existsSync: (candidate) => candidate === servicePath,
      home,
      lstatSync: nonSymlinkStat,
      platform: "linux",
      readFileSync: () => `# ${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER}\n`,
      spawnSyncImpl: vi.fn(() => spawnResult(1, "Failed to connect to bus: No medium found")),
    });

    expect(result).toMatchObject({
      attempted: true,
      standaloneFallbackAllowed: true,
      stopped: false,
    });
  });

  it("refuses standalone fallback when the systemd service can activate automatically", () => {
    const home = "/home/nvidia";
    const servicePath = `${home}/.config/systemd/user/nemoclaw-openshell-gateway.service`;
    const activationPath = `${home}/.config/systemd/user/default.target.wants/nemoclaw-openshell-gateway.service`;

    const result = stopOpenShellGatewayUserService({
      commandExists: (command) => command === "systemctl",
      env: { HOME: home },
      existsSync: (candidate) => candidate === servicePath || candidate === activationPath,
      home,
      lstatSync: nonSymlinkStat,
      platform: "linux",
      readFileSync: () => `# ${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER}\n`,
      spawnSyncImpl: vi.fn(() => spawnResult(1, "Failed to connect to bus: No medium found")),
    });

    expect(result).toMatchObject({
      attempted: true,
      standaloneFallbackAllowed: false,
      stopped: false,
    });
  });
});
