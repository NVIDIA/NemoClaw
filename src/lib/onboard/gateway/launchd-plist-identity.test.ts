// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import { describe, expect, it } from "vitest";

import {
  inspectLaunchdPlistFileIdentity,
  type LaunchdPlistFileIdentityOptions,
  type LaunchdPlistPathStat,
  type LaunchdPlistStat,
  sameLaunchdPlistLifecycleIdentity,
} from "./launchd-plist-identity";

const FORMULA_PATH = "/opt/homebrew/opt/openshell/homebrew.mxcl.openshell.plist";
const LOADED_PATH = "/Users/nemoclaw/Library/LaunchAgents/homebrew.mxcl.openshell.plist";
const SERVICE_COMMAND = "/opt/homebrew/opt/openshell/libexec/openshell-gateway-homebrew-service";
// The checksum-reviewed OpenShell v0.0.106 formula generates this launchd plist.
const V00106_FORMULA_PLIST_TEXT = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
  '<plist version="1.0">',
  "<dict>",
  "<key>KeepAlive</key>",
  "<dict>",
  "<key>SuccessfulExit</key>",
  "<false/>",
  "</dict>",
  "<key>Label</key>",
  "<string>homebrew.mxcl.openshell</string>",
  "<key>LimitLoadToSessionType</key>",
  "<array>",
  "<string>Aqua</string>",
  "<string>Background</string>",
  "<string>LoginWindow</string>",
  "<string>StandardIO</string>",
  "<string>System</string>",
  "</array>",
  "<key>ProgramArguments</key>",
  "<array>",
  `<string>${SERVICE_COMMAND}</string>`,
  "</array>",
  "<key>RunAtLoad</key>",
  "<true/>",
  "<key>StandardErrorPath</key>",
  "<string>/opt/homebrew/var/log/openshell/openshell-gateway.err.log</string>",
  "<key>StandardOutPath</key>",
  "<string>/opt/homebrew/var/log/openshell/openshell-gateway.out.log</string>",
  "</dict>",
  "</plist>",
].join("\n");
const V00106_FORMULA_PLIST = Buffer.from(V00106_FORMULA_PLIST_TEXT);
const CURRENT_UID = 501;

function fileStat({
  changedTime = 31,
  device = 17,
  file = true,
  inode = 23,
  mode = 0o644,
  modifiedTime = 29,
  linkCount = 1,
  size = V00106_FORMULA_PLIST.length,
  symbolicLink = false,
  uid = CURRENT_UID,
}: {
  changedTime?: number;
  device?: number;
  file?: boolean;
  inode?: number;
  mode?: number;
  modifiedTime?: number;
  linkCount?: number;
  size?: number;
  symbolicLink?: boolean;
  uid?: number;
} = {}): LaunchdPlistPathStat {
  return {
    ctimeNs: changedTime,
    dev: device,
    ino: inode,
    isFile: () => file,
    mode,
    mtimeNs: modifiedTime,
    nlink: linkCount,
    size,
    isSymbolicLink: () => symbolicLink,
    uid,
  };
}

interface DescriptorFixture {
  beforeOpen?: (filePath: string, flags: number) => void;
  close?: (filePath: string) => void;
  pathStat?: (filePath: string) => LaunchdPlistPathStat;
  read?: (filePath: string) => Buffer | string | Uint8Array;
  size?: (filePath: string) => number;
  stat?: (filePath: string) => LaunchdPlistStat;
}

function descriptorSeams(
  fixture: DescriptorFixture,
): Pick<
  LaunchdPlistFileIdentityOptions,
  "closeSync" | "fstatSync" | "lstatSync" | "openSync" | "readSync"
