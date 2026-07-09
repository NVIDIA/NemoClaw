// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import ts from "typescript";

import {
  loadSourceRequireCompilerOptions,
  sourceRequireCacheDir,
  sourceRequireCachePath,
} from "./source-require-cache";

type CommonJsModule = NodeModule & {
  _compile(source: string, filename: string): void;
};

type LockSnapshot = {
  contents: string;
  dev: number;
  ino: number;
  mtimeMs: number;
  size: number;
};

type ResolveFilename = (
  request: string,
  parent?: CommonJsModule | null,
  isMain?: boolean,
  options?: unknown,
) => string;

const moduleRuntime = Module as unknown as {
  _extensions: Record<string, (module: CommonJsModule, filename: string) => void>;
  _resolveFilename: ResolveFilename;
};
const repoRoot = path.resolve(__dirname, "../..");
const compilerOptions = loadSourceRequireCompilerOptions(repoRoot);
// Keep the cross-process transpilation cache in this checkout's dependency
// tree. A shared, predictable directory under the OS temp root could be
// replaced by another local user before a test process reads from it.
const cacheDir = sourceRequireCacheDir(repoRoot);
fs.mkdirSync(cacheDir, { recursive: true });
const cacheWaitMs = envInt("NEMOCLAW_SOURCE_REQUIRE_CACHE_WAIT_MS", 5_000);
const cachePollMs = Math.max(1, envInt("NEMOCLAW_SOURCE_REQUIRE_CACHE_POLL_MS", 25));
const cacheLockStaleMs = envInt("NEMOCLAW_SOURCE_REQUIRE_CACHE_LOCK_STALE_MS", 30_000);
const statsPath = sourceRequireStatsPath(process.env.NEMOCLAW_SOURCE_REQUIRE_STATS);

const stats = {
  cacheHits: 0,
  cacheMisses: 0,
  compileMs: 0,
  duplicateFallbacks: 0,
  files: 0,
  lockWaits: 0,
  readCacheMs: 0,
  staleLocks: 0,
  transforms: 0,
  transformMs: 0,
  waitMs: 0,
};

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
}

function sourceRequireStatsPath(configuredPath: string | undefined): string | undefined {
  if (!configuredPath) return undefined;
  const resolved = path.resolve(configuredPath);
  return [repoRoot, os.tmpdir()].some((root) => isWithin(path.resolve(root), resolved))
    ? resolved
    : undefined;
}

function openSourceRequireStats(statsPath: string): number | null {
  const parent = path.dirname(statsPath);
  let canonicalParent: string;
  try {
    canonicalParent = fs.realpathSync.native(parent);
  } catch {
    return null;
  }
  const canonicalPath = path.join(canonicalParent, path.basename(statsPath));
  const withinAllowedRoot = [repoRoot, os.tmpdir()].some((root) => {
    try {
      return isWithin(fs.realpathSync.native(root), canonicalPath);
    } catch {
      return false;
    }
  });
  if (!withinAllowedRoot) return null;

  let descriptor: number;
  try {
    descriptor = fs.openSync(
      statsPath,
      fs.constants.O_APPEND |
        fs.constants.O_CREAT |
        fs.constants.O_WRONLY |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    return null;
  }
  const stat = fs.fstatSync(descriptor);
  if (!stat.isFile() || stat.nlink !== 1) {
    fs.closeSync(descriptor);
    return null;
  }
  return descriptor;
}

function nowMs(): number {
  return performance.now();
}

const sleepBuffer = new SharedArrayBuffer(4);
const sleepArray = new Int32Array(sleepBuffer);

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(sleepArray, 0, 0, ms);
}

function readCachedOutput(cachePath: string): string | null {
  const start = nowMs();
  try {
    const output = fs.readFileSync(cachePath, "utf8");
    stats.readCacheMs += nowMs() - start;
    return output;
  } catch (error) {
    stats.readCacheMs += nowMs() - start;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  }
}

