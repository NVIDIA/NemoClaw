// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { shellQuote } from "../../../src/lib/core/shell-quote";
import { extractShellFunction } from "../../support/hermes-shell-harness";

const START_SCRIPT = path.join(import.meta.dirname, "../../..", "agents", "hermes", "start.sh");

function runHermesMutableLayoutChmodDenied(initialMode: number, desiredMode: string) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-layout-chmod-"));
  const hermesHome = path.join(tmpDir, ".hermes");
  const injectedScript = path.join(tmpDir, "layout-repair.py");
  const fchmodSentinel = path.join(tmpDir, "fchmod-called");
  const fakeBin = path.join(tmpDir, "fake-bin");
  const scriptPath = path.join(tmpDir, "run.sh");
  fs.mkdirSync(hermesHome);
  fs.chmodSync(hermesHome, initialMode);
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(
    path.join(fakeBin, "python3"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `tee ${shellQuote(injectedScript)} >/dev/null`,
      `export NEMOCLAW_TEST_LAYOUT_SCRIPT=${shellQuote(injectedScript)}`,
      `export NEMOCLAW_TEST_FCHMOD_SENTINEL=${shellQuote(fchmodSentinel)}`,
      `export PATH=${shellQuote(process.env.PATH ?? "")}`,
      "exec python3 -I -c '",
      "import errno",
      "import os",
      "def deny_fchmod(_fd, _mode):",
      '    open(os.environ["NEMOCLAW_TEST_FCHMOD_SENTINEL"], "w").close()',
      '    raise PermissionError(errno.EPERM, "Operation not permitted")',
      "os.fchmod = deny_fchmod",
      'script = os.environ["NEMOCLAW_TEST_LAYOUT_SCRIPT"]',
      'exec(compile(open(script, encoding="utf-8").read(), script, "exec"))',
      "'",
    ].join("\n"),
    { mode: 0o700 },
  );

  const source = fs.readFileSync(START_SCRIPT, "utf-8");
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      extractShellFunction(source, "ensure_hermes_mutable_layout_dir"),
      `HERMES_DIR=${shellQuote(hermesHome)}`,
      `ensure_hermes_mutable_layout_dir . ${shellQuote(desiredMode)}`,
    ].join("\n"),
    { mode: 0o700 },
  );

  try {
    const result = spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      timeout: 5000,
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
    });
    return {
      result,
      fchmodInvoked: fs.existsSync(fchmodSentinel),
      mode: (fs.statSync(hermesHome).mode & 0o7777).toString(8),
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("Hermes mutable layout repair", () => {
  it("accepts a non-root chmod refusal only when the descriptor mode already matches", () => {
    const matching = runHermesMutableLayoutChmodDenied(0o3770, "3770");
    expect(matching.result.status, matching.result.stderr).toBe(0);
    expect(matching.fchmodInvoked).toBe(true);
    expect(matching.mode).toBe("3770");

    const mismatched = runHermesMutableLayoutChmodDenied(0o750, "3770");
    expect(mismatched.result.status).not.toBe(0);
    expect(mismatched.fchmodInvoked).toBe(true);
    expect(mismatched.result.stderr).toContain("mode could not be repaired");
    expect(mismatched.mode).toBe("750");
  });
});
