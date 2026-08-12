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

function runLazyDependencyPreparation(root: boolean) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-lazy-prep-"));
  const pythonPath = path.join(tmpDir, "python3");
  const handoffPath = path.join(tmpDir, "sandbox-handoff");
  const scriptPath = path.join(tmpDir, "run.sh");
  const source = fs.readFileSync(START_SCRIPT, "utf-8");

  fs.writeFileSync(
    pythonPath,
    [
      "#!/usr/bin/env sh",
      'printf "identity=%s\\n" "${NEMOCLAW_INSTALL_IDENTITY:-current}"',
      'printf "home=%s\\n" "$HOME"',
      'printf "target=%s\\n" "$HERMES_LAZY_INSTALL_TARGET"',
      'case "$*" in *\'ensure("memory.hindsight", prompt=False)\'*) printf "installer=reviewed\\n" ;; *) exit 9 ;; esac',
    ].join("\n"),
    { mode: 0o700 },
  );
  fs.writeFileSync(
    handoffPath,
    ["#!/usr/bin/env sh", "export NEMOCLAW_INSTALL_IDENTITY=sandbox", 'exec "$@"'].join("\n"),
    { mode: 0o700 },
  );
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      extractShellFunction(source, "prepare_hermes_lazy_dependencies"),
      `id() { [ "\${1:-}" = "-u" ] && printf "${root ? "0" : "1000"}\\n" || command id "$@"; }`,
      `HERMES_DIR=${shellQuote(path.join(tmpDir, ".hermes"))}`,
      `_HERMES_PYTHON=${shellQuote(pythonPath)}`,
      `STEP_DOWN_PREFIX_SANDBOX=(${shellQuote(handoffPath)})`,
      "prepare_hermes_lazy_dependencies",
    ].join("\n"),
    { mode: 0o700 },
  );

  try {
    return spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      timeout: 5000,
      env: process.env,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("Hermes lazy dependency lifecycle", () => {
  it.each([
    ["root-separated", true, "sandbox"],
    ["same-identity", false, "current"],
  ] as const)("runs approved preparation under the sandbox owner (%s) (#8613)", (_mode, root, identity) => {
    const result = runLazyDependencyPreparation(root);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`identity=${identity}`);
    expect(result.stdout).toContain("home=/sandbox");
    expect(result.stdout).toContain("target=/sandbox/.hermes/lazy-packages");
    expect(result.stdout).toContain("installer=reviewed");
  });
});
