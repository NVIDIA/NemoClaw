// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { shellQuote } from "../src/lib/core/shell-quote";
import { extractShellFunction } from "./support/hermes-shell-harness";

const START_SCRIPT = path.join(import.meta.dirname, "..", "agents", "hermes", "start.sh");

describe("agents/hermes/start.sh Tirith retry finalization", () => {
  it("clears a download_failed marker recreated by the handled startup retry", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-tirith-finalize-"));
    const hermesHome = path.join(tmpDir, ".hermes");
    const marker = path.join(hermesHome, ".tirith-install-failed");
    const scriptPath = path.join(tmpDir, "run.sh");
    fs.mkdirSync(hermesHome, { recursive: true });
    fs.writeFileSync(marker, "download_failed");

    const source = fs.readFileSync(START_SCRIPT, "utf-8");
    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        extractShellFunction(source, "retry_tirith_marker_if_needed"),
        extractShellFunction(source, "finalize_tirith_marker_retry"),
        `HERMES_DIR=${shellQuote(hermesHome)}`,
        "TIRITH_RETRY_MARKER_CLEARED=0",
        "retry_tirith_marker_if_needed",
        `printf %s download_failed > ${shellQuote(marker)}`,
        "finalize_tirith_marker_retry",
      ].join("\n"),
      { mode: 0o700 },
    );

    try {
      const result = spawnSync("bash", [scriptPath], {
        encoding: "utf-8",
        timeout: 5000,
        env: process.env,
      });

      expect(result.status).toBe(0);
      expect(fs.existsSync(marker)).toBe(false);
      expect(result.stderr).toContain(
        "Tirith retry completed with download_failed; clearing the handled retry marker",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
