// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
const root = path.join(import.meta.dirname, "../../..");
const uvVersionCheckPath = path.join(root, "agents/hermes/check-uv-version.py");

function uvVersionCheckStatus(output: string, expectedVersion: string): number | null {
  return spawnSync("python3", [uvVersionCheckPath, output, expectedVersion]).status;
}

describe("Hermes 0.20.6 dependency review", () => {
  it("accepts uv build metadata and rejects a different semantic version", () => {
    const expectedVersion = "0.11.33";
    expect(
      uvVersionCheckStatus(
        `uv ${expectedVersion} (fece32fc5 2026-07-28 aarch64-unknown-linux-gnu)`,
        expectedVersion,
      ),
    ).toBe(0);
    expect(uvVersionCheckStatus("uv 0.11.34 (different)", expectedVersion)).toBe(1);
    expect(uvVersionCheckStatus(expectedVersion, expectedVersion)).toBe(1);
  });

  it("rejects an altered Hindsight wheel before the compatibility import", () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hindsight-hash-"));
    const artifact = path.join(temporaryRoot, "hindsight_client-0.6.1-py3-none-any.whl");
    const installTarget = path.join(temporaryRoot, "install");
    const requirementsPath = path.join(temporaryRoot, "requirements.txt");
    fs.writeFileSync(artifact, "same version, altered wheel digest\n", "utf8");
    fs.writeFileSync(
      requirementsPath,
      `hindsight-client==0.6.1 --hash=sha256:${"0".repeat(64)}\n`,
      "utf8",
    );
    try {
      const result = spawnSync(
        "python3",
        [
          "-m",
          "pip",
          "install",
          "--target",
          installTarget,
          "--no-deps",
          "--no-index",
          "--find-links",
          temporaryRoot,
          "--require-hashes",
          "-r",
          requirementsPath,
        ],
        { encoding: "utf8" },
      );
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      expect(result.status, output).not.toBe(0);
      expect(output).toContain("DO NOT MATCH THE HASHES");
      expect(fs.existsSync(path.join(installTarget, "hindsight_client"))).toBe(false);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
