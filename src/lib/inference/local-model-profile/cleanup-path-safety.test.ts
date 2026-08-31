// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cleanupHuggingFaceCacheData,
  cleanupLocalModelRuntimes,
  type LocalModelRuntimeCleanupOptions,
} from "./cleanup";

const temporaryDirectories: string[] = [];

function home(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cleanup-path-safety-"));
  temporaryDirectories.push(directory);
  return directory;
}

function hostIdentity(): string {
  return `${String(process.getuid?.() ?? 0)}:${String(process.getgid?.() ?? 0)}`;
}

function privilegedOrNonPosixHost(): boolean {
  return (
    process.platform === "win32" || typeof process.getuid !== "function" || process.getuid() === 0
  );
}

function dockerDeps(
  overrides: NonNullable<LocalModelRuntimeCleanupOptions["deps"]> = {},
): NonNullable<LocalModelRuntimeCleanupOptions["deps"]> {
  return {
    capture: vi.fn(() => "") as never,
    forceRm: vi.fn(() => ({ status: 0 })) as never,
    run: vi.fn(() => ({ status: 0 })) as never,
    ...overrides,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("host-local model cleanup path safety", () => {
  it.skipIf(process.platform === "win32")(
    "fails closed when the Hugging Face model cache is a symlink",
    () => {
      const homeDir = home();
      const cacheParent = path.join(homeDir, ".cache");
      const target = path.join(homeDir, "substituted-cache");
      fs.mkdirSync(cacheParent);
      fs.mkdirSync(target);
      fs.symlinkSync(target, path.join(cacheParent, "huggingface"), "dir");

      expect(cleanupHuggingFaceCacheData({ homeDir })).toMatchObject({
        ok: false,
        reason: expect.stringContaining("model cache is a symlink"),
      });
      expect(fs.existsSync(target)).toBe(true);
    },
  );

  it.skipIf(typeof process.getuid !== "function")(
    "fails closed when the Hugging Face model cache has an unexpected owner",
    () => {
      const homeDir = home();
      const cache = path.join(homeDir, ".cache", "huggingface");
      fs.mkdirSync(cache, { recursive: true });
      const observedOwner = fs.lstatSync(cache).uid;

      expect(
        cleanupHuggingFaceCacheData({
          homeDir,
          currentUserId: observedOwner + 1,
        }),
      ).toMatchObject({
        ok: false,
        reason: expect.stringContaining("cache parent is not owned by the current user"),
      });
      expect(fs.existsSync(cache)).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")(
    "restores owner-only writes before deleting a group-writable Hugging Face model cache",
    () => {
      const homeDir = home();
      const cache = path.join(homeDir, ".cache", "huggingface");
      fs.mkdirSync(cache, { recursive: true });
      fs.writeFileSync(path.join(cache, "shared-model"), "delete");
      fs.chmodSync(cache, 0o777);

      expect(cleanupHuggingFaceCacheData({ homeDir })).toMatchObject({ ok: true });
      expect(fs.lstatSync(cache).mode & 0o022).toBe(0);
      expect(fs.existsSync(path.join(cache, "shared-model"))).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "fails closed when the Hugging Face cache parent is group-writable",
    () => {
      const homeDir = home();
      const cache = path.join(homeDir, ".cache", "huggingface");
      fs.mkdirSync(cache, { recursive: true });
      fs.chmodSync(path.dirname(cache), 0o775);

      expect(cleanupHuggingFaceCacheData({ homeDir })).toMatchObject({
        ok: false,
        reason: expect.stringContaining("cache parent is not current-user filesystem authority"),
      });
      expect(fs.existsSync(cache)).toBe(true);
    },
  );

  it.skipIf(privilegedOrNonPosixHost())(
    "names the blocking directory in the ownership repair for a nested cache entry",
    () => {
      const homeDir = home();
      const cache = path.join(homeDir, ".cache", "huggingface");
      const blocking = path.join(cache, "hub", "models--nvidia--demo", "blobs");
      fs.mkdirSync(blocking, { recursive: true });
      fs.writeFileSync(path.join(blocking, "sha256-demo"), "written by a root container");
      fs.chmodSync(blocking, 0o500);

      const blockedRun = cleanupHuggingFaceCacheData({ homeDir });
      fs.chmodSync(blocking, 0o700);
      const repairedRun = cleanupHuggingFaceCacheData({ homeDir });

      expect(blockedRun).toMatchObject({
        ok: false,
        reason: expect.stringContaining(
          `is not removable by host user ${hostIdentity()}. It may have been created`,
        ),
      });
      expect(blockedRun).toMatchObject({
        reason: expect.stringContaining(
          `Repair ownership and owner access, then retry uninstall: ` +
            `sudo chown -R ${hostIdentity()} '${blocking}' && ` +
            `sudo chmod -R u+rwX '${blocking}'`,
        ),
      });
      expect(repairedRun).toMatchObject({ ok: true });
      expect(fs.existsSync(path.join(cache, "hub"))).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps the set-group-id bit while clearing the group write bit from the model cache",
    () => {
      const homeDir = home();
      const cache = path.join(homeDir, ".cache", "huggingface");
      fs.mkdirSync(cache, { recursive: true });
      fs.chmodSync(cache, 0o2775);

      expect(cleanupHuggingFaceCacheData({ homeDir })).toMatchObject({ ok: true });
      expect(fs.lstatSync(cache).mode & 0o7777).toBe(0o2755);
    },
  );

  it.skipIf(process.platform === "win32")(
    "leaves an owner-only model cache at its existing mode",
    () => {
      const homeDir = home();
      const cache = path.join(homeDir, ".cache", "huggingface");
      fs.mkdirSync(cache, { recursive: true, mode: 0o700 });

      expect(cleanupHuggingFaceCacheData({ homeDir })).toMatchObject({ ok: true });
      expect(fs.lstatSync(cache).mode & 0o7777).toBe(0o700);
    },
  );

  it.skipIf(privilegedOrNonPosixHost())(
    "reports the cache data it already deleted when a later entry blocks removal",
    () => {
      const homeDir = home();
      const cache = path.join(homeDir, ".cache", "huggingface");
      const blocking = path.join(cache, "hub");
      fs.mkdirSync(blocking, { recursive: true });
      fs.writeFileSync(path.join(blocking, "sha256-demo"), "written by a root container");
      fs.writeFileSync(path.join(cache, "datasets"), "deletable");
      fs.chmodSync(blocking, 0o500);

      const result = cleanupHuggingFaceCacheData({ homeDir });
      fs.chmodSync(blocking, 0o700);

      expect(result).toMatchObject({ ok: false, removed: [`cache-contents:${cache}`] });
      expect(fs.existsSync(path.join(cache, "datasets"))).toBe(false);
    },
  );

  it.skipIf(privilegedOrNonPosixHost())(
    "names the cache entry itself when its own directory denies removal",
    () => {
      const homeDir = home();
      const cache = path.join(homeDir, ".cache", "huggingface");
      const blocking = path.join(cache, "hub");
      fs.mkdirSync(blocking, { recursive: true });
      fs.writeFileSync(path.join(blocking, "sha256-demo"), "written by a root container");
      fs.chmodSync(blocking, 0o500);

      const result = cleanupHuggingFaceCacheData({ homeDir });
      fs.chmodSync(blocking, 0o700);

      expect(result).toMatchObject({
        reason: expect.stringContaining(`sudo chown -R ${hostIdentity()} '${blocking}'`),
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "fails closed when managed llama.cpp state is a symlink",
    () => {
      const homeDir = home();
      const stateRoot = path.join(homeDir, ".nemoclaw");
      const target = path.join(homeDir, "substituted-state");
      fs.mkdirSync(stateRoot, { recursive: true });
      fs.mkdirSync(target);
      fs.symlinkSync(target, path.join(stateRoot, "managed-llama-cpp"), "dir");
      const deps = dockerDeps();

      expect(cleanupLocalModelRuntimes({ homeDir, deps })).toMatchObject({
        ok: false,
        reason: expect.stringContaining("symlink"),
      });
      expect(deps.capture).not.toHaveBeenCalled();
      expect(deps.forceRm).not.toHaveBeenCalled();
    },
  );

  it.skipIf(typeof process.getuid !== "function")(
    "fails closed when managed llama.cpp state has an unexpected owner",
    () => {
      const homeDir = home();
      const stateDir = path.join(homeDir, ".nemoclaw", "managed-llama-cpp");
      fs.mkdirSync(stateDir, { recursive: true });
      const observedOwner = fs.lstatSync(stateDir).uid;
      const deps = dockerDeps({ currentUserId: observedOwner + 1 });

      expect(cleanupLocalModelRuntimes({ homeDir, deps })).toMatchObject({
        ok: false,
        reason: expect.stringContaining("not owned by the current user"),
      });
      expect(deps.capture).not.toHaveBeenCalled();
      expect(deps.forceRm).not.toHaveBeenCalled();
    },
  );

  it("fails closed when managed llama.cpp state is not a directory", () => {
    const homeDir = home();
    const stateRoot = path.join(homeDir, ".nemoclaw");
    fs.mkdirSync(stateRoot, { recursive: true });
    fs.writeFileSync(path.join(stateRoot, "managed-llama-cpp"), "unexpected\n");
    const deps = dockerDeps();

    expect(cleanupLocalModelRuntimes({ homeDir, deps })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("not a directory"),
    });
    expect(deps.capture).not.toHaveBeenCalled();
    expect(deps.forceRm).not.toHaveBeenCalled();
  });
});
