// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = path.join(import.meta.dirname, "..", "scripts", "brev-launchable-cua-gpu.sh");

describe("CUA GPU Brev Launchable (#7753)", () => {
  it("rejects a mutable candidate before invoking Launchable prerequisites", () => {
    const result = spawnSync("bash", [SCRIPT], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, NEMOCLAW_REF: "main" },
      timeout: 10_000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("NEMOCLAW_REF must be an exact lowercase 40-hex commit");
    expect(result.stderr).not.toContain("does not expose nvidia-smi");
  });

  it("is valid shell syntax", () => {
    const result = spawnSync("bash", ["-n", SCRIPT], {
      encoding: "utf8",
      timeout: 10_000,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });
});
