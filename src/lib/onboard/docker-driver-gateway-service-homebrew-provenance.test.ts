// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  type OpenShellGatewayUserServiceOptions,
  type SpawnSyncLikeResult,
  startOpenShellGatewayUserService,
} from "./docker-driver-gateway-service";
import {
  HOMEBREW_GATEWAY_FIXTURE,
  homebrewFixturePathExists,
  homebrewFormulaOperationFixture,
  homebrewLaunchdPlistFileFixture,
  homebrewServiceInfoFixture as serviceInfo,
  launchctlAbsentResultFixture as launchctlAbsentResult,
  spawnSyncResultFixture as spawnResult,
} from "./__test-helpers__/docker-driver-gateway-service-test-fixture";

const {
  gatewayBinary: GATEWAY_BINARY,
  home: HOME,
  serviceCommand: SERVICE_COMMAND,
} = HOMEBREW_GATEWAY_FIXTURE;

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
    ...homebrewLaunchdPlistFileFixture(),
    commandExists: () => true,
    env: { HOME },
    existsSync: homebrewFixturePathExists,
    home: HOME,
    homebrewFormulaOperation: homebrewFormulaOperationFixture({ events, serviceInfo }),
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
