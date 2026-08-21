// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

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

const USER_HOME = "/Users/nemoclaw";
const FORMULA_PREFIX = "/opt/homebrew/opt/openshell";
const GATEWAY_BINARY = `${FORMULA_PREFIX}/bin/openshell-gateway`;
const SERVICE_COMMAND = `${FORMULA_PREFIX}/libexec/openshell-gateway-homebrew-service`;
const FORMULA_PLIST = `${FORMULA_PREFIX}/homebrew.mxcl.openshell.plist`;
const USER_PLIST = `${USER_HOME}/Library/LaunchAgents/homebrew.mxcl.openshell.plist`;
const CURRENT_UID = 501;

type DescriptorStat = {
  ctimeNs: number;
  dev: number;
  ino: number;
  isFile: () => boolean;
  isSymbolicLink: () => boolean;
  mode: number;
  mtimeNs: number;
  nlink: number;
  size: number;
  uid: number;
};

function result(status = 0, stdout = ""): SpawnSyncLikeResult {
  return { status, stderr: "", stdout };
}

function descriptorStat({
  device = 17,
  file = true,
  inode = 23,
  mode = 0o644,
  size = trustedPlist().length,
  symbolicLink = false,
  uid = CURRENT_UID,
}: {
  device?: number;
  file?: boolean;
  inode?: number;
  mode?: number;
  size?: number;
  symbolicLink?: boolean;
  uid?: number;
} = {}): DescriptorStat {
  return {
    ctimeNs: 31,
    dev: device,
    ino: inode,
    isFile: () => file,
    isSymbolicLink: () => symbolicLink,
    mode,
    mtimeNs: 29,
    nlink: 1,
    size,
    uid,
  };
}

function trustedDescriptorStat(candidate: string, size: number): DescriptorStat {
  return candidate === FORMULA_PLIST
    ? descriptorStat({ size })
    : descriptorStat({ device: 18, inode: 24, size });
}

function throwSymlinkOpenFailure(): never {
  throw new Error("ELOOP");
}

function serviceInfo(running: boolean): SpawnSyncLikeResult {
  const effectivePlist = running ? USER_PLIST : FORMULA_PLIST;
  return result(
    0,
    JSON.stringify([
      {
        command: SERVICE_COMMAND,
        file: effectivePlist,
        loaded: running,
        loaded_file: running ? effectivePlist : null,
        name: "openshell",
        pid: running ? 4242 : null,
        registered: running,
        running,
        service_name: "homebrew.mxcl.openshell",
      },
    ]),
  );
}

function trustedPlist(extra = ""): string {
  return openShellHomebrewServicePlistFixture(FORMULA_PREFIX).replace(
    "</dict>\n</plist>",
    `${extra}\n</dict>\n</plist>`,
  );
}

const HOSTILE_ENVIRONMENT = [
  "<key>EnvironmentVariables</key>",
  "<dict>",
  "<key>OPENAI_API_KEY</key>",
  "<string>attacker-controlled</string>",
  "</dict>",
].join("\n");

const EXTRA_ARGUMENT = "<string>--config=/tmp/attacker-controlled.toml</string>";
const EXTRA_PROGRAM_ARGUMENTS = trustedPlist().replace(
  `<string>${SERVICE_COMMAND}</string>\n</array>`,
  `<string>${SERVICE_COMMAND}</string>\n${EXTRA_ARGUMENT}\n</array>`,
);

function formulaOperation(
  running: () => boolean,
  setRunning: (running: boolean) => void,
  events: string[],
): (args: string[]) => SpawnSyncLikeResult {
  return (args) => {
    const command = args.join(" ");
    events.push(command);
    const response =
      args[0] === "list"
        ? result()
        : args[0] === "info"
          ? result(
              0,
              JSON.stringify({ formulae: [{ name: "openshell", tap: "nvidia/openshell" }] }),
            )
          : args[0] === "--prefix"
            ? result(0, FORMULA_PREFIX)
            : args[0] === "services" && args[1] === "info"
              ? serviceInfo(running())
              : result();
    setRunning(command === "services stop openshell" ? false : running());
    return response;
  };
}

function homebrewOptions(
  events: string[],
  overrides: Pick<
    OpenShellGatewayUserServiceOptions,
    "getuid" | "lstatSync" | "preparePortForServiceStart" | "prepareServiceEnv" | "readFileSync"
  > = {},
  initiallyRunning = true,
): OpenShellGatewayUserServiceOptions {
  let running = initiallyRunning;
  let nextFileDescriptor = 10;
  const descriptorPaths = new Map<number, string>();
  const descriptorOffsets = new Map<number, number>();
  const descriptorContents = new Map<number, Buffer>();
  const inspectContents = overrides.readFileSync ?? (() => trustedPlist());
  const inspectStat =
    overrides.lstatSync ??
    ((candidate: string) =>
      trustedDescriptorStat(candidate, Buffer.byteLength(inspectContents(candidate, "utf8"))));
  return {
    closeSync: (fileDescriptor) => {
      descriptorPaths.delete(fileDescriptor);
      descriptorOffsets.delete(fileDescriptor);
      descriptorContents.delete(fileDescriptor);
    },
    commandExists: (command) => command === "brew",
    existsSync: (candidate) =>
      [FORMULA_PLIST, GATEWAY_BINARY, SERVICE_COMMAND, USER_PLIST].includes(candidate),
    getuid: () => CURRENT_UID,
    home: USER_HOME,
    homebrewFormulaOperation: formulaOperation(
      () => running,
      (next) => {
        running = next;
      },
      events,
    ),
    inspectServiceFileIdentity: serviceFileIdentityFixture(
      () => "reviewed Homebrew executable\n",
      () => CURRENT_UID,
    ),
    fstatSync: ((fileDescriptor: number) =>
      inspectStat(descriptorPaths.get(fileDescriptor) ?? "")) as never,
    lstatSync: inspectStat as never,
    openSync: (candidate) => {
      inspectStat(candidate).isSymbolicLink() ? throwSymlinkOpenFailure() : undefined;
      const fileDescriptor = nextFileDescriptor;
      nextFileDescriptor += 1;
      descriptorPaths.set(fileDescriptor, candidate);
      return fileDescriptor;
    },
    platform: "darwin",
    readSync: (fileDescriptor, buffer, offset, length) => {
      const contents =
        descriptorContents.get(fileDescriptor) ??
        Buffer.from(inspectContents(descriptorPaths.get(fileDescriptor) ?? "", "utf8"));
      descriptorContents.set(fileDescriptor, contents);
      const contentOffset = descriptorOffsets.get(fileDescriptor) ?? 0;
      const count = Math.max(0, Math.min(length, contents.length - contentOffset));
      contents.copy(buffer, offset, contentOffset, contentOffset + count);
      descriptorOffsets.set(fileDescriptor, contentOffset + count);
      return count;
    },
    readFileSync: () => trustedPlist(),
    ...overrides,
  };
}

