// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Test harness helpers for hermes-gateway-pid-cleanup.test.ts. The shell-
// function extraction + invocation branching lives here (not in the *.test.ts)
// so the test body stays linear.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const START_SCRIPT = path.join(import.meta.dirname, "..", "agents", "hermes", "start.sh");

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractShellFunctionFromSource(src: string, name: string): string {
  const escapedName = escapeRegExp(name);
  const match = src.match(new RegExp(`${escapedName}\\(\\) \\{([\\s\\S]*?)^\\}`, "m"));
  if (!match) {
    throw new Error(`Expected ${name} in agents/hermes/start.sh`);
  }
  return `${name}() {${match[1]}\n}`;
}

/**
 * Extract remove_stale_gateway_file and run it against `pidPath` inside a
 * throwaway temp dir. Returns the spawn result plus the temp root so callers
 * can assert on the resulting on-disk shape.
 */
export function runRemoveStale(
  seed: (tmp: string, pidPath: string) => void,
  label = "legacy PID file",
): { status: number | null; stderr: string; tmp: string; pidPath: string } {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  const fn = extractShellFunctionFromSource(src, "remove_stale_gateway_file");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-gw-pid-cleanup-"));
  const pidPath = path.join(tmp, "gateway.pid");
  seed(tmp, pidPath);

  const script = [
    "set -euo pipefail",
    fn,
    `remove_stale_gateway_file ${JSON.stringify(pidPath)} ${JSON.stringify(label)}`,
  ].join("\n");

  const result = spawnSync("bash", ["-c", script], { encoding: "utf-8", timeout: 5000 });
  return { status: result.status, stderr: result.stderr, tmp, pidPath };
}
