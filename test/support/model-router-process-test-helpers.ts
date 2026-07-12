// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type RouterLaunchLog = {
  args: string[];
  cwd: string;
  env: Record<string, string | null>;
  pid: number;
};

export type ProductionModelRouterInstallFixture = {
  fakeBin: string;
  fingerprintPath: string;
  managedCommand: string;
  routerDir: string;
  setupLog: string;
  sourceHead: string;
  venvDir: string;
};

function runGit(args: string[]): string {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.error?.message || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

export function createProductionModelRouterInstallFixture(
  tmpDir: string,
): ProductionModelRouterInstallFixture {
  const routerDir = path.join(tmpDir, "model-router-source");
  const fakeBin = path.join(tmpDir, "bin");
  const venvDir = path.join(tmpDir, "model-router-venv");
  const managedCommand = path.join(venvDir, "bin", "model-router");
  const fingerprintPath = path.join(venvDir, ".nemoclaw-source-fingerprint");
  const setupLog = path.join(tmpDir, "model-router-install.log");
  const fakeRouterSource = path.join(tmpDir, "installed-model-router");

  fs.mkdirSync(routerDir, { recursive: true });
  runGit(["init", "--quiet", routerDir]);
  fs.writeFileSync(path.join(routerDir, "pyproject.toml"), "[project]\nname = 'model-router'\n");
  runGit(["-C", routerDir, "add", "pyproject.toml"]);
  runGit([
    "-C",
    routerDir,
    "-c",
    "user.name=NemoClaw Test",
    "-c",
    "user.email=nemoclaw-test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--quiet",
    "-m",
    "test: create model router install fixture",
  ]);
  const sourceHead = runGit(["-C", routerDir, "rev-parse", "HEAD"]);

  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(
    path.join(fakeBin, "model-router"),
    [
      "#!/usr/bin/env bash",
      `printf "path-router %s\\n" "$*" >> ${JSON.stringify(setupLog)}`,
      "exit 89",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  fs.writeFileSync(fakeRouterSource, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  const fakePython = path.join(fakeBin, "python3.13");
  fs.writeFileSync(
    fakePython,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `printf "python3 %s\\n" "$*" >> ${JSON.stringify(setupLog)}`,
      'if [ "$1" = "-c" ]; then',
      '  printf \'{"version": [3, 13, 7], "error": null}\\n\'',
      "  exit 0",
      "fi",
      'if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then',
      '  venv_dir="$3"',
      '  mkdir -p "$venv_dir/bin"',
      "  cat > \"$venv_dir/bin/python\" <<'PY'",
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `printf "venv-python %s\\n" "$*" >> ${JSON.stringify(setupLog)}`,
      'if [ "$1" = "-m" ] && [ "$2" = "pip" ] && [ "$3" = "install" ]; then',
      '  venv_bin="$(cd "$(dirname "$0")" && pwd)"',
      `  cp ${JSON.stringify(fakeRouterSource)} "$venv_bin/model-router"`,
      '  chmod +x "$venv_bin/model-router"',
      "  exit 0",
      "fi",
      "exit 97",
      "PY",
      '  chmod +x "$venv_dir/bin/python"',
      "  exit 0",
      "fi",
      "exit 96",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  for (const candidate of ["python3.12", "python3.11", "python3.10", "python3"]) {
    const candidatePath = path.join(fakeBin, candidate);
    fs.copyFileSync(fakePython, candidatePath);
    fs.chmodSync(candidatePath, 0o755);
  }

  return {
    fakeBin,
    fingerprintPath,
    managedCommand,
    routerDir,
    setupLog,
    sourceHead,
    venvDir,
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function stopTestProcess(pid: number | null): Promise<void> {
  if (pid === null) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!isProcessAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Process exited between the final probe and cleanup.
  }
}

export async function readRouterLaunchLog(
  logPath: string,
  expectedEntries: number,
): Promise<RouterLaunchLog[]> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (fs.existsSync(logPath)) {
      const contents = fs.readFileSync(logPath, "utf8");
      const lines = contents.split("\n");
      if (!contents.endsWith("\n")) lines.pop();
      const entries = lines.filter(Boolean).map((line) => JSON.parse(line) as RouterLaunchLog);
      if (entries.length >= expectedEntries) return entries;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${expectedEntries} Model Router launch log entries`);
}
