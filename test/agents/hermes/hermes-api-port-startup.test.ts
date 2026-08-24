// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const START_SCRIPT = path.join(import.meta.dirname, "../../..", "agents", "hermes", "start.sh");

function runHermesApiPortBootstrap(apiPort: string) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-api-port-"));
  try {
    const scriptPath = path.join(tmpDir, "run.sh");
    const source = fs.readFileSync(START_SCRIPT, "utf-8");
    const start = source.indexOf('NEMOCLAW_CMD=("$@")');
    const end = source.indexOf('\nHERMES="$(command -v hermes)"', start);
    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "set -- true",
        source.slice(start, end).trimEnd(),
        'printf "PUBLIC_PORT=%s\\n" "$PUBLIC_PORT"',
      ].join("\n"),
      { mode: 0o700 },
    );

    return spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      timeout: 5000,
      env: {
        ...process.env,
        NEMOCLAW_HERMES_API_PORT: apiPort,
      },
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("agents/hermes/start.sh API port allocation", () => {
  it("accepts an allocated interior Hermes API port (#8543)", () => {
    const run = runHermesApiPortBootstrap("8645");

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("PUBLIC_PORT=8645");
  });

  it.each([
    "8641",
    "8653",
    "9000",
  ])("rejects Hermes API port %s outside the allocation range", (port) => {
    const run = runHermesApiPortBootstrap(port);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("Invalid NEMOCLAW_HERMES_API_PORT");
  });
});
