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
const nestedOverrideLocations = managedMessagingNestedOverridePaths(
  runtimeManifest,
  runtimeLock.packages,
);

interface DockerArchivePin {
  archive: string;
  digest: string;
  resolved: string;
}

function writeInstalledOverrides(root: string): void {
  for (const location of nestedOverrideLocations) {
    const entry = runtimeLock.packages[location];
    writeInstalledVersion(root, location, entry.version, entry.name);
  }
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

function writeInstalledVersion(
  root: string,
  location: string,
  version: string,
  name?: string,
): void {
  const packageDirectory = path.join(root, location);
  fs.mkdirSync(packageDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(packageDirectory, "package.json"),
    `${JSON.stringify({ version, name })}\n`,
  );
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
      "@modelcontextprotocol/sdk": "1.32.0",
      "proxy-addr": "2.0.8",
      hono: "4.13.11",
      tar: "7.5.22",
      "fast-uri": "3.1.8",
      undici: "8.12.3",
      npm: { ".": "12.2.1", undici: "6.29.1" },
      "@azure/msal-node": "7.1.0",
      "body-parser": "2.4.0",
      qs: "6.16.1",
      zod: "4.6.6",
      "follow-redirects": "1.16.1",
      "@openclaw/googlechat@2026.10.5": {
        "google-auth-library@11.1.0": {
          "fetch-blob@3.2.0": {
            "node-domexception": "npm:@nolyfill/domexception@1.0.28",
          },
        },
      },
      "@openclaw/discord@2026.10.5": {
        uuid: bundledVersion("node_modules/@openclaw/discord/node_modules/uuid"),
      },
      "@openclaw/whatsapp@2026.10.5": {
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
    expect(nestedOverrideLocations).toHaveLength(5);
    nestedOverrideLocations.forEach((location) => {
      expect(runtimeLock.packages[location]?.version).toMatch(/^\d/u);
    });
    expect(runtimeManifest.dependencies).toMatchObject({
      "@emnapi/core": "1.11.1",
      "@emnapi/runtime": "1.11.3",
    });
    expect(runtimeLock.packages[""].dependencies).toMatchObject({
      "@emnapi/core": "1.11.1",
      "@emnapi/runtime": "1.11.3",
    });
    expect(runtimeLock.packages["node_modules/@emnapi/core"]).toMatchObject({
      version: "1.11.1",
      dependencies: {
        "@emnapi/wasi-threads": "1.2.2",
      },
    });
    expect(runtimeLock.packages["node_modules/@emnapi/runtime"]).toMatchObject({
      version: "1.11.3",
    });
    expect(runtimeLock.packages["node_modules/@emnapi/wasi-threads"]).toMatchObject({
      version: "1.2.2",
    });
    expect(runtimeLock.packages["node_modules/proxy-addr"]).toMatchObject({
      version: "2.0.8",
      dependencies: { forwarded: "0.2.0", "ipaddr.js": "1.9.1" },
    });
  });

  it("pins the complete lock graphs below the cold-build layer limit", () => {
    const amd64Lock = lockedArchives(
      runtimeLockSource,
      {
        cpu: "x64",
        libc: "glibc",
        os: "linux",
      },
      JSON.stringify(runtimeManifest),
    );
    const arm64Lock = lockedArchives(
      runtimeLockSource,
      {
        cpu: "arm64",
        libc: "glibc",
        os: "linux",
      },
      JSON.stringify(runtimeManifest),
    );
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
      "FROM openclaw-managed-messaging-npm-cache-1 AS openclaw-managed-messaging-npm-cache\n",
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
      writeInstalledOverrides(temporary);
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

  it("rejects a missing override scope or a substituted alias in the lock", () => {
    const manifest = {
      overrides: { "@fixture/channel@1.0.0": { shim: "npm:@fixture/replacement@2.0.0" } },
    };
    const scope = "node_modules/@fixture/channel";
    const alias = `${scope}/node_modules/shim`;
    const packages = {
      [scope]: { version: "1.0.0", name: "@fixture/channel" },
      [alias]: { version: "2.0.0", name: "@fixture/replacement" },
    };
    expect(managedMessagingNestedOverridePaths(manifest, packages)).toEqual([alias]);
    packages[alias].name = "shim";
    expect(() => managedMessagingNestedOverridePaths(manifest, packages)).toThrow(
      "managed messaging locked override mismatch",
    );
    packages[alias].name = "@fixture/replacement";
    packages[scope].version = "0.0.0";
    expect(() => managedMessagingNestedOverridePaths(manifest, packages)).toThrow(
      "managed messaging lockfile is missing override scope",
    );
  });

  it("rejects an installed alias substitution even when its version matches", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "managed-messaging-alias-test-"));
    try {
      writeInstalledOverrides(temporary);
      const alias = nestedOverrideLocations.find((location) =>
        location.endsWith("/node-domexception"),
      );
      expect(alias).toBeDefined();
      writeInstalledVersion(
        temporary,
        alias!,
        runtimeLock.packages[alias!].version,
        "node-domexception",
      );
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
