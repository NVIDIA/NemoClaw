// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  type OpenShellGatewayUserServiceOptions,
  type SpawnSyncLikeResult,
  startOpenShellGatewayUserService,
} from "./docker-driver-gateway-service";
import { openShellHomebrewServicePlistFixture } from "./__test-helpers__/docker-driver-gateway-service";

const HOME = "/Users/nemoclaw";
const FORMULA_PREFIX = "/opt/homebrew/opt/openshell";
const GATEWAY_BINARY = `${FORMULA_PREFIX}/bin/openshell-gateway`;
const SERVICE_COMMAND = `${FORMULA_PREFIX}/libexec/openshell-gateway-homebrew-service`;
const FORMULA_PLIST = `${FORMULA_PREFIX}/homebrew.mxcl.openshell.plist`;
const USER_PLIST = `${HOME}/Library/LaunchAgents/homebrew.mxcl.openshell.plist`;
const PLIST_CONTENTS = openShellHomebrewServicePlistFixture(FORMULA_PREFIX);

function spawnResult(status = 0, stderr = "", stdout = ""): SpawnSyncLikeResult {
  return { status, stderr, stdout };
}

function launchctlAbsentResult(): SpawnSyncLikeResult {
  return { signal: null, status: 113, stderr: null, stdout: null };
}

function serviceInfo(running: boolean): SpawnSyncLikeResult {
  return spawnResult(
    0,
    "",
    JSON.stringify([
      {
        command: SERVICE_COMMAND,
        file: running ? USER_PLIST : FORMULA_PLIST,
        loaded: running,
        loaded_file: running ? USER_PLIST : null,
        name: "openshell",
        pid: running ? 4242 : null,
        registered: running,
        running,
        service_name: "homebrew.mxcl.openshell",
      },
    ]),
  );
}

function launchdPlistSeams(): Pick<
  OpenShellGatewayUserServiceOptions,
  "closeSync" | "fstatSync" | "getuid" | "lstatSync" | "openSync" | "readSync"
> {
  let nextFileDescriptor = 10;
  const paths = new Map<number, string>();
  const offsets = new Map<number, number>();
  const stat = (candidate: string) => ({
    ctimeNs: 31,
    dev: 17,
    ino: candidate === FORMULA_PLIST ? 23 : 24,
    isFile: () => true,
    isSymbolicLink: () => false,
    mode: 0o644,
    mtimeNs: 29,
    nlink: 1,
    size: Buffer.byteLength(PLIST_CONTENTS),
    uid: 501,
  });
  const missingUserPlist = (): never => {
    throw Object.assign(new Error("missing launchd destination"), { code: "ENOENT" });
  };
  return {
    closeSync: (fileDescriptor) => {
      paths.delete(fileDescriptor);
      offsets.delete(fileDescriptor);
    },
    fstatSync: (fileDescriptor) => stat(paths.get(fileDescriptor) ?? FORMULA_PLIST),
    getuid: () => 501,
    lstatSync: ((candidate: string) =>
      candidate === USER_PLIST ? missingUserPlist() : stat(candidate)) as never,
    openSync: (filePath) => {
      const fileDescriptor = nextFileDescriptor++;
      paths.set(fileDescriptor, filePath);
      return fileDescriptor;
    },
    readSync: (fileDescriptor, buffer, offset, length) => {
      const contents = Buffer.from(PLIST_CONTENTS);
      const contentOffset = offsets.get(fileDescriptor) ?? 0;
      const count = Math.max(0, Math.min(length, contents.length - contentOffset));
      contents.copy(buffer, offset, contentOffset, contentOffset + count);
      offsets.set(fileDescriptor, contentOffset + count);
      return count;
    },
  };
}

type ServiceFileCondition = {
  changedTimeNanoseconds?: string;
  mode?: number;
  owner?: number;
  symbolicLink?: boolean;
};

function serviceFileIdentitySeam(
  conditionForPath: (filePath: string) => ServiceFileCondition = () => ({}),
): NonNullable<OpenShellGatewayUserServiceOptions["inspectServiceFileIdentity"]> {
  return (options) => {
    const condition = conditionForPath(options.filePath);
    const changedTimeNanoseconds = condition.changedTimeNanoseconds ?? "1";
    const mode = condition.mode ?? 0o755;
    const owner = condition.owner ?? 501;
    const rejected =
      condition.symbolicLink === true ||
      owner !== options.expectedUid ||
      (mode & 0o022) !== 0 ||
      ((options.requiredModeBits ?? 0) & mode) !== (options.requiredModeBits ?? 0);
    const contents = Buffer.from(`${options.filePath}\n`);
    return rejected
      ? null
      : {
          identity: {
            changedTimeNanoseconds,
            ...(options.hashContents === true
              ? { contentSha256: createHash("sha256").update(contents).digest("hex") }
              : {}),
            device: "17",
            inode: options.filePath === SERVICE_COMMAND ? "31" : "32",
            linkCount: "1",
            mode,
            modifiedTimeNanoseconds: changedTimeNanoseconds,
            owner,
            size: String(contents.length),
          },
        };
  };
}