function writeAtomic(cachePath: string, outputText: string): void {
  const temporaryPath = `${cachePath}.${process.pid}.${crypto.randomUUID()}`;
  fs.writeFileSync(temporaryPath, outputText, { flag: "wx", mode: 0o600 });
  try {
    fs.renameSync(temporaryPath, cachePath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

function readLockSnapshot(lockPath: string): LockSnapshot | null {
  let descriptor: number;
  try {
    descriptor = fs.openSync(lockPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ELOOP") return null;
    throw error;
  }

  try {
    const before = fs.fstatSync(descriptor);
    const contents = fs.readFileSync(descriptor, "utf8");
    const after = fs.fstatSync(descriptor);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mtimeMs !== after.mtimeMs ||
      before.size !== after.size
    ) {
      return null;
    }
    return {
      contents,
      dev: after.dev,
      ino: after.ino,
      mtimeMs: after.mtimeMs,
      size: after.size,
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function parseLockOwner(contents: string): { pid?: number } {
  try {
    const parsed = JSON.parse(contents);
    return typeof parsed?.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0
      ? { pid: parsed.pid }
      : {};
  } catch {
    return {};
  }
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function tryAcquireLock(lockPath: string, filename: string): boolean {
  try {
    fs.writeFileSync(
      lockPath,
      `${JSON.stringify({
        filename,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        startedAtMs: Date.now(),
      })}\n`,
      { flag: "wx", mode: 0o600 },
    );
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return false;
  }
}

function sameLockIdentity(left: LockSnapshot, right: LockSnapshot | null): boolean {
  return (
    right !== null &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mtimeMs === right.mtimeMs &&
    left.size === right.size &&
    left.contents === right.contents
  );
}

function staleLockClaimPath(lockPath: string, snapshot: LockSnapshot): string {
  const identity = crypto
    .createHash("sha256")
    .update(String(snapshot.dev))
    .update("\0")
    .update(String(snapshot.ino))
    .update("\0")
    .update(String(snapshot.mtimeMs))
    .update("\0")
    .update(String(snapshot.size))
    .update("\0")
    .update(snapshot.contents)
    .digest("hex")
    .slice(0, 24);
  return `${lockPath}.reclaim-${identity}`;
}

function reclaimStaleLock(lockPath: string): boolean {
  if (cacheLockStaleMs <= 0) return false;
  const snapshot = readLockSnapshot(lockPath);
  if (snapshot === null || Date.now() - snapshot.mtimeMs < cacheLockStaleMs) return false;
  const { pid } = parseLockOwner(snapshot.contents);
  if (pid !== undefined && processIsRunning(pid)) return false;

  // A hard link is an atomic claim on this exact lock inode. Contenders that
  // observed the same stale lock derive the same claim path, so only one can
  // unlink it. If the lock was replaced before linkSync, the identity check
  // below rejects the replacement without removing it.
  const claimPath = staleLockClaimPath(lockPath, snapshot);
  try {
    fs.linkSync(lockPath, claimPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOENT") return false;
    throw error;
  }

  try {
    const claimed = readLockSnapshot(claimPath);
    if (!sameLockIdentity(snapshot, claimed) || claimed === null) return false;
    let current: fs.Stats;
    try {
      current = fs.lstatSync(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (current.dev !== claimed.dev || current.ino !== claimed.ino) return false;
    fs.unlinkSync(lockPath);
    stats.staleLocks += 1;
    return true;
  } finally {
    fs.rmSync(claimPath, { force: true });
  }
}

function transpileSource(source: string, filename: string): string {
  const start = nowMs();
  const result = ts.transpileModule(source, {
    compilerOptions,
    fileName: filename,
    reportDiagnostics: true,
  });
  stats.transformMs += nowMs() - start;
  stats.transforms += 1;
  const errors = result.diagnostics?.filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (errors && errors.length > 0) {
    throw new Error(
      errors
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
        .join("\n"),
    );
  }
  return result.outputText;
}

function waitForCache(cachePath: string): string | null {
  if (cacheWaitMs <= 0) return null;
  const start = nowMs();
  const deadline = start + cacheWaitMs;
  stats.lockWaits += 1;

  while (nowMs() < deadline) {
    const output = readCachedOutput(cachePath);
    if (output !== null) {
      stats.waitMs += nowMs() - start;
      return output;
    }
    sleepSync(Math.min(cachePollMs, Math.max(0, deadline - nowMs())));
  }
  stats.waitMs += nowMs() - start;
  return null;
}

function compileWithCache(filename: string, source: string, cachePath: string): string {
  const cached = readCachedOutput(cachePath);
  if (cached !== null) {
    stats.cacheHits += 1;
    return cached;
  }
  stats.cacheMisses += 1;

  const lockPath = `${cachePath}.lock`;
  let ownsLock = tryAcquireLock(lockPath, filename);
  if (!ownsLock && reclaimStaleLock(lockPath)) {
    const cachedAfterReclaim = readCachedOutput(cachePath);
    if (cachedAfterReclaim !== null) {
      stats.cacheHits += 1;
      return cachedAfterReclaim;
    }
    ownsLock = tryAcquireLock(lockPath, filename);
  }

  if (!ownsLock) {
    const waited = waitForCache(cachePath);
    if (waited !== null) {
      stats.cacheHits += 1;
      return waited;
    }
    stats.duplicateFallbacks += 1;
    return transpileSource(source, filename);
  }

  try {
    const outputText = transpileSource(source, filename);
    try {
      writeAtomic(cachePath, outputText);
    } catch {
      // The compiled output is still valid when best-effort cache persistence fails.
    }
    return outputText;
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
}

if (statsPath) {
  process.once("exit", () => {
    if (stats.files === 0) return;
    let descriptor: number | null = null;
    try {
      const row = {
        ...stats,
        cacheDir,
        cachePollMs,
        label: process.env.NEMOCLAW_SOURCE_REQUIRE_STATS_LABEL ?? null,
        pid: process.pid,
        rssMb: Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10,
      };
      descriptor = openSourceRequireStats(statsPath);
      if (descriptor !== null) fs.appendFileSync(descriptor, `${JSON.stringify(row)}\n`);
    } catch {
      // Diagnostics are best-effort and must not fail an otherwise successful test process.
    } finally {
      if (descriptor !== null) fs.closeSync(descriptor);
    }
  });
}

const resolveFilename = moduleRuntime._resolveFilename;
moduleRuntime._resolveFilename = function resolveSourceFilename(request, parent, isMain, options) {
  try {
    return resolveFilename.call(this, request, parent, isMain, options);
  } catch (error) {
    const parentFilename = parent?.filename ? path.resolve(parent.filename) : "";
    const sourceRoot = path.join(repoRoot, "src") + path.sep;
    if (request.startsWith(".") && request.endsWith(".js") && parentFilename) {
      const sourceRequest = `${request.slice(0, -3)}.ts`;
      const sourceCandidate = path.resolve(path.dirname(parentFilename), sourceRequest);
      if (sourceCandidate.startsWith(sourceRoot) && fs.existsSync(sourceCandidate)) {
        return resolveFilename.call(this, sourceRequest, parent, isMain, options);
      }
    }
    throw error;
  }
};

moduleRuntime._extensions[".ts"] = (module, filename) => {
  const compileStart = nowMs();
  stats.files += 1;
  const source = fs.readFileSync(filename, "utf8");
  const cachePath = sourceRequireCachePath({ compilerOptions, filename, repoRoot, source });
  const outputText = compileWithCache(filename, source, cachePath);
  stats.compileMs += nowMs() - compileStart;
  module._compile(outputText, filename);
};
