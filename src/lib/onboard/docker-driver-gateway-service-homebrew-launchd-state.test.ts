// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  type OpenShellGatewayUserServiceOptions,
  type SpawnSyncLikeResult,
  startOpenShellGatewayUserService,
  stopOpenShellGatewayUserService,
} from "./docker-driver-gateway-service";
import {
  HOMEBREW_GATEWAY_FIXTURE,
  type HomebrewLaunchdDestinationState,
  homebrewFixturePathExists,
  homebrewFormulaOperationFixture,
  homebrewLaunchdPlistFileFixture,
  homebrewServiceInfoFixture as serviceInfo,
  launchctlAbsentResultFixture as launchctlAbsentResult,
  serviceFileIdentityFixture,
  spawnSyncResultFixture as spawnResult,
} from "./__test-helpers__/docker-driver-gateway-service-test-fixture";

const { home: HOME, label: SERVICE_LABEL, userPlist: USER_PLIST } = HOMEBREW_GATEWAY_FIXTURE;
const SECRET = "launchctl-secret-output";

function loadedServiceInfo(running: boolean): SpawnSyncLikeResult {
  return serviceInfo({
    file: USER_PLIST,
    loaded: true,
    loaded_file: USER_PLIST,
    pid: running ? 4242 : null,
    registered: true,
    running,
  });
}

interface HomebrewTestOptions {
  destinationState?: () => HomebrewLaunchdDestinationState;
  events?: string[];
  launchctl?: (domain: string, options: Record<string, unknown>) => SpawnSyncLikeResult;
  serviceInfo?: () => SpawnSyncLikeResult;
}

function trustedHomebrewOptions({
  destinationState = () => "absent",
  events = [],
  launchctl = () => launchctlAbsentResult(),
  serviceInfo: readServiceInfo = () => serviceInfo(),
}: HomebrewTestOptions = {}): OpenShellGatewayUserServiceOptions {
  return {
    ...homebrewLaunchdPlistFileFixture({ destinationState }),
    commandExists: (command) => command === "brew",
    env: { HOME },
    existsSync: homebrewFixturePathExists,
    home: HOME,
    homebrewFormulaOperation: homebrewFormulaOperationFixture({
      events,
      serviceInfo: readServiceInfo,
    }),
    inspectServiceFileIdentity: serviceFileIdentityFixture(
      () => "reviewed Homebrew executable\n",
      () => 501,
    ),
    platform: "darwin",
    spawnSyncImpl: (command, args, options) =>
      command === "/bin/launchctl"
        ? launchctl(args[1] ?? "", (options ?? {}) as Record<string, unknown>)
        : spawnResult(),
  };
}

const FIXED_GUIDANCE =
  "NemoClaw cannot verify the loaded Homebrew launchd job definition. Run `brew services stop openshell`, then rerun onboarding.";

