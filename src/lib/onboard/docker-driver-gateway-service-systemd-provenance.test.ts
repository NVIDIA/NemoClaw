// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { expect, it, vi } from "vitest";

import {
  NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER,
  type OpenShellGatewayUserServiceOptions,
  type SpawnSyncLike,
  type SpawnSyncLikeResult,
  startOpenShellGatewayUserService,
  stopOpenShellGatewayUserService,
} from "./docker-driver-gateway-service";
import { nemoclawGatewaySystemdUnitFixture } from "./__test-helpers__/docker-driver-gateway-service-test-fixture";

const HOME = "/home/nvidia";
const NEMOCLAW_UNIT = `${HOME}/.config/systemd/user/nemoclaw-openshell-gateway.service`;
const NEMOCLAW_GATEWAY = `${HOME}/.local/bin/openshell-gateway`;
const SYSTEM_LOCAL_GATEWAY = "/usr/local/bin/openshell-gateway";
const PACKAGE_UNIT = "/usr/lib/systemd/user/openshell-gateway.service";
const PACKAGE_GATEWAY = "/usr/bin/openshell-gateway";
const NEMOCLAW_PRE_START = `{ path=${NEMOCLAW_GATEWAY} ; argv[]=${NEMOCLAW_GATEWAY} generate-certs --output-dir \${OPENSHELL_LOCAL_TLS_DIR} --server-san host.openshell.internal ; ignore_errors=no ; }`;
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
] as const;

function spawnResult(status = 0, stderr = "", stdout = ""): SpawnSyncLikeResult {
  return { status, stderr, stdout };
}

function fileStat(
  uid: number,
  ino = 1,
  symlink = false,
  changedTimeNanoseconds = "1",
  mode = 0o755,
) {
  return {
    dev: 7,
    ino,
    isFile: () => !symlink,
    isSymbolicLink: () => symlink,
    mode,
    changedTimeNanoseconds,
    uid,
  };
}

function serviceFileIdentitySeam(
  statForPath: (candidate: string) => ReturnType<typeof fileStat>,
  contentsForPath: (candidate: string) => string = (candidate) =>
    candidate === NEMOCLAW_UNIT
      ? nemoclawGatewaySystemdUnitFixture(NEMOCLAW_GATEWAY)
      : `${candidate}\n`,
): NonNullable<OpenShellGatewayUserServiceOptions["inspectServiceFileIdentity"]> {
  return (options) => {
    const stat = statForPath(options.filePath);
    const rejected =
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.uid !== options.expectedUid ||
      ((options.requiredModeBits ?? 0) & stat.mode) !== (options.requiredModeBits ?? 0);
    const source = contentsForPath(options.filePath);
    const contents = Buffer.from(source);
    const tooLarge = options.contentsLimit !== undefined && contents.length > options.contentsLimit;
    const hashed = options.hashContents === true || options.contentsLimit !== undefined;
    return rejected || tooLarge
      ? null
      : {
          ...(options.contentsLimit === undefined ? {} : { contents }),
          identity: {
            changedTimeNanoseconds: stat.changedTimeNanoseconds,
            ...(hashed
              ? { contentSha256: createHash("sha256").update(contents).digest("hex") }
              : {}),
            device: String(stat.dev),
            inode: String(stat.ino),
            linkCount: "1",
            mode: stat.mode,
            modifiedTimeNanoseconds: stat.changedTimeNanoseconds,
            owner: stat.uid,
            size: String(contents.length),
          },
        };
  };
}

function systemdSnapshot(
  fragmentPath: string,
  executablePath: string,
  overrides: Partial<Record<(typeof SYSTEMD_IDENTITY_PROPERTIES)[number], string>> = {},
): string {
  const properties = {
    FragmentPath: fragmentPath,
    ExecStart: `{ path=${executablePath} ; argv[]=${executablePath} ; ignore_errors=no ; }`,
    DropInPaths: "",
    ExecCondition: "",
    ExecStartPre: fragmentPath === NEMOCLAW_UNIT ? NEMOCLAW_PRE_START : "",
    ExecStartPost: "",
    ExecReload: "",
    ExecStop: "",
    ExecStopPost: "",
    ...overrides,
  };
  return SYSTEMD_IDENTITY_PROPERTIES.map((property) => `${property}=${properties[property]}`).join(
    "\n",
  );
}

