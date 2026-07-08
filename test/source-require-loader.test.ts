// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  nodeOptionsWithoutSourceLoader,
  SOURCE_REQUIRE_HOOK,
} from "./helpers/source-loader-options";
import {
  sourceRequireCachePath as buildSourceRequireCachePath,
  loadSourceRequireCompilerOptions,
} from "./helpers/source-require-cache";

type SourceRequireStats = {
  cacheHits: number;
  cacheMisses: number;
  cachePollMs: number;
  duplicateFallbacks: number;
  files: number;
  label: string | null;
  staleLocks: number;
  transforms: number;
};

const roots: string[] = [];
const cacheArtifacts: string[] = [];
const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const compilerOptions = loadSourceRequireCompilerOptions(REPO_ROOT);

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  for (const artifact of cacheArtifacts.splice(0)) {
    fs.rmSync(artifact, { force: true });
  }
});

function runFixtureRequire(
  fixturePath: string,
  statsPath: string,
  env: Record<string, string> = {},
): void {
  const script = `
require(${JSON.stringify(SOURCE_REQUIRE_HOOK)});
const fixture = require(${JSON.stringify(fixturePath)});
process.exitCode = fixture.value === 42 ? 0 : 7;
`;
  const result = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      NEMOCLAW_SOURCE_REQUIRE_STATS: statsPath,
      NEMOCLAW_SOURCE_REQUIRE_STATS_LABEL: "source-require-loader-test",
      NODE_OPTIONS: nodeOptionsWithoutSourceLoader(process.env.NODE_OPTIONS),
      ...env,
    },
    timeout: 10_000,
  });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}

function exitedChildPid(): number {
  const result = spawnSync(process.execPath, ["-e", ""], {
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.pid).toBeGreaterThan(0);
  return result.pid;
}

function sourceRequireCachePath(filename: string): string {
  return buildSourceRequireCachePath({
    compilerOptions,
    filename,
    repoRoot: REPO_ROOT,
    source: fs.readFileSync(filename, "utf8"),
  });
}

function trackCacheArtifacts(filename: string): { cachePath: string; lockPath: string } {
  const cachePath = sourceRequireCachePath(filename);
  const lockPath = `${cachePath}.lock`;
  cacheArtifacts.push(cachePath, lockPath);
  return { cachePath, lockPath };
}

function readStats(statsPath: string): SourceRequireStats[] {
  return fs
    .readFileSync(statsPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as SourceRequireStats);
}

describe("source require loader", () => {
  it("emits opt-in cache statistics and reuses a cross-process cache entry (#6237)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-source-require-"));
    roots.push(root);
    const fixturePath = path.join(root, "fixture.ts");
    const statsPath = path.join(root, "stats.jsonl");
    fs.writeFileSync(fixturePath, "export const value: number = 42;\n");
    trackCacheArtifacts(fs.realpathSync(fixturePath));

    const env = { NEMOCLAW_SOURCE_REQUIRE_CACHE_POLL_MS: "0" };
    runFixtureRequire(fixturePath, statsPath, env);
    runFixtureRequire(fixturePath, statsPath, env);

    const rows = readStats(statsPath);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      cacheHits: 0,
      cacheMisses: 1,
      cachePollMs: 1,
      files: 1,
      label: "source-require-loader-test",
      transforms: 1,
    });
    expect(rows[1]).toMatchObject({
      cacheHits: 1,
      cacheMisses: 0,
      cachePollMs: 1,
      files: 1,
      label: "source-require-loader-test",
      transforms: 0,
    });
  });

  it("reclaims dead cache locks before falling back to duplicate transpilation (#6237)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-source-require-stale-"));
    roots.push(root);
    const fixturePath = path.join(root, "fixture.ts");
    const statsPath = path.join(root, "stats.jsonl");
    fs.writeFileSync(fixturePath, "export const value: number = 42;\n");
    const fixtureRealPath = fs.realpathSync(fixturePath);

    const { cachePath, lockPath } = trackCacheArtifacts(fixtureRealPath);
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.rmSync(cachePath, { force: true });
    fs.writeFileSync(
      lockPath,
      `${JSON.stringify({
        filename: fixtureRealPath,
        pid: exitedChildPid(),
        startedAtMs: Date.now() - 60_000,
      })}\n`,
      { mode: 0o600 },
    );
    const staleTime = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, staleTime, staleTime);

    runFixtureRequire(fixtureRealPath, statsPath, {
      NEMOCLAW_SOURCE_REQUIRE_CACHE_LOCK_STALE_MS: "1",
      NEMOCLAW_SOURCE_REQUIRE_CACHE_WAIT_MS: "1",
    });

    const [row] = readStats(statsPath);
    expect(row).toMatchObject({
      cacheMisses: 1,
      duplicateFallbacks: 0,
      staleLocks: 1,
      transforms: 1,
    });
    expect(fs.existsSync(cachePath)).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(
      fs
        .readdirSync(path.dirname(cachePath))
        .filter((entry) => entry.startsWith(`${path.basename(lockPath)}.reclaim-`)),
    ).toEqual([]);
  });

  it("keeps stats output best-effort when the destination cannot be appended (#6237)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-source-require-stats-"));
    roots.push(root);
    const fixturePath = path.join(root, "fixture.ts");
    fs.writeFileSync(fixturePath, "export const value: number = 42;\n");
    trackCacheArtifacts(fs.realpathSync(fixturePath));

    runFixtureRequire(fixturePath, root);
  });
});
