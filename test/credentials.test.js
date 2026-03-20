// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

describe("credential prompts", () => {
  it("exits cleanly when answers are staged through a pipe", () => {
    const script = `
      set -euo pipefail
      pipe="$(mktemp -u)"
      mkfifo "$pipe"
      trap 'rm -f "$pipe"' EXIT
      {
        printf 'sandbox-name\\n'
        sleep 1
        printf 'n\\n'
      } > "$pipe" &
      node -e 'const { prompt } = require(${JSON.stringify(path.join(__dirname, "..", "bin", "lib", "credentials"))}); (async()=>{ await prompt("first: "); await prompt("second: "); })().catch(err=>{ console.error(err); process.exit(1); });' < "$pipe"
    `;

    const result = spawnSync("bash", ["-lc", script], {
      cwd: path.join(__dirname, ".."),
      encoding: "utf-8",
      timeout: 5000,
    });

    assert.equal(result.status, 0);
  });
});
