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
const dockerfiles = ["Dockerfile.base", "Dockerfile"].map((name) => ({
  name,
  contents: fs.readFileSync(path.join(repoRoot, name), "utf8"),
}));
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

const runtimePrefix = "npm --prefix /usr/local/lib/nemoclaw/mcporter-runtime";
const reviewedAuditConfig = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "ci", "reviewed-npm-audit.json"), "utf8"),
) as {
  lockedGraphs: Array<{
    directory: string;
    id: string;
    integrity: string;
    lockSha256: string;
    packageSpec: string;
    tarballUrl: string;
  }>;
};
const reviewedAuditDriver = fs.readFileSync(
  path.join(repoRoot, "scripts", "audit-reviewed-npm-graph.mts"),
  "utf8",
);

function extractIntegrityGate(contents: string): string {
  const startMarker = 'MCPORTER_EXPECTED_INTEGRITY=""';
  const start = contents.indexOf(startMarker);
  const helperMarker =
    "node --experimental-strip-types /scripts/lib/reviewed-npm-archive.mts --verify-only";
  const helperStart = contents.indexOf(helperMarker, start);
  const helperEndMarker = '--label "mcporter ${MCPORTER_VERSION}"';
  const helperEnd = contents.indexOf(helperEndMarker, helperStart) + helperEndMarker.length;
  const [end = -1] = [contents.indexOf('MCPORTER_LOCK_SHA256="', start), helperStart]
    .filter((index) => index > start)
    .sort((left, right) => left - right);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  expect(helperStart).toBeGreaterThanOrEqual(end);
  expect(helperEnd).toBeGreaterThan(helperStart);
  return `${contents.slice(start, end)}\n${contents.slice(helperStart, helperEnd)}`
    .replace(/\\\s*\n/g, " ")
    .trim();
}

function runIntegrityGate(contents: string, version: string) {
  const script = [
    "set -euo pipefail",
    `MCPORTER_VERSION=${JSON.stringify(version)}`,
    `MCPORTER_0_7_3_INTEGRITY=${JSON.stringify(expectedIntegrity)}`,
    `MCPORTER_0_7_3_TARBALL=${JSON.stringify(expectedTarball)}`,
    `npm() { printf '%s\\n' ${JSON.stringify(expectedIntegrity)}; }`,
    "node() {",
    '  [ "$#" -eq 11 ] && [ "${1:-}" = "--experimental-strip-types" ] || return 81',
    '  [ "${2:-}" = "/scripts/lib/reviewed-npm-archive.mts" ] && [ "${3:-}" = "--verify-only" ] || return 82',
    '  [ "${4:-}" = "--package-spec" ] && [ "${5:-}" = "mcporter@${MCPORTER_VERSION}" ] || return 83',
    '  [ "${6:-}" = "--integrity" ] && [ "${7:-}" = ' +
      `${JSON.stringify(expectedIntegrity)} ] || return 84`,
    '  [ "${8:-}" = "--tarball-url" ] && [ "${9:-}" = ' +
      `${JSON.stringify(expectedTarball)} ] || return 85`,
    '  [ "${10:-}" = "--label" ] && [ "${11:-}" = "mcporter ${MCPORTER_VERSION}" ] || return 86',
    "}",
    extractIntegrityGate(contents),
    "printf 'gate-passed\\n'",
  ].join("\n");
  return spawnSync("bash", ["-c", script], { encoding: "utf8" });
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

  it.each(dockerfiles)("pins and verifies the package in $name", ({ contents }) => {
    const flattenedContents = contents.replace(/\\\s*\n/g, " ").replace(/\s+/g, " ");

    expect(contents).toContain(`ARG MCPORTER_VERSION=${expectedVersion}`);
    expect(contents).toContain(`ARG MCPORTER_0_7_3_INTEGRITY=${expectedIntegrity}`);
    expect(contents).toContain(`ARG MCPORTER_0_7_3_TARBALL=${expectedTarball}`);
    expect(flattenedContents).toContain(
      '--verify-only --package-spec "mcporter@${MCPORTER_VERSION}" --integrity "$MCPORTER_EXPECTED_INTEGRITY" --tarball-url "$MCPORTER_EXPECTED_TARBALL"',
    );
    const groupedRuntimeCopy =
      "COPY agents/openclaw/mcporter-runtime/package.json agents/openclaw/mcporter-runtime/package-lock.json /usr/local/lib/nemoclaw/mcporter-runtime/";
    const splitRuntimeCopies = [
      "COPY agents/openclaw/mcporter-runtime/package.json /usr/local/lib/nemoclaw/mcporter-runtime/package.json",
      "COPY agents/openclaw/mcporter-runtime/package-lock.json /usr/local/lib/nemoclaw/mcporter-runtime/package-lock.json",
    ];
    expect(
      flattenedContents.includes(groupedRuntimeCopy) ||
        splitRuntimeCopies.every((copy) => contents.includes(copy)),
    ).toBe(true);
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

  it.each(dockerfiles)("fails closed for unrecognized versions in $name", ({ contents }) => {
    const pinned = runIntegrityGate(contents, expectedVersion);
    expect(pinned.status, pinned.stderr).toBe(0);
    expect(pinned.stdout).toContain("gate-passed");

    const unrecognizedVersion = "9.9.9-unreviewed";
    const unpinned = runIntegrityGate(contents, unrecognizedVersion);
    expect(unpinned.status).not.toBe(0);
    expect(unpinned.stderr).toContain(
      `mcporter ${unrecognizedVersion} has no committed npm integrity pin`,
    );
    expect(unpinned.stdout).not.toContain("gate-passed");
  });

  it.each(dockerfiles)("audits the committed dependency graph in $name", ({ contents }) => {
    const flattenedContents = contents.replace(/\\\s*\n/g, " ").replace(/\s+/g, " ");
    expect(contents).toContain(
      "COPY ci/npm-audit-exceptions.json /scripts/npm-audit-exceptions.json",
    );
    expect(
      flattenedContents.includes(
        "COPY scripts/lib/reviewed-npm-archive.mts scripts/lib/bundled-npm-package.mts scripts/lib/reviewed-npm-audit.mts scripts/lib/openclaw-npm-remediation.mts /scripts/lib/",
      ) ||
        contents.includes(
          "COPY scripts/lib/reviewed-npm-audit.mts /scripts/lib/reviewed-npm-audit.mts",
        ),
    ).toBe(true);
    expect(flattenedContents).toContain(
      "node --experimental-strip-types /scripts/lib/reviewed-npm-audit.mts --directory /usr/local/lib/nemoclaw/mcporter-runtime --exceptions /scripts/npm-audit-exceptions.json --graph mcporter-runtime --threshold high",
    );
    expect(contents).not.toContain(`${runtimePrefix} audit --omit=dev --audit-level=low`);
    expect(contents).not.toContain(`${runtimePrefix} audit signatures`);
    expect(flattenedContents).toContain(
      `${runtimePrefix} ls --omit=dev --all @hono/node-server @modelcontextprotocol/sdk hono mcporter`,
    );
    expect(contents).toContain("StreamableHTTPServerTransport");
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
    expect(createHash("sha256").update(lockfile).digest("hex")).toBe(graph?.lockSha256);
    expect(reviewedAuditDriver).toContain(
      'run("npm", ["audit", "signatures", "--omit=dev"], directory);',
    );
  });
});
