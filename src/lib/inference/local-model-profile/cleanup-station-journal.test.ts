// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";
import { loadManagedLlamaCppReceipt, managedLlamaCppStatePaths } from "../llama-cpp/managed-state";
import { prepareManagedLlamaCppRuntimeCleanupForSandbox } from "./cleanup";
import { createManagedState, engineHarness, NETWORK_ID, RUNTIME_ID } from "./cleanup.test-support";

it("cleans an unfinished legacy Station journal without a GPU UUID or receipt", () => {
  const homeDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-cleanup-")),
  );
  try {
    const harness = engineHarness();
    createManagedState(homeDir, harness.engine, {
      phase: "started",
      sandboxName: "station-agent",
      recipeId: "llama-cpp.qwen3-6-35b-a3b.n1x-wsl.v1",
    });
    const paths = managedLlamaCppStatePaths(homeDir);
    expect(loadManagedLlamaCppReceipt(paths)).toBeNull();

    const prepared = prepareManagedLlamaCppRuntimeCleanupForSandbox("station-agent", {
      homeDir,
      engine: harness.engine,
    });
    expect(prepared?.cleanup()).toMatchObject({ ok: true });
    expect(harness.capture).toHaveBeenCalledWith(["rm", "--force", RUNTIME_ID], expect.any(Number));
    expect(harness.capture).toHaveBeenCalledWith(["network", "rm", NETWORK_ID], expect.any(Number));
    expect(fs.existsSync(paths.stateDir)).toBe(false);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
