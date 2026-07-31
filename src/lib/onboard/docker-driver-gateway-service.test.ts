// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createVirtualClock } from "./__test-helpers__/virtual-clock";
import {
  getNemoclawOpenShellGatewayUserServicePath,
  getOpenShellGatewayUserServiceBinaryPaths,
  getOpenShellGatewayUserServicePaths,
  getOpenShellUserConfigHome,
  getTrustedActiveOpenShellGatewayUserServicePid,
  hasOpenShellGatewayUserService,
  NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER,
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

  it("rejects a missing Homebrew formula when Homebrew is available (#6903)", () => {
    expect(() =>
      hasOpenShellGatewayUserService({
        commandExists: () => true,
        platform: "darwin",
        spawnSyncImpl: () => spawnResult(1, "formula not installed"),
      }),
    ).toThrow("official OpenShell Homebrew formula is not installed");
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
      fallbackAllowed: false,
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

    expect(result).toMatchObject({ fallbackAllowed: false, started: false });
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

    expect(result).toMatchObject({ manager: "homebrew", serviceName: "openshell", started: true });
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
    ["manager unavailable", "daemon-reload", "Failed to connect to bus", true],
    ["foreign executable", "show", "", false],
    ["inactive service", "is-active", "inactive", false],
  ])("returns the expected fallback decision for a selected systemd service failure: %s (#6903)", (_case, failedCommand, detail, fallbackAllowed) => {
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

    expect(result).toMatchObject({ fallbackAllowed, started: false });
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
          fallbackAllowed: false,
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

  it("allows detached fallback only before a service authority starts (#6903)", async () => {
    const register = vi.fn(() => true);
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
          fallbackAllowed: true,
          reason: "user manager unavailable",
          started: false,
        }),
        verifySandboxBridgeGatewayReachableOrExit: vi.fn(),
      }),
    ).resolves.toBe(false);
    expect(register).not.toHaveBeenCalled();
  });

  it("keeps runtime breadcrumbs when managed service health fails (#6903)", async () => {
    const clear = vi.fn();
    const clock = createVirtualClock();
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
          fallbackAllowed: false,
          started: true,
          statusCommand: "systemctl --user status nemoclaw-openshell-gateway",
        }),
        verifySandboxBridgeGatewayReachableOrExit: vi.fn(),
      }),
    ).rejects.toThrow("configured 1s health deadline");
    expect(clear).not.toHaveBeenCalled();
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

    expect(result).toMatchObject({ attempted: true, stopped: false });
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
      reason,
      stopped: false,
    });
  });
});
