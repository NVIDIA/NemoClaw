// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import pluginVitestConfig from "../nemoclaw/vitest.config";
import rootVitestConfig from "../vitest.config";
import { setupVitestTempRoot } from "./helpers/vitest-temp-root";

const TEMP_ENV_KEYS = ["TMPDIR", "TMP", "TEMP"] as const;
const ROOT_SETUP = "test/helpers/vitest-temp-root.ts";

type TempEnv = Record<(typeof TEMP_ENV_KEYS)[number], string | undefined>;

function readTempEnv(): TempEnv {
  return {
    TMPDIR: process.env.TMPDIR,
    TMP: process.env.TMP,
    TEMP: process.env.TEMP,
  };
}

function restoreTempEnv(previous: TempEnv): void {
  for (const key of TEMP_ENV_KEYS) {
    const value = previous[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Vitest temp root", () => {
  it("redirects the selected project into one private temp root", () => {
    const root = process.env.TMPDIR as string;

    expect(process.env.TMP).toBe(root);
    expect(process.env.TEMP).toBe(root);
    expect(os.tmpdir()).toBe(root);
    expect(path.isAbsolute(root)).toBe(true);
    expect(path.basename(root)).toMatch(/^nemoclaw-vitest-/);
    expect(fs.statSync(root).isDirectory()).toBe(true);
  });

  it("removes run artifacts and restores the caller temp environment", () => {
    const outerEnv = readTempEnv();
    const previousKeep = process.env.NEMOCLAW_TEST_KEEP_TEMP;
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-vitest-parent-"));
    let nestedRoot: string | undefined;
    let teardown: (() => void) | undefined;

    try {
      delete process.env.NEMOCLAW_TEST_KEEP_TEMP;
      process.env.TMPDIR = parent;
      process.env.TMP = parent;
      delete process.env.TEMP;
      const previous = readTempEnv();

      teardown = setupVitestTempRoot();
      nestedRoot = process.env.TMPDIR as string;
      fs.mkdirSync(path.join(nestedRoot, "nested"));
      fs.writeFileSync(path.join(nestedRoot, "nested", "sentinel"), "test");

      expect(process.env.TMP).toBe(nestedRoot);
      expect(process.env.TEMP).toBe(nestedRoot);
      expect(os.tmpdir()).toBe(nestedRoot);

      teardown();
      teardown = undefined;

      expect(fs.existsSync(nestedRoot)).toBe(false);
      expect(readTempEnv()).toEqual(previous);
    } finally {
      teardown?.();
      if (nestedRoot) fs.rmSync(nestedRoot, { recursive: true, force: true });
      fs.rmSync(parent, { recursive: true, force: true });
      restoreTempEnv(outerEnv);
      if (previousKeep === undefined) {
        delete process.env.NEMOCLAW_TEST_KEEP_TEMP;
      } else {
        process.env.NEMOCLAW_TEST_KEEP_TEMP = previousKeep;
      }
    }
  });

  it("keeps run artifacts only when explicitly requested", () => {
    const previousKeep = process.env.NEMOCLAW_TEST_KEEP_TEMP;
    const outerEnv = readTempEnv();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let keptRoot: string | undefined;
    let teardown: (() => void) | undefined;

    try {
      process.env.NEMOCLAW_TEST_KEEP_TEMP = "1";
      teardown = setupVitestTempRoot();
      keptRoot = process.env.TMPDIR as string;
      fs.writeFileSync(path.join(keptRoot, "sentinel"), "test");

      teardown();
      teardown = undefined;

      expect(fs.readFileSync(path.join(keptRoot, "sentinel"), "utf8")).toBe("test");
      expect(readTempEnv()).toEqual(outerEnv);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining(keptRoot));
    } finally {
      teardown?.();
      if (keptRoot) fs.rmSync(keptRoot, { recursive: true, force: true });
      if (previousKeep === undefined) {
        delete process.env.NEMOCLAW_TEST_KEEP_TEMP;
      } else {
        process.env.NEMOCLAW_TEST_KEEP_TEMP = previousKeep;
      }
      restoreTempEnv(outerEnv);
    }
  });

  it("wires cleanup into root and standalone plugin test runs", () => {
    expect(rootVitestConfig.test?.globalSetup).toBe(ROOT_SETUP);
    expect(pluginVitestConfig.test?.globalSetup).toBe(
      path.resolve(import.meta.dirname, "..", ROOT_SETUP),
    );
  });
});
