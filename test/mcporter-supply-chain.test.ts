// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = path.join(import.meta.dirname, "..");
const runtimeDirectory = path.join(repoRoot, "agents", "openclaw", "mcporter-runtime");
const packageManifest = JSON.parse(
  fs.readFileSync(path.join(runtimeDirectory, "package.json"), "utf8"),
);
const packageLock = JSON.parse(
  fs.readFileSync(path.join(runtimeDirectory, "package-lock.json"), "utf8"),
);
const dockerfiles = ["Dockerfile.base", "Dockerfile"].map((name) => ({
  name,
  contents: fs.readFileSync(path.join(repoRoot, name), "utf8"),
}));
const expectedVersion = "0.7.3";
const expectedIntegrity =
  "sha512-egoPVYqTnWb3NjRIxo+xc8OrAI0dlPrJm9pAiZx0pImuNIV5rKhGtTnIfH/Y1ldGPVu74ibj3KR5c9U/QSdQFA==";
const runtimePrefix = "npm --prefix /usr/local/lib/nemoclaw/mcporter-runtime";

describe("mcporter image supply-chain controls", () => {
  it("commits an exact registry-only production dependency graph", () => {
    expect(packageManifest).toMatchObject({
      private: true,
      dependencies: { mcporter: expectedVersion },
    });
    expect(packageLock).toMatchObject({
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { mcporter: expectedVersion } },
        "node_modules/mcporter": {
          version: expectedVersion,
          integrity: expectedIntegrity,
        },
      },
    });

    for (const [packagePath, entry] of Object.entries(packageLock.packages).slice(1)) {
      expect(entry, packagePath).toMatchObject({
        resolved: expect.stringMatching(/^https:\/\/registry\.npmjs\.org\//),
        integrity: expect.stringMatching(/^sha512-/),
      });
    }
  });

  it.each(dockerfiles)("pins and verifies the package in $name", ({ contents }) => {
    const flattenedContents = contents.replace(/\\\s*\n/g, " ").replace(/\s+/g, " ");

    expect(contents).toContain(`ARG MCPORTER_VERSION=${expectedVersion}`);
    expect(contents).toContain(`ARG MCPORTER_0_7_3_INTEGRITY=${expectedIntegrity}`);
    expect(contents).toContain('npm view "mcporter@${MCPORTER_VERSION}" dist.integrity');
    expect(contents).toContain(
      "COPY agents/openclaw/mcporter-runtime/package.json /usr/local/lib/nemoclaw/mcporter-runtime/package.json",
    );
    expect(contents).toContain(
      "COPY agents/openclaw/mcporter-runtime/package-lock.json /usr/local/lib/nemoclaw/mcporter-runtime/package-lock.json",
    );
    expect(flattenedContents).toContain(
      `${runtimePrefix} ci --ignore-scripts --omit=dev --no-audit --no-fund --no-progress`,
    );
    expect(contents).toContain(
      "ln -s /usr/local/lib/nemoclaw/mcporter-runtime/node_modules/.bin/mcporter /usr/local/bin/mcporter",
    );
    expect(contents).toContain('test "$(mcporter --version)" = "$MCPORTER_VERSION"');
    expect(contents).not.toMatch(/npm install -g[^\n]*mcporter/);
    expect(contents).not.toContain("mcporter shrinkwrap");
  });

  it.each(dockerfiles)("audits the committed dependency graph in $name", ({ contents }) => {
    expect(contents).toContain(`${runtimePrefix} audit --omit=dev --audit-level=low`);
    expect(contents).toContain(`${runtimePrefix} audit signatures`);
  });
});
