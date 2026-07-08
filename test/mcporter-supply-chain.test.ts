// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = path.join(import.meta.dirname, "..");
const runtimeDirectory = path.join(repoRoot, "agents", "openclaw", "mcporter-runtime");
const dockerfiles = ["Dockerfile.base", "Dockerfile"].map((name) => ({
  name,
  contents: fs.readFileSync(path.join(repoRoot, name), "utf8"),
}));
const expectedVersion = "0.7.3";
const expectedIntegrity =
  "sha512-egoPVYqTnWb3NjRIxo+xc8OrAI0dlPrJm9pAiZx0pImuNIV5rKhGtTnIfH/Y1ldGPVu74ibj3KR5c9U/QSdQFA==";
const runtimePrefix = "npm --prefix /usr/local/lib/nemoclaw/mcporter-runtime";

function extractIntegrityGate(contents: string): string {
  const startMarker = 'MCPORTER_EXPECTED_INTEGRITY=""';
  const start = contents.indexOf(startMarker);
  const [end = -1] = [
    contents.indexOf('MCPORTER_LOCK_SHA256="', start),
    contents.indexOf("&& MCPORTER_REGISTRY_INTEGRITY=", start),
  ]
    .filter((index) => index > start)
    .sort((left, right) => left - right);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return contents
    .slice(start, end)
    .replace(/\\\s*\n/g, " ")
    .trim();
}

function runIntegrityGate(contents: string, version: string) {
  const script = [
    "set -euo pipefail",
    `MCPORTER_VERSION=${JSON.stringify(version)}`,
    `MCPORTER_0_7_3_INTEGRITY=${JSON.stringify(expectedIntegrity)}`,
    `npm() { printf '%s\\n' ${JSON.stringify(expectedIntegrity)}; }`,
    extractIntegrityGate(contents),
    "printf 'gate-passed\\n'",
  ].join("\n");
  return spawnSync("bash", ["-c", script], { encoding: "utf8" });
}

describe("mcporter image supply-chain controls", () => {
  it("resolves the committed production graph through npm's lockfile boundary", () => {
    const result = spawnSync(
      "npm",
      ["ls", "--package-lock-only", "--omit=dev", "--all", "--json"],
      { cwd: runtimeDirectory, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    const graph = JSON.parse(result.stdout) as {
      dependencies?: Record<string, { version?: string }>;
      problems?: string[];
    };
    expect(graph.problems).toBeUndefined();
    expect(graph.dependencies?.mcporter?.version).toBe(expectedVersion);
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
    expect(contents).toContain(`${runtimePrefix} audit --omit=dev --audit-level=low`);
    expect(contents).toContain(`${runtimePrefix} audit signatures`);
  });
});