describe("Homebrew launchd lifecycle state", () => {
  it("starts only from an exact unloaded state without calling stop (#9705)", () => {
    const events: string[] = [];
    const probeCalls: Array<{ domain: string; options: Record<string, unknown> }> = [];
    const result = startOpenShellGatewayUserService(
      trustedHomebrewOptions({
        events,
        launchctl: (domain, options) => {
          probeCalls.push({ domain, options });
          return launchctlAbsentResult();
        },
      }),
    );

    expect(result.started).toBe(true);
    expect(events).toContain("services start openshell");
    expect(events).not.toContain("services stop openshell");
    expect(events).not.toContain("services restart openshell");
    expect(probeCalls.map(({ domain }) => domain)).toEqual(
      expect.arrayContaining([`gui/501/${SERVICE_LABEL}`, `user/501/${SERVICE_LABEL}`]),
    );
    expect(probeCalls.length).toBeGreaterThanOrEqual(2);
    expect(probeCalls.every(({ options }) => options.stdio === "ignore")).toBe(true);
    expect(probeCalls.every(({ options }) => options.timeout === 10_000)).toBe(true);
    expect(
      probeCalls.every(
        ({ options }) => (options.env as NodeJS.ProcessEnv | undefined)?.LC_ALL === "C",
      ),
    ).toBe(true);
  });

  it("reports an exact unloaded service as already stopped without a mutation (#9705)", () => {
    const events: string[] = [];
    const result = stopOpenShellGatewayUserService(trustedHomebrewOptions({ events }));

    expect(result).toMatchObject({
      attempted: true,
      reason: "Homebrew service is already stopped.",
      stopped: true,
    });
    expect(events).not.toContain("services stop openshell");
  });

  it.each([
    ["missing registered", { registered: undefined }],
    ["string registered", { registered: "false" }],
    ["missing loaded", { loaded: undefined }],
    ["string loaded", { loaded: "false" }],
    ["missing running", { running: undefined }],
    ["string running", { running: "false" }],
    ["missing pid", { pid: undefined }],
    ["zero pid", { pid: 0 }],
    ["string pid", { pid: "0" }],
  ])("rejects an unloaded Homebrew row with %s (#9705)", (_case, override) => {
    const events: string[] = [];
    const prepareServiceEnv = vi.fn();
    const result = startOpenShellGatewayUserService({
      ...trustedHomebrewOptions({ events, serviceInfo: () => serviceInfo(override) }),
      prepareServiceEnv,
    });

    expect(result).toMatchObject({ started: false, standaloneFallbackBlocked: true });
    expect(prepareServiceEnv).not.toHaveBeenCalled();
    expect(events).not.toContain("services start openshell");
    expect(events).not.toContain("services stop openshell");
  });

  it.each([
    ["running", true],
    ["stopped but loaded", false],
  ])("rejects a %s Homebrew job without mutating it (#9705)", (_case, running) => {
    const startEvents: string[] = [];
    const prepareServiceEnv = vi.fn();
    const start = startOpenShellGatewayUserService({
      ...trustedHomebrewOptions({
        destinationState: () => "regular",
        events: startEvents,
        serviceInfo: () => loadedServiceInfo(running),
      }),
      prepareServiceEnv,
    });
    const stopEvents: string[] = [];
    const stop = stopOpenShellGatewayUserService(
      trustedHomebrewOptions({
        destinationState: () => "regular",
        events: stopEvents,
        serviceInfo: () => loadedServiceInfo(running),
      }),
    );

    expect(start).toMatchObject({ reason: FIXED_GUIDANCE, started: false });
    expect(stop).toMatchObject({ reason: FIXED_GUIDANCE, stopped: false });
    expect(prepareServiceEnv).not.toHaveBeenCalled();
    expect(startEvents).not.toContain("services stop openshell");
    expect(startEvents).not.toContain("services start openshell");
    expect(stopEvents).not.toContain("services stop openshell");
  });

  it.each([
    ["GUI job", [spawnResult(0, SECRET, SECRET)]],
    ["user job", [launchctlAbsentResult(), spawnResult(0, SECRET, SECRET)]],
    ["unexpected status", [launchctlAbsentResult(), spawnResult(7, SECRET, SECRET)]],
    ["missing status", [launchctlAbsentResult(), spawnResult(null, SECRET, SECRET)]],
    ["spawn error", [launchctlAbsentResult(), launchctlAbsentResult({ error: new Error(SECRET) })]],
    ["stdout output", [launchctlAbsentResult(), launchctlAbsentResult({ stdout: SECRET })]],
    ["stderr output", [launchctlAbsentResult(), launchctlAbsentResult({ stderr: SECRET })]],
    ["termination signal", [launchctlAbsentResult(), launchctlAbsentResult({ signal: "SIGTERM" })]],
    ["incomplete result", [launchctlAbsentResult(), { status: 113 }]],
  ] satisfies Array<[string, SpawnSyncLikeResult[]]>)(
    "rejects a launchctl probe that reports a %s (#9705)",
    (_case, probeResults) => {
      const events: string[] = [];
      let probeIndex = 0;
      const prepareServiceEnv = vi.fn();
      const result = startOpenShellGatewayUserService({
        ...trustedHomebrewOptions({
          events,
          launchctl: () => probeResults[probeIndex++] ?? launchctlAbsentResult(),
        }),
        prepareServiceEnv,
      });

      expect(result).toMatchObject({ reason: FIXED_GUIDANCE, started: false });
      expect(result.reason).not.toContain(SECRET);
      expect(prepareServiceEnv).not.toHaveBeenCalled();
      expect(events).not.toContain("services start openshell");
      expect(events).not.toContain("services stop openshell");
    },
  );

  it("rejects a launchctl invocation exception without exposing it (#9705)", () => {
    const result = startOpenShellGatewayUserService(
      trustedHomebrewOptions({
        launchctl: () => {
          throw new Error(SECRET);
        },
      }),
    );

    expect(result).toMatchObject({ reason: FIXED_GUIDANCE, started: false });
    expect(result.reason).not.toContain(SECRET);
  });

  it.each(["regular", "broken-symlink", "inaccessible"] as const)(
    "rejects a %s Homebrew destination plist before startup (#9705)",
    (destination) => {
      const events: string[] = [];
      const prepareServiceEnv = vi.fn();
      const result = startOpenShellGatewayUserService({
        ...trustedHomebrewOptions({ destinationState: () => destination, events }),
        prepareServiceEnv,
      });

      expect(result).toMatchObject({ reason: FIXED_GUIDANCE, started: false });
      expect(prepareServiceEnv).not.toHaveBeenCalled();
      expect(events).not.toContain("services start openshell");
    },
  );

  it.each(["regular", "broken-symlink", "inaccessible"] as const)(
    "rejects a %s Homebrew destination plist before reporting a stop (#9705)",
    (destination) => {
      const events: string[] = [];
      const result = stopOpenShellGatewayUserService(
        trustedHomebrewOptions({ destinationState: () => destination, events }),
      );

      expect(result).toMatchObject({ reason: FIXED_GUIDANCE, stopped: false });
      expect(events).not.toContain("services stop openshell");
    },
  );

  it("rejects a launchd job that appears after environment preparation (#9705)", () => {
    const events: string[] = [];
    let loaded = false;
    const preparePortForServiceStart = vi.fn();
    const result = startOpenShellGatewayUserService({
      ...trustedHomebrewOptions({
        events,
        launchctl: () => (loaded ? spawnResult(0) : launchctlAbsentResult()),
      }),
      preparePortForServiceStart,
      prepareServiceEnv: () => {
        loaded = true;
      },
    });

    expect(result).toMatchObject({ reason: FIXED_GUIDANCE, started: false });
    expect(preparePortForServiceStart).not.toHaveBeenCalled();
    expect(events).not.toContain("services start openshell");
  });

  it("rejects a destination plist that appears after port preparation (#9705)", () => {
    const events: string[] = [];
    let destination: HomebrewLaunchdDestinationState = "absent";
    const result = startOpenShellGatewayUserService({
      ...trustedHomebrewOptions({ destinationState: () => destination, events }),
      preparePortForServiceStart: () => {
        destination = "regular";
      },
    });

    expect(result).toMatchObject({ reason: FIXED_GUIDANCE, started: false });
    expect(events).not.toContain("services start openshell");
  });
});
