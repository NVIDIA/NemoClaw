// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function bashPrintfQ(value: string): string {
  const result = spawnSync("bash", ["-c", "printf '%q' \"$1\"", "bash-printf-q", value], {
    encoding: "utf-8",
    timeout: 5000,
    env: process.env,
  });
  if (result.status !== 0) throw new Error(`bash printf %q failed: ${result.stderr}`);
  return result.stdout;
}

export function extractShellFunction(source: string, name: string): string {
  const match = source.match(new RegExp(`${escapeRegExp(name)}\\(\\) \\{([\\s\\S]*?)^\\}`, "m"));
  if (!match) throw new Error(`Expected shell function ${name}`);
  return `${name}() {${match[1]}\n}`;
}

export function runHermesBashHarness(
  lines: string[],
  configure?: (tmpDir: string) => Record<string, string>,
) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-supervisor-test-"));
  const script = path.join(tmpDir, "run.sh");
  fs.writeFileSync(
    script,
    [
      "#!/usr/bin/env bash",
      "set -uo pipefail",
      "HERMES_MCP_RECONCILE_PENDING=0",
      "HERMES_MCP_INTEGRITY_FAILED=0",
      ...lines,
    ].join("\n"),
    { mode: 0o700 },
  );

  try {
    return spawnSync("bash", [script], {
      encoding: "utf-8",
      timeout: 5000,
      env: { ...process.env, ...configure?.(tmpDir) },
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
