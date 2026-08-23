// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { lstatSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createVirtualClock } from "./__test-helpers__/virtual-clock";
import {
  createGatewayServiceFileContentsFixture,
  openShellHomebrewServicePlistFixture,
  serviceFileIdentityFixture,
} from "./__test-helpers__/docker-driver-gateway-service-test-fixture";
import {
  getNemoclawOpenShellGatewayUserServicePath,
  getOpenShellGatewayManagedServiceLogCommand,
  getOpenShellGatewayUserServiceBinaryPaths,
  getOpenShellGatewayUserServicePaths,
  getOpenShellUserConfigHome,
  getTrustedActiveOpenShellGatewayUserServiceIdentity,
  getTrustedActiveOpenShellGatewayUserServicePid,
  hasOpenShellGatewayUserService,
  NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE,
  NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER,
  OPENSHELL_GATEWAY_USER_SERVICE,
  OpenShellGatewayServiceTrustError,
  type SpawnSyncLike,
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

const TRUSTED_HOMEBREW_PLIST = openShellHomebrewServicePlistFixture("/opt/homebrew/opt/openshell");
function spawnResult(status = 0, stderr = "", stdout = ""): SpawnSyncLikeResult {
  return { status, stderr, stdout };
}

function trustedBrew(spawnSyncImpl: SpawnSyncLike): (args: string[]) => SpawnSyncLikeResult {
  return (args) => spawnSyncImpl("brew", args);
}

const SYSTEMD_IDENTITY_PROPERTIES = [
  "FragmentPath",
  "ExecStart",
  "DropInPaths",
  "ExecCondition",
  "ExecStartPre",
  "ExecStartPost",
  "ExecReload",
  "ExecStop",
  "ExecStopPost",
];
const SYSTEMD_IDENTITY_PROPERTY_OPTIONS = SYSTEMD_IDENTITY_PROPERTIES.map(
  (property) => `--property=${property}`,
);
function systemdIdentityShowEvent(serviceName: string): string {
  return ["show", serviceName, ...SYSTEMD_IDENTITY_PROPERTY_OPTIONS].join(" ");
}

function trustedShowOutput(
  fragmentPath = "/lib/systemd/user/openshell-gateway.service",
  execPath = "/usr/bin/openshell-gateway",
): string {
  return [
    `FragmentPath=${fragmentPath}`,
    `ExecStart={ path=${execPath} ; argv[]=${execPath} ; ignore_errors=no ; }`,
    "DropInPaths=",
    "ExecCondition=",
    fragmentPath.endsWith("/nemoclaw-openshell-gateway.service")
      ? `ExecStartPre={ path=${execPath} ; argv[]=${execPath} generate-certs --output-dir \${OPENSHELL_LOCAL_TLS_DIR} --server-san host.openshell.internal ; ignore_errors=no ; }`
      : "ExecStartPre=",
    "ExecStartPost=",
    "ExecReload=",
    "ExecStop=",
    "ExecStopPost=",
  ].join("\n");
}

function officialFormulaInfo(): SpawnSyncLikeResult {
  return spawnResult(
    0,
    "",
    JSON.stringify({ formulae: [{ name: "openshell", tap: "nvidia/openshell" }] }),
  );
}

let nextTrustedFileDescriptor = 10;
const trustedFilePaths = new Map<number, string>();
const trustedFileOffsets = new Map<number, number>();
const trustedFileStat = (candidate: string) => ({
  ctimeNs: 31,
  dev: 17,
  ino: 23,
  isFile: () => true,
  isSymbolicLink: () => false,
  mode: 0o644,
  mtimeNs: 29,
  nlink: 1,
  size: Buffer.byteLength(trustedFileContents(candidate)),
  uid: candidate.startsWith("/lib/") || candidate.startsWith("/usr/") ? 0 : 1000,
});
const trustedFileContents = createGatewayServiceFileContentsFixture(
  "/home/nvidia/.local/bin/openshell-gateway",
  TRUSTED_HOMEBREW_PLIST,
);
const trustedFileOwner = (filePath: string): number => trustedFileStat(filePath).uid;
const UNIT_OWNER = {
  closeSync: (fileDescriptor: number) => {
    trustedFilePaths.delete(fileDescriptor);
    trustedFileOffsets.delete(fileDescriptor);
  },
  fstatSync: (fileDescriptor: number) =>
    trustedFileStat(trustedFilePaths.get(fileDescriptor) ?? ""),
  getuid: () => 1000,
  inspectServiceFileIdentity: serviceFileIdentityFixture(trustedFileContents, trustedFileOwner),
  lstatSync: ((candidate: string) => trustedFileStat(candidate)) as unknown as typeof lstatSync,
  openSync: (candidate: string) => {
    const fileDescriptor = nextTrustedFileDescriptor++;
    trustedFilePaths.set(fileDescriptor, candidate);
    trustedFileOffsets.set(fileDescriptor, 0);
    return fileDescriptor;
  },
  readSync: (fileDescriptor: number, buffer: Buffer, offset: number, length: number) => {
    const contents = Buffer.from(trustedFileContents(trustedFilePaths.get(fileDescriptor) ?? ""));
    const contentOffset = trustedFileOffsets.get(fileDescriptor) ?? 0;
    const count = Math.max(0, Math.min(length, contents.length - contentOffset));
    contents.copy(buffer, offset, contentOffset, contentOffset + count);
    trustedFileOffsets.set(fileDescriptor, contentOffset + count);
    return count;
  },
  readFileSync: (): string => `# ${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER}\n`,
};
function throwErrno(message: string, code: string): never {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  throw error;
}

function systemdSpawn(
  events: string[],
  fragmentPath = "/lib/systemd/user/openshell-gateway.service",
  execPath = "/usr/bin/openshell-gateway",
  competingIdentity: [string, string] = [fragmentPath, execPath],
) {
  return vi.fn((_command: string, args: string[]) => {
    events.push(args.slice(1).join(" "));
    const identity =
      args[2] === NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE
        ? competingIdentity
        : [fragmentPath, execPath];
    return args.includes("show")
      ? spawnResult(0, "", trustedShowOutput(identity[0], identity[1]))
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

    expect(
      hasOpenShellGatewayUserService({
        ...UNIT_OWNER,
        existsSync: linuxExists,
        getUpstreamGatewayVersion: () => "0.0.85",
        getUpstreamGatewayVersionBounds: () => ({ max: "0.0.85", min: "0.0.85" }),
        platform: "linux",
        spawnSyncImpl: systemdSpawn([], "/usr/lib/systemd/user/openshell-gateway.service"),
      }),
    ).toBe(true);
    expect(
      hasOpenShellGatewayUserService({
        commandExists: (command) => command === "brew",
        homebrewFormulaOperation: trustedBrew(brew),
        platform: "darwin",
        spawnSyncImpl: brew,
        ...UNIT_OWNER,
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
  it.each([
    { ...UNIT_OWNER, readFileSync: (): string => "# foreign\n", error: "foreign" },
    {
      lstatSync: () => ({ isSymbolicLink: () => true }) as never,
      readFileSync: (): string => `# ${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER}\n`,
      error: "symlinked",
    },
  ])(
    "uses the effective XDG config home and accepts only a marked regular unit [case %#] (#6903)",
    (unsafe) => {
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
          ...UNIT_OWNER,
          platform: "linux",
        }),
      ).toBe(true);

      expect(() =>
        hasOpenShellGatewayUserService({
          env,
          existsSync: (candidate) => candidate === servicePath,
          home,
          platform: "linux",
          ...unsafe,
        }),
      ).toThrow(unsafe.error);
    },
  );

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
      ...UNIT_OWNER,
      platform: "linux",
      preparePortForServiceStart: () => events.push("prepare-port"),
      prepareServiceEnv: () => events.push("prepare-env"),
      spawnSyncImpl: systemdSpawn(events, servicePath, gatewayBin),
      validatePortOwnerForServiceStart: () => events.push("validate-port"),
    });
    expect(result).toMatchObject({
      logCommand: "journalctl --user --unit nemoclaw-openshell-gateway --no-pager --lines=200",
      manager: "systemd",
      serviceName: "nemoclaw-openshell-gateway",
      started: true,
    });
    const identityShow = systemdIdentityShowEvent(NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE);
    expect(events).toEqual([
      identityShow,
      identityShow,
      "daemon-reload",
      "validate-port",
      identityShow,
      "prepare-env",
      identityShow,
      "stop nemoclaw-openshell-gateway",
      identityShow,
      "prepare-port",
      identityShow,
      "enable nemoclaw-openshell-gateway",
      identityShow,
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
      ...UNIT_OWNER,
      inspectServiceFileIdentity: serviceFileIdentityFixture(
        createGatewayServiceFileContentsFixture(gatewayBin, TRUSTED_HOMEBREW_PLIST),
        trustedFileOwner,
      ),
      platform: "linux",
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
      getTrustedActiveOpenShellGatewayUserServiceIdentity({
        commandExists: (command) => command === "systemctl",
        env: { HOME: home },
        existsSync: (candidate) => candidate === servicePath,
        home,
        ...UNIT_OWNER,
        platform: "linux",
        spawnSyncImpl,
      }),
    ).toEqual({ pid: 4242, executablePath: gatewayBin });
    expect(spawnSyncImpl).toHaveBeenCalledWith(
      "systemctl",
      [
        "--user",
        "show",
        "nemoclaw-openshell-gateway",
        ...SYSTEMD_IDENTITY_PROPERTY_OPTIONS,
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
  it("removes a marked NemoClaw unit before activating an upstream systemd unit (#6903)", () => {
    const events: string[] = [];
    const removed: string[] = [];
    const servicePath = "/home/nvidia/.config/systemd/user/nemoclaw-openshell-gateway.service";
    const competingIdentity: [string, string] = [
      servicePath,
      "/home/nvidia/.local/bin/openshell-gateway",
    ];
    const result = startOpenShellGatewayUserService({
      commandExists: () => true,
      env: { HOME: "/home/nvidia" },
      existsSync: (candidate) =>
        candidate === servicePath || candidate === "/lib/systemd/user/openshell-gateway.service",
      getUpstreamGatewayVersion: () => "0.0.85",
      getUpstreamGatewayVersionBounds: () => ({ max: "0.0.85", min: "0.0.85" }),
      home: "/home/nvidia",
      ...UNIT_OWNER,
      platform: "linux",
      rmSync: ((candidate: string) => removed.push(candidate)) as never,
      spawnSyncImpl: systemdSpawn(events, undefined, undefined, competingIdentity),
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
      getUpstreamGatewayVersion: () => "0.0.85",
      getUpstreamGatewayVersionBounds: () => ({ max: "0.0.85", min: "0.0.85" }),
      platform: "linux",
      spawnSyncImpl: systemdSpawn(events),
      ...UNIT_OWNER,
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

  it.each([
    ["the manager is unavailable", "daemon-reload", "Failed to connect to bus", false],
    ["the service is inactive", "is-active", "inactive", false],
  ])(
    "reports the selected systemd log command when %s (#8104)",
    (_case, failedCommand, detail, standaloneFallbackBlocked) => {
      const result = startOpenShellGatewayUserService({
        commandExists: () => true,
        env: {},
        existsSync: (candidate) => candidate === "/lib/systemd/user/openshell-gateway.service",
        getUpstreamGatewayVersion: () => "0.0.85",
        getUpstreamGatewayVersionBounds: () => ({ max: "0.0.85", min: "0.0.85" }),
        platform: "linux",
        ...UNIT_OWNER,
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
    },
  );

  it("blocks an upstream systemd service with a foreign executable (#8926)", () => {
    expect(() =>
      startOpenShellGatewayUserService({
        commandExists: () => true,
        env: {},
        existsSync: (candidate) => candidate === "/lib/systemd/user/openshell-gateway.service",
        platform: "linux",
        spawnSyncImpl: () =>
          spawnResult(
            0,
            "",
            trustedShowOutput(
              "/lib/systemd/user/openshell-gateway.service",
              "/tmp/openshell-gateway",
            ),
          ),
      }),
    ).toThrow("Could not verify the effective OpenShell gateway user service");
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
  ])(
    "prints the %s log command before standalone fallback (#8104)",
    async (_case, logCommand, manager, serviceName) => {
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
    },
  );

  it("keeps Homebrew as lifecycle authority when managed startup fails (#7707)", async () => {
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
          manager: "homebrew",
          reason: "temporary trust failed",
          serviceName: "openshell",
          started: false,
        }),
        stopOpenShellGatewayUserService: stopService,
        verifySandboxBridgeGatewayReachableOrExit: vi.fn(),
      }),
    ).rejects.toThrow("temporary trust failed");
    expect(stopService).not.toHaveBeenCalled();
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

  it("stops an unhealthy Homebrew service without changing lifecycle authority (#7707)", async () => {
    const clock = createVirtualClock();
    const stopService = vi.fn(() => ({
      attempted: true,
      standaloneFallbackAllowed: false,
      stopped: true,
    }));

    await expect(
      startPackageManagedDockerDriverGateway({
        clearDockerDriverGatewayRuntimeFiles: vi.fn(),
        exitOnFailure: false,
        gatewayName: "nemoclaw",
        hasOpenShellGatewayUserService: () => true,
        healthPollCount: 1,
        healthPollInterval: 1,
        isDockerDriverGatewayReady: async () => false,
        now: clock.now,
        registerDockerDriverGatewayEndpoint: () => true,
        runCaptureOpenshell: () => "unhealthy",
        skipSandboxBridgeReachability: false,
        sleepSeconds: clock.advance,
        startOpenShellGatewayUserService: () => ({
          attempted: true,
          manager: "homebrew",
          serviceName: "openshell",
          started: true,
        }),
        stopOpenShellGatewayUserService: stopService,
        verifySandboxBridgeGatewayReachableOrExit: vi.fn(),
      }),
    ).rejects.toThrow("Homebrew formula remains lifecycle authority");
    expect(stopService).toHaveBeenCalledOnce();
  });

  it("blocks standalone fallback when managed service cleanup fails without permission (#8926)", async () => {
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
    ).rejects.toThrow("service manager unavailable");
  });

  it("continues only when cleanup explicitly permits standalone fallback (#8926)", async () => {
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
        stopOpenShellGatewayUserService: () => ({
          attempted: true,
          reason: "Failed to connect to bus: No medium found",
          standaloneFallbackAllowed: true,
          stopped: false,
        }),
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
            homebrewFormulaOperation: () => spawnResult(65),
            platform: "darwin",
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
      ...UNIT_OWNER,
      platform: "linux",
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
      systemdIdentityShowEvent(NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE),
      systemdIdentityShowEvent(NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE),
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
      ...UNIT_OWNER,
      platform: "linux",
      spawnSyncImpl: systemdSpawn(
        events,
        `${home}/.config/systemd/user/unrelated.service`,
        "/usr/bin/unrelated",
      ),
    });

    expect(result.attempted).toBe(true);
    expect(result.standaloneFallbackBlocked).toBe(true);
    expect(result.stopped).toBe(false);
    expect(result.reason).toBe("systemd executable lifecycle hooks are not trusted");
    expect(events).toEqual([systemdIdentityShowEvent(NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE)]);
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
      ...UNIT_OWNER,
      platform: "linux",
      spawnSyncImpl: vi.fn((_command: string, args: string[]) =>
        args.includes("show")
          ? spawnResult(0, "", trustedShowOutput(servicePath, gatewayBin))
          : spawnResult(1, "Job for nemoclaw-openshell-gateway.service failed"),
      ),
    });

    expect(result).toMatchObject({ attempted: true, stopped: false });
    expect(result.statusCommand).toBe("systemctl --user status nemoclaw-openshell-gateway");
    expect(result.reason).toBe(
      "systemctl --user stop nemoclaw-openshell-gateway failed with status 1",
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
      ...UNIT_OWNER,
      platform: "linux",
      readdirSync: (() => []) as never,
      spawnSyncImpl: vi.fn(() => spawnResult(1, "Failed to connect to bus: No medium found")),
    });

    expect(result).toMatchObject({
      attempted: true,
      standaloneFallbackAllowed: true,
      stopped: false,
    });
  });

  it.each([OPENSHELL_GATEWAY_USER_SERVICE, NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE])(
    "blocks standalone fallback when the %s service can activate automatically (#8926)",
    (activationService) => {
      const home = "/home/nvidia";
      const servicePath = `${home}/.config/systemd/user/nemoclaw-openshell-gateway.service`;
      const activationPath = `${home}/.config/systemd/user/default.target.wants/${activationService}.service`;

      const result = stopOpenShellGatewayUserService({
        commandExists: (command) => command === "systemctl",
        env: { HOME: home },
        existsSync: (candidate) => candidate === servicePath,
        home,
        ...UNIT_OWNER,
        lstatSync: ((candidate: string) => ({
          ...UNIT_OWNER.lstatSync(""),
          isSymbolicLink: () => candidate === activationPath,
        })) as never,
        platform: "linux",
        readdirSync: ((root: string) =>
          root === path.dirname(path.dirname(activationPath))
            ? [
                {
                  isDirectory: () => true,
                  isSymbolicLink: () => false,
                  name: path.basename(path.dirname(activationPath)),
                },
              ]
            : root === path.dirname(activationPath)
              ? [path.basename(activationPath)]
              : []) as never,
        spawnSyncImpl: vi.fn(() => spawnResult(1, "Failed to connect to bus: No medium found")),
      });

      expect(result).toMatchObject({
        attempted: true,
        standaloneFallbackAllowed: false,
        standaloneFallbackBlocked: true,
        stopped: false,
      });
      expect(result.reason).toContain("can later claim port 8080");
    },
  );

  it("blocks standalone fallback when the service query returns an unknown error (#8926)", () => {
    const home = "/home/nvidia";
    const servicePath = `${home}/.config/systemd/user/nemoclaw-openshell-gateway.service`;

    const result = stopOpenShellGatewayUserService({
      commandExists: (command) => command === "systemctl",
      env: { HOME: home },
      existsSync: (candidate) => candidate === servicePath,
      home,
      ...UNIT_OWNER,
      platform: "linux",
      spawnSyncImpl: vi.fn(() =>
        spawnResult(
          1,
          "Failed to connect to bus: No medium found\nFailed to connect to bus: Permission denied",
        ),
      ),
    });

    expect(result.attempted).toBe(true);
    expect(result.standaloneFallbackAllowed).toBe(false);
    expect(result.standaloneFallbackBlocked).toBe(true);
    expect(result.stopped).toBe(false);
    expect(result.reason).toBe("systemd service identity query failed");
  });

  it("blocks standalone fallback when systemctl splits known and unknown diagnostics (#8926)", () => {
    const home = "/home/nvidia";
    const servicePath = `${home}/.config/systemd/user/nemoclaw-openshell-gateway.service`;

    const result = stopOpenShellGatewayUserService({
      commandExists: (command) => command === "systemctl",
      env: { HOME: home },
      existsSync: (candidate) => candidate === servicePath,
      home,
      ...UNIT_OWNER,
      platform: "linux",
      spawnSyncImpl: vi.fn(() =>
        spawnResult(1, "Failed to connect to bus: No medium found", "Permission denied"),
      ),
    });

    expect(result.standaloneFallbackAllowed).toBe(false);
    expect(result.standaloneFallbackBlocked).toBe(true);
    expect(result.reason).toBe("systemd service identity query failed");
  });

  it("blocks standalone fallback when the systemctl query throws (#8926)", () => {
    const home = "/home/nvidia";
    const servicePath = `${home}/.config/systemd/user/nemoclaw-openshell-gateway.service`;

    const result = stopOpenShellGatewayUserService({
      commandExists: (command) => command === "systemctl",
      env: { HOME: home },
      existsSync: (candidate) => candidate === servicePath,
      home,
      ...UNIT_OWNER,
      platform: "linux",
      spawnSyncImpl: vi.fn(() => {
        throw new Error("systemctl invocation failed");
      }),
    });

    expect(result.standaloneFallbackAllowed).toBe(false);
    expect(result.standaloneFallbackBlocked).toBe(true);
    expect(result.reason).toBe("systemd service identity query failed");
  });

  it("rejects multiple effective gateway executables (#8926)", () => {
    const output = [
      "FragmentPath=/usr/lib/systemd/user/openshell-gateway.service",
      "ExecStart={ path=/usr/bin/openshell-gateway ; argv[]=/usr/bin/openshell-gateway ; }; { path=/tmp/foreign/openshell-gateway ; argv[]=/tmp/foreign/openshell-gateway ; }",
    ].join("\n");

    expect(() =>
      hasOpenShellGatewayUserService({
        existsSync: (candidate) => candidate === "/usr/lib/systemd/user/openshell-gateway.service",
        platform: "linux",
        spawnSyncImpl: () => spawnResult(0, "", output),
      }),
    ).toThrow("Could not verify the effective OpenShell gateway user service");
  });

  it.each([
    ["user data", "/home/nvidia/.local/share/systemd/user/session.target.wants"],
    ["user runtime", "/run/user/1000/systemd/user/default.target.wants"],
    ["user control", "/home/nvidia/.config/systemd/user.control/default.target.wants"],
    ["runtime control", "/run/user/1000/systemd/user.control/default.target.requires"],
    ["early generator", "/run/user/1000/systemd/generator.early/default.target.wants"],
    ["generator", "/run/user/1000/systemd/generator/default.target.requires"],
    ["late generator", "/run/user/1000/systemd/generator.late/default.target.wants"],
    ["transient", "/run/user/1000/systemd/transient/default.target.requires"],
    ["upheld", "/etc/systemd/user/default.target.upholds"],
    ["global config", "/etc/systemd/user/default.target.requires"],
    ["package data", "/usr/share/systemd/user/default.target.wants"],
  ])(
    "blocks fallback for an activation link in the %s root (#8926)",
    (_root, activationDirectory) => {
      const home = "/home/nvidia";
      const servicePath = `${home}/.config/systemd/user/nemoclaw-openshell-gateway.service`;
      const activationPath = `${activationDirectory}/openshell-gateway.service`;

      const result = stopOpenShellGatewayUserService({
        commandExists: (command) => command === "systemctl",
        env: { HOME: home, XDG_RUNTIME_DIR: "/run/user/1000" },
        existsSync: (candidate) => candidate === servicePath,
        home,
        ...UNIT_OWNER,
        lstatSync: ((candidate: string) => ({
          ...UNIT_OWNER.lstatSync(""),
          isSymbolicLink: () => candidate === activationPath,
        })) as never,
        platform: "linux",
        readdirSync: ((root: string) =>
          root === activationDirectory
            ? [path.basename(activationPath)]
            : root === path.dirname(activationDirectory)
              ? [{ isDirectory: () => true, name: path.basename(activationDirectory) }]
              : []) as never,
        spawnSyncImpl: vi.fn(() => spawnResult(1, "Failed to connect to bus: No medium found")),
      });

      expect(result).toMatchObject({
        standaloneFallbackAllowed: false,
        standaloneFallbackBlocked: true,
      });
      expect(result.reason).toContain(activationPath);
    },
  );

  it("blocks fallback when an activation root cannot be inspected (#8926)", () => {
    const home = "/home/nvidia";
    const servicePath = `${home}/.config/systemd/user/nemoclaw-openshell-gateway.service`;

    const result = stopOpenShellGatewayUserService({
      commandExists: (command) => command === "systemctl",
      env: { HOME: home },
      existsSync: (candidate) => candidate === servicePath,
      home,
      ...UNIT_OWNER,
      lstatSync: ((candidate: string) =>
        candidate === servicePath
          ? UNIT_OWNER.lstatSync("")
          : throwErrno(
              candidate === `${home}/.local/share/systemd/user` ? "permission denied" : "missing",
              candidate === `${home}/.local/share/systemd/user` ? "EACCES" : "ENOENT",
            )) as never,
      platform: "linux",
      readdirSync: ((root: string) =>
        root === `${home}/.local/share/systemd/user`
          ? throwErrno("permission denied", "EACCES")
          : throwErrno("missing", "ENOENT")) as never,
      spawnSyncImpl: vi.fn(() => spawnResult(1, "Failed to connect to bus: No medium found")),
    });

    expect(result).toMatchObject({
      standaloneFallbackAllowed: false,
      standaloneFallbackBlocked: true,
    });
    expect(result.reason).toContain("could not inspect systemd user service activation paths");
    expect(result.reason).not.toContain("permission denied");
  });

  it.each([
    [
      "spawn error",
      {
        error: new Error("Failed to connect to bus: No medium found"),
        status: null,
      },
    ],
    [
      "missing exit status",
      {
        status: null,
        stderr: "Failed to connect to bus: No medium found",
      },
    ],
  ])("blocks fallback for a %s with a known-looking diagnostic (#8926)", (_case, queryResult) => {
    const home = "/home/nvidia";
    const servicePath = `${home}/.config/systemd/user/nemoclaw-openshell-gateway.service`;

    const result = stopOpenShellGatewayUserService({
      commandExists: (command) => command === "systemctl",
      env: { HOME: home },
      existsSync: (candidate) => candidate === servicePath,
      home,
      ...UNIT_OWNER,
      platform: "linux",
      spawnSyncImpl: vi.fn(() => queryResult),
    });

    expect(result).toMatchObject({
      standaloneFallbackAllowed: false,
      standaloneFallbackBlocked: true,
    });
  });

  it("blocks fallback for a symlinked activation directory (#8926)", () => {
    const home = "/home/nvidia";
    const servicePath = `${home}/.config/systemd/user/nemoclaw-openshell-gateway.service`;
    const userRoot = `${home}/.config/systemd/user`;
    const activationDirectory = `${userRoot}/default.target.wants`;
    const activationPath = `${activationDirectory}/openshell-gateway.service`;

    const result = stopOpenShellGatewayUserService({
      commandExists: (command) => command === "systemctl",
      env: { HOME: home },
      existsSync: (candidate) => candidate === servicePath,
      home,
      ...UNIT_OWNER,
      platform: "linux",
      readdirSync: ((root: string) =>
        root === userRoot
          ? [
              {
                isDirectory: () => false,
                isSymbolicLink: () => true,
                name: "default.target.wants",
              },
            ]
          : root === activationDirectory
            ? ["openshell-gateway.service"]
            : []) as never,
      spawnSyncImpl: vi.fn(() => spawnResult(1, "Failed to connect to bus: No medium found")),
    });

    expect(result).toMatchObject({ standaloneFallbackBlocked: true });
    expect(result.reason).toContain(activationPath);
  });

  it("blocks fallback for a dangling activation directory (#8926)", () => {
    const home = "/home/nvidia";
    const servicePath = `${home}/.config/systemd/user/nemoclaw-openshell-gateway.service`;
    const userRoot = `${home}/.config/systemd/user`;

    const result = stopOpenShellGatewayUserService({
      commandExists: (command) => command === "systemctl",
      env: { HOME: home },
      existsSync: (candidate) => candidate === servicePath,
      home,
      ...UNIT_OWNER,
      platform: "linux",
      readdirSync: ((root: string) =>
        root === userRoot
          ? [
              {
                isDirectory: () => false,
                isSymbolicLink: () => true,
                name: "default.target.wants",
              },
            ]
          : throwErrno("dangling activation directory", "ENOENT")) as never,
      spawnSyncImpl: vi.fn(() => spawnResult(1, "Failed to connect to bus: No medium found")),
    });

    expect(result.standaloneFallbackAllowed).toBe(false);
    expect(result.standaloneFallbackBlocked).toBe(true);
    expect(result.reason).toContain("could not inspect systemd user service activation paths");
    expect(result.reason).not.toContain("dangling activation directory");
  });

  it("blocks fallback for a dangling activation root (#8926)", () => {
    const home = "/home/nvidia";
    const servicePath = `${home}/.config/systemd/user/nemoclaw-openshell-gateway.service`;
    const userRoot = `${home}/.config/systemd/user`;

    const result = stopOpenShellGatewayUserService({
      commandExists: (command) => command === "systemctl",
      env: { HOME: home },
      existsSync: (candidate) => candidate === servicePath,
      home,
      ...UNIT_OWNER,
      lstatSync: ((candidate: string) => ({
        ...UNIT_OWNER.lstatSync(""),
        isSymbolicLink: () => candidate === userRoot,
      })) as never,
      platform: "linux",
      readdirSync: ((root: string) => {
        const error = new Error(
          root === userRoot ? "dangling activation root" : "missing",
        ) as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }) as never,
      spawnSyncImpl: vi.fn(() => spawnResult(1, "Failed to connect to bus: No medium found")),
    });

    expect(result).toMatchObject({
      standaloneFallbackAllowed: false,
      standaloneFallbackBlocked: true,
    });
    expect(result.reason).toContain("could not inspect systemd user service activation paths");
    expect(result.reason).not.toContain("dangling activation root");
  });

  it("does not classify a thrown known diagnostic as a manager result (#8926)", () => {
    const home = "/home/nvidia";
    const servicePath = `${home}/.config/systemd/user/nemoclaw-openshell-gateway.service`;

    const result = stopOpenShellGatewayUserService({
      commandExists: (command) => command === "systemctl",
      env: { HOME: home },
      existsSync: (candidate) => candidate === servicePath,
      home,
      ...UNIT_OWNER,
      platform: "linux",
      spawnSyncImpl: vi.fn(() => {
        throw new Error("Failed to connect to bus: No medium found");
      }),
    });

    expect(result.standaloneFallbackAllowed).toBe(false);
    expect(result.standaloneFallbackBlocked).toBe(true);
    expect(result.reason).toBe("systemd service identity query failed");
  });
});
