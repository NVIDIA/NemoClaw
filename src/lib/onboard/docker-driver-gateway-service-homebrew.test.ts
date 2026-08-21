// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  getTrustedActiveOpenShellGatewayUserServiceIdentity,
  hasOpenShellGatewayUserService,
  type SpawnSyncLike,
  type SpawnSyncLikeResult,
  startOpenShellGatewayUserService,
  startPackageManagedDockerDriverGateway,
  stopOpenShellGatewayUserService,
} from "./docker-driver-gateway-service";

const HOMEBREW_HOME = "/Users/nemoclaw";
const HOMEBREW_FORMULA_PREFIX = "/opt/homebrew/opt/openshell";
const HOMEBREW_GATEWAY_BINARY = `${HOMEBREW_FORMULA_PREFIX}/bin/openshell-gateway`;
const HOMEBREW_SERVICE_COMMAND = `${HOMEBREW_FORMULA_PREFIX}/libexec/openshell-gateway-homebrew-service`;
const HOMEBREW_FORMULA_PLIST = `${HOMEBREW_FORMULA_PREFIX}/homebrew.mxcl.openshell.plist`;
const HOMEBREW_USER_PLIST = `${HOMEBREW_HOME}/Library/LaunchAgents/homebrew.mxcl.openshell.plist`;
const SECRET_SENTINEL = "sentinel-secret-not-for-child-processes-or-diagnostics";

function spawnResult(status = 0, stderr = "", stdout = ""): SpawnSyncLikeResult {
  return { status, stderr, stdout };
}

function officialFormulaInfo(): SpawnSyncLikeResult {
  return spawnResult(
    0,
    "",
    JSON.stringify({ formulae: [{ name: "openshell", tap: "nvidia/openshell" }] }),
  );
}

type HomebrewServiceInfo = {
  command: string;
  file: string;
  loaded: boolean;
  loaded_file: string | null;
  name: string;
  pid: number | null;
  registered: boolean;
  running: boolean;
  service_name: string;
};

function homebrewServiceInfo(overrides: Partial<HomebrewServiceInfo> = {}): SpawnSyncLikeResult {
  return spawnResult(
    0,
    "",
    JSON.stringify([
      {
        command: HOMEBREW_SERVICE_COMMAND,
        file: HOMEBREW_USER_PLIST,
        loaded: true,
        loaded_file: HOMEBREW_USER_PLIST,
        name: "openshell",
        pid: 4242,
        registered: true,
        running: true,
        service_name: "homebrew.mxcl.openshell",
        ...overrides,
      },
    ]),
  );
}

function stoppedHomebrewServiceInfo(
  overrides: Partial<HomebrewServiceInfo> = {},
): SpawnSyncLikeResult {
  return homebrewServiceInfo({
    file: HOMEBREW_FORMULA_PLIST,
    loaded: false,
    loaded_file: null,
    pid: null,
    registered: false,
    running: false,
    ...overrides,
  });
}

function homebrewPathExists(candidate: string): boolean {
  return [
    HOMEBREW_FORMULA_PLIST,
    HOMEBREW_GATEWAY_BINARY,
    HOMEBREW_SERVICE_COMMAND,
    HOMEBREW_USER_PLIST,
  ].includes(candidate);
}

function homebrewOperation(
  serviceInfo: () => SpawnSyncLikeResult,
  events: string[] = [],
  failCommand?: string,
): (args: string[]) => SpawnSyncLikeResult {
  return (args) => {
    const command = args.join(" ");
    events.push(command);
    return command === failCommand
      ? spawnResult(1, SECRET_SENTINEL)
      : args[0] === "info"
        ? officialFormulaInfo()
        : args[0] === "--prefix"
          ? spawnResult(0, "", HOMEBREW_FORMULA_PREFIX)
          : args[0] === "services" && args[1] === "info"
            ? serviceInfo()
            : spawnResult();
  };
}

function extractHomebrewOperation(args: string[]): string[] {
  const brewIndex = args.lastIndexOf("brew");
  return brewIndex === -1 ? [] : args.slice(brewIndex + 1);
}

