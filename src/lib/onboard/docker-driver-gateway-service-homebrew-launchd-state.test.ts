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
  openShellHomebrewServicePlistFixture,
  serviceFileIdentityFixture,
} from "./__test-helpers__/docker-driver-gateway-service";

const HOME = "/Users/nemoclaw";
const FORMULA_PREFIX = "/opt/homebrew/opt/openshell";
const SERVICE_LABEL = "homebrew.mxcl.openshell";
const SERVICE_COMMAND = `${FORMULA_PREFIX}/libexec/openshell-gateway-homebrew-service`;
const GATEWAY_BINARY = `${FORMULA_PREFIX}/bin/openshell-gateway`;
const FORMULA_PLIST = `${FORMULA_PREFIX}/${SERVICE_LABEL}.plist`;
const USER_PLIST = `${HOME}/Library/LaunchAgents/${SERVICE_LABEL}.plist`;
const PLIST_CONTENTS = openShellHomebrewServicePlistFixture(FORMULA_PREFIX);
const SECRET = "launchctl-secret-output";

function spawnResult(
  status: number | null = 0,
  stderr = "",
  stdout = "",
  error?: Error,
): SpawnSyncLikeResult {
  return { ...(error ? { error } : {}), status, stderr, stdout };
}

function serviceInfo(overrides: Record<string, unknown> = {}): SpawnSyncLikeResult {
  return spawnResult(
    0,
    "",
    JSON.stringify([
      {
        command: SERVICE_COMMAND,
        file: FORMULA_PLIST,
        loaded: false,
        loaded_file: null,
        name: "openshell",
        pid: null,
        registered: false,
        running: false,
        service_name: SERVICE_LABEL,
        ...overrides,
      },
    ]),
  );
}

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

type DestinationState = "absent" | "broken-symlink" | "inaccessible" | "regular";

interface HomebrewTestOptions {
  destinationState?: () => DestinationState;
  events?: string[];
  launchctl?: (domain: string, options: Record<string, unknown>) => SpawnSyncLikeResult;
  serviceInfo?: () => SpawnSyncLikeResult;
}

function trustedHomebrewOptions({
  destinationState = () => "absent",
  events = [],
  launchctl = () => spawnResult(113),
  serviceInfo: readServiceInfo = () => serviceInfo(),
}: HomebrewTestOptions = {}): OpenShellGatewayUserServiceOptions {
  let nextFileDescriptor = 10;
  const paths = new Map<number, string>();
  const offsets = new Map<number, number>();
  const stat = (candidate: string, symbolicLink = false) => ({
    ctimeNs: 31,
    dev: 17,
    ino: candidate === FORMULA_PLIST ? 23 : 24,
    isFile: () => true,
    isSymbolicLink: () => symbolicLink,
    mode: 0o644,
    mtimeNs: 29,
    nlink: 1,
    size: Buffer.byteLength(PLIST_CONTENTS),
    uid: 501,
  });
  const missing = (code: string): never => {
    throw Object.assign(new Error("launchd destination inspection failed"), { code });
  };
  return {
    closeSync: (fileDescriptor) => {
      paths.delete(fileDescriptor);
      offsets.delete(fileDescriptor);
    },
    commandExists: (command) => command === "brew",
    env: { HOME },
    existsSync: (candidate) =>
      [FORMULA_PLIST, USER_PLIST, SERVICE_COMMAND, GATEWAY_BINARY].includes(candidate),
    fstatSync: (fileDescriptor) => stat(paths.get(fileDescriptor) ?? FORMULA_PLIST),
    getuid: () => 501,
    home: HOME,
    homebrewFormulaOperation: (args) => {
      const operation = args.join(" ");
      events.push(operation);
      return args[0] === "info"
        ? spawnResult(
            0,
            "",
            JSON.stringify({ formulae: [{ name: "openshell", tap: "nvidia/openshell" }] }),
          )
        : args[0] === "--prefix"
          ? spawnResult(0, "", FORMULA_PREFIX)
          : args[0] === "services" && args[1] === "info"
            ? readServiceInfo()
            : spawnResult();
    },
    inspectServiceFileIdentity: serviceFileIdentityFixture(
      () => "reviewed Homebrew executable\n",
      () => 501,
    ),
    lstatSync: ((candidate: string) => {
      const state = destinationState();
      return candidate !== USER_PLIST
        ? stat(candidate)
        : state === "absent"
          ? missing("ENOENT")
          : state === "inaccessible"
            ? missing("EACCES")
            : stat(candidate, state === "broken-symlink");
    }) as never,
    openSync: (filePath) => {
      const fileDescriptor = nextFileDescriptor++;
      paths.set(fileDescriptor, filePath);
      return fileDescriptor;
    },
    platform: "darwin",
    readSync: (fileDescriptor, buffer, offset, length) => {
      const contents = Buffer.from(PLIST_CONTENTS);
      const contentOffset = offsets.get(fileDescriptor) ?? 0;
      const count = Math.max(0, Math.min(length, contents.length - contentOffset));
      contents.copy(buffer, offset, contentOffset, contentOffset + count);
      offsets.set(fileDescriptor, contentOffset + count);
      return count;
    },
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
          return spawnResult(113, SECRET, SECRET);
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
    ["user job", [spawnResult(113), spawnResult(0, SECRET, SECRET)]],
    ["unexpected status", [spawnResult(113), spawnResult(7, SECRET, SECRET)]],
    ["missing status", [spawnResult(113), spawnResult(null, SECRET, SECRET)]],
    ["spawn error", [spawnResult(113), spawnResult(113, SECRET, SECRET, new Error(SECRET))]],
  ] satisfies Array<[string, SpawnSyncLikeResult[]]>)(
    "rejects a launchctl probe that reports a %s (#9705)",
    (_case, probeResults) => {
      const events: string[] = [];
      let probeIndex = 0;
      const prepareServiceEnv = vi.fn();
      const result = startOpenShellGatewayUserService({
        ...trustedHomebrewOptions({
          events,
          launchctl: () => probeResults[probeIndex++] ?? spawnResult(113),
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

  it("rejects a launchd job that appears after environment preparation (#9705)", () => {
    const events: string[] = [];
    let loaded = false;
    const preparePortForServiceStart = vi.fn();
    const result = startOpenShellGatewayUserService({
      ...trustedHomebrewOptions({
        events,
        launchctl: () => spawnResult(loaded ? 0 : 113),
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
    let destination: DestinationState = "absent";
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
