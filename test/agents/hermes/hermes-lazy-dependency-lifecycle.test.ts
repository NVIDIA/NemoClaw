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

function runLazyDependencyPreparation(root: boolean, provider = "hindsight") {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-lazy-prep-"));
  const pythonPath = path.join(tmpDir, "python3");
  const pythonHarnessPath = path.join(tmpDir, "python-harness.py");
  const handoffPath = path.join(tmpDir, "sandbox-handoff");
  const scriptPath = path.join(tmpDir, "run.sh");
  const hermesDir = path.join(tmpDir, ".hermes");
  const source = fs.readFileSync(START_SCRIPT, "utf-8");

  fs.mkdirSync(hermesDir);
  fs.writeFileSync(path.join(hermesDir, "config.yaml"), `memory:\n  provider: ${provider}\n`);
  fs.writeFileSync(
    pythonHarnessPath,
    [
      "import sys",
      "import types",
      "",
      "yaml = types.ModuleType('yaml')",
      "def safe_load(text):",
      "    provider = next(",
      "        (line.split(':', 1)[1].strip() for line in text.splitlines() if line.strip().startswith('provider:')),",
      "        None,",
      "    )",
      "    return {'memory': {'provider': provider}}",
      "yaml.safe_load = safe_load",
      "sys.modules['yaml'] = yaml",
      "",
      "tools = types.ModuleType('tools')",
      "tools.__path__ = []",
      "lazy_deps = types.ModuleType('tools.lazy_deps')",
      "def activate_durable_lazy_target():",
      "    print('activated=durable')",
      "def ensure(name, prompt=False):",
      "    if name != 'memory.hindsight' or prompt is not False:",
      "        raise AssertionError('unexpected lazy dependency request')",
      "    print('installer=reviewed')",
      "lazy_deps.activate_durable_lazy_target = activate_durable_lazy_target",
      "lazy_deps.ensure = ensure",
      "sys.modules['tools'] = tools",
      "sys.modules['tools.lazy_deps'] = lazy_deps",
      "",
      "program = sys.argv[1]",
      "exec(compile(program, '<prepare_hermes_lazy_dependencies>', 'exec'), {'__name__': '__main__'})",
    ].join("\n"),
  );

  fs.writeFileSync(
    pythonPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'printf "identity=%s\\n" "${NEMOCLAW_INSTALL_IDENTITY:-current}"',
      'printf "home=%s\\n" "$HOME"',
      'printf "target=%s\\n" "$HERMES_LAZY_INSTALL_TARGET"',
      'program="${@: -1}"',
      `exec ${shellQuote(process.env.PYTHON || "python3")} -I ${shellQuote(pythonHarnessPath)} "$program"`,
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
      `HERMES_DIR=${shellQuote(hermesDir)}`,
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
    expect(result.stdout).toContain("activated=durable");
    expect(result.stdout).toContain("installer=reviewed");
  });

  it("skips dependency preparation for a non-Hindsight provider (#8613)", () => {
    const result = runLazyDependencyPreparation(false, "local");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("identity=current");
    expect(result.stdout).not.toContain("activated=durable");
    expect(result.stdout).not.toContain("installer=reviewed");
  });
});