function trustedLstat(candidate: string) {
  return candidate.startsWith("/usr/") ? fileStat(0) : fileStat(1000);
}

function nemoclawOptions(spawnSyncImpl: SpawnSyncLike) {
  return {
    commandExists: (command: string) => command === "systemctl",
    env: { HOME },
    existsSync: (candidate: string) => candidate === NEMOCLAW_UNIT,
    getuid: () => 1000,
    home: HOME,
    inspectServiceFileIdentity: serviceFileIdentitySeam(trustedLstat),
    lstatSync: trustedLstat as never,
    platform: "linux" as const,
    readFileSync: () => `# ${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER}\n`,
    spawnSyncImpl,
  };
}

function packageOptions(spawnSyncImpl: SpawnSyncLike, lstatSync = trustedLstat) {
  return {
    commandExists: (command: string) => command === "systemctl",
    env: { HOME },
    existsSync: (candidate: string) => candidate === PACKAGE_UNIT,
    getUpstreamGatewayVersion: () => "0.0.85",
    getUpstreamGatewayVersionBounds: () => ({ max: "0.0.85", min: "0.0.85" }),
    getuid: () => 1000,
    home: HOME,
    inspectServiceFileIdentity: serviceFileIdentitySeam(lstatSync),
    lstatSync: lstatSync as never,
    platform: "linux" as const,
    spawnSyncImpl,
  };
}

it("uses one complete effective systemd snapshot before service state changes (#9705)", () => {
  const events: string[] = [];
  const spawnSyncImpl = vi.fn((_command: string, args: string[]) => {
    events.push(args.slice(1).join(" "));
    return args.includes("show")
      ? spawnResult(0, "", systemdSnapshot(NEMOCLAW_UNIT, NEMOCLAW_GATEWAY))
      : spawnResult();
  });

  const result = startOpenShellGatewayUserService(nemoclawOptions(spawnSyncImpl));

  expect(result.started).toBe(true);
  expect(events[0]).toContain("show nemoclaw-openshell-gateway");
  expect(events[0]).toContain("--property=DropInPaths");
  expect(events[0]).toContain("--property=ExecStopPost");
  expect(events.indexOf("daemon-reload")).toBeGreaterThan(0);
});

it("binds the complete gateway executable content before systemd mutations (#9705)", () => {
  const events: string[] = [];
  const inspected: Array<{ filePath: string; hashContents?: boolean }> = [];
  const inspect = serviceFileIdentitySeam(trustedLstat);
  const spawnSyncImpl = vi.fn((_command: string, args: string[]) => {
    events.push(args.slice(1).join(" "));
    return args.includes("show")
      ? spawnResult(0, "", systemdSnapshot(NEMOCLAW_UNIT, NEMOCLAW_GATEWAY))
      : spawnResult();
  });

  const result = startOpenShellGatewayUserService({
    ...nemoclawOptions(spawnSyncImpl),
    inspectServiceFileIdentity: (options) => {
      inspected.push(options);
      return inspect(options);
    },
  });

  expect(result.started).toBe(true);
  expect(inspected.filter(({ filePath }) => filePath === NEMOCLAW_GATEWAY)).not.toHaveLength(0);
  expect(
    inspected
      .filter(({ filePath }) => filePath === NEMOCLAW_GATEWAY)
      .every(({ hashContents }) => hashContents === true),
  ).toBe(true);
});

it("accepts a current-user-owned system-local executable staged by the installer (#9705)", () => {
  const systemLocalPreStart = `{ path=${SYSTEM_LOCAL_GATEWAY} ; argv[]=${SYSTEM_LOCAL_GATEWAY} generate-certs --output-dir \${OPENSHELL_LOCAL_TLS_DIR} --server-san host.openshell.internal ; ignore_errors=no ; }`;
  const currentUserOwnedSystemLocalFile = (candidate: string) =>
    fileStat(candidate === NEMOCLAW_UNIT || candidate === SYSTEM_LOCAL_GATEWAY ? 1000 : 0);
  const spawnSyncImpl = vi.fn((_command: string, args: string[]) =>
    args.includes("show")
      ? spawnResult(
          0,
          "",
          systemdSnapshot(NEMOCLAW_UNIT, SYSTEM_LOCAL_GATEWAY, {
            ExecStartPre: systemLocalPreStart,
          }),
        )
      : spawnResult(),
  );

  const result = startOpenShellGatewayUserService({
    ...nemoclawOptions(spawnSyncImpl),
    inspectServiceFileIdentity: serviceFileIdentitySeam(
      currentUserOwnedSystemLocalFile,
      (candidate) =>
        candidate === NEMOCLAW_UNIT
          ? nemoclawGatewaySystemdUnitFixture(SYSTEM_LOCAL_GATEWAY)
          : `${candidate}\n`,
    ),
    lstatSync: currentUserOwnedSystemLocalFile as never,
  });

  expect(result.started).toBe(true);
});

