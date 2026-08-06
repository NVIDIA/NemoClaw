// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { cleanupLocalModelRuntimes, type LocalModelRuntimeCleanupOptions } from "./cleanup";

const temporaryDirectories: string[] = [];

function home(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cleanup-path-safety-"));
  temporaryDirectories.push(directory);
  return directory;
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
    "fails closed when managed llama.cpp state is a symlink",
    () => {
      const homeDir = home();
      const stateRoot = path.join(homeDir, ".nemoclaw");
      const target = path.join(homeDir, "substituted-state");
      fs.mkdirSync(stateRoot, { recursive: true });
      fs.mkdirSync(target);
      fs.symlinkSync(target, path.join(stateRoot, "managed-llama-cpp"), "dir");
      const deps = dockerDeps();

      expect(cleanupLocalModelRuntimes({ deleteModels: false, homeDir, deps })).toMatchObject({
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

      expect(cleanupLocalModelRuntimes({ deleteModels: false, homeDir, deps })).toMatchObject({
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

    expect(cleanupLocalModelRuntimes({ deleteModels: false, homeDir, deps })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("not a directory"),
    });
    expect(deps.capture).not.toHaveBeenCalled();
    expect(deps.forceRm).not.toHaveBeenCalled();
  });
});
