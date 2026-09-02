// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { shellQuote } from "../../../src/lib/core/shell-quote";
import {
  extractShellFunction,
  LOCKED_HERMES_CONFIG_STAT_MOCK,
} from "../../support/hermes-shell-harness";

const START_SCRIPT = path.join(import.meta.dirname, "../../..", "agents", "hermes", "start.sh");

function configureLockedHermesRoot(hermesHome: string) {
  fs.chmodSync(hermesHome, 0o755);
  fs.writeFileSync(path.join(hermesHome, "config.yaml"), "model: test\n");
  fs.writeFileSync(path.join(hermesHome, ".env"), "HERMES_TEST=1\n");
}

function runShieldsUpRuntimeEnv({
  configureRoot = () => undefined,
  presetValue,
  statMock = "",
}: {
  configureRoot?: (hermesHome: string) => void;
  presetValue?: string;
  statMock?: string;
}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-shields-env-"));
  const hermesHome = path.join(tmpDir, ".hermes");
  const scriptPath = path.join(tmpDir, "run.sh");

  fs.mkdirSync(hermesHome, { recursive: true });
  configureRoot(hermesHome);

  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  const presetLine =
    presetValue === undefined
      ? "unset HERMES_KANBAN_DISPATCH_IN_GATEWAY"
      : `export HERMES_KANBAN_DISPATCH_IN_GATEWAY=${shellQuote(presetValue)}`;

  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -uo pipefail",
      extractShellFunction(src, "hermes_config_path_is_locked"),
      extractShellFunction(src, "hermes_config_root_is_locked"),
      extractShellFunction(src, "apply_shields_up_runtime_env"),
      `HERMES_DIR=${shellQuote(hermesHome)}`,
      statMock,
      presetLine,
      "apply_shields_up_runtime_env",
      'printf "KANBAN=%s\\n" "${HERMES_KANBAN_DISPATCH_IN_GATEWAY-<unset>}"',
    ].join("\n"),
    { mode: 0o700 },
  );

  try {
    const result = spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      timeout: 5000,
      env: process.env,
    });
    const match = result.stdout.match(/KANBAN=(.*)/);
    return { result, kanbanValue: match ? match[1] : "" };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("agents/hermes/start.sh shields-up kanban dispatcher override", () => {
  it("disables the embedded Hermes kanban dispatcher when the config root is locked", () => {
    const run = runShieldsUpRuntimeEnv({
      configureRoot: configureLockedHermesRoot,
      statMock: LOCKED_HERMES_CONFIG_STAT_MOCK,
    });

    expect(run.result.status).toBe(0);
    expect(run.kanbanValue).toBe("0");
    expect(run.result.stderr).toContain("Shields-up: HERMES_KANBAN_DISPATCH_IN_GATEWAY=0");
    expect(run.result.stderr).toContain("embedded kanban dispatcher suspended");
  });

  it("preserves a caller-supplied Hermes kanban dispatcher value when shields are down", () => {
    const run = runShieldsUpRuntimeEnv({ presetValue: "1" });

    expect(run.result.status).toBe(0);
    expect(run.kanbanValue).toBe("1");
    expect(run.result.stderr).not.toContain("HERMES_KANBAN_DISPATCH_IN_GATEWAY=0");
  });

  it("preserves a caller-supplied HERMES_KANBAN_DISPATCH_IN_GATEWAY value under shields-up", () => {
    const run = runShieldsUpRuntimeEnv({
      configureRoot: configureLockedHermesRoot,
      presetValue: "1",
      statMock: LOCKED_HERMES_CONFIG_STAT_MOCK,
    });

    expect(run.result.status).toBe(0);
    expect(run.kanbanValue).toBe("1");
    expect(run.result.stderr).not.toContain("HERMES_KANBAN_DISPATCH_IN_GATEWAY=0");
  });
});
