// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  type ReviewedNpmArchiveRequest,
  verifyReviewedNpmLock,
} from "../../scripts/lib/reviewed-npm-archive.mts";
import { type DependencyNode, findDependency } from "../fixtures/dependency-graph.ts";

const repoRoot = path.join(import.meta.dirname, "../..");
const runtimeDirectory = path.join(repoRoot, "agents", "openclaw", "mcporter-runtime");
const expectedVersion = "0.7.3";
const expectedIntegrity =
  "sha512-egoPVYqTnWb3NjRIxo+xc8OrAI0dlPrJm9pAiZx0pImuNIV5rKhGtTnIfH/Y1ldGPVu74ibj3KR5c9U/QSdQFA==";
const expectedTarball = "https://registry.npmjs.org/mcporter/-/mcporter-0.7.3.tgz";
const expectedHonoNodeServerVersion = "2.0.11";
const expectedHonoNodeServerTarball =
  "https://registry.npmjs.org/@hono/node-server/-/node-server-2.0.11.tgz";
const expectedHonoVersion = "4.12.34";
const expectedHonoTarball = "https://registry.npmjs.org/hono/-/hono-4.12.34.tgz";
const expectedFastUriVersion = "3.1.6";
const expectedFastUriTarball = "https://registry.npmjs.org/fast-uri/-/fast-uri-3.1.6.tgz";
const expectedIpAddressVersion = "10.3.1";
const expectedIpAddressTarball = "https://registry.npmjs.org/ip-address/-/ip-address-10.3.1.tgz";
const temporaryRoots: string[] = [];

type SyntheticMcporterLock = {
  lockfileVersion: number;
  packages: Record<
    string,
    {
      dependencies?: Record<string, string>;
      integrity?: string;
      resolved?: string;
      version?: string;
    }
  >;
};

function writeSyntheticLock(mutate: (lock: SyntheticMcporterLock) => void = () => undefined): {
  expectedLockSha256: string;
  lockfilePath: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcporter-lock-test-"));
  temporaryRoots.push(root);
  const lockfilePath = path.join(root, "package-lock.json");
  const lock: SyntheticMcporterLock = {
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { mcporter: expectedVersion } },
      "node_modules/fast-uri": {
        integrity: `sha512-${"B".repeat(88)}`,
        resolved: expectedFastUriTarball,
        version: expectedFastUriVersion,
      },
      "node_modules/mcporter": {
        dependencies: { "fast-uri": expectedFastUriVersion },
        integrity: expectedIntegrity,
        resolved: expectedTarball,
        version: expectedVersion,
      },
    },
  };
  mutate(lock);
  fs.writeFileSync(lockfilePath, `${JSON.stringify(lock, null, 2)}\n`);
  return {
    expectedLockSha256: createHash("sha256").update(fs.readFileSync(lockfilePath)).digest("hex"),
    lockfilePath,
  };
}

function reviewedMetadata(args: readonly string[], request: ReviewedNpmArchiveRequest): string {
  return args[2] === "dist.integrity" ? request.expectedIntegrity : request.tarballUrl;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe("mcporter image supply-chain controls", () => {
  it("resolves the committed production graph through npm's lockfile boundary", () => {
    const result = spawnSync(
      "npm",
      ["ls", "--package-lock-only", "--omit=dev", "--all", "--json"],
      { cwd: runtimeDirectory, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    const graph = JSON.parse(result.stdout) as DependencyNode & { problems?: string[] };
    expect(graph.problems).toBeUndefined();
    expect(graph.dependencies?.mcporter?.version).toBe(expectedVersion);
    expect(findDependency(graph, "@hono/node-server")).toEqual(
      expect.objectContaining({
        overridden: true,
        resolved: expectedHonoNodeServerTarball,
        version: expectedHonoNodeServerVersion,
      }),
    );
    expect(findDependency(graph, "hono")).toEqual(
      expect.objectContaining({
        overridden: true,
        resolved: expectedHonoTarball,
        version: expectedHonoVersion,
      }),
    );
    expect(findDependency(graph, "fast-uri")).toEqual(
      expect.objectContaining({
        overridden: true,
        resolved: expectedFastUriTarball,
        version: expectedFastUriVersion,
      }),
    );
    expect(findDependency(graph, "ip-address")).toEqual(
      expect.objectContaining({
        overridden: true,
        resolved: expectedIpAddressTarball,
        version: expectedIpAddressVersion,
      }),
    );
  });

  it("binds the selected package identity to every locked dependency", () => {
    const lock = writeSyntheticLock();
    const verified = verifyReviewedNpmLock(
      {
        expectedIntegrity,
        label: `mcporter ${expectedVersion}`,
        packageSpec: `mcporter@${expectedVersion}`,
        registryOrigin: "https://registry.npmjs.org/",
        tarballUrl: expectedTarball,
        ...lock,
      },
      reviewedMetadata,
    );
    expect(verified).toHaveLength(2);
    expect(verified).toEqual(
      expect.arrayContaining([`mcporter@${expectedVersion}`, `fast-uri@${expectedFastUriVersion}`]),
    );
  });

  it("rejects lock byte drift before consulting registry metadata", () => {
    const lock = writeSyntheticLock();
    fs.appendFileSync(lock.lockfilePath, " ");
    let npmCalled = false;

    expect(() =>
      verifyReviewedNpmLock(
        {
          expectedIntegrity,
          label: `mcporter ${expectedVersion}`,
          packageSpec: `mcporter@${expectedVersion}`,
          registryOrigin: "https://registry.npmjs.org/",
          tarballUrl: expectedTarball,
          ...lock,
        },
        () => {
          npmCalled = true;
          return "";
        },
      ),
    ).toThrow("lock SHA-256 mismatch");
    expect(npmCalled).toBe(false);
  });

  it("rejects a transitive package from an unreviewed registry", () => {
    const lock = writeSyntheticLock((candidate) => {
      candidate.packages["node_modules/fast-uri"].resolved =
        "https://packages.invalid/fast-uri-3.1.6.tgz";
    });

    expect(() =>
      verifyReviewedNpmLock(
        {
          expectedIntegrity,
          label: `mcporter ${expectedVersion}`,
          packageSpec: `mcporter@${expectedVersion}`,
          registryOrigin: "https://registry.npmjs.org/",
          tarballUrl: expectedTarball,
          ...lock,
        },
        reviewedMetadata,
      ),
    ).toThrow("reviewed npm lock package must use the reviewed registry");
  });
});
