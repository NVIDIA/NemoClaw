// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type {
  ServiceFileIdentityOptions,
  ServiceFileInspection,
} from "../gateway/service-file-identity";
import type {
  OpenShellGatewayUserServiceOptions,
  SpawnSyncLikeResult,
} from "../docker-driver-gateway-service";

const NEMOCLAW_GATEWAY_UNIT_TEMPLATE = fs.readFileSync(
  path.resolve(import.meta.dirname, "../../../../scripts/lib/openshell-gateway.service.in"),
  "utf-8",
);

export const HOMEBREW_GATEWAY_FIXTURE = {
  formulaPlist: "/opt/homebrew/opt/openshell/homebrew.mxcl.openshell.plist",
  formulaPrefix: "/opt/homebrew/opt/openshell",
  gatewayBinary: "/opt/homebrew/opt/openshell/bin/openshell-gateway",
  home: "/Users/nemoclaw",
  label: "homebrew.mxcl.openshell",
  serviceCommand: "/opt/homebrew/opt/openshell/libexec/openshell-gateway-homebrew-service",
  userPlist: "/Users/nemoclaw/Library/LaunchAgents/homebrew.mxcl.openshell.plist",
} as const;

export type HomebrewLaunchdDestinationState =
  | "absent"
  | "broken-symlink"
  | "inaccessible"
  | "regular";

export function spawnSyncResultFixture(
  status: number | null = 0,
  stderr: string | null = "",
  stdout: string | null = "",
  extra: Partial<SpawnSyncLikeResult> = {},
): SpawnSyncLikeResult {
  return { status, stderr, stdout, ...extra };
}

export function launchctlAbsentResultFixture(
  overrides: Partial<SpawnSyncLikeResult> = {},
): SpawnSyncLikeResult {
  return spawnSyncResultFixture(113, null, null, { signal: null, ...overrides });
}

export interface HomebrewServiceInfoFixture {
  command: string;
  file: string;
  loaded: boolean;
  loaded_file: string | null;
  name: string;
  pid: number | null;
  registered: boolean;
  running: boolean;
  service_name: string;
}

export function homebrewServiceInfoFixture(
  overrides: Record<string, unknown> = {},
): SpawnSyncLikeResult {
  return spawnSyncResultFixture(
    0,
    "",
    JSON.stringify([
      {
        command: HOMEBREW_GATEWAY_FIXTURE.serviceCommand,
        file: HOMEBREW_GATEWAY_FIXTURE.formulaPlist,
        loaded: false,
        loaded_file: null,
        name: "openshell",
        pid: null,
        registered: false,
        running: false,
        service_name: HOMEBREW_GATEWAY_FIXTURE.label,
        ...overrides,
      },
    ]),
  );
}

export function homebrewFormulaInfoFixture(): SpawnSyncLikeResult {
  return spawnSyncResultFixture(
    0,
    "",
    JSON.stringify({ formulae: [{ name: "openshell", tap: "nvidia/openshell" }] }),
  );
}

export function homebrewFormulaOperationFixture({
  events = [],
  failCommand,
  failDiagnostic = "",
  serviceInfo = () => homebrewServiceInfoFixture(),
}: {
  events?: string[];
  failCommand?: string;
  failDiagnostic?: string;
  serviceInfo?: () => SpawnSyncLikeResult;
} = {}): (args: string[]) => SpawnSyncLikeResult {
  return (args) => {
    const command = args.join(" ");
    events.push(command);
    return command === failCommand
      ? spawnSyncResultFixture(1, failDiagnostic)
      : args[0] === "info"
        ? homebrewFormulaInfoFixture()
        : args[0] === "--prefix"
          ? spawnSyncResultFixture(0, "", HOMEBREW_GATEWAY_FIXTURE.formulaPrefix)
          : args[0] === "services" && args[1] === "info"
            ? serviceInfo()
            : spawnSyncResultFixture();
  };
}

export function homebrewFixturePathExists(candidate: string): boolean {
  return [
    HOMEBREW_GATEWAY_FIXTURE.formulaPlist,
    HOMEBREW_GATEWAY_FIXTURE.gatewayBinary,
    HOMEBREW_GATEWAY_FIXTURE.serviceCommand,
    HOMEBREW_GATEWAY_FIXTURE.userPlist,
  ].some((fixturePath) => fixturePath === candidate);
}

export function homebrewLaunchdPlistFileFixture({
  destinationState = () => "absent",
  plistContents = openShellHomebrewServicePlistFixture(HOMEBREW_GATEWAY_FIXTURE.formulaPrefix),
}: {
  destinationState?: () => HomebrewLaunchdDestinationState;
  plistContents?: string;
} = {}): Pick<
  OpenShellGatewayUserServiceOptions,
  "closeSync" | "fstatSync" | "getuid" | "lstatSync" | "openSync" | "readSync"