it.each([
  ["omits ignore_errors", `{ path=${NEMOCLAW_GATEWAY} ; argv[]=${NEMOCLAW_GATEWAY} ; }`],
  [
    "allows ignored failures",
    `{ path=${NEMOCLAW_GATEWAY} ; argv[]=${NEMOCLAW_GATEWAY} ; ignore_errors=yes ; }`,
  ],
  [
    "duplicates ignore_errors",
    `{ path=${NEMOCLAW_GATEWAY} ; argv[]=${NEMOCLAW_GATEWAY} ; ignore_errors=no ; ignore_errors=no ; }`,
  ],
] as const)("rejects an ExecStart that %s (#9705)", (_case, execStart) => {
  const events: string[] = [];
  const spawnSyncImpl = vi.fn((_command: string, args: string[]) => {
    events.push(args.slice(1).join(" "));
    return args.includes("show")
      ? spawnResult(
          0,
          "",
          systemdSnapshot(NEMOCLAW_UNIT, NEMOCLAW_GATEWAY, { ExecStart: execStart }),
        )
      : spawnResult();
  });

  const result = startOpenShellGatewayUserService(nemoclawOptions(spawnSyncImpl));

  expect(result).toMatchObject({ started: false, standaloneFallbackBlocked: true });
  expect(events.some((event) => /^(daemon-reload|stop|enable|restart)/u.test(event))).toBe(false);
});

it("rejects a marker-bearing NemoClaw unit whose complete definition differs (#9705)", () => {
  const events: string[] = [];
  const spawnSyncImpl = vi.fn((_command: string, args: string[]) => {
    events.push(args.slice(1).join(" "));
    return args.includes("show")
      ? spawnResult(0, "", systemdSnapshot(NEMOCLAW_UNIT, NEMOCLAW_GATEWAY))
      : spawnResult();
  });
  const hostileContents = (candidate: string) =>
    candidate === NEMOCLAW_UNIT
      ? nemoclawGatewaySystemdUnitFixture(NEMOCLAW_GATEWAY).replace(
          "[Service]\n",
          "[Service]\nEnvironment=LD_PRELOAD=/tmp/hostile.so\n",
        )
      : `${candidate}\n`;

  const result = startOpenShellGatewayUserService({
    ...nemoclawOptions(spawnSyncImpl),
    inspectServiceFileIdentity: serviceFileIdentitySeam(trustedLstat, hostileContents),
  });

  expect(result).toMatchObject({ started: false, standaloneFallbackBlocked: true });
  expect(events.some((event) => /^(daemon-reload|stop|enable|restart)/u.test(event))).toBe(false);
});

it("rejects a NemoClaw pre-start command that ignores failures (#9705)", () => {
  const events: string[] = [];
  const spawnSyncImpl = vi.fn((_command: string, args: string[]) => {
    events.push(args.slice(1).join(" "));
    return args.includes("show")
      ? spawnResult(
          0,
          "",
          systemdSnapshot(NEMOCLAW_UNIT, NEMOCLAW_GATEWAY, {
            ExecStartPre: NEMOCLAW_PRE_START.replace("ignore_errors=no", "ignore_errors=yes"),
          }),
        )
      : spawnResult();
  });

  const result = startOpenShellGatewayUserService(nemoclawOptions(spawnSyncImpl));

  expect(result).toMatchObject({ started: false, standaloneFallbackBlocked: true });
  expect(events.some((event) => /^(daemon-reload|stop|enable|restart)/u.test(event))).toBe(false);
});

