// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const UNINSTALL_SCRIPT = path.join(__dirname, "..", "uninstall.sh");

describe("uninstall helpers", () => {
  it("returns the expected gateway volume candidate", () => {
    const result = spawnSync(
      "bash",
      ["-lc", `source "${UNINSTALL_SCRIPT}"; gateway_volume_candidates nemoclaw`],
      {
        cwd: path.join(__dirname, ".."),
        encoding: "utf-8",
      },
    );

    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "openshell-cluster-nemoclaw");
  });
});
