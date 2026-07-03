// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// PATH-shadow regression for start.sh's cold-start secret-boundary invocation.
// Split out of hermes-start.test.ts to keep that file under the changed-test
// size budget while preserving direct coverage of the trusted-python3 path.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { shellQuote } from "../src/lib/core/shell-quote";

const START_SCRIPT = path.join(import.meta.dirname, "..", "agents", "hermes", "start.sh");
const SECRET_BOUNDARY_VALIDATOR_SCRIPT = path.join(
  import.meta.dirname,
  "..",
  "agents",
  "hermes",
  "validate-env-secret-boundary.py",
);

function extractShellFunctionFromSource(source: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match =
    source.match(new RegExp(`${escaped}\\(\\) \\{([\\s\\S]*?)^\\}`, "m")) ??
    (() => {
      throw new Error(`Expected ${name} in agents/hermes/start.sh`);
    })();
  return `${name}() {${match[1]}\n}`;
}

describe("agents/hermes/start.sh env secret boundary (PATH shadowing)", () => {
  it("ignores PATH-shadowed python3 at cold start so the validator cannot be bypassed", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-env-shadow-"));
    const hermesHome = path.join(tmpDir, ".hermes");
    const envFile = path.join(hermesHome, ".env");
    const shadowBin = path.join(tmpDir, "shadow-bin");
    const scriptPath = path.join(tmpDir, "run.sh");
    fs.mkdirSync(hermesHome, { recursive: true });
    fs.mkdirSync(shadowBin, { recursive: true });
    fs.writeFileSync(envFile, "DEVTEST_API_TOKEN=raw-attacker-bypass-token\n");
    fs.writeFileSync(path.join(shadowBin, "python3"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });
    const src = fs.readFileSync(START_SCRIPT, "utf-8");
    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        // Mirror start.sh's trusted-python resolver: scan a fixed absolute-path
        // list rather than resolving `python3` via `$PATH`. The shadow bin is
        // intentionally NOT on the list, so a compromised PATH cannot redirect
        // the validator to a no-op interpreter.
        '_HERMES_BOUNDARY_TIMEOUT=(); _HERMES_PYTHON=""; for _c in /opt/hermes/.venv/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do [ -x "$_c" ] && { _HERMES_PYTHON="$_c"; break; }; done',
        extractShellFunctionFromSource(src, "validate_hermes_env_secret_boundary"),
        `HERMES_DIR=${shellQuote(hermesHome)}`,
        `_HERMES_BOUNDARY_VALIDATOR=${shellQuote(SECRET_BOUNDARY_VALIDATOR_SCRIPT)}`,
        "validate_hermes_env_secret_boundary",
      ].join("\n"),
      { mode: 0o700 },
    );
    try {
      const result = spawnSync("bash", [scriptPath], {
        encoding: "utf-8",
        timeout: 5000,
        env: { ...process.env, PATH: `${shadowBin}:${process.env.PATH ?? ""}` },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("[SECURITY]");
      expect(result.stderr).toContain("DEVTEST_API_TOKEN");
      expect(result.stderr).not.toContain("raw-attacker-bypass-token");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
