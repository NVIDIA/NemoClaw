// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { restrictSharedCacheWritesToOwner } from "./cleanup";

const temporaryDirectories: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shared-cache-mode-"));
  temporaryDirectories.push(root);
  return fs.realpathSync(root);
}

function currentUserId(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function modeOf(target: string): number {
  return fs.lstatSync(target).mode & 0o7777;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("shared Hugging Face cache write bits", () => {
  it.skipIf(process.platform === "win32")(
    "leaves a directory owned by another account unchanged",
    () => {
      const cache = path.join(temporaryRoot(), "huggingface");
      fs.mkdirSync(cache);
      fs.chmodSync(cache, 0o777);
      const foreignUserId = (currentUserId() ?? 0) + 1;

      restrictSharedCacheWritesToOwner(cache, foreignUserId);

      expect(modeOf(cache)).toBe(0o777);
    },
  );

  it.skipIf(process.platform === "win32")(
    "leaves the cache mode unchanged when host user identity is unavailable",
    () => {
      const cache = path.join(temporaryRoot(), "huggingface");
      fs.mkdirSync(cache);
      fs.chmodSync(cache, 0o775);

      restrictSharedCacheWritesToOwner(cache, null);

      expect(modeOf(cache)).toBe(0o775);
    },
  );

  it.skipIf(process.platform === "win32")("leaves a symlinked cache path unchanged", () => {
    const root = temporaryRoot();
    const target = path.join(root, "substituted-cache");
    const cache = path.join(root, "huggingface");
    fs.mkdirSync(target);
    fs.chmodSync(target, 0o777);
    fs.symlinkSync(target, cache, "dir");

    restrictSharedCacheWritesToOwner(cache, currentUserId());

    expect(modeOf(target)).toBe(0o777);
  });

  it("ignores a cache path that does not exist", () => {
    const cache = path.join(temporaryRoot(), "huggingface");

    restrictSharedCacheWritesToOwner(cache, currentUserId());

    expect(fs.existsSync(cache)).toBe(false);
  });
});
