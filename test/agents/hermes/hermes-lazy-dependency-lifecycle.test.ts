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

function runLazyDependencyPreparation(
  root: boolean,
  provider = "hindsight",
  envOverrides: Record<string, string> = {},
) {
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
      'printf "cache=%s\\n" "$UV_CACHE_DIR"',
      "while IFS= read -r name; do",
      '  case "$name" in UV_*|PIP_*|PYTHON*|LD_*|DYLD_*|BASH_ENV|ENV|PATH|VIRTUAL_ENV) printf "managed-env=%s=%s\\n" "$name" "${!name}" ;; esac',
      "done < <(compgen -e | LC_ALL=C sort)",
      'program="${@: -1}"',
      `exec ${shellQuote(process.env.PYTHON || "python3")} -I ${shellQuote(pythonHarnessPath)} "$program"`,
    ].join("\n"),
    { mode: 0o700 },
  );
  fs.writeFileSync(
    handoffPath,
    ["#!/usr/bin/env sh", "export NEMOCLAW_INSTALL_IDENTITY=gateway", 'exec "$@"'].join("\n"),
    { mode: 0o700 },
  );
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      extractShellFunction(source, "prepare_hermes_lazy_dependencies"),
      `id() { [ "\${1:-}" = "-u" ] && printf "${root ? "0" : "1000"}\\n" || command id "$@"; }`,
      'prepare_hermes_gateway_lazy_install_target() { printf "gateway-target=prepared\\n"; }',
      `HERMES_DIR=${shellQuote(hermesDir)}`,
      "HERMES_SANDBOX_LAZY_INSTALL_TARGET=/sandbox/.hermes/lazy-packages",
      "HERMES_GATEWAY_LAZY_INSTALL_TARGET=/run/nemoclaw/hermes-gateway-lazy-packages",
      `_HERMES_PYTHON=${shellQuote(pythonPath)}`,
      `STEP_DOWN_PREFIX_GATEWAY=(${shellQuote(handoffPath)})`,
      "prepare_hermes_lazy_dependencies",
    ].join("\n"),
    { mode: 0o700 },
  );

  try {
    return spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      timeout: 5000,
      env: { ...process.env, ...envOverrides },
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function managedEnvironment(stdout: string): Record<string, string> {
  return Object.fromEntries(
    stdout
      .split("\n")
      .filter((line) => line.startsWith("managed-env="))
      .map((line) => {
        const assignment = line.slice("managed-env=".length);
        const separator = assignment.indexOf("=");
        return [assignment.slice(0, separator), assignment.slice(separator + 1)];
      }),
  );
}

describe("Hermes lazy dependency lifecycle", () => {
  it.each([
    [
      "root-separated",
      true,
      "gateway",
      "/run/nemoclaw/hermes-gateway-lazy-packages",
      "/run/nemoclaw/hermes-gateway-lazy-packages/.uv-cache",
    ],
    [
      "same-identity",
      false,
      "current",
      "/sandbox/.hermes/lazy-packages",
      "/sandbox/.hermes/cache/uv",
    ],
  ] as const)(
    "runs approved preparation under the consuming identity (%s) (#8613)",
    (_mode, root, identity, target, cache) => {
      const result = runLazyDependencyPreparation(root);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`identity=${identity}`);
      expect(result.stdout).toContain("home=/sandbox");
      expect(result.stdout).toContain(`target=${target}`);
      expect(result.stdout).toContain(`cache=${cache}`);
      expect(result.stdout).toContain("activated=durable");
      expect(result.stdout).toContain("installer=reviewed");
      expect(result.stdout.includes("gateway-target=prepared")).toBe(root);
    },
  );

  it("skips dependency preparation for a non-Hindsight provider (#8613)", () => {
    const result = runLazyDependencyPreparation(false, "local");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("identity=current");
    expect(result.stdout).not.toContain("activated=durable");
    expect(result.stdout).not.toContain("installer=reviewed");
  });

  it("scrubs inherited package-manager and Python inputs only for root-separated preparation", () => {
    const hostileEnvironment = {
      UV_CONFIG_FILE: "/sandbox/uv.toml",
      UV_INDEX_URL: "file:///sandbox/wheels",
      UV_NO_CONFIG: "0",
      PIP_CONFIG_FILE: "/sandbox/pip.conf",
      PIP_INDEX_URL: "file:///sandbox/wheels",
      PIP_DISABLE_PIP_VERSION_CHECK: "0",
      PYTHONPATH: "/sandbox/python",
      PYTHONHOME: "/sandbox/python-home",
      PYTHONSAFEPATH: "0",
      PYTHONNOUSERSITE: "0",
      PYTHONUTF8: "0",
      VIRTUAL_ENV: "/sandbox/venv",
    };
    const rootSeparated = runLazyDependencyPreparation(true, "hindsight", hostileEnvironment);
    const sameIdentity = runLazyDependencyPreparation(false, "hindsight", hostileEnvironment);

    expect(rootSeparated.status, rootSeparated.stderr).toBe(0);
    expect(managedEnvironment(rootSeparated.stdout)).toEqual({
      PIP_CONFIG_FILE: "/dev/null",
      PIP_DISABLE_PIP_VERSION_CHECK: "1",
      PATH: "/usr/local/bin:/opt/hermes/.venv/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      PYTHONNOUSERSITE: "1",
      PYTHONSAFEPATH: "1",
      PYTHONUTF8: "1",
      UV_CACHE_DIR: "/run/nemoclaw/hermes-gateway-lazy-packages/.uv-cache",
      UV_NO_CACHE: "1",
      UV_NO_CONFIG: "1",
    });

    expect(sameIdentity.status, sameIdentity.stderr).toBe(0);
    const sameIdentityEnvironment = managedEnvironment(sameIdentity.stdout);
    expect(sameIdentityEnvironment.UV_CONFIG_FILE).toBe("/sandbox/uv.toml");
    expect(sameIdentityEnvironment.UV_INDEX_URL).toBe("file:///sandbox/wheels");
    expect(sameIdentityEnvironment.PIP_CONFIG_FILE).toBe("/sandbox/pip.conf");
    expect(sameIdentityEnvironment.PIP_INDEX_URL).toBe("file:///sandbox/wheels");
    expect(sameIdentityEnvironment.PYTHONPATH).toBe("/sandbox/python");
    expect(sameIdentityEnvironment.PYTHONHOME).toBe("/sandbox/python-home");
    expect(sameIdentityEnvironment.VIRTUAL_ENV).toBe("/sandbox/venv");
  });
});
