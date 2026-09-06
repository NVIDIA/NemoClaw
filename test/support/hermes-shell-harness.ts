// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shellQuote } from "../../src/lib/core/shell-quote";

export { extractShellFunctionFromSource as extractShellFunction } from "./shell-function-extractor";

export const LOCKED_HERMES_CONFIG_STAT_MOCK = [
  "stat() {",
  '  if [ "${1:-}" = "-c" ] && [ "${2:-}" = "%U:%G" ] && [ "${3:-}" = "$HERMES_DIR" ]; then printf "root:root\\n"; return 0; fi',
  '  if [ "${1:-}" = "-c" ] && [ "${2:-}" = "%a" ] && [ "${3:-}" = "$HERMES_DIR" ]; then printf "755\\n"; return 0; fi',
  '  if [ "${1:-}" = "-f" ] && [ "${2:-}" = "%Su:%Sg" ] && [ "${3:-}" = "$HERMES_DIR" ]; then printf "root:root\\n"; return 0; fi',
  '  if [ "${1:-}" = "-f" ] && [ "${2:-}" = "%Lp" ] && [ "${3:-}" = "$HERMES_DIR" ]; then printf "755\\n"; return 0; fi',
  '  case "${3:-}" in "$HERMES_DIR/config.yaml"|"$HERMES_DIR/.env")',
  '    if [ "${1:-}" = "-c" ] && [ "${2:-}" = "%U:%G" ]; then printf "root:root\\n"; return 0; fi',
  '    if [ "${1:-}" = "-c" ] && [ "${2:-}" = "%a" ]; then printf "444\\n"; return 0; fi',
  '    if [ "${1:-}" = "-f" ] && [ "${2:-}" = "%Su:%Sg" ]; then printf "root:root\\n"; return 0; fi',
  '    if [ "${1:-}" = "-f" ] && [ "${2:-}" = "%Lp" ]; then printf "444\\n"; return 0; fi',
  "    ;;",
  "  esac",
  '  command stat "$@"',
  "}",
].join("\n");

export function writeFakeProcCmdline(procRoot: string, pid: number, argv: string[]) {
  const pidDir = path.join(procRoot, String(pid));
  fs.mkdirSync(pidDir, { recursive: true });
  fs.writeFileSync(path.join(pidDir, "cmdline"), Buffer.from(`${argv.join("\0")}\0`));
  fs.writeFileSync(path.join(pidDir, "status"), "Name:\tfixture\nUid:\t1000\t1000\t1000\t1000\n");
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

export function runHermesSandboxInitPreludeWithFakePath(
  startScript: string,
  envWrapper: string,
  temporaryRoot = os.tmpdir(),
) {
  const tmpDir = fs.mkdtempSync(path.join(temporaryRoot, "nemoclaw-hermes-init-path-"));
  try {
    const fakeBin = path.join(tmpDir, "bin");
    const fakeInit = path.join(tmpDir, "sandbox-init.sh");
    const fakeSupervisor = path.join(tmpDir, "gateway-supervisor.sh");
    const marker = path.join(tmpDir, "dirname-called");
    const sourcePathLog = path.join(tmpDir, "source-path.log");
    const scriptPath = path.join(tmpDir, "run.sh");
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(
      path.join(fakeBin, "dirname"),
      ["#!/usr/bin/env bash", `printf called > ${shellQuote(marker)}`, "exit 99"].join("\n"),
      { mode: 0o700 },
    );
    fs.writeFileSync(
      fakeInit,
      [
        `printf "%s\\n" "$PATH" > ${shellQuote(sourcePathLog)}`,
        "harden_resource_limits() { :; }",
      ].join("\n"),
    );
    fs.writeFileSync(fakeSupervisor, "# supervisor fixture\n");

    const src = fs.readFileSync(startScript, "utf-8");
    const start = src.indexOf(
      "# SECURITY: Lock down PATH before resolving or sourcing root startup helpers.",
    );
    const end = src.indexOf("\nif [ -d /opt/hermes/hermes_cli/web_dist ];", start);
    assert(start >= 0 && end >= 0, "Hermes start.sh prelude markers not found");
    const prelude = src
      .slice(start, end)
      .replaceAll("/usr/local/lib/nemoclaw/entrypoint-env-wrapper.sh", envWrapper)
      .replaceAll("/usr/local/lib/nemoclaw/sandbox-init.sh", fakeInit)
      .replaceAll("/usr/local/lib/nemoclaw/gateway-supervisor.sh", fakeSupervisor);

    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `export PATH=${shellQuote(`${fakeBin}:${process.env.PATH ?? ""}`)}`,
        prelude,
      ].join("\n"),
      { mode: 0o700 },
    );

    const result = spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      timeout: 5000,
      env: process.env,
    });
    return {
      result,
      dirnameCalled: fs.existsSync(marker),
      sourcePath: fs.existsSync(sourcePathLog)
        ? fs.readFileSync(sourcePathLog, "utf-8").trim()
        : "",
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
