// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

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
const runtimeLock = JSON.parse(
  fs.readFileSync(path.join(runtimeDirectory, "package-lock.json"), "utf8"),
);
function dockerfileSection(startMarker: string, endMarker: string): string {
  const start = dockerfile.indexOf(startMarker);
  const end = dockerfile.indexOf(endMarker, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return dockerfile.slice(start, end);
}

describe("OpenClaw managed messaging offline image build", () => {
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
  });

  it("materializes one exact platform seed from the committed lock", () => {
    const archiveStage = dockerfileSection(
      "AS openclaw-managed-messaging-npm-archives",
      "# Keep the complete managed-image messaging dependency graph inert",
    );

    expect(archiveStage).toContain(
      "COPY agents/openclaw/managed-image-messaging-runtime/package-lock.json",
    );
    expect(archiveStage).toContain(
      "COPY agents/openclaw/managed-image-messaging-runtime/npm-cache-seed/",
    );
    expect(archiveStage).toContain("RUN --network=default set -eu;");
    expect(archiveStage).toContain(
      "copy --lockfile /opt/managed-image-messaging-runtime/package-lock.json",
    );
    expect(archiveStage).toContain(
      "export --lockfile /opt/managed-image-messaging-runtime/package-lock.json",
    );
    expect(archiveStage).toContain('--output /out --os linux --cpu "$npm_target_cpu" --libc glibc');
    expect(archiveStage).not.toContain("ADD ");
  });

  it("verifies and materializes the selected archives with networking disabled", () => {
    const cacheStage = dockerfileSection(
      "AS openclaw-managed-messaging-npm-cache-1",
      "FROM openclaw-managed-messaging-npm-cache-${NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION}",
    );

    expect(dockerfile).toContain("AS openclaw-managed-messaging-npm-archives");
    expect(cacheStage).toContain(
      "COPY --from=openclaw-managed-messaging-npm-archives /out/ /opt/nemoclaw-build-tools/npm-cache-seed/",
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
