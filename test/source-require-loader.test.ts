// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
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
  lockWaits: number;
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
  readyPath?: string,
): void {
  const script = `
require(${JSON.stringify(SOURCE_REQUIRE_HOOK)});
${readyPath ? `require("node:fs").writeFileSync(${JSON.stringify(readyPath)}, "ready\\n");` : ""}
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

function waitForFile(filename: string, timeoutMs = 2_000): void {
  const deadline = Date.now() + timeoutMs;
  const sleepBuffer = new SharedArrayBuffer(4);
  const sleepArray = new Int32Array(sleepBuffer);
  while (Date.now() < deadline) {
    if (fs.existsSync(filename)) return;
    Atomics.wait(sleepArray, 0, 0, 5);
  }
  throw new Error(`Timed out waiting for ${filename}`);
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

  it("waits for a live lock owner to publish the cache without duplicate transpilation (#6237)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-source-require-wait-"));
    roots.push(root);
    const fixturePath = path.join(root, "fixture.ts");
    const statsPath = path.join(root, "stats.jsonl");
    const readyPath = path.join(root, "publisher-ready");
    const consumerReadyPath = path.join(root, "consumer-ready");
    fs.writeFileSync(fixturePath, "export const value: number = 42;\n");
    const fixtureRealPath = fs.realpathSync(fixturePath);

    const { cachePath, lockPath } = trackCacheArtifacts(fixtureRealPath);
    const publisherCachePath = `${cachePath}.publisher`;
    cacheArtifacts.push(publisherCachePath);
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.rmSync(cachePath, { force: true });
    const publisherScript = `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(lockPath)}, JSON.stringify({ pid: process.pid }) + "\\n", {
  flag: "wx",
  mode: 0o600,
});
fs.writeFileSync(${JSON.stringify(readyPath)}, "ready\\n");
const deadline = Date.now() + 5000;
const publishWhenConsumerIsReady = () => {
  if (fs.existsSync(${JSON.stringify(consumerReadyPath)})) {
    setTimeout(() => {
      fs.writeFileSync(${JSON.stringify(publisherCachePath)}, "exports.value = 42;\\n", {
        flag: "wx",
        mode: 0o600,
      });
      fs.renameSync(${JSON.stringify(publisherCachePath)}, ${JSON.stringify(cachePath)});
    }, 100);
    setTimeout(() => fs.rmSync(${JSON.stringify(lockPath)}, { force: true }), 200);
    return;
  }
  if (Date.now() >= deadline) {
    process.exitCode = 2;
    return;
  }
  setTimeout(publishWhenConsumerIsReady, 5);
};
publishWhenConsumerIsReady();
`;
    const publisher = spawn(process.execPath, ["-e", publisherScript], {
      env: {
        ...process.env,
        NODE_OPTIONS: nodeOptionsWithoutSourceLoader(process.env.NODE_OPTIONS),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let publisherStderr = "";
    publisher.stderr?.setEncoding("utf8");
    publisher.stderr?.on("data", (chunk: string) => {
      publisherStderr += chunk;
    });

    try {
      waitForFile(readyPath);
      runFixtureRequire(
        fixtureRealPath,
        statsPath,
        {
          NEMOCLAW_SOURCE_REQUIRE_CACHE_POLL_MS: "5",
          NEMOCLAW_SOURCE_REQUIRE_CACHE_WAIT_MS: "2000",
        },
        consumerReadyPath,
      );
      const [code, signal] =
        publisher.exitCode !== null || publisher.signalCode !== null
          ? [publisher.exitCode, publisher.signalCode]
          : await once(publisher, "exit");
      expect({ code, signal, stderr: publisherStderr }).toMatchObject({ code: 0, signal: null });
    } finally {
      if (publisher.exitCode === null && publisher.signalCode === null) publisher.kill();
    }

    const [row] = readStats(statsPath);
    expect(row).toMatchObject({
      cacheHits: 1,
      cacheMisses: 1,
      duplicateFallbacks: 0,
      lockWaits: 1,
      staleLocks: 0,
      transforms: 0,
    });
  });

  it("preserves a stale-looking live lock and falls back after the bounded wait (#6237)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-source-require-live-lock-"));
    roots.push(root);
    const fixturePath = path.join(root, "fixture.ts");
    const statsPath = path.join(root, "stats.jsonl");
    fs.writeFileSync(fixturePath, "export const value: number = 42;\n");
    const fixtureRealPath = fs.realpathSync(fixturePath);

    const { cachePath, lockPath } = trackCacheArtifacts(fixtureRealPath);
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.rmSync(cachePath, { force: true });
    fs.writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid })}\n`, { mode: 0o600 });
    const staleTime = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, staleTime, staleTime);

    runFixtureRequire(fixtureRealPath, statsPath, {
      NEMOCLAW_SOURCE_REQUIRE_CACHE_LOCK_STALE_MS: "1",
      NEMOCLAW_SOURCE_REQUIRE_CACHE_POLL_MS: "1",
      NEMOCLAW_SOURCE_REQUIRE_CACHE_WAIT_MS: "5",
    });

    const [row] = readStats(statsPath);
    expect(row).toMatchObject({
      cacheHits: 0,
      cacheMisses: 1,
      duplicateFallbacks: 1,
      lockWaits: 1,
      staleLocks: 0,
      transforms: 1,
    });
    expect(fs.existsSync(cachePath)).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it("rejects a symlinked stats destination inside an allowed directory (#6237)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-source-require-stats-link-"));
    roots.push(root);
    const fixturePath = path.join(root, "fixture.ts");
    const targetPath = path.join(root, "target.jsonl");
    const statsPath = path.join(root, "stats.jsonl");
    fs.writeFileSync(fixturePath, "export const value: number = 42;\n");
    fs.writeFileSync(targetPath, "sentinel\n");
    fs.symlinkSync(targetPath, statsPath);
    trackCacheArtifacts(fs.realpathSync(fixturePath));

    runFixtureRequire(fixturePath, statsPath);

    expect(fs.readFileSync(targetPath, "utf8")).toBe("sentinel\n");
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
