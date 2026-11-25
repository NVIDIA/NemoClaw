// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
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
  it("rejects an installed approval wrapper after the script guard", () => {
    const tempDir = createPackageFixture();
    patchFixture(tempDir);
    const mainPath = path.join(tempDir, "deepagents_code", "main.py");
    const source = fs.readFileSync(mainPath, "utf8");
    const start = source.indexOf("# NemoClaw-managed Deep Agents Code startup approval mode.");
    const guard = source.indexOf('if __name__ == "__main__":', start);
    const wrapper = source.slice(start, guard);
    const stale = source.slice(0, start) + source.slice(guard) + "\n" + wrapper;
    fs.writeFileSync(mainPath, stale);
    const result = spawnSync(
      "python3",
      [path.resolve("agents/langchain-deepagents-code/patch-managed-deepagents-code.py")],
      { encoding: "utf8", env: { PATH: process.env.PATH, PYTHONPATH: tempDir } },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("startup approval patch must precede the script guard");
    expect(fs.readFileSync(mainPath, "utf8")).toBe(stale);
  });

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
