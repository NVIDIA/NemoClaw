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
  type OpenShellGatewayUserServiceOptions,
} from "./docker-driver-gateway-service";
import {
  HOMEBREW_GATEWAY_FIXTURE,
  type HomebrewServiceInfoFixture,
  homebrewFixturePathExists as homebrewPathExists,
  homebrewFormulaInfoFixture as officialFormulaInfo,
  homebrewFormulaOperationFixture,
  homebrewLaunchdPlistFileFixture,
  homebrewServiceInfoFixture,
  launchctlAbsentResultFixture as launchctlAbsentResult,
  serviceFileIdentityFixture,
  spawnSyncResultFixture as spawnResult,
} from "./__test-helpers__/docker-driver-gateway-service-test-fixture";

const {
  formulaPrefix: HOMEBREW_FORMULA_PREFIX,
  home: HOMEBREW_HOME,
  userPlist: HOMEBREW_USER_PLIST,
} = HOMEBREW_GATEWAY_FIXTURE;
const SECRET_SENTINEL = "sentinel-secret-not-for-child-processes-or-diagnostics";

function homebrewServiceInfo(
  overrides: Partial<HomebrewServiceInfoFixture> = {},
): SpawnSyncLikeResult {
  return homebrewServiceInfoFixture({
    file: HOMEBREW_USER_PLIST,
    loaded: true,
    loaded_file: HOMEBREW_USER_PLIST,
    pid: 4242,
    registered: true,
    running: true,
    ...overrides,
  });
}

function stoppedHomebrewServiceInfo(
  overrides: Partial<HomebrewServiceInfoFixture> = {},
): SpawnSyncLikeResult {
  return homebrewServiceInfoFixture(overrides);
}

function trustedHomebrewPlistFiles({ userPlistExists = false } = {}): Pick<
  OpenShellGatewayUserServiceOptions,
  | "closeSync"
  | "fstatSync"
  | "getuid"
  | "inspectServiceFileIdentity"
  | "lstatSync"
  | "openSync"
  | "readSync"
  | "spawnSyncImpl"
> {
  return {
    ...homebrewLaunchdPlistFileFixture({
      destinationState: () => (userPlistExists ? "regular" : "absent"),
    }),
    inspectServiceFileIdentity: serviceFileIdentityFixture(
      () => "reviewed Homebrew executable\n",
      () => 501,
    ),
    spawnSyncImpl: (command) =>
      command === "/bin/launchctl" ? launchctlAbsentResult() : spawnResult(),
  };
}