> {
  let nextFileDescriptor = 10;
  const paths = new Map<number, string>();
  const offsets = new Map<number, number>();
  const contents = new Map<number, Buffer>();
  const defaultStat = (candidate: string) =>
    candidate === FORMULA_PATH
      ? fileStat({ size: fixture.size?.(candidate) ?? V00106_FORMULA_PLIST.length })
      : fileStat({
          device: 18,
          inode: 24,
          size: fixture.size?.(candidate) ?? V00106_FORMULA_PLIST.length,
        });
  return {
    closeSync: (fileDescriptor) => {
      const filePath = paths.get(fileDescriptor) ?? "";
      fixture.close?.(filePath);
      paths.delete(fileDescriptor);
      offsets.delete(fileDescriptor);
      contents.delete(fileDescriptor);
    },
    fstatSync: (fileDescriptor) => (fixture.stat ?? defaultStat)(paths.get(fileDescriptor) ?? ""),
    lstatSync: (filePath) =>
      (fixture.pathStat ?? fixture.stat ?? defaultStat)(filePath) as LaunchdPlistPathStat,
    openSync: (filePath, flags) => {
      fixture.beforeOpen?.(filePath, flags);
      const fileDescriptor = nextFileDescriptor;
      nextFileDescriptor += 1;
      paths.set(fileDescriptor, filePath);
      return fileDescriptor;
    },
    readSync: (fileDescriptor, buffer, offset, length) => {
      const content =
        contents.get(fileDescriptor) ??
        Buffer.from(
          (fixture.read ?? (() => V00106_FORMULA_PLIST))(paths.get(fileDescriptor) ?? ""),
        );
      contents.set(fileDescriptor, content);
      const contentOffset = offsets.get(fileDescriptor) ?? 0;
      const count = Math.max(0, Math.min(length, content.length - contentOffset));
      content.copy(buffer, offset, contentOffset, contentOffset + count);
      offsets.set(fileDescriptor, contentOffset + count);
      return count;
    },
  };
}

function inspectOptions(
  fixture: DescriptorFixture = {},
  overrides: Partial<
    Pick<LaunchdPlistFileIdentityOptions, "effectivePath" | "formulaPath" | "getuid">
  > = {},
): LaunchdPlistFileIdentityOptions {
  return {
    ...descriptorSeams(fixture),
    effectivePath: LOADED_PATH,
    formulaPath: FORMULA_PATH,
    getuid: () => CURRENT_UID,
    ...overrides,
  };
}

function throwSymlinkOpenFailure(): never {
  throw new Error("ELOOP");
}

