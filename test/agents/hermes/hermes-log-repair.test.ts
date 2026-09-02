// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

import { shellQuote } from "../../../src/lib/core/shell-quote";
import { extractShellFunction } from "../../support/hermes-shell-harness";

const START_SCRIPT = path.join(import.meta.dirname, "../../..", "agents", "hermes", "start.sh");

function fingerprint(file: string): string {
  const metadata = fs.statSync(file);
  return `${metadata.uid}:${metadata.gid}:${metadata.mode & 0o7777}:${fs.readFileSync(file, "utf-8")}`;
}

it("rejects a replaced logs directory link without mutating its external sentinel", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-log-repair-"));
  const hermesDir = path.join(tmpDir, ".hermes");
  const externalLogs = path.join(tmpDir, "external-logs");
  const sentinel = path.join(externalLogs, "sentinel.log");
  const harness = path.join(tmpDir, "run.sh");
  fs.mkdirSync(hermesDir);
  fs.mkdirSync(externalLogs);
  fs.writeFileSync(sentinel, "outside sentinel\n", { mode: 0o640 });
  fs.symlinkSync(externalLogs, path.join(hermesDir, "logs"));
  const before = fingerprint(sentinel);
  const source = fs.readFileSync(START_SCRIPT, "utf-8");
  fs.writeFileSync(
    harness,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      extractShellFunction(source, "repair_hermes_log_permissions"),
      extractShellFunction(source, "repair_hermes_startup_layout"),
      "ensure_hermes_cross_uid_state_dir() { return 0; }",
      "hermes_config_root_is_locked() { return 1; }",
      "ensure_hermes_config_root_mode() { return 0; }",
      "ensure_hermes_state_dir() { return 0; }",
      "ensure_hermes_history_file() { return 0; }",
      `HERMES_DIR=${shellQuote(hermesDir)}`,
      "repair_hermes_startup_layout",
    ].join("\n"),
    { mode: 0o700 },
  );

  try {
    const result = spawnSync("bash", [harness], {
      encoding: "utf-8",
      timeout: 5000,
      env: process.env,
    });
    expect(result.status).toBe(1);
    expect(fingerprint(sentinel)).toBe(before);
    expect(result.stderr).toContain("Refusing Hermes log repair because");
    expect(result.stderr).toContain("/logs is a symlink");
    expect(result.stderr).toContain("Hermes pre-launch layout repair failed at logs directory");
    expect(result.stderr).toContain(
      "Restore a trusted snapshot into a recreated sandbox, or recreate from host-side onboarding configuration.",
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
