// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const START_SCRIPT = path.join(import.meta.dirname, "..", "scripts", "nemoclaw-start.sh");

function safeTmpHelpers(src: string): string {
  const start = src.indexOf("_nemoclaw_safe_replace_tmp_file() {");
  const end = src.indexOf("_START_LOG=", start);
  if (start === -1 || end === -1 || end <= start) throw new Error("Expected safe temp helpers");
  return src.slice(start, end);
}

describe("nemoclaw-start safe tmp file creation", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  it("creates fixed runtime paths through the safe helper with the requested modes", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-start-safe-tmp-"));
    const gatewayLog = path.join(tmpDir, "gateway.log");
    const autoPairLog = path.join(tmpDir, "auto-pair.log");
    const pidFile = path.join(tmpDir, "nemoclaw-gateway.pid");

    try {
      const script = [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        safeTmpHelpers(src),
        `_nemoclaw_safe_create_tmp_file ${JSON.stringify(gatewayLog)} 644`,
        `_nemoclaw_safe_create_tmp_file ${JSON.stringify(autoPairLog)} 600`,
        `printf '%s\\n' 12345 | _nemoclaw_safe_replace_tmp_file ${JSON.stringify(pidFile)} 600 "" best-effort`,
      ].join("\n");

      const result = spawnSync("bash", ["-c", script], { encoding: "utf-8", timeout: 5000 });

      expect(result.status).toBe(0);
      expect((fs.statSync(gatewayLog).mode & 0o777).toString(8)).toBe("644");
      expect((fs.statSync(autoPairLog).mode & 0o777).toString(8)).toBe("600");
      expect((fs.statSync(pidFile).mode & 0o777).toString(8)).toBe("600");
      expect(fs.readFileSync(pidFile, "utf-8")).toBe("12345\n");
      expect(fs.readdirSync(tmpDir).filter((entry) => entry.includes(".tmp."))).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
