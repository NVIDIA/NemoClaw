// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as openshellClient from "../adapters/openshell/client.js";
import { restoreRecreatedSandboxState } from "./sandbox.js";
import {
  createRestoreWarningHarness,
  spawnResult,
  type RestoreWarningHarness,
  type SpawnHandler,
} from "./sandbox-restore-extract-warning-fixture.js";

const spawnRouter = vi.hoisted(() => ({
  handler: ((_command: string, _args?: readonly string[]) => undefined) as SpawnHandler,
}));

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: (command: string, args?: readonly string[], options?: object) =>
      spawnRouter.handler(command, args) ?? actual.spawnSync(command, args, options),
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: (command: string, args?: readonly string[], options?: object) =>
      spawnRouter.handler(command, args) ?? actual.spawnSync(command, args, options),
  };
});

describe("restoreSandboxState tar-warning handling (#12358)", () => {
  let harness: RestoreWarningHarness;

  beforeEach(async () => {
    harness = createRestoreWarningHarness();
    const defs = await import("../agent/defs.js");
    vi.spyOn(defs, "loadAgent").mockImplementation(() => harness.agent);
    vi.stubEnv("NEMOCLAW_OPENSHELL_BIN", process.execPath);
    vi.spyOn(openshellClient, "captureSandboxSshConfigCommand").mockReturnValue({
      status: 0,
      output: "Host openshell-alpha\n  HostName 127.0.0.1\n",
    });
    spawnRouter.handler = harness.spawnHandler;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    harness.dispose();
  });

  it("marks dirs restored when tar exits 1 but every dir is usable", async () => {
    harness.behavior.extract = spawnResult(
      1,
      "tar: sessions: Cannot utime: Operation not permitted\ntar: Exiting with failure status due to previous errors\n",
    );
    harness.behavior.usability = spawnResult(0);

    const result = await restoreRecreatedSandboxState("alpha", harness.writeBackup(), {
      targetAgentType: "fake-agent",
    });

    expect(result.success).toBe(true);
    expect(result.restoredDirs).toEqual(["memories", "sessions"]);
    expect(result.failedDirs).toEqual([]);
  });

  it("marks dirs failed when tar exits non-zero and usability fails", async () => {
    harness.behavior.extract = spawnResult(1, "tar: memories: Cannot open: Permission denied\n");
    harness.behavior.usability = spawnResult(1);

    const result = await restoreRecreatedSandboxState("alpha", harness.writeBackup(), {
      targetAgentType: "fake-agent",
    });

    expect(result.success).toBe(false);
    expect(result.restoredDirs).toEqual([]);
    expect(result.failedDirs).toEqual(["memories", "sessions"]);
  });

  it("keeps clean-extract behavior when tar exits 0", async () => {
    harness.behavior.extract = spawnResult(0);
    harness.behavior.usability = spawnResult(0);

    const result = await restoreRecreatedSandboxState("alpha", harness.writeBackup(), {
      targetAgentType: "fake-agent",
    });

    expect(result.success).toBe(true);
    expect(result.restoredDirs).toEqual(["memories", "sessions"]);
    expect(result.failedDirs).toEqual([]);
  });

  it("fails closed without touching the sandbox when local archive creation fails", async () => {
    harness.behavior.localTar = spawnResult(
      2,
      "tar: /tmp/missing: Cannot stat: No such file or directory\n",
    );

    const result = await restoreRecreatedSandboxState("alpha", harness.writeBackup(), {
      targetAgentType: "fake-agent",
    });

    expect(result.success).toBe(false);
    expect(result.failedDirs).toEqual(["memories", "sessions"]);
    expect(harness.recordedSshCommands).toEqual([]);
  });
});
