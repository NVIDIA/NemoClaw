// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import path from "node:path";
import { spawnSync } from "node:child_process";

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
      node -e 'const { prompt } = require(${JSON.stringify(path.join(import.meta.dirname, "..", "bin", "lib", "credentials"))}); (async()=>{ await prompt("first: "); await prompt("second: "); })().catch(err=>{ console.error(err); process.exit(1); });' < "$pipe"
    `;

    const result = spawnSync("bash", ["-lc", script], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf-8",
      timeout: 5000,
    });

    expect(result.status).toBe(0);
  });
});
