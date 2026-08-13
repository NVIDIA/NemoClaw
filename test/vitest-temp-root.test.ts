// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import pluginVitestConfig from "../nemoclaw/vitest.config";
import rootVitestConfig from "../vitest.config";
import {
  prepareGitHubHostedRuntimeAuthority,
  setupVitestTempRoot,
} from "./helpers/vitest-temp-root";

const TEMP_ENV_KEYS = ["TMPDIR", "TMP", "TEMP"] as const;
const ROOT_SETUP = "test/helpers/vitest-temp-root.ts";
const STATE_SETUP = "test/helpers/isolate-test-state.ts";

type TempEnv = Record<(typeof TEMP_ENV_KEYS)[number], string | undefined>;

function restoreEnvValue(key: string, value: string | undefined): void {
  Reflect.deleteProperty(process.env, key);
  Object.assign(process.env, value === undefined ? {} : { [key]: value });
}

function readTempEnv(): TempEnv {
  return {
    TMPDIR: process.env.TMPDIR,
    TMP: process.env.TMP,
    TEMP: process.env.TEMP,
  };
}

function restoreTempEnv(previous: TempEnv): void {
  for (const key of TEMP_ENV_KEYS) {
    restoreEnvValue(key, previous[key]);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Vitest temp root", () => {
  it("reapplies the required Linux runtime-authority ownership and mode (#8942)", () => {
    const install = vi.fn();
    const options = {
      platform: "linux" as const,
      githubActions: "true",
      runnerEnvironment: "github-hosted",
      uid: 1001,
      gid: 1002,
      install,
    };

    prepareGitHubHostedRuntimeAuthority(options);
    prepareGitHubHostedRuntimeAuthority(options);

    expect(install).toHaveBeenCalledTimes(2);
    expect(install).toHaveBeenLastCalledWith(
      "sudo",
      [
        "--non-interactive",
        "install",
        "-d",
        "-m",
        "0700",
        "-o",
        "1001",
        "-g",
        "1002",
        "/run/user/1001",
        "/run/user/1001/nemoclaw",
        "/run/user/1001/nemoclaw/launch-readiness",
      ],
      { stdio: "inherit" },
    );
  });

  it("does not prepare runtime authority on macOS (#8942)", () => {
    const install = vi.fn();

    prepareGitHubHostedRuntimeAuthority({
      platform: "darwin",
      githubActions: "true",
      runnerEnvironment: "github-hosted",
      uid: 1001,
      gid: 1002,
      install,
    });

    expect(install).not.toHaveBeenCalled();
  });

  it("recognizes the GitHub-hosted image marker exported to test processes (#8942)", () => {
    const install = vi.fn();

    prepareGitHubHostedRuntimeAuthority({
      platform: "linux",
      githubActions: "true",
      runnerImageOs: "ubuntu24",
      uid: 1001,
      gid: 1002,
      install,
    });

    expect(install).toHaveBeenCalledOnce();
  });

  it("redirects the selected project into one private temp root", () => {
    const root = process.env.TMPDIR as string;

    expect(process.env.TMP).toBe(root);
    expect(process.env.TEMP).toBe(root);
    expect(os.tmpdir()).toBe(root);
    expect(path.isAbsolute(root)).toBe(true);
    expect(path.basename(root)).toMatch(/^nemoclaw-vitest-/);
    expect(fs.statSync(root).isDirectory()).toBe(true);
  });

  it("isolates each test file's NemoClaw state inside the run root", () => {
    const root = process.env.TMPDIR as string;
    const stateDir = process.env.NEMOCLAW_TEST_STATE_DIR as string;
    const relativeStateDir = path.relative(root, stateDir);

    expect(relativeStateDir).toMatch(/^state-\d+-/);
    expect(relativeStateDir.startsWith(`..${path.sep}`)).toBe(false);
    expect(path.isAbsolute(stateDir)).toBe(true);
    expect(fs.statSync(stateDir).mode & 0o777).toBe(0o700);
  });

  it("removes run artifacts and restores the caller temp environment", () => {
    const outerEnv = readTempEnv();
    const previousKeep = process.env.NEMOCLAW_TEST_KEEP_TEMP;
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-vitest-parent-"));
    let nestedRoot = path.join(parent, "no-nested-root");
    let teardown = (): void => {};

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
      teardown = (): void => {};

      expect(fs.existsSync(nestedRoot)).toBe(false);
      expect(readTempEnv()).toEqual(previous);
    } finally {
      try {
        teardown();
      } finally {
        fs.rmSync(nestedRoot, { recursive: true, force: true });
        fs.rmSync(parent, { recursive: true, force: true });
        restoreTempEnv(outerEnv);
        restoreEnvValue("NEMOCLAW_TEST_KEEP_TEMP", previousKeep);
      }
    }
  });

  it("keeps run artifacts only when explicitly requested", () => {
    const previousKeep = process.env.NEMOCLAW_TEST_KEEP_TEMP;
    const outerEnv = readTempEnv();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let keptRoot = path.join(os.tmpdir(), "no-kept-root");
    let teardown = (): void => {};

    try {
      process.env.NEMOCLAW_TEST_KEEP_TEMP = "1";
      teardown = setupVitestTempRoot();
      keptRoot = process.env.TMPDIR as string;
      fs.writeFileSync(path.join(keptRoot, "sentinel"), "test");

      teardown();
      teardown = (): void => {};

      expect(fs.readFileSync(path.join(keptRoot, "sentinel"), "utf8")).toBe("test");
      expect(readTempEnv()).toEqual(outerEnv);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining(keptRoot));
    } finally {
      try {
        teardown();
      } finally {
        fs.rmSync(keptRoot, { recursive: true, force: true });
        restoreEnvValue("NEMOCLAW_TEST_KEEP_TEMP", previousKeep);
        restoreTempEnv(outerEnv);
      }
    }
  });

  it("removes the run root through the process-exit fallback", () => {
    const outerEnv = readTempEnv();
    const previousKeep = process.env.NEMOCLAW_TEST_KEEP_TEMP;
    const previousExitListeners = process.listenerCount("exit");
    let exitHandler = (_code: number): void => {};
    let root = path.join(os.tmpdir(), "no-exit-fallback-root");
    let teardown = (): void => {};

    try {
      delete process.env.NEMOCLAW_TEST_KEEP_TEMP;
      teardown = setupVitestTempRoot();
      root = process.env.TMPDIR as string;
      fs.writeFileSync(path.join(root, "sentinel"), "test");
      exitHandler = process.listeners("exit").at(-1) as (code: number) => void;

      expect(process.listenerCount("exit")).toBe(previousExitListeners + 1);
      exitHandler(0);
      expect(fs.existsSync(root)).toBe(false);

      teardown();
      teardown = (): void => {};
      expect(readTempEnv()).toEqual(outerEnv);
      expect(process.listenerCount("exit")).toBe(previousExitListeners);
    } finally {
      try {
        teardown();
      } finally {
        process.off("exit", exitHandler);
        fs.rmSync(root, { recursive: true, force: true });
        restoreTempEnv(outerEnv);
        restoreEnvValue("NEMOCLAW_TEST_KEEP_TEMP", previousKeep);
      }
    }
  });

  it("retries cleanup on exit after teardown removal fails", () => {
    const outerEnv = readTempEnv();
    const previousKeep = process.env.NEMOCLAW_TEST_KEEP_TEMP;
    const previousExitListeners = process.listenerCount("exit");
    const removeError = new Error("simulated removal failure");
    const realRmSync = fs.rmSync;
    const remove = vi
      .spyOn(fs, "rmSync")
      .mockImplementationOnce(() => {
        throw removeError;
      })
      .mockImplementation(realRmSync);
    let exitHandler = (_code: number): void => {};
    let root = path.join(os.tmpdir(), "no-retry-root");
    let teardown = (): void => {};

    try {
      delete process.env.NEMOCLAW_TEST_KEEP_TEMP;
      teardown = setupVitestTempRoot();
      root = process.env.TMPDIR as string;
      fs.writeFileSync(path.join(root, "sentinel"), "test");
      exitHandler = process.listeners("exit").at(-1) as (code: number) => void;

      expect(teardown).toThrow(removeError);
      expect(readTempEnv()).toEqual(outerEnv);
      expect(process.listenerCount("exit")).toBe(previousExitListeners + 1);

      exitHandler(0);
      expect(fs.existsSync(root)).toBe(false);
      expect(remove).toHaveBeenCalledTimes(2);

      teardown();
      teardown = (): void => {};
      expect(process.listenerCount("exit")).toBe(previousExitListeners);
    } finally {
      try {
        teardown();
      } finally {
        process.off("exit", exitHandler);
        realRmSync(root, { recursive: true, force: true });
        restoreTempEnv(outerEnv);
        restoreEnvValue("NEMOCLAW_TEST_KEEP_TEMP", previousKeep);
      }
    }
  });

  // source-shape-contract: compatibility -- Root and standalone runners must install the shared temporary-root cleanup boundary
  it("wires cleanup into root and standalone plugin test runs", () => {
    expect(rootVitestConfig.test?.globalSetup).toBe(ROOT_SETUP);
    expect(pluginVitestConfig.test?.globalSetup).toBe(
      path.resolve(import.meta.dirname, "..", ROOT_SETUP),
    );
  });

  // source-shape-contract: security -- Non-live state isolation must never redirect credential-bearing live E2E state
  it("isolates stateful non-live projects without redirecting live E2E state", () => {
    const projects = (rootVitestConfig.test?.projects ?? []) as Array<{
      test?: { name?: string; setupFiles?: string[] };
    }>;
    const setupFilesByProject = new Map(
      projects.map((project) => [project.test?.name, project.test?.setupFiles ?? []]),
    );

    for (const name of [
      "cli",
      "integration",
      "installer-integration",
      "package-contract",
      "e2e-support",
    ]) {
      expect(setupFilesByProject.get(name), name).toContain(STATE_SETUP);
    }
    expect(setupFilesByProject.get("plugin")).not.toContain(STATE_SETUP);
    expect(setupFilesByProject.get("e2e-live")).not.toContain(STATE_SETUP);
  });
});
