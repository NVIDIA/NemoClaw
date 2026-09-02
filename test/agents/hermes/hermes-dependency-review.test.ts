// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
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
});