describe("OpenShell launchd service identity", () => {
  it.each([
    ["a symlink", descriptorStat({ symbolicLink: true })],
    ["owned by another user", descriptorStat({ uid: CURRENT_UID + 1 })],
    ["not a regular file", descriptorStat({ file: false })],
  ])("rejects a loaded Homebrew service plist that is %s (#9705)", (_case, invalidStat) => {
    const events: string[] = [];
    const outcome = stopOpenShellGatewayUserService(
      homebrewOptions(events, {
        lstatSync: ((candidate: string) =>
          candidate === USER_PLIST ? invalidStat : descriptorStat()) as never,
      }),
    );

    expect(outcome).toMatchObject({
      attempted: true,
      standaloneFallbackBlocked: true,
      stopped: false,
    });
    expect(events).not.toContain("services stop openshell");
  });

  it.each([
    ["a symlink", descriptorStat({ symbolicLink: true })],
    ["owned by another user", descriptorStat({ uid: CURRENT_UID + 1 })],
    ["not a regular file", descriptorStat({ file: false })],
  ])("rejects an unloaded Homebrew formula plist that is %s (#9705)", (_case, invalidStat) => {
    const events: string[] = [];
    const outcome = startOpenShellGatewayUserService(
      homebrewOptions(
        events,
        {
          lstatSync: ((candidate: string) =>
            candidate === FORMULA_PLIST ? invalidStat : descriptorStat()) as never,
        },
        false,
      ),
    );

    expect(events).not.toContain("services stop openshell");
    expect(events).not.toContain("services start openshell");
    expect(outcome).toMatchObject({ attempted: true, started: false });
  });

  it.each([
    ["EnvironmentVariables", trustedPlist(HOSTILE_ENVIRONMENT)],
    ["extra ProgramArguments", EXTRA_PROGRAM_ARGUMENTS],
  ])("rejects a loaded Homebrew service plist with %s (#9705)", (_case, plist) => {
    const events: string[] = [];
    const outcome = stopOpenShellGatewayUserService(
      homebrewOptions(events, {
        readFileSync: (candidate) => (candidate === USER_PLIST ? plist : trustedPlist()),
      }),
    );

    expect(outcome).toMatchObject({
      attempted: true,
      standaloneFallbackBlocked: true,
      stopped: false,
    });
    expect(events).not.toContain("services stop openshell");
  });

  it.each([
    ["EnvironmentVariables", trustedPlist(HOSTILE_ENVIRONMENT)],
    ["extra ProgramArguments", EXTRA_PROGRAM_ARGUMENTS],
  ])("rejects an unloaded Homebrew formula plist with %s (#9705)", (_case, hostilePlist) => {
    const events: string[] = [];
    const outcome = startOpenShellGatewayUserService(
      homebrewOptions(
        events,
        {
          readFileSync: (candidate) =>
            candidate === FORMULA_PLIST ? hostilePlist : trustedPlist(),
        },
        false,
      ),
    );

    expect(events).not.toContain("services stop openshell");
    expect(events).not.toContain("services start openshell");
    expect(outcome).toMatchObject({ attempted: true, started: false });
  });

  it("rechecks the unloaded formula plist after environment preparation and before start (#9705)", () => {
    const events: string[] = [];
    let descriptorChanged = false;
    const outcome = startOpenShellGatewayUserService(
      homebrewOptions(
        events,
        {
          prepareServiceEnv: () => {
            descriptorChanged = true;
          },
          readFileSync: (candidate) =>
            candidate === FORMULA_PLIST && descriptorChanged
              ? EXTRA_PROGRAM_ARGUMENTS
              : trustedPlist(),
        },
        false,
      ),
    );

    expect(outcome).toMatchObject({ attempted: true, started: false });
    expect(events).not.toContain("services stop openshell");
    expect(events).not.toContain("services start openshell");
  });

  it("rechecks the unloaded formula plist after port preparation and before start (#9705)", () => {
    const events: string[] = [];
    let descriptorChanged = false;
    const outcome = startOpenShellGatewayUserService(
      homebrewOptions(
        events,
        {
          preparePortForServiceStart: () => {
            descriptorChanged = true;
          },
          readFileSync: (candidate) =>
            candidate === FORMULA_PLIST && descriptorChanged
              ? trustedPlist(HOSTILE_ENVIRONMENT)
              : trustedPlist(),
        },
        false,
      ),
    );

    expect(events).not.toContain("services stop openshell");
    expect(events).not.toContain("services start openshell");
    expect(outcome).toMatchObject({ attempted: true, started: false });
  });
});
