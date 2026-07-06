// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Test harness helpers for nemoclaw-start-extra-placeholder-breadcrumb.test.ts.
// The heredoc-aware shell-function extractor and the refresh invocation wrapper
// (both branching) live here so the test body stays linear.

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const START_SCRIPT = path.join(import.meta.dirname, "..", "scripts", "nemoclaw-start.sh");

// Heredoc-aware extractor. The reconcile harness's naive /^}/m regex stops at
// the first column-0 "}", which for refresh_openclaw_provider_placeholders is
// the closing brace of a Python dict comprehension inside a <<'PY…' heredoc,
// not the function's real close. Skip heredoc bodies so we capture the whole
// function.
export function extractShellFunction(src: string, name: string): string {
  const lines = src.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`${name}() {`));
  if (start < 0) throw new Error(`Expected ${name} in scripts/nemoclaw-start.sh`);
  let heredocTerminator: string | null = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (heredocTerminator !== null) {
      if (line === heredocTerminator) heredocTerminator = null;
      continue;
    }
    const opener = line.match(/<<-?\s*'?([A-Za-z_][A-Za-z0-9_]*)'?/);
    if (opener) {
      heredocTerminator = opener[1];
      continue;
    }
    if (line === "}") return lines.slice(start, i + 1).join("\n");
  }
  throw new Error(`Expected a top-level close for ${name} in scripts/nemoclaw-start.sh`);
}

export interface RunResult {
  result: SpawnSyncReturns<string>;
  // Arbitrary caller-shaped openclaw.json indexed directly by tests
  // (config.channels.telegram…), matching the original inline helper's typing.
  // biome noExplicitAny is not enforced under test/, so no suppression is needed.
  config: any;
}

export function runRefresh(config: unknown, env: Record<string, string> = {}): RunResult {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-extra-placeholder-"));
  const openclawDir = path.join(root, ".openclaw");
  fs.mkdirSync(openclawDir, { recursive: true });
  const configPath = path.join(openclawDir, "openclaw.json");
  const hashPath = path.join(openclawDir, ".config-hash");
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  fs.writeFileSync(hashPath, "oldhash\n");

  const fn = extractShellFunction(src, "refresh_openclaw_provider_placeholders").replaceAll(
    "/sandbox/.openclaw",
    openclawDir,
  );
  // Stub the config-mutability guards and the dir-owner probe so the helper
  // runs on a mutable temp dir without touching real sandbox ownership. This
  // isolates the extras-validation + placeholder-rewrite path under test.
  const wrapper = [
    "#!/usr/bin/env bash",
    "set -eu",
    "openclaw_config_dir_owner() { echo sandbox; }",
    "prepare_openclaw_config_for_write() { :; }",
    "restore_openclaw_config_after_write() { :; }",
    fn,
    "refresh_openclaw_provider_placeholders",
  ].join("\n");
  const script = path.join(root, "run.sh");
  fs.writeFileSync(script, wrapper, { mode: 0o700 });
  try {
    const result = spawnSync("bash", [script], {
      encoding: "utf-8",
      env: { PATH: process.env.PATH || "", ...env },
      timeout: 5000,
    });
    const updated = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return { result, config: updated };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// Mirror the messaging-runtime plan the entrypoint forwards so the in-
// container parser discovers TELEGRAM_BOT_TOKEN as a canonical provider
// envKey; per-profile TELEGRAM_BOT_TOKEN_AGENT_* names then read as valid
// extensions rather than colliding with a canonical base key.
export function placeholderPlan(envKeys: string[]): string {
  return Buffer.from(
    JSON.stringify({
      credentialBindings: envKeys.map((envKey) => ({ providerEnvKey: envKey })),
    }),
  ).toString("base64");
}