it.each([
  [
    "a drop-in",
    "DropInPaths",
    "/home/nvidia/.config/systemd/user/openshell-gateway.service.d/override.conf",
  ],
  [
    "a condition hook",
    "ExecCondition",
    "{ path=/tmp/condition ; argv[]=/tmp/condition ; ignore_errors=no ; }",
  ],
  [
    "a different start-pre hook",
    "ExecStartPre",
    "{ path=/tmp/pre ; argv[]=/tmp/pre ; ignore_errors=no ; }",
  ],
  [
    "a start-post hook",
    "ExecStartPost",
    "{ path=/tmp/post ; argv[]=/tmp/post ; ignore_errors=no ; }",
  ],
  ["a reload hook", "ExecReload", "{ path=/tmp/reload ; argv[]=/tmp/reload ; ignore_errors=no ; }"],
  ["a stop hook", "ExecStop", "{ path=/tmp/stop ; argv[]=/tmp/stop ; ignore_errors=no ; }"],
  [
    "a stop-post hook",
    "ExecStopPost",
    "{ path=/tmp/post ; argv[]=/tmp/post ; ignore_errors=no ; }",
  ],
] as const)("rejects a systemd service that has %s (#9705)", (_case, property, value) => {
  const events: string[] = [];
  const spawnSyncImpl = vi.fn((_command: string, args: string[]) => {
    events.push(args.slice(1).join(" "));
    return args.includes("show")
      ? spawnResult(0, "", systemdSnapshot(NEMOCLAW_UNIT, NEMOCLAW_GATEWAY, { [property]: value }))
      : spawnResult();
  });

  const result = startOpenShellGatewayUserService(nemoclawOptions(spawnSyncImpl));

  expect(result).toMatchObject({ started: false, standaloneFallbackBlocked: true });
  expect(events.some((event) => /^(daemon-reload|stop|enable|restart)/u.test(event))).toBe(false);
});

it.each([
  ["is missing", ""],
  [
    "uses a different output directory",
    `{ path=${NEMOCLAW_GATEWAY} ; argv[]=${NEMOCLAW_GATEWAY} generate-certs --output-dir /tmp/tls --server-san host.openshell.internal ; ignore_errors=no ; }`,
  ],
  [
    "uses a different executable",
    `{ path=/tmp/openshell-gateway ; argv[]=/tmp/openshell-gateway generate-certs --output-dir \${OPENSHELL_LOCAL_TLS_DIR} --server-san host.openshell.internal ; ignore_errors=no ; }`,
  ],
] as const)("rejects a NemoClaw unit whose pre-start command %s (#9705)", (_case, value) => {
  const events: string[] = [];
  const spawnSyncImpl = vi.fn((_command: string, args: string[]) => {
    events.push(args.slice(1).join(" "));
    return args.includes("show")
      ? spawnResult(
          0,
          "",
          systemdSnapshot(NEMOCLAW_UNIT, NEMOCLAW_GATEWAY, { ExecStartPre: value }),
        )
      : spawnResult();
  });

  const result = startOpenShellGatewayUserService(nemoclawOptions(spawnSyncImpl));

  expect(result).toMatchObject({ started: false, standaloneFallbackBlocked: true });
  expect(events.some((event) => /^(daemon-reload|stop|enable|restart)/u.test(event))).toBe(false);
});

it("rejects a package unit that defines a pre-start command (#9705)", () => {
  const events: string[] = [];
  const spawnSyncImpl = vi.fn((_command: string, args: string[]) => {
    events.push(args.slice(1).join(" "));
    return args.includes("show")
      ? spawnResult(
          0,
          "",
          systemdSnapshot(PACKAGE_UNIT, PACKAGE_GATEWAY, {
            ExecStartPre: `{ path=${PACKAGE_GATEWAY} ; argv[]=${PACKAGE_GATEWAY} generate-certs ; ignore_errors=no ; }`,
          }),
        )
      : spawnResult();
  });

  expect(() => startOpenShellGatewayUserService(packageOptions(spawnSyncImpl))).toThrow(
    "Could not verify the effective OpenShell gateway user service",
  );
  expect(events.some((event) => /^(daemon-reload|stop|enable|restart)/u.test(event))).toBe(false);
});