function homebrewOperation(
  serviceInfo: () => SpawnSyncLikeResult,
  events: string[] = [],
  failCommand?: string,
): (args: string[]) => SpawnSyncLikeResult {
  return homebrewFormulaOperationFixture({
    events,
    failCommand,
    failDiagnostic: SECRET_SENTINEL,
    serviceInfo,
  });
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
        "f0f86519e227b3b326431410058ba690b1a7b83e5af7384014e4b96283d3a642",
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
  ] satisfies Array<[string, Partial<HomebrewServiceInfoFixture>]>)(
    "does not inspect or trust a loaded launchd job with a reported %s (#9705)",
    (_field, change) => {
      const events: string[] = [];
      const operation = homebrewOperation(() => homebrewServiceInfo(change), events);

      expect(
        getTrustedActiveOpenShellGatewayUserServiceIdentity({
          commandExists: (command) => command === "brew",
          existsSync: homebrewPathExists,
          home: HOMEBREW_HOME,
          homebrewFormulaOperation: operation,
          platform: "darwin",
        }),
      ).toBeNull();
      expect(events).not.toContain("services info openshell --json");
    },
  );

  it("rechecks the unloaded Homebrew service definition after environment preparation and before start (#9705)", () => {
    const events: string[] = [];
    let identityChanged = false;
    const operation = homebrewOperation(() => {
      const change = identityChanged ? { command: "/tmp/foreign-gateway-service" } : {};
      return stoppedHomebrewServiceInfo(change);
    }, events);

    const result = startOpenShellGatewayUserService({
      ...trustedHomebrewPlistFiles(),
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
    expect(events[events.indexOf("prepare environment") - 1]).toBe(
      "services info openshell --json",
    );
    expect(events).not.toContain("services stop openshell");
    expect(events).not.toContain("services start openshell");
    expect(
      events
        .slice(events.indexOf("prepare environment") + 1)
        .some((event) => event.startsWith("services info openshell")),
    ).toBe(true);
  });

  it("rechecks the unloaded Homebrew service definition after port preparation and before start (#9705)", () => {
    const events: string[] = [];
    let identityChanged = false;
    const operation = homebrewOperation(() => {
      const change = identityChanged ? { loaded_file: "/tmp/foreign.plist" } : {};
      return stoppedHomebrewServiceInfo(change);
    }, events);

    const result = startOpenShellGatewayUserService({
      ...trustedHomebrewPlistFiles(),
      commandExists: (command) => command === "brew",
      existsSync: homebrewPathExists,
      home: HOMEBREW_HOME,
      homebrewFormulaOperation: operation,
      platform: "darwin",
      preparePortForServiceStart: () => {
        events.push("prepare port");
        identityChanged = true;
      },
    });

    expect(result.started).toBe(false);
    expect(events).not.toContain("services stop openshell");
    expect(events[events.indexOf("prepare port") - 1]).toBe("services info openshell --json");
    expect(events).not.toContain("services start openshell");
    expect(
      events
        .slice(events.indexOf("prepare port") + 1)
        .some((event) => event.startsWith("services info openshell")),
    ).toBe(true);
  });

  it("does not expose child stderr when the Homebrew start command fails (#9705)", () => {
    const result = startOpenShellGatewayUserService({
      ...trustedHomebrewPlistFiles(),
      commandExists: (command) => command === "brew",
      existsSync: homebrewPathExists,
      home: HOMEBREW_HOME,
      homebrewFormulaOperation: homebrewOperation(
        () => stoppedHomebrewServiceInfo(),
        [],
        "services start openshell",
      ),
      platform: "darwin",
    });

    expect(result).toMatchObject({ attempted: true, started: false });
    expect(result.reason).not.toContain(SECRET_SENTINEL);
  });

  it("does not stop an unverified loaded Homebrew job (#9705)", () => {
    const events: string[] = [];
    const result = stopOpenShellGatewayUserService({
      ...trustedHomebrewPlistFiles({ userPlistExists: true }),
      commandExists: (command) => command === "brew",
      existsSync: homebrewPathExists,
      home: HOMEBREW_HOME,
      homebrewFormulaOperation: homebrewOperation(
        () => homebrewServiceInfo(),
        events,
        "services stop openshell",
      ),
      platform: "darwin",
    });

    expect(result).toMatchObject({
      attempted: true,
      standaloneFallbackBlocked: true,
      stopped: false,
    });
    expect(result.reason).toContain("brew services stop openshell");
    expect(result.reason).not.toContain(SECRET_SENTINEL);
    expect(events).not.toContain("services stop openshell");
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
    const spawnSyncImpl: SpawnSyncLike = vi.fn((command, args, options) => {
      expect(options?.env).toMatchObject(requiredEnvironment);
      expect(options?.env).not.toHaveProperty("LC_CLIENT_SECRET");
      expect(options?.env).not.toHaveProperty("NVIDIA_INFERENCE_API_KEY");
      expect(options?.env).not.toHaveProperty("OPENSHELL_GATEWAY_AUTH_TOKEN");
      expect(options?.env).not.toHaveProperty("XDG_API_TOKEN");
      expect(Object.values(options?.env ?? {})).not.toContain(SECRET_SENTINEL);
      const operation = command === "/bin/launchctl" ? [] : extractHomebrewOperation(args);
      const result =
        command === "/bin/launchctl"
          ? launchctlAbsentResult()
          : operation[0] === "info"
            ? officialFormulaInfo()
            : operation[0] === "--prefix"
              ? spawnResult(0, "", HOMEBREW_FORMULA_PREFIX)
              : operation[0] === "services" && operation[1] === "info"
                ? stoppedHomebrewServiceInfo()
                : spawnResult();
      return result;
    });

    const result = startOpenShellGatewayUserService({
      ...trustedHomebrewPlistFiles(),
      commandExists: (command) => command === "brew",
      env,
      existsSync: homebrewPathExists,
      home: HOMEBREW_HOME,
      platform: "darwin",
      spawnSyncImpl,
    });

    expect(result.started).toBe(true);
    expect(result.logCommand).toBe(
      'tail -n 200 "$(brew --prefix)/var/log/openshell/openshell-gateway.out.log" "$(brew --prefix)/var/log/openshell/openshell-gateway.err.log"',
    );
    expect(spawnSyncImpl).toHaveBeenCalled();
  });
});