describe("OpenShell Homebrew service boundary", () => {
  it("rejects a Homebrew formula outside the official tap (#6903)", () => {
    const operation = vi.fn((args: string[]) =>
      args[0] === "info"
        ? spawnResult(
            0,
            "",
            JSON.stringify({ formulae: [{ name: "openshell", tap: "other/tap" }] }),
          )
        : spawnResult(),
    );

    expect(() =>
      hasOpenShellGatewayUserService({
        commandExists: () => true,
        homebrewFormulaOperation: operation,
        platform: "darwin",
      }),
    ).toThrow("must come from nvidia/openshell");
  });

  it("uses the temporary formula trust boundary for inspection (#7707)", () => {
    const operation = vi.fn((args: string[]) =>
      args[0] === "info" ? officialFormulaInfo() : spawnResult(),
    );

    expect(
      hasOpenShellGatewayUserService({
        commandExists: () => true,
        homebrewFormulaOperation: operation,
        platform: "darwin",
      }),
    ).toBe(true);
    expect(operation.mock.calls.map(([args]) => args)).toEqual([
      ["list", "--formula", "openshell"],
      ["info", "--json=v2", "openshell"],
    ]);
  });

  it.each([
    [66, "Run curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash"],
    [67, "could not grant temporary trust"],
    [68, "could not remove temporary trust"],
    [69, "Run curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash"],
  ])("fails closed on Homebrew boundary status %i (#7707)", (status, expected) => {
    const preparePortForServiceStart = vi.fn();
    const prepareServiceEnv = vi.fn();
    const validatePortOwnerForServiceStart = vi.fn();

    expect(() =>
      startOpenShellGatewayUserService({
        commandExists: () => true,
        homebrewFormulaOperation: () => spawnResult(status, "opaque Homebrew diagnostic"),
        platform: "darwin",
        preparePortForServiceStart,
        prepareServiceEnv,
        validatePortOwnerForServiceStart,
      }),
    ).toThrow(expected);
    expect(preparePortForServiceStart).not.toHaveBeenCalled();
    expect(prepareServiceEnv).not.toHaveBeenCalled();
    expect(validatePortOwnerForServiceStart).not.toHaveBeenCalled();
  });

  it("invokes the shipped operation boundary instead of parsing Homebrew stderr (#7707)", () => {
    const spawnSyncImpl = vi.fn((_command: string, args: string[]) => {
      const brewIndex = args.indexOf("brew");
      return args[brewIndex + 1] === "info" ? officialFormulaInfo() : spawnResult();
    });

    expect(
      hasOpenShellGatewayUserService({
        commandExists: () => true,
        platform: "darwin",
        spawnSyncImpl,
      }),
    ).toBe(true);
    expect(spawnSyncImpl).toHaveBeenCalledWith(
      "bash",
      expect.arrayContaining([
        "--homebrew-formula-operation",
        "--",
        "brew",
        "list",
        "--formula",
        "openshell",
      ]),
      expect.any(Object),
    );
  });

  it("skips the managed start when no trusted Homebrew service is selected (#7707)", async () => {
    const startService = vi.fn(() => {
      throw new Error("managed start must not run");
    });
    const started = await startPackageManagedDockerDriverGateway({
      clearDockerDriverGatewayRuntimeFiles: () => {},
      exitOnFailure: false,
      gatewayName: "nemoclaw",
      hasOpenShellGatewayUserService: () => false,
      registerDockerDriverGatewayEndpoint: () => true,
      runCaptureOpenshell: () => "",
      skipSandboxBridgeReachability: true,
      startOpenShellGatewayUserService: startService,
      verifySandboxBridgeGatewayReachableOrExit: async () => {},
    });

    expect(started).toBe(false);
    expect(startService).not.toHaveBeenCalled();
  });

  it("reports no managed service only when the formula is genuinely absent (#8104)", () => {
    expect(
      hasOpenShellGatewayUserService({
        commandExists: () => true,
        homebrewFormulaOperation: () => spawnResult(65),
        platform: "darwin",
      }),
    ).toBe(false);
  });

  it.each([
    ["command", { command: "/tmp/foreign-gateway-service" }],
    ["file", { file: "/tmp/homebrew.mxcl.openshell.plist" }],
    ["loaded_file", { loaded_file: "/tmp/homebrew.mxcl.openshell.plist" }],
    ["registered", { registered: false }],
  ] satisfies Array<[string, Partial<HomebrewServiceInfo>]>)(
    "rejects an active Homebrew service with a foreign %s value (#9705)",
    (_field, change) => {
      const operation = homebrewOperation(() => homebrewServiceInfo(change));

      expect(
        getTrustedActiveOpenShellGatewayUserServiceIdentity({
          commandExists: (command) => command === "brew",
          existsSync: homebrewPathExists,
          home: HOMEBREW_HOME,
          homebrewFormulaOperation: operation,
          platform: "darwin",
        }),
      ).toBeNull();
    },
  );

  it("rechecks the Homebrew service definition after environment preparation and before stop (#9705)", () => {
    const events: string[] = [];
    let identityChanged = false;
    const operation = homebrewOperation(
      () => homebrewServiceInfo(identityChanged ? { command: "/tmp/foreign-gateway-service" } : {}),
      events,
    );

    const result = startOpenShellGatewayUserService({
      commandExists: (command) => command === "brew",
      existsSync: homebrewPathExists,
      home: HOMEBREW_HOME,
      homebrewFormulaOperation: operation,
      platform: "darwin",
      prepareServiceEnv: () => {
        events.push("prepare environment");
        identityChanged = true;
      },
    });

    expect(result.started).toBe(false);
    expect(events).not.toContain("services stop openshell");
    expect(events).not.toContain("services restart openshell");
    expect(
      events
        .slice(events.indexOf("prepare environment") + 1)
        .some((event) => event.startsWith("services info openshell")),
    ).toBe(true);
  });

  it("rechecks the Homebrew service definition after stop and before restart (#9705)", () => {
    const events: string[] = [];
    let identityChanged = false;
    let serviceRunning = true;
    const operation = homebrewOperation(() => {
      const change = identityChanged ? { loaded_file: "/tmp/foreign.plist" } : {};
      return serviceRunning ? homebrewServiceInfo(change) : stoppedHomebrewServiceInfo(change);
    }, events);
    const trackedOperation = (args: string[]) => {
      const result = operation(args);
      serviceRunning =
        args.join(" ") === "services stop openshell" && result.status === 0
          ? false
          : serviceRunning;
      return result;
    };

    const result = startOpenShellGatewayUserService({
      commandExists: (command) => command === "brew",
      existsSync: homebrewPathExists,
      home: HOMEBREW_HOME,
      homebrewFormulaOperation: trackedOperation,
      platform: "darwin",
      preparePortForServiceStart: () => {
        events.push("prepare port");
        identityChanged = true;
      },
    });

    expect(result.started).toBe(false);
    expect(events).toContain("services stop openshell");
    expect(events).not.toContain("services restart openshell");
    expect(
      events
        .slice(events.indexOf("prepare port") + 1)
        .some((event) => event.startsWith("services info openshell")),
    ).toBe(true);
  });

  it.each(["services stop openshell", "services restart openshell"])(
    "does not expose child stderr when Homebrew lifecycle command %s fails (#9705)",
    (failedCommand) => {
      let serviceRunning = true;
      const operation = homebrewOperation(
        () => (serviceRunning ? homebrewServiceInfo() : stoppedHomebrewServiceInfo()),
        [],
        failedCommand,
      );
      const trackedOperation = (args: string[]) => {
        const result = operation(args);
        serviceRunning =
          args.join(" ") === "services stop openshell" && result.status === 0
            ? false
            : serviceRunning;
        return result;
      };

      const result = startOpenShellGatewayUserService({
        commandExists: (command) => command === "brew",
        existsSync: homebrewPathExists,
        home: HOMEBREW_HOME,
        homebrewFormulaOperation: trackedOperation,
        platform: "darwin",
      });

      expect(result).toMatchObject({ attempted: true, started: false });
      expect(result.reason).not.toContain(SECRET_SENTINEL);
    },
  );

  it("does not expose child stderr when Homebrew stop fails (#9705)", () => {
    const result = stopOpenShellGatewayUserService({
      commandExists: (command) => command === "brew",
      existsSync: homebrewPathExists,
      home: HOMEBREW_HOME,
      homebrewFormulaOperation: homebrewOperation(
        () => homebrewServiceInfo(),
        [],
        "services stop openshell",
      ),
      platform: "darwin",
    });

    expect(result).toMatchObject({ attempted: true, stopped: false });
    expect(result.reason).not.toContain(SECRET_SENTINEL);
  });

  it("preserves required host variables without passing secrets to Homebrew child processes (#9705)", () => {
    const requiredEnvironment = {
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/501/bus",
      HOME: HOMEBREW_HOME,
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      XDG_CONFIG_HOME: `${HOMEBREW_HOME}/.config`,
      XDG_RUNTIME_DIR: "/run/user/501",
    };
    const env = {
      ...requiredEnvironment,
      LC_CLIENT_SECRET: SECRET_SENTINEL,
      NVIDIA_INFERENCE_API_KEY: SECRET_SENTINEL,
      OPENSHELL_GATEWAY_AUTH_TOKEN: SECRET_SENTINEL,
      XDG_API_TOKEN: SECRET_SENTINEL,
    };
    let serviceRunning = true;
    const spawnSyncImpl: SpawnSyncLike = vi.fn((_command, args, options) => {
      expect(options?.env).toMatchObject(requiredEnvironment);
      expect(options?.env).not.toHaveProperty("LC_CLIENT_SECRET");
      expect(options?.env).not.toHaveProperty("NVIDIA_INFERENCE_API_KEY");
      expect(options?.env).not.toHaveProperty("OPENSHELL_GATEWAY_AUTH_TOKEN");
      expect(options?.env).not.toHaveProperty("XDG_API_TOKEN");
      expect(Object.values(options?.env ?? {})).not.toContain(SECRET_SENTINEL);
      const operation = extractHomebrewOperation(args);
      const command = operation.join(" ");
      const result =
        operation[0] === "info"
          ? officialFormulaInfo()
          : operation[0] === "--prefix"
            ? spawnResult(0, "", HOMEBREW_FORMULA_PREFIX)
            : operation[0] === "services" && operation[1] === "info"
              ? serviceRunning
                ? homebrewServiceInfo()
                : stoppedHomebrewServiceInfo()
              : spawnResult();
      serviceRunning = command === "services stop openshell" ? false : serviceRunning;
      return result;
    });

    const result = startOpenShellGatewayUserService({
      commandExists: (command) => command === "brew",
      env,
      existsSync: homebrewPathExists,
      home: HOMEBREW_HOME,
      platform: "darwin",
      spawnSyncImpl,
    });

    expect(result.started).toBe(true);
    expect(spawnSyncImpl).toHaveBeenCalled();
  });
});