describe("launchd plist file identity", () => {
  it("accepts the exact OpenShell v0.0.106 Homebrew launchd plist (#9705)", () => {
    const identity = inspectLaunchdPlistFileIdentity(inspectOptions());

    expect(identity).toEqual({
      contentSha256: createHash("sha256").update(V00106_FORMULA_PLIST).digest("hex"),
      effective: { device: "18", inode: "24", source: "loaded" },
      formula: { device: "17", inode: "23" },
    });
    const serialized = JSON.stringify(identity);
    expect(serialized).not.toContain(V00106_FORMULA_PLIST.toString());
    expect(serialized).not.toContain(FORMULA_PATH);
    expect(serialized).not.toContain(LOADED_PATH);
  });

  it("rejects a loaded plist whose bytes differ from the formula plist (#9705)", () => {
    expect(
      inspectLaunchdPlistFileIdentity(
        inspectOptions({
          read: (candidate) =>
            candidate === FORMULA_PATH ? V00106_FORMULA_PLIST : Buffer.from("hostile override"),
          size: (candidate) =>
            candidate === FORMULA_PATH
              ? V00106_FORMULA_PLIST.length
              : Buffer.byteLength("hostile override"),
        }),
      ),
    ).toBeNull();
  });

  it.each([
    [
      "EnvironmentVariables",
      V00106_FORMULA_PLIST_TEXT.replace(
        "<key>RunAtLoad</key>",
        [
          "<key>EnvironmentVariables</key>",
          "<dict>",
          "<key>OPENAI_API_KEY</key>",
          "<string>attacker-controlled</string>",
          "</dict>",
          "<key>RunAtLoad</key>",
        ].join("\n"),
      ),
    ],
    [
      "an extra program argument",
      V00106_FORMULA_PLIST_TEXT.replace(
        `<string>${SERVICE_COMMAND}</string>\n</array>\n<key>RunAtLoad</key>`,
        [
          `<string>${SERVICE_COMMAND}</string>`,
          "<string>--config=/tmp/attacker-controlled.toml</string>",
          "</array>",
          "<key>RunAtLoad</key>",
        ].join("\n"),
      ),
    ],
    [
      "another label",
      V00106_FORMULA_PLIST_TEXT.replace(
        "homebrew.mxcl.openshell</string>",
        "homebrew.mxcl.hostile</string>",
      ),
    ],
    [
      "RunAtLoad disabled",
      V00106_FORMULA_PLIST_TEXT.replace(
        "<key>RunAtLoad</key>\n<true/>",
        "<key>RunAtLoad</key>\n<false/>",
      ),
    ],
    [
      "a permissive KeepAlive value",
      V00106_FORMULA_PLIST_TEXT.replace(
        "<key>SuccessfulExit</key>\n<false/>",
        "<key>SuccessfulExit</key>\n<true/>",
      ),
    ],
    [
      "a duplicate key",
      V00106_FORMULA_PLIST_TEXT.replace(
        "<key>LimitLoadToSessionType</key>",
        "<key>Label</key>\n<string>homebrew.mxcl.openshell</string>\n<key>LimitLoadToSessionType</key>",
      ),
    ],
    [
      "an XML entity",
      V00106_FORMULA_PLIST_TEXT.replace(
        "<string>homebrew.mxcl.openshell</string>",
        "<string>homebrew.mxcl.open&#115;hell</string>",
      ),
    ],
    ["trailing XML content", `${V00106_FORMULA_PLIST_TEXT}\n<dict></dict>`],
  ])("rejects matching plists with %s (#9705)", (_case, hostileContent) => {
    expect(
      inspectLaunchdPlistFileIdentity(
        inspectOptions({
          read: () => Buffer.from(hostileContent),
          size: () => Buffer.byteLength(hostileContent),
        }),
      ),
    ).toBeNull();
  });

  it("opens each plist read-only without following symlinks or blocking (#9705)", () => {
    const flags: number[] = [];
    const identity = inspectLaunchdPlistFileIdentity(
      inspectOptions({ beforeOpen: (_filePath, value) => flags.push(value) }),
    );

    expect(identity).not.toBeNull();
    expect(flags).toEqual([
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW,
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW,
    ]);
  });

  it.each([FORMULA_PATH, LOADED_PATH])("rejects a symlink open at %s (#9705)", (symlinkPath) => {
    expect(
      inspectLaunchdPlistFileIdentity(
        inspectOptions({
          beforeOpen: (candidate) => {
            candidate === symlinkPath ? throwSymlinkOpenFailure() : undefined;
          },
        }),
      ),
    ).toBeNull();
  });

  it.each([
    ["group-writable", 0o664],
    ["world-writable", 0o646],
  ])("rejects a %s plist (#9705)", (_case, mode) => {
    expect(
      inspectLaunchdPlistFileIdentity(inspectOptions({ stat: () => fileStat({ mode }) })),
    ).toBeNull();
  });

  it("rejects an oversized plist before reading its descriptor (#9705)", () => {
    let readCount = 0;
    expect(
      inspectLaunchdPlistFileIdentity(
        inspectOptions({
          read: () => {
            readCount += 1;
            return V00106_FORMULA_PLIST;
          },
          size: () => 64 * 1024 + 1,
        }),
      ),
    ).toBeNull();
    expect(readCount).toBe(0);
  });

  it("rejects a short descriptor read through the shared file inspector (#9705)", () => {
    const options = inspectOptions();
    const readResults = [1, 0];
    options.readSync = (_fileDescriptor, buffer, offset) => {
      V00106_FORMULA_PLIST.copy(buffer, offset, 0, 1);
      return readResults.shift() ?? 0;
    };

    expect(inspectLaunchdPlistFileIdentity(options)).toBeNull();
  });

  it("rejects a descriptor that cannot be closed by the shared file inspector (#9705)", () => {
    expect(
      inspectLaunchdPlistFileIdentity(
        inspectOptions({
          close: () => {
            throw new Error("injected close failure");
          },
        }),
      ),
    ).toBeNull();
  });

  it.each([
    ["a symlink", fileStat({ symbolicLink: true })],
    ["owned by another user", fileStat({ uid: CURRENT_UID + 1 })],
    ["not a regular file", fileStat({ file: false })],
  ])("rejects a formula pathname that is %s after reading (#9705)", (_case, invalidStat) => {
    expect(
      inspectLaunchdPlistFileIdentity(
        inspectOptions({
          pathStat: (candidate) =>
            candidate === FORMULA_PATH ? invalidStat : fileStat({ device: 18, inode: 24 }),
        }),
      ),
    ).toBeNull();
  });

  it("rejects a formula pathname swap during the descriptor read (#9705)", () => {
    let formulaRead = false;
    expect(
      inspectLaunchdPlistFileIdentity(
        inspectOptions({
          pathStat: (candidate) =>
            candidate === FORMULA_PATH && formulaRead
              ? fileStat({ inode: 99 })
              : candidate === FORMULA_PATH
                ? fileStat()
                : fileStat({ device: 18, inode: 24 }),
          read: (candidate) => {
            formulaRead ||= candidate === FORMULA_PATH;
            return V00106_FORMULA_PLIST;
          },
        }),
      ),
    ).toBeNull();
  });

  it.each([
    ["owned by another user", fileStat({ uid: CURRENT_UID + 1 })],
    ["not a regular file", fileStat({ file: false })],
  ])("rejects a formula plist that is %s (#9705)", (_case, invalidStat) => {
    expect(
      inspectLaunchdPlistFileIdentity(
        inspectOptions({
          stat: (candidate) =>
            candidate === FORMULA_PATH ? invalidStat : fileStat({ device: 18, inode: 24 }),
        }),
      ),
    ).toBeNull();
  });

  it.each([
    ["owned by another user", fileStat({ uid: CURRENT_UID + 1 })],
    ["not a regular file", fileStat({ file: false })],
  ])("rejects a loaded plist that is %s (#9705)", (_case, invalidStat) => {
    expect(
      inspectLaunchdPlistFileIdentity(
        inspectOptions({
          stat: (candidate) => (candidate === LOADED_PATH ? invalidStat : fileStat()),
        }),
      ),
    ).toBeNull();
  });

  it.each([
    ["inode", fileStat({ inode: 99 })],
    ["device", fileStat({ device: 99 })],
    ["owner", fileStat({ uid: CURRENT_UID + 1 })],
    ["file type", fileStat({ file: false })],
  ])("rejects a formula plist whose %s changes during the read (#9705)", (_case, after) => {
    const formulaStats = [fileStat(), after];
    expect(
      inspectLaunchdPlistFileIdentity(
        inspectOptions({
          stat: (candidate) =>
            candidate === FORMULA_PATH
              ? (formulaStats.shift() ?? after)
              : fileStat({ device: 18, inode: 24 }),
        }),
      ),
    ).toBeNull();
  });

  it("rejects a loaded plist whose inode changes during the read (#9705)", () => {
    const loadedStats = [fileStat({ device: 18, inode: 24 }), fileStat({ device: 18, inode: 25 })];
    expect(
      inspectLaunchdPlistFileIdentity(
        inspectOptions({
          stat: (candidate) =>
            candidate === LOADED_PATH ? (loadedStats.shift() ?? loadedStats[0]) : fileStat(),
        }),
      ),
    ).toBeNull();
  });

  it("returns no read error or file content when inspection fails (#9705)", () => {
    const secret = "child-secret-must-not-escape";
    const identity = inspectLaunchdPlistFileIdentity(
      inspectOptions({
        read: () => {
          throw new Error(`${secret}: ${V00106_FORMULA_PLIST.toString()}`);
        },
      }),
    );

    expect(identity).toBeNull();
    expect(JSON.stringify(identity)).not.toContain(secret);
    expect(JSON.stringify(identity)).not.toContain(V00106_FORMULA_PLIST.toString());
  });

  it("binds lifecycle equality to formula content and descriptor identity (#9705)", () => {
    const baseline = inspectLaunchdPlistFileIdentity(inspectOptions());
    const matching = inspectLaunchdPlistFileIdentity(inspectOptions());
    const replacedFormula = inspectLaunchdPlistFileIdentity(
      inspectOptions({
        stat: (candidate) =>
          candidate === FORMULA_PATH
            ? fileStat({ inode: 99 })
            : fileStat({ device: 18, inode: 24 }),
      }),
    );
    const replacedLoaded = inspectLaunchdPlistFileIdentity(
      inspectOptions({
        stat: (candidate) =>
          candidate === FORMULA_PATH ? fileStat() : fileStat({ device: 18, inode: 99 }),
      }),
    );

    expect(baseline).not.toBeNull();
    expect(matching).not.toBeNull();
    expect(replacedFormula).not.toBeNull();
    expect(replacedLoaded).not.toBeNull();
    expect(sameLaunchdPlistLifecycleIdentity(baseline!, matching!)).toBe(true);
    expect(sameLaunchdPlistLifecycleIdentity(baseline!, replacedFormula!)).toBe(false);
    expect(sameLaunchdPlistLifecycleIdentity(baseline!, replacedLoaded!)).toBe(false);
  });

  it("rejects a loaded-to-formula source transition (#9705)", () => {
    const loaded = inspectLaunchdPlistFileIdentity(inspectOptions());
    const unloaded = inspectLaunchdPlistFileIdentity(
      inspectOptions({}, { effectivePath: FORMULA_PATH }),
    );

    expect(loaded).not.toBeNull();
    expect(unloaded).not.toBeNull();
    expect(sameLaunchdPlistLifecycleIdentity(loaded!, unloaded!)).toBe(false);
  });
});
