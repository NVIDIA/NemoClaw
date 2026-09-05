// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureHfCacheDir } from "./vllm";
import type { VllmModelDef } from "./vllm-models";

const temporaryDirectories: string[] = [];
const originalHome = process.env.HOME;
let restoreUmask = 0o022;

function temporaryHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-vllm-hf-cache-"));
  temporaryDirectories.push(home);
  return fs.realpathSync(home);
}

// A umask of 002 is the Ubuntu default and the host state that produced #10650:
// it leaves an unmoded mkdir group-writable, which every current-user authority
// check on the shared cache then rejects.
function permissiveHome(): string {
  const home = temporaryHome();
  process.env.HOME = home;
  restoreUmask = process.umask(0o002);
  return home;
}

function model(): VllmModelDef {
  return { id: "nvidia/Qwen3.6-35B-A3B-NVFP4" } as VllmModelDef;
}

beforeEach(() => {
  restoreUmask = process.umask(0o022);
});

afterEach(() => {
  process.umask(restoreUmask);
  process.env.HOME = originalHome;
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("shared Hugging Face cache directory creation", () => {
  it.skipIf(process.platform === "win32")(
    "creates the shared cache without group or world write access under a permissive umask",
    () => {
      const home = permissiveHome();

      expect(ensureHfCacheDir(model())).toEqual({ ok: true });

      const cache = path.join(home, ".cache", "huggingface");
      expect(fs.lstatSync(cache).mode & 0o022).toBe(0);
      expect(fs.lstatSync(path.dirname(cache)).mode & 0o022).toBe(0);
    },
  );

  it.skipIf(process.platform === "win32")(
    "reuses an existing owner-only shared cache without changing its mode",
    () => {
      const home = permissiveHome();
      const cache = path.join(home, ".cache", "huggingface");
      fs.mkdirSync(cache, { recursive: true, mode: 0o700 });

      expect(ensureHfCacheDir(model())).toEqual({ ok: true });

      expect(fs.lstatSync(cache).mode & 0o7777).toBe(0o700);
    },
  );
});
