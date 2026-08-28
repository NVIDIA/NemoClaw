// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  type LockedArchive,
  lockedArchives,
} from "../../../scripts/checks/materialize-locked-npm-cache-seed.mts";

const repoRoot = path.join(import.meta.dirname, "../../..");
const dockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
const lockSource = fs.readFileSync(
  path.join(repoRoot, "agents/openclaw/managed-image-messaging-runtime/package-lock.json"),
  "utf8",
);

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
  ].map((match) => ({ archive: match[3], digest: match[1], resolved: match[2] }));
}

function archiveIdentity(archive: LockedArchive | DockerArchivePin): string {
  return `${archive.archive}\n${archive.resolved}`;
}

describe("OpenClaw managed messaging offline image build", () => {
  it("pins the complete lock graphs below the cold-build layer limit", () => {
    const amd64Lock = lockedArchives(lockSource, { cpu: "x64", libc: "glibc", os: "linux" });
    const arm64Lock = lockedArchives(lockSource, {
      cpu: "arm64",
      libc: "glibc",
      os: "linux",
    });
    const amd64Names = new Set(amd64Lock.map(({ archive }) => archive));
    const arm64Names = new Set(arm64Lock.map(({ archive }) => archive));
    const commonLock = amd64Lock.filter(({ archive }) => arm64Names.has(archive));
    const amd64OnlyLock = amd64Lock.filter(({ archive }) => !arm64Names.has(archive));
    const arm64OnlyLock = arm64Lock.filter(({ archive }) => !amd64Names.has(archive));

    const commonArchiveStages = [1, 2, 3].map((part) =>
      dockerfileSection(
        `FROM scratch AS openclaw-managed-messaging-npm-common-archives-${part}`,
        part < 3
          ? `FROM scratch AS openclaw-managed-messaging-npm-common-archives-${part + 1}`
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
    expect(commonArchiveMerge).toContain(
      "COPY --from=openclaw-managed-messaging-npm-common-archives-1 / /",
    );
    expect(commonArchiveMerge).toContain(
      "COPY --from=openclaw-managed-messaging-npm-common-archives-2 / /",
    );
    expect(commonArchiveMerge).toContain(
      "COPY --from=openclaw-managed-messaging-npm-common-archives-3 / /",
    );
    expect(amd64OnlyPins.map(archiveIdentity)).toEqual(amd64OnlyLock.map(archiveIdentity));
    expect(arm64OnlyPins.map(archiveIdentity)).toEqual(arm64OnlyLock.map(archiveIdentity));
    expect(new Set(commonPins.map(({ digest }) => digest)).size).toBe(commonPins.length);
    expect(new Set(amd64OnlyPins.map(({ digest }) => digest)).size).toBe(amd64OnlyPins.length);
    expect(new Set(arm64OnlyPins.map(({ digest }) => digest)).size).toBe(arm64OnlyPins.length);
    expect(commonPins.length + amd64OnlyPins.length).toBe(amd64Lock.length);
    expect(commonPins.length + arm64OnlyPins.length).toBe(arm64Lock.length);
  });

  it("verifies and materializes the selected archives with networking disabled", () => {
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
    expect(cacheStage).toContain('--os linux --cpu "$npm_target_cpu" --libc glibc');
    expect(cacheStage).not.toContain("--network=default");
    expect(cacheStage).not.toContain("else \\");
    expect(cacheStage).not.toContain("find /opt/nemoclaw-build-tools/npm-cache-seed");
  });
});