it.each([
  ["unit has a non-root owner", PACKAGE_UNIT, fileStat(1000)],
  ["unit is a symbolic link", PACKAGE_UNIT, fileStat(0, 1, true)],
  ["binary has a non-root owner", PACKAGE_GATEWAY, fileStat(1000)],
  ["binary is a symbolic link", PACKAGE_GATEWAY, fileStat(0, 1, true)],
] as const)("rejects a package service whose %s (#9705)", (_case, hostilePath, hostileStat) => {
  const events: string[] = [];
  const spawnSyncImpl = vi.fn((_command: string, args: string[]) => {
    events.push(args.slice(1).join(" "));
    return args.includes("show")
      ? spawnResult(0, "", systemdSnapshot(PACKAGE_UNIT, PACKAGE_GATEWAY))
      : spawnResult();
  });

  expect(() =>
    startOpenShellGatewayUserService(
      packageOptions(spawnSyncImpl, (candidate) =>
        candidate === hostilePath ? hostileStat : trustedLstat(candidate),
      ),
    ),
  ).toThrow("Could not verify the effective OpenShell gateway user service");
  expect(events.some((event) => /^(daemon-reload|stop|enable|restart)/u.test(event))).toBe(false);
});

it.each([
  ["has a different owner", fileStat(0)],
  ["is a symbolic link", fileStat(1000, 1, true)],
] as const)("rejects a user gateway binary that %s (#9705)", (_case, hostileStat) => {
  const events: string[] = [];
  const spawnSyncImpl = vi.fn((_command: string, args: string[]) => {
    events.push(args.slice(1).join(" "));
    return args.includes("show")
      ? spawnResult(0, "", systemdSnapshot(NEMOCLAW_UNIT, NEMOCLAW_GATEWAY))
      : spawnResult();
  });
  const hostileLstat = (candidate: string) =>
    candidate === NEMOCLAW_GATEWAY ? hostileStat : trustedLstat(candidate);

  const result = startOpenShellGatewayUserService({
    ...nemoclawOptions(spawnSyncImpl),
    inspectServiceFileIdentity: serviceFileIdentitySeam(hostileLstat),
    lstatSync: hostileLstat as never,
  });

  expect(result).toMatchObject({ started: false, standaloneFallbackBlocked: true });
  expect(events.some((event) => /^(daemon-reload|stop|enable|restart)/u.test(event))).toBe(false);
});

it("rejects a service descriptor swap before environment preparation (#9705)", () => {
  const events: string[] = [];
  const prepareServiceEnv = vi.fn();
  const spawnSyncImpl = vi.fn((_command: string, args: string[]) => {
    events.push(args.slice(1).join(" "));
    return args.includes("show")
      ? spawnResult(0, "", systemdSnapshot(NEMOCLAW_UNIT, NEMOCLAW_GATEWAY))
      : spawnResult();
  });
  const options = nemoclawOptions(spawnSyncImpl);
  const swappedLstat = (candidate: string) =>
    candidate === NEMOCLAW_UNIT
      ? fileStat(1000, events.includes("daemon-reload") ? 2 : 1)
      : trustedLstat(candidate);

  const result = startOpenShellGatewayUserService({
    ...options,
    inspectServiceFileIdentity: serviceFileIdentitySeam(swappedLstat),
    lstatSync: swappedLstat as never,
    prepareServiceEnv,
  });

  expect(result).toMatchObject({
    reason: "service identity changed before lifecycle mutation",
    started: false,
    standaloneFallbackBlocked: true,
  });
  expect(events).toContain("daemon-reload");
  expect(prepareServiceEnv).not.toHaveBeenCalled();
  expect(events.some((event) => event.startsWith("stop "))).toBe(false);
});

it.each([
  ["service descriptor", NEMOCLAW_UNIT],
  ["gateway executable", NEMOCLAW_GATEWAY],
] as const)(
  "rejects a same-inode %s change before environment preparation (#9705)",
  (_case, changedPath) => {
    const events: string[] = [];
    const prepareServiceEnv = vi.fn();
    const spawnSyncImpl = vi.fn((_command: string, args: string[]) => {
      events.push(args.slice(1).join(" "));
      return args.includes("show")
        ? spawnResult(0, "", systemdSnapshot(NEMOCLAW_UNIT, NEMOCLAW_GATEWAY))
        : spawnResult();
    });
    const changedSameInode = (candidate: string) => {
      const stat = trustedLstat(candidate);
      return candidate === changedPath && events.includes("daemon-reload")
        ? fileStat(stat.uid, stat.ino, false, "2", stat.mode)
        : stat;
    };

    const result = startOpenShellGatewayUserService({
      ...nemoclawOptions(spawnSyncImpl),
      inspectServiceFileIdentity: serviceFileIdentitySeam(changedSameInode),
      prepareServiceEnv,
    });

    expect(result).toMatchObject({
      reason: "service identity changed before lifecycle mutation",
      started: false,
      standaloneFallbackBlocked: true,
    });
    expect(prepareServiceEnv).not.toHaveBeenCalled();
    expect(events.some((event) => event.startsWith("stop "))).toBe(false);
  },
);

