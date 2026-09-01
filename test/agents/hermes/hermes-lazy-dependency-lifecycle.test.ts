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
const PERMISSIONS_NORMALIZER = path.join(
  import.meta.dirname,
  "../../..",
  "agents",
  "hermes",
  "normalize-lazy-package-permissions.py",
);

function fileMode(target: string): number {
  return fs.statSync(target).mode & 0o7777;
}

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
      "runpy = types.ModuleType('runpy')",
      "def normalize_lazy_package_permissions(target):",
      "    print(f'permissions=normalized:{target}')",
      "def run_path(path, run_name=None):",
      "    if path != '/usr/local/lib/nemoclaw/normalize-hermes-lazy-package-permissions.py':",
      "        raise AssertionError(f'unexpected normalizer path: {path}')",
      "    return {'normalize_lazy_package_permissions': normalize_lazy_package_permissions}",
      "runpy.run_path = run_path",
      "sys.modules['runpy'] = runpy",
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
  ] as const)(
    "runs approved preparation under the sandbox owner (%s) (#8613)",
    (_mode, root, identity) => {
      const result = runLazyDependencyPreparation(root);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`identity=${identity}`);
      expect(result.stdout).toContain("home=/sandbox");
      expect(result.stdout).toContain("target=/sandbox/.hermes/lazy-packages");
      expect(result.stdout).toContain("activated=durable");
      expect(result.stdout).toContain("installer=reviewed");
      expect(result.stdout).toContain("permissions=normalized:/sandbox/.hermes/lazy-packages");
    },
  );

  it("skips dependency preparation for a non-Hindsight provider (#8613)", () => {
    const result = runLazyDependencyPreparation(false, "local");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("identity=current");
    expect(result.stdout).not.toContain("activated=durable");
    expect(result.stdout).not.toContain("installer=reviewed");
    expect(result.stdout).not.toContain("permissions=normalized");
  });

  it("normalizes only sandbox-owned regular entries without following symlinks", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-lazy-perms-"));
    const target = path.join(tmpDir, "lazy-packages");
    const packageDir = path.join(target, "hindsight_client");
    const packageFile = path.join(packageDir, "__init__.py");
    const executable = path.join(target, "reviewed-tool");
    const outside = path.join(tmpDir, "outside-secret");
    const outsideLink = path.join(target, "outside-link");
    fs.mkdirSync(packageDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(target, 0o700);
    fs.writeFileSync(packageFile, "fixture\n", { mode: 0o600 });
    fs.writeFileSync(executable, "#!/bin/sh\n", { mode: 0o700 });
    fs.writeFileSync(outside, "secret\n", { mode: 0o600 });
    fs.symlinkSync(outside, outsideLink);

    try {
      const result = spawnSync(
        process.env.PYTHON || "python3",
        ["-I", PERMISSIONS_NORMALIZER, target],
        {
          encoding: "utf8",
          env: { ...process.env, HERMES_LAZY_INSTALL_TARGET: target },
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(fileMode(target)).toBe(0o750);
      expect(fileMode(packageDir)).toBe(0o750);
      expect(fileMode(packageFile)).toBe(0o640);
      expect(fileMode(executable)).toBe(0o750);
      expect(fs.lstatSync(outsideLink).isSymbolicLink()).toBe(true);
      expect(fileMode(outside)).toBe(0o600);
      expect(fileMode(packageFile) & 0o200).toBe(0o200);
      expect(fileMode(packageFile) & 0o020).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects hardlinks instead of broadening another sandbox-owned path", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-lazy-hardlink-"));
    const target = path.join(tmpDir, "lazy-packages");
    const outside = path.join(tmpDir, "outside-secret");
    fs.mkdirSync(target, { mode: 0o700 });
    fs.writeFileSync(outside, "secret\n", { mode: 0o600 });
    fs.linkSync(outside, path.join(target, "a-hardlink"));

    try {
      const result = spawnSync(
        process.env.PYTHON || "python3",
        ["-I", PERMISSIONS_NORMALIZER, target],
        {
          encoding: "utf8",
          env: { ...process.env, HERMES_LAZY_INSTALL_TARGET: target },
        },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("hardlinked file: a-hardlink");
      expect(fileMode(outside)).toBe(0o600);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("bounds directory enumeration before sorting or changing entry modes", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-lazy-budget-"));
    const target = path.join(tmpDir, "lazy-packages");
    fs.mkdirSync(target, { mode: 0o700 });
    fs.writeFileSync(path.join(target, "a"), "a\n", { mode: 0o600 });
    fs.writeFileSync(path.join(target, "b"), "b\n", { mode: 0o600 });
    fs.writeFileSync(path.join(target, "c"), "c\n", { mode: 0o600 });

    try {
      const result = spawnSync(
        process.env.PYTHON || "python3",
        [
          "-I",
          "-c",
          [
            "import runpy, sys",
            "module = runpy.run_path(sys.argv[1], run_name='nemoclaw_lazy_budget_test')",
            "normalizer = module['normalize_lazy_package_permissions']",
            "normalizer.__globals__['MAX_ENTRIES'] = 2",
            "normalizer(sys.argv[2])",
          ].join("; "),
          PERMISSIONS_NORMALIZER,
          target,
        ],
        {
          encoding: "utf8",
          env: { ...process.env, HERMES_LAZY_INSTALL_TARGET: target },
        },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("lazy-package tree exceeds entry limit");
      expect(fileMode(target)).toBe(0o700);
      expect(fileMode(path.join(target, "a"))).toBe(0o600);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
