// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { resolveReviewedMcporterPackage } from "../../scripts/lib/reviewed-mcporter-package.mts";
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
const reviewedAuditConfig = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "ci", "reviewed-npm-audit.json"), "utf8"),
) as {
  lockedGraphs: Array<{
    directory: string;
    id: string;
    integrity: string;
    lockSha256: string;
    replacementLockSha256?: string;
    packageSpec: string;
    tarballUrl: string;
  }>;
};

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

  it("fails closed before install when the selected package identity is unreviewed", () => {
    expect(
      resolveReviewedMcporterPackage(expectedVersion, expectedIntegrity, expectedTarball),
    ).toEqual({
      integrity: expectedIntegrity,
      tarballUrl: expectedTarball,
      version: expectedVersion,
    });
    expect(() =>
      resolveReviewedMcporterPackage("9.9.9-unreviewed", expectedIntegrity, expectedTarball),
    ).toThrow("mcporter 9.9.9-unreviewed has no committed npm integrity pin");
    expect(() =>
      resolveReviewedMcporterPackage(expectedVersion, "sha512-unreviewed", expectedTarball),
    ).toThrow("does not match the committed npm package identity");
  });

  it("verifies the exact committed dependency graph signatures in trusted CI (#8925)", () => {
    const graph = reviewedAuditConfig.lockedGraphs.find(
      (candidate) => candidate.id === "mcporter-runtime",
    );
    expect(graph).toMatchObject({
      directory: "agents/openclaw/mcporter-runtime",
      integrity: expectedIntegrity,
      packageSpec: `mcporter@${expectedVersion}`,
      tarballUrl: expectedTarball,
    });

    const lockfile = fs.readFileSync(path.join(runtimeDirectory, "package-lock.json"));
    expect(createHash("sha256").update(lockfile).digest("hex")).toBe(
      graph?.replacementLockSha256,
    );
  });
});