it("rejects a service descriptor whose pathname changes during inspection (#9705)", () => {
  const events: string[] = [];
  const spawnSyncImpl = vi.fn((_command: string, args: string[]) => {
    events.push(args.slice(1).join(" "));
    return args.includes("show")
      ? spawnResult(0, "", systemdSnapshot(NEMOCLAW_UNIT, NEMOCLAW_GATEWAY))
      : spawnResult();
  });
  const inspected = serviceFileIdentitySeam(trustedLstat);

  const result = startOpenShellGatewayUserService({
    ...nemoclawOptions(spawnSyncImpl),
    inspectServiceFileIdentity: (options) =>
      options.filePath === NEMOCLAW_UNIT ? null : inspected(options),
  });

  expect(result).toMatchObject({ started: false, standaloneFallbackBlocked: true });
  expect(events.some((event) => /^(daemon-reload|stop|enable|restart)/u.test(event))).toBe(false);
});

it("revalidates a package service after the version probe and before stop (#9705)", () => {
  const events: string[] = [];
  let versionProbeCount = 0;
  const spawnSyncImpl = vi.fn((_command: string, args: string[]) => {
    events.push(args.slice(1).join(" "));
    const snapshot =
      versionProbeCount >= 2
        ? systemdSnapshot("/tmp/foreign.service", PACKAGE_GATEWAY)
        : systemdSnapshot(PACKAGE_UNIT, PACKAGE_GATEWAY);
    return args.includes("show") ? spawnResult(0, "", snapshot) : spawnResult();
  });

  const result = stopOpenShellGatewayUserService({
    ...packageOptions(spawnSyncImpl),
    getUpstreamGatewayVersion: () => {
      versionProbeCount += 1;
      return "0.0.85";
    },
  });

  expect(result).toMatchObject({
    reason: "service identity changed before stop",
    standaloneFallbackBlocked: true,
    stopped: false,
  });
  expect(events.some((event) => event.startsWith("stop "))).toBe(false);
});

it("rejects a competing descriptor swap before unlink (#9705)", () => {
  const events: string[] = [];
  const rmSync = vi.fn();
  const spawnSyncImpl = vi.fn((_command: string, args: string[]) => {
    events.push(args.slice(1).join(" "));
    const serviceName = args[args.indexOf("show") + 1];
    const snapshot =
      serviceName === "nemoclaw-openshell-gateway"
        ? systemdSnapshot(NEMOCLAW_UNIT, NEMOCLAW_GATEWAY)
        : systemdSnapshot(PACKAGE_UNIT, PACKAGE_GATEWAY);
    return args.includes("show") ? spawnResult(0, "", snapshot) : spawnResult();
  });
  const swappedLstat = (candidate: string) =>
    candidate === NEMOCLAW_UNIT
      ? fileStat(1000, events.includes("disable --now nemoclaw-openshell-gateway") ? 2 : 1)
      : trustedLstat(candidate);

  const result = startOpenShellGatewayUserService({
    ...packageOptions(spawnSyncImpl),
    inspectServiceFileIdentity: serviceFileIdentitySeam(swappedLstat),
    existsSync: (candidate) => candidate === PACKAGE_UNIT || candidate === NEMOCLAW_UNIT,
    lstatSync: swappedLstat as never,
    readFileSync: () => `# ${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER}\n`,
    rmSync: rmSync as never,
  });

  expect(events).toContain("disable --now nemoclaw-openshell-gateway");
  expect(rmSync).not.toHaveBeenCalled();
  expect(result).toMatchObject({ started: false, standaloneFallbackBlocked: true });
});
