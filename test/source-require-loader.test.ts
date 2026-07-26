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
  beforeHook = "",
): void {
  const script = `
${beforeHook}
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
  while (!fs.existsSync(filename) && Date.now() < deadline) {
    Atomics.wait(sleepArray, 0, 0, 5);
  }
  expect(fs.existsSync(filename), `Timed out waiting for ${filename}`).toBe(true);
}

describe("source require loader", () => {
  it("emits opt-in cache statistics and reuses a cross-process cache entry (#6237)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-source-require-"));
    roots.push(root);
    const fixturePath = path.join(root, "fixture.ts");
    const statsPath = path.join(root, "stats.jsonl");
    fs.writeFileSync(fixturePath, "export const value: number = 42;\n");
    trackCacheArtifacts(fs.realpathSync(fixturePath));

    const diagnosticSentinel = "source-require-environment-sentinel";
    const env = {
      NEMOCLAW_SOURCE_REQUIRE_CACHE_POLL_MS: "0",
      SOURCE_REQUIRE_TEST_SENTINEL: diagnosticSentinel,
    };
    runFixtureRequire(fixturePath, statsPath, env);
    runFixtureRequire(fixturePath, statsPath, env);

    const statsOutput = fs.readFileSync(statsPath, "utf8");
    expect(statsOutput).not.toContain(diagnosticSentinel);
    expect(statsOutput).not.toContain("export const value");
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
      publisher.kill();
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

  it("does not unlink a replacement lock during stale-lock reclamation (#6237)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-source-require-replaced-"));
    roots.push(root);
    const fixturePath = path.join(root, "fixture.ts");
    const statsPath = path.join(root, "stats.jsonl");
    fs.writeFileSync(fixturePath, "export const value: number = 42;\n");
    const fixtureRealPath = fs.realpathSync(fixturePath);
    const { cachePath, lockPath } = trackCacheArtifacts(fixtureRealPath);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.rmSync(cachePath, { force: true });
    fs.writeFileSync(lockPath, `${JSON.stringify({ filename: fixtureRealPath })}\n`, {
      mode: 0o600,
    });
    const staleTime = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, staleTime, staleTime);
    const replacementContents = `${JSON.stringify({
      filename: fixtureRealPath,
      pid: process.pid,
      replacement: true,
    })}\n`;

    runFixtureRequire(
      fixtureRealPath,
      statsPath,
      {
        NEMOCLAW_SOURCE_REQUIRE_CACHE_LOCK_STALE_MS: "1",
        NEMOCLAW_SOURCE_REQUIRE_CACHE_WAIT_MS: "5",
      },
      undefined,
      `
const fs = require("node:fs");
const originalLinkSync = fs.linkSync;
let replaced = false;
fs.linkSync = function replaceSourceRequireLock(existingPath, claimPath) {
  if (!replaced && existingPath === ${JSON.stringify(lockPath)}) {
    replaced = true;
    fs.rmSync(existingPath, { force: true });
    fs.writeFileSync(existingPath, ${JSON.stringify(replacementContents)}, { mode: 0o600 });
  }
  return originalLinkSync.call(this, existingPath, claimPath);
};
`,
    );

    const [row] = readStats(statsPath);
    expect(row).toMatchObject({
      cacheMisses: 1,
      duplicateFallbacks: 1,
      staleLocks: 0,
      transforms: 1,
    });
    expect(fs.readFileSync(lockPath, "utf8")).toBe(replacementContents);
  });

  it.runIf(process.platform !== "win32")(
    "does not follow symlinked cache locks before duplicate fallback (#6237)",
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-source-require-symlink-"));
      roots.push(root);
      const fixturePath = path.join(root, "fixture.ts");
      const statsPath = path.join(root, "stats.jsonl");
      const targetPath = path.join(root, "lock-target");
      fs.writeFileSync(fixturePath, "export const value: number = 42;\n");
      fs.writeFileSync(targetPath, "do not follow\n");
      const fixtureRealPath = fs.realpathSync(fixturePath);
      const { cachePath, lockPath } = trackCacheArtifacts(fixtureRealPath);
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.rmSync(cachePath, { force: true });
      fs.symlinkSync(targetPath, lockPath);

      runFixtureRequire(fixtureRealPath, statsPath, {
        NEMOCLAW_SOURCE_REQUIRE_CACHE_LOCK_STALE_MS: "1",
        NEMOCLAW_SOURCE_REQUIRE_CACHE_WAIT_MS: "5",
      });

      const [row] = readStats(statsPath);
      expect(row).toMatchObject({
        cacheMisses: 1,
        duplicateFallbacks: 1,
        staleLocks: 0,
        transforms: 1,
      });
      expect(fs.lstatSync(lockPath).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(targetPath, "utf8")).toBe("do not follow\n");
      expect(fs.existsSync(cachePath)).toBe(false);
    },
  );

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

  it("limits bootstrap transpilation to source-mapped loader helpers (#6237)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-source-require-bootstrap-"));
    roots.push(root);
    const unexpectedPath = path.join(root, "unexpected.ts");
    fs.writeFileSync(unexpectedPath, "export const unexpected = true;\n");
    const script = `
const Module = require("node:module");
const path = require("node:path");
const expected = new Set([
  path.resolve(${JSON.stringify(path.join(import.meta.dirname, "helpers", "register-source-require.ts"))}),
  path.resolve(${JSON.stringify(path.join(import.meta.dirname, "helpers", "source-require-cache.ts"))}),
]);
const compiled = [];
const originalCompile = Module.prototype._compile;
Module.prototype._compile = function recordBootstrapSource(source, filename) {
  if (expected.has(path.resolve(filename))) {
    compiled.push({ filename: path.resolve(filename), sourceMapped: source.includes("sourceMappingURL=data:application/json;base64") });
  }
  return originalCompile.call(this, source, filename);
};
let rejectedUnexpected = false;
Object.defineProperty(Module._extensions, ".ts", {
  configurable: true,
  get() {
    return undefined;
  },
  set(handler) {
    try {
      handler({ _compile() { throw new Error("unexpected module was compiled"); } }, ${JSON.stringify(unexpectedPath)});
    } catch (error) {
      rejectedUnexpected = String(error).includes("Refusing to bootstrap unexpected TypeScript module");
    }
    Object.defineProperty(Module._extensions, ".ts", {
      configurable: true,
      enumerable: true,
      value: handler,
      writable: true,
    });
  },
});
require(${JSON.stringify(SOURCE_REQUIRE_HOOK)});
if (!rejectedUnexpected || compiled.length !== 2 || compiled.some((entry) => !entry.sourceMapped)) {
  console.error(JSON.stringify({ compiled, rejectedUnexpected }));
  process.exitCode = 9;
}
`;
    const result = spawnSync(process.execPath, ["-e", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_OPTIONS: nodeOptionsWithoutSourceLoader(process.env.NODE_OPTIONS),
      },
      timeout: 10_000,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  it("keeps stats output best-effort when the destination cannot be appended (#6237)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-source-require-stats-"));
    roots.push(root);
    const fixturePath = path.join(root, "fixture.ts");
    fs.writeFileSync(fixturePath, "export const value: number = 42;\n");
    trackCacheArtifacts(fs.realpathSync(fixturePath));

    runFixtureRequire(fixturePath, root);
  });

  it("returns transpiled output when cache persistence fails (#6237)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-source-require-write-"));
    roots.push(root);
    const fixturePath = path.join(root, "fixture.ts");
    const statsPath = path.join(root, "stats.jsonl");
    fs.writeFileSync(fixturePath, "export const value: number = 42;\n");
    const fixtureRealPath = fs.realpathSync(fixturePath);
    const { cachePath, lockPath } = trackCacheArtifacts(fixtureRealPath);
    fs.rmSync(cachePath, { force: true });

    runFixtureRequire(
      fixtureRealPath,
      statsPath,
      {},
      undefined,
      `
const fs = require("node:fs");
const originalRenameSync = fs.renameSync;
fs.renameSync = function renameSourceRequireCache(from, to) {
  if (to === ${JSON.stringify(cachePath)}) {
    const error = new Error("synthetic cache write failure");
    error.code = "EACCES";
    throw error;
  }
  return originalRenameSync.call(this, from, to);
};
`,
    );

    const [row] = readStats(statsPath);
    expect(row).toMatchObject({
      cacheMisses: 1,
      duplicateFallbacks: 0,
      transforms: 1,
    });
    expect(fs.existsSync(cachePath)).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(
      fs
        .readdirSync(path.dirname(cachePath))
        .filter((entry) => entry.startsWith(`${path.basename(cachePath)}.`)),
    ).toEqual([]);
  });
});
