// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  type LockedArchive,
  lockedArchives,
} from "../../../scripts/checks/materialize-locked-npm-cache-seed.mts";
import {
  managedMessagingNestedOverridePaths,
  verifyManagedMessagingOfflineInstall,
} from "../../../scripts/checks/verify-managed-messaging-offline-install.mts";

const repoRoot = path.join(import.meta.dirname, "../../..");
const dockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
const runtimeDirectory = path.join(
  repoRoot,
  "agents",
  "openclaw",
  "managed-image-messaging-runtime",
);
const runtimeManifest = JSON.parse(
  fs.readFileSync(path.join(runtimeDirectory, "package.json"), "utf8"),
);
const runtimeLockSource = fs.readFileSync(path.join(runtimeDirectory, "package-lock.json"), "utf8");
const runtimeLock = JSON.parse(runtimeLockSource);
const nestedOverrideLocations = managedMessagingNestedOverridePaths(runtimeManifest);

interface DockerArchivePin {
  archive: string;
  digest: string;
  resolved: string;
}

// BuildKit failed at the 130th remote ADD during a cold managed-image build.
const MAX_CHECKSUM_ADD_CHAIN = 120;

function dockerfileSection(startMarker: string, endMarker: string): string {
  const start = dockerfile.indexOf(startMarker);
  const end = dockerfile.indexOf(endMarker, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return dockerfile.slice(start, end);
}

function archivePins(section: string): DockerArchivePin[] {
  return [
    ...section.matchAll(
      /^ADD --chmod=0444 --checksum=sha256:([a-f0-9]{64}) (https:\/\/registry\.npmjs\.org\/\S+) \/([^/\s]+\.tgz)$/gmu,
    ),
  ].map((match) => ({
    archive: match[3],
    digest: match[1],
    resolved: match[2],
  }));
}

function archiveIdentity(archive: LockedArchive | DockerArchivePin): string {
  return `${archive.archive}\n${archive.resolved}`;
}

function writeInstalledVersion(root: string, location: string, version: string): void {
  const packageDirectory = path.join(root, location);
  fs.mkdirSync(packageDirectory, { recursive: true });
  fs.writeFileSync(path.join(packageDirectory, "package.json"), `${JSON.stringify({ version })}\n`);
}

describe("OpenClaw managed messaging offline image build", () => {
  // source-shape-contract: security -- Exact npm overrides bind the offline clean-install graph to reviewed versions embedded in signed plugin archives
  it("binds npm's clean-install view to the versions shipped in reviewed bundles", () => {
    const bundledVersion = (location: string) => {
      const bundled = runtimeLock.packages[location];
      expect(bundled?.inBundle).toBe(true);
      return bundled?.version;
    };

    expect(runtimeManifest.overrides).toEqual({
      "@openclaw/discord@2026.9.1": {
        "@discord/embedded-app-sdk@2.5.0": {
          uuid: bundledVersion(
            "node_modules/@openclaw/discord/node_modules/@discord/embedded-app-sdk/node_modules/uuid",
          ),
        },
      },
      "@openclaw/whatsapp@2026.9.1": {
        "baileys@7.0.0-rc14": {
          "file-type": bundledVersion(
            "node_modules/@openclaw/whatsapp/node_modules/baileys/node_modules/file-type",
          ),
          protobufjs: bundledVersion(
            "node_modules/@openclaw/whatsapp/node_modules/baileys/node_modules/protobufjs",
          ),
        },
      },
    });
    expect(nestedOverrideLocations).toHaveLength(3);
    nestedOverrideLocations.forEach((location) => {
      expect(runtimeLock.packages[location]?.version).toMatch(/^\d/u);
    });
    expect(runtimeManifest.dependencies).toMatchObject({
      "@emnapi/core": "1.11.1",
      "@emnapi/runtime": "1.11.1",
    });
    expect(runtimeLock.packages[""].dependencies).toMatchObject({
      "@emnapi/core": "1.11.1",
      "@emnapi/runtime": "1.11.1",
    });
    expect(runtimeLock.packages["node_modules/@emnapi/core"]).toMatchObject({
      version: "1.11.1",
      dependencies: {
        "@emnapi/wasi-threads": "1.2.2",
      },
    });
    expect(runtimeLock.packages["node_modules/@emnapi/runtime"]).toMatchObject({
      version: "1.11.1",
    });
    expect(runtimeLock.packages["node_modules/@emnapi/wasi-threads"]).toMatchObject({
      version: "1.2.2",
    });
  });

  it("pins the complete lock graphs below the cold-build layer limit", () => {
    const amd64Lock = lockedArchives(runtimeLockSource, {
      cpu: "x64",
      libc: "glibc",
      os: "linux",
    });
    const arm64Lock = lockedArchives(runtimeLockSource, {
      cpu: "arm64",
      libc: "glibc",
      os: "linux",
    });
    const amd64Names = new Set(amd64Lock.map(({ archive }) => archive));
    const arm64Names = new Set(arm64Lock.map(({ archive }) => archive));
    const commonLock = amd64Lock.filter(({ archive }) => arm64Names.has(archive));
    const amd64OnlyLock = amd64Lock.filter(({ archive }) => !arm64Names.has(archive));
    const arm64OnlyLock = arm64Lock.filter(({ archive }) => !amd64Names.has(archive));

    const commonStageNumbers = [
      ...dockerfile.matchAll(
        /^FROM scratch AS openclaw-managed-messaging-npm-common-archives-(\d+)$/gmu,
      ),
    ].map((match) => Number(match[1]));
    expect(commonStageNumbers).toEqual(
      Array.from({ length: commonStageNumbers.length }, (_, index) => index + 1),
    );
    const commonArchiveStages = commonStageNumbers.map((part, index) =>
      dockerfileSection(
        `FROM scratch AS openclaw-managed-messaging-npm-common-archives-${part}`,
        index + 1 < commonStageNumbers.length
          ? `FROM scratch AS openclaw-managed-messaging-npm-common-archives-${commonStageNumbers[index + 1]}`
          : "FROM scratch AS openclaw-managed-messaging-npm-common-archives\n",
      ),
    );
    const commonPins = commonArchiveStages.flatMap(archivePins);
    const commonArchiveMerge = dockerfileSection(
      "FROM scratch AS openclaw-managed-messaging-npm-common-archives\n",
      "FROM openclaw-managed-messaging-npm-common-archives AS openclaw-managed-messaging-npm-amd64-archives",
    );
    const amd64OnlyPins = archivePins(
      dockerfileSection(
        "FROM openclaw-managed-messaging-npm-common-archives AS openclaw-managed-messaging-npm-amd64-archives",
        "FROM openclaw-managed-messaging-npm-common-archives AS openclaw-managed-messaging-npm-arm64-archives",
      ),
    );
    const arm64OnlyPins = archivePins(
      dockerfileSection(
        "FROM openclaw-managed-messaging-npm-common-archives AS openclaw-managed-messaging-npm-arm64-archives",
        "FROM openclaw-managed-messaging-npm-${TARGETARCH}-archives AS openclaw-managed-messaging-npm-archives",
      ),
    );

    expect(commonPins.map(archiveIdentity)).toEqual(commonLock.map(archiveIdentity));
    expect(
      commonArchiveStages.every((stage) => archivePins(stage).length <= MAX_CHECKSUM_ADD_CHAIN),
    ).toBe(true);
    expect(
      commonStageNumbers.every((part) =>
        commonArchiveMerge.includes(
          `COPY --from=openclaw-managed-messaging-npm-common-archives-${part} / /`,
        ),
      ),
    ).toBe(true);
    expect(amd64OnlyPins.map(archiveIdentity)).toEqual(amd64OnlyLock.map(archiveIdentity));
    expect(arm64OnlyPins.map(archiveIdentity)).toEqual(arm64OnlyLock.map(archiveIdentity));
    expect(new Set(commonPins.map(({ digest }) => digest)).size).toBe(commonPins.length);
    expect(new Set(amd64OnlyPins.map(({ digest }) => digest)).size).toBe(amd64OnlyPins.length);
    expect(new Set(arm64OnlyPins.map(({ digest }) => digest)).size).toBe(arm64OnlyPins.length);
    expect(commonPins.length + amd64OnlyPins.length).toBe(amd64Lock.length);
    expect(commonPins.length + arm64OnlyPins.length).toBe(arm64Lock.length);
  });

  it("runs and verifies the real offline clean install in the managed-image build", () => {
    const cacheStage = dockerfileSection(
      "AS openclaw-managed-messaging-npm-cache-1",
      "FROM openclaw-managed-messaging-npm-cache-${NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION}",
    );

    expect(dockerfile).toContain(
      "FROM openclaw-managed-messaging-npm-${TARGETARCH}-archives AS openclaw-managed-messaging-npm-archives",
    );
    expect(cacheStage).toContain(
      "COPY --from=openclaw-managed-messaging-npm-archives / /opt/nemoclaw-build-tools/npm-cache-seed/",
    );
    expect(cacheStage).toContain("RUN --network=none set -eu;");
    expect(cacheStage).toContain("--archive-directory /opt/nemoclaw-build-tools/npm-cache-seed");
    expect(cacheStage).toContain("NPM_CONFIG_OFFLINE=true npm ci");
    expect(cacheStage).toContain(
      "scripts/checks/verify-managed-messaging-offline-install.mts /scripts/checks/",
    );
    expect(cacheStage).toContain(
      "node /scripts/checks/verify-managed-messaging-offline-install.mts",
    );
    expect(
      cacheStage.indexOf("verify-managed-messaging-offline-install.mts --lockfile"),
    ).toBeGreaterThan(cacheStage.indexOf("NPM_CONFIG_OFFLINE=true npm ci"));
    expect(cacheStage).toContain('--os linux --cpu "$npm_target_cpu" --libc glibc');
    expect(cacheStage.indexOf("npm cache verify")).toBeGreaterThan(
      cacheStage.indexOf("NPM_CONFIG_OFFLINE=true npm ci"),
    );
    expect(cacheStage.indexOf("--packuments-only")).toBeGreaterThan(
      cacheStage.indexOf("npm cache verify"),
    );
    expect(cacheStage).not.toContain("--network=default");
    expect(cacheStage).not.toContain("else \\");
    expect(cacheStage).not.toContain("find /opt/nemoclaw-build-tools/npm-cache-seed");
  });

  it("rejects nested installed versions that differ from the reviewed lock", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "managed-messaging-install-test-"));
    try {
      nestedOverrideLocations.forEach((location) => {
        writeInstalledVersion(temporary, location, runtimeLock.packages[location].version);
      });
      verifyManagedMessagingOfflineInstall(
        path.join(runtimeDirectory, "package-lock.json"),
        temporary,
      );
      writeInstalledVersion(temporary, nestedOverrideLocations[0], "0.0.0");
      expect(() =>
        verifyManagedMessagingOfflineInstall(
          path.join(runtimeDirectory, "package-lock.json"),
          temporary,
        ),
      ).toThrow("managed messaging nested override mismatch");
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
});
