// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDestroyHarness } from "../../../test/helpers/destroy-flow-test-harness";
import { getMcpLifecycleLockPath } from "../../lib/state/mcp-lifecycle-lock-storage";

describe("sandbox:destroy command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it(
    "recovers an abandoned timer and clears registry and lifecycle state (#10066)",
    { timeout: 45_000 },
    async () => {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-destroy-command-"));
      vi.stubEnv("NEMOCLAW_TEST_STATE_DIR", stateDir);
      const timerPath = path.join(stateDir, "shields-timer-alpha.json");
      fs.writeFileSync(
        timerPath,
        JSON.stringify({
          pid: 2_147_483_647,
          sandboxName: "alpha",
          snapshotPath: path.join(stateDir, "snapshot.yaml"),
          restoreAt: new Date(Date.now() - 1_000).toISOString(),
          processToken: "d".repeat(32),
        }),
      );
      const harness = createDestroyHarness({
        activeTimer: true,
        dockerRunResult: { status: 0, stdout: "", stderr: "" },
        openshellDriver: "docker",
        registeredSandboxCount: 1,
        sandboxPresent: false,
      });
      harness.killTimerSpy.mockImplementation(() => {
        fs.rmSync(timerPath, { force: true });
        return { warnings: [] };
      });
      await expect(
        harness.destroyCommand.run(["alpha", "--yes"], process.cwd()),
      ).resolves.toBeUndefined();

      expect(harness.removeSandboxSpy).toHaveBeenCalledWith("alpha");
      expect(fs.existsSync(timerPath)).toBe(false);
      const lockPath = getMcpLifecycleLockPath("alpha", stateDir);
      expect(fs.existsSync(lockPath)).toBe(false);
      expect(fs.existsSync(`${lockPath}.deadline`)).toBe(false);
      expect(fs.existsSync(`${lockPath}.containment`)).toBe(false);
      fs.rmSync(stateDir, { recursive: true, force: true });
    },
  );
});
