// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupPackageFixtures,
  createPackageFixture,
  patchFixture,
  writeManagedAutoApproval,
} from "../../helpers/langchain-deepagents-code-patch-fixture";

afterEach(cleanupPackageFixtures);

describe("LangChain Deep Agents Code managed startup approval mode", () => {
  it.each([
    ["deepagents_code", "disabled\n", "auto", "manual"],
    ["deepagents_code", "disabled\n", "yolo", "manual"],
    ["deepagents_code", "thread-opt-in\n", "auto", "auto"],
    ["deepagents_code", "thread-opt-in\n", "manual", "manual"],
    ["deepagents_code.main", "disabled\n", "auto", "manual"],
    ["deepagents_code.main", "thread-opt-in\n", "auto", "auto"],
  ])(
    "python -m %s applies capability %j to the native startup mode %s (#13838)",
    (module, capability, nativeMode, resolvedMode) => {
      const tempDir = createPackageFixture();
      patchFixture(tempDir);
      writeManagedAutoApproval(tempDir, capability);
      const result = spawnSync("python3", ["-m", module], {
        env: {
          PATH: process.env.PATH,
          PYTHONPATH: tempDir,
          FIXTURE_NATIVE_STARTUP_MODE: nativeMode,
        },
        encoding: "utf8",
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`resolved_mode=${resolvedMode}`);
    },
  );
});