> {
  let nextFileDescriptor = 10;
  const paths = new Map<number, string>();
  const offsets = new Map<number, number>();
  const stat = (candidate: string, symbolicLink = false) => ({
    ctimeNs: 31,
    dev: 17,
    ino: candidate === HOMEBREW_GATEWAY_FIXTURE.formulaPlist ? 23 : 24,
    isFile: () => true,
    isSymbolicLink: () => symbolicLink,
    mode: 0o644,
    mtimeNs: 29,
    nlink: 1,
    size: Buffer.byteLength(plistContents),
    uid: 501,
  });
  const fail = (code: string): never => {
    throw Object.assign(new Error("launchd destination inspection failed"), { code });
  };
  return {
    closeSync: (fileDescriptor) => {
      paths.delete(fileDescriptor);
      offsets.delete(fileDescriptor);
    },
    fstatSync: (fileDescriptor) => stat(paths.get(fileDescriptor) ?? ""),
    getuid: () => 501,
    lstatSync: ((candidate: string) => {
      if (candidate !== HOMEBREW_GATEWAY_FIXTURE.userPlist) return stat(candidate);
      const state = destinationState();
      return state === "absent"
        ? fail("ENOENT")
        : state === "inaccessible"
          ? fail("EACCES")
          : stat(candidate, state === "broken-symlink");
    }) as never,
    openSync: (filePath) => {
      const fileDescriptor = nextFileDescriptor++;
      paths.set(fileDescriptor, filePath);
      return fileDescriptor;
    },
    readSync: (fileDescriptor, buffer, offset, length) => {
      const contents = Buffer.from(plistContents);
      const contentOffset = offsets.get(fileDescriptor) ?? 0;
      const count = Math.max(0, Math.min(length, contents.length - contentOffset));
      contents.copy(buffer, offset, contentOffset, contentOffset + count);
      offsets.set(fileDescriptor, contentOffset + count);
      return count;
    },
  };
}

export function nemoclawGatewaySystemdUnitFixture(gatewayBinary: string): string {
  return NEMOCLAW_GATEWAY_UNIT_TEMPLATE.replaceAll("@OPENSHELL_GATEWAY_BIN@", gatewayBinary);
}

export function createGatewayServiceFileContentsFixture(
  gatewayBinary: string,
  homebrewPlist: string,
): (filePath: string) => string {
  return (filePath) =>
    filePath.endsWith("homebrew.mxcl.openshell.plist")
      ? homebrewPlist
      : filePath.endsWith("nemoclaw-openshell-gateway.service")
        ? nemoclawGatewaySystemdUnitFixture(gatewayBinary)
        : "# NEMOCLAW_MANAGED_OPENSHELL_GATEWAY=1\n";
}

export function openShellHomebrewServicePlistFixture(formulaPrefix: string): string {
  const homebrewPrefix = path.dirname(path.dirname(formulaPrefix));
  const logDirectory = path.join(homebrewPrefix, "var", "log", "openshell");
  return [
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
    ...["Aqua", "Background", "LoginWindow", "StandardIO", "System"].map(
      (session) => `<string>${session}</string>`,
    ),
    "</array>",
    "<key>ProgramArguments</key>",
    "<array>",
    `<string>${path.join(formulaPrefix, "libexec", "openshell-gateway-homebrew-service")}</string>`,
    "</array>",
    "<key>RunAtLoad</key>",
    "<true/>",
    "<key>StandardErrorPath</key>",
    `<string>${path.join(logDirectory, "openshell-gateway.err.log")}</string>`,
    "<key>StandardOutPath</key>",
    `<string>${path.join(logDirectory, "openshell-gateway.out.log")}</string>`,
    "</dict>",
    "</plist>",
  ].join("\n");
}

export function serviceFileIdentityFixture(
  contentsForPath: (filePath: string) => Buffer | string,
  ownerForPath: (filePath: string) => number,
): (options: ServiceFileIdentityOptions) => ServiceFileInspection | null {
  return (options) => {
    const owner = ownerForPath(options.filePath);
    if (owner !== options.expectedUid) return null;
    const contents = Buffer.from(contentsForPath(options.filePath));
    if (options.contentsLimit !== undefined && contents.length > options.contentsLimit) return null;
    const contentSha256 = createHash("sha256").update(contents).digest("hex");
    return {
      ...(options.contentsLimit === undefined ? {} : { contents }),
      identity: {
        changedTimeNanoseconds: "1",
        ...(options.hashContents === true || options.contentsLimit !== undefined
          ? { contentSha256 }
          : {}),
        device: "1",
        inode: createHash("sha256").update(options.filePath).digest("hex"),
        linkCount: "1",
        mode: 0o755,
        modifiedTimeNanoseconds: "1",
        owner,
        size: String(contents.length),
      },
    };
  };
}
