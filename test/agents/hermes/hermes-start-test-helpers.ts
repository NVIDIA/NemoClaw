// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { shellQuote } from "../../../src/lib/core/shell-quote";

const START_SCRIPT = path.join(import.meta.dirname, "../../..", "agents", "hermes", "start.sh");

export function filesystemFingerprint(entry: string): string {
  const fd = fs.openSync(entry, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const metadata = fs.fstatSync(fd);
    const contents = metadata.isDirectory() ? "" : fs.readFileSync(fd, "utf8");
    return `${metadata.dev}:${metadata.ino}:${metadata.uid}:${metadata.gid}:${metadata.mode & 0o7777}:${metadata.size}:${metadata.mtimeMs}:${contents}`;
  } finally {
    fs.closeSync(fd);
  }
}

export function createStaleCleanupSwapFixture(tmpDir: string, hermesHome: string) {
  const externalRoot = path.join(tmpDir, "unsafe-stale-cleanup-target");
  const externalPid = path.join(externalRoot, "gateway.pid");
  const sentinel = path.join(externalRoot, "sentinel.txt");
  const originalEntry = path.join(tmpDir, "original-runtime");
  const fakeBin = path.join(tmpDir, "stale-cleanup-swap-bin");
  fs.mkdirSync(externalRoot);
  fs.writeFileSync(externalPid, "external pid sentinel\n", { mode: 0o640 });
  fs.writeFileSync(sentinel, "outside sentinel\n", { mode: 0o640 });
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(
    path.join(fakeBin, "python3"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [ -z "${NEMOCLAW_HERMES_STALE_CLEANUP_ROOT:-}" ]; then',
      `  export PATH=${shellQuote(process.env.PATH ?? "")}`,
      '  exec python3 "$@"',
      "fi",
      `mv ${shellQuote(path.join(hermesHome, "runtime"))} ${shellQuote(originalEntry)}`,
      `ln -s ${shellQuote(externalRoot)} ${shellQuote(path.join(hermesHome, "runtime"))}`,
      `export PATH=${shellQuote(process.env.PATH ?? "")}`,
      'exec python3 "$@"',
    ].join("\n"),
    { mode: 0o700 },
  );
  const fingerprint = () => [
    filesystemFingerprint(externalRoot),
    filesystemFingerprint(externalPid),
    filesystemFingerprint(sentinel),
    fs.readFileSync(externalPid, "utf-8"),
    fs.readFileSync(sentinel, "utf-8"),
  ];
  return { fakeBin, before: fingerprint(), fingerprint, originalEntry };
}

function extractDashboardPortBootstrap(src: string): string {
  const start = src.indexOf('NEMOCLAW_CMD=("$@")');
  const end = src.indexOf('\nHERMES="$(command -v hermes)"', start);
  if (start < 0 || end < 0) {
    throw new Error("Expected Hermes dashboard port bootstrap block in agents/hermes/start.sh");
  }
  return src.slice(start, end).trimEnd();
}

export function runHermesDashboardPortBootstrap(
  env: Record<string, string | undefined> = {},
  hostilePythonPath = false,
) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-port-bootstrap-"));
  const scriptPath = path.join(tmpDir, "run.sh");
  const pythonImportSentinel = path.join(tmpDir, "python-import-sentinel");
  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  if (hostilePythonPath) {
    fs.writeFileSync(
      path.join(tmpDir, "sitecustomize.py"),
      `from pathlib import Path\nPath(${JSON.stringify(pythonImportSentinel)}).write_text("loaded")\n`,
    );
  }
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -eo pipefail",
      "set --",
      extractDashboardPortBootstrap(src),
      'printf "CHAT_UI_URL=%s\\n" "${CHAT_UI_URL:-}"',
      'printf "DASHBOARD_PUBLIC_PORT=%s\\n" "$DASHBOARD_PUBLIC_PORT"',
      'printf "DASHBOARD_INTERNAL_PORT=%s\\n" "$DASHBOARD_INTERNAL_PORT"',
      'printf "PUBLIC_PORT=%s\\n" "$PUBLIC_PORT"',
    ].join("\n"),
    { mode: 0o700 },
  );

  try {
    const childEnv = { ...process.env };
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) {
        delete childEnv[key];
      } else {
        childEnv[key] = value;
      }
    }
    if (hostilePythonPath) childEnv.PYTHONPATH = tmpDir;
    const result = spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      timeout: 5000,
      env: childEnv,
    });
    return Object.assign(result, {
      pythonImportSentinelExists: fs.existsSync(pythonImportSentinel),
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