function homebrewOptions(
  events: string[],
  inspectServiceFileIdentity = serviceFileIdentitySeam(),
): OpenShellGatewayUserServiceOptions {
  return {
    ...launchdPlistSeams(),
    commandExists: () => true,
    env: { HOME },
    existsSync: (candidate) =>
      [FORMULA_PLIST, GATEWAY_BINARY, SERVICE_COMMAND, USER_PLIST].includes(candidate),
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
            ? serviceInfo(false)
            : spawnResult();
    },
    inspectServiceFileIdentity,
    platform: "darwin",
    spawnSyncImpl: (command) =>
      command === "/bin/launchctl" ? launchctlAbsentResult() : spawnResult(),
  };
}

describe("Homebrew gateway executable provenance", () => {
  it("binds the complete service wrapper and gateway executable content (#9705)", () => {
    const events: string[] = [];
    const inspected: Array<{ filePath: string; hashContents?: boolean }> = [];
    const inspect = serviceFileIdentitySeam();

    const result = startOpenShellGatewayUserService(
      homebrewOptions(events, (options) => {
        inspected.push(options);
        return inspect(options);
      }),
    );

    expect(result.started).toBe(true);
    const wrapperInspections = inspected.filter(
      (inspection) => inspection.filePath === SERVICE_COMMAND,
    );
    const gatewayInspections = inspected.filter(
      (inspection) => inspection.filePath === GATEWAY_BINARY,
    );
    expect(wrapperInspections).not.toHaveLength(0);
    expect(wrapperInspections.every(({ hashContents }) => hashContents === true)).toBe(true);
    expect(gatewayInspections).not.toHaveLength(0);
    expect(gatewayInspections.every(({ hashContents }) => hashContents === true)).toBe(true);
  });

  it.each([
    ["service wrapper is a symbolic link", SERVICE_COMMAND, { symbolicLink: true }],
    ["service wrapper has a different owner", SERVICE_COMMAND, { owner: 0 }],
    ["service wrapper is group-writable", SERVICE_COMMAND, { mode: 0o775 }],
    ["gateway executable is a symbolic link", GATEWAY_BINARY, { symbolicLink: true }],
    ["gateway executable has a different owner", GATEWAY_BINARY, { owner: 0 }],
    ["gateway executable is world-writable", GATEWAY_BINARY, { mode: 0o757 }],
  ] as const)("rejects a Homebrew service whose %s (#9705)", (_case, hostilePath, condition) => {
    const events: string[] = [];
    const inspectServiceFileIdentity = serviceFileIdentitySeam((candidate) =>
      candidate === hostilePath ? condition : {},
    );

    const result = startOpenShellGatewayUserService(
      homebrewOptions(events, inspectServiceFileIdentity),
    );

    expect(result).toMatchObject({ started: false, standaloneFallbackBlocked: true });
    expect(events).not.toContain("services stop openshell");
    expect(events).not.toContain("services restart openshell");
  });

  it.each([
    ["service wrapper", SERVICE_COMMAND],
    ["gateway executable", GATEWAY_BINARY],
  ] as const)(
    "rejects a same-inode Homebrew %s change before lifecycle mutation (#9705)",
    (_case, changedPath) => {
      const events: string[] = [];
      const inspectServiceFileIdentity = serviceFileIdentitySeam((candidate) => ({
        changedTimeNanoseconds:
          candidate === changedPath &&
          events.filter((event) => event === "services info openshell --json").length >= 2
            ? "2"
            : "1",
      }));

      const result = startOpenShellGatewayUserService(
        homebrewOptions(events, inspectServiceFileIdentity),
      );

      expect(result).toMatchObject({
        reason: "service identity changed before lifecycle mutation",
        started: false,
        standaloneFallbackBlocked: true,
      });
      expect(events).not.toContain("services stop openshell");
      expect(events).not.toContain("services restart openshell");
    },
  );

  it.each([
    ["service wrapper", SERVICE_COMMAND],
    ["gateway executable", GATEWAY_BINARY],
  ] as const)(
    "rejects a Homebrew %s without its owner execute bit (#9705)",
    (_case, changedPath) => {
      const events: string[] = [];
      const inspectServiceFileIdentity = serviceFileIdentitySeam((candidate) =>
        candidate === changedPath ? { mode: 0o644 } : {},
      );

      const result = startOpenShellGatewayUserService(
        homebrewOptions(events, inspectServiceFileIdentity),
      );

      expect(result).toMatchObject({ started: false, standaloneFallbackBlocked: true });
      expect(events).not.toContain("services stop openshell");
    },
  );
});
