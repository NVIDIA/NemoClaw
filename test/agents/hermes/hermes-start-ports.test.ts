// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { shellQuote } from "../../../src/lib/core/shell-quote";
import {
  extractShellFunction,
  runHermesBashHarness as runBashHarness,
} from "../../support/hermes-shell-harness";

const START_SCRIPT = path.join(import.meta.dirname, "../../..", "agents", "hermes", "start.sh");
const {
  CHAT_UI_URL: _inheritedChatUiUrl,
  NEMOCLAW_DASHBOARD_PORT: _inheritedDashboardPort,
  ...BASE_BOOTSTRAP_ENV
} = process.env;

function extractDashboardPortBootstrap(source: string): string {
  const start = source.indexOf('NEMOCLAW_CMD=("$@")');
  const end = source.indexOf('\nHERMES="$(command -v hermes)"', start);
  assert(start >= 0 && end > start, "Hermes dashboard port bootstrap markers not found");
  return source.slice(start, end).trimEnd();
}

function runHermesDashboardPortBootstrap(env: Record<string, string>) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-port-bootstrap-"));
  const scriptPath = path.join(tmpDir, "run.sh");
  const pythonImportSentinel = path.join(tmpDir, "python-import-sentinel");
  const source = fs.readFileSync(START_SCRIPT, "utf-8");
  fs.writeFileSync(
    path.join(tmpDir, "sitecustomize.py"),
    `from pathlib import Path\nPath(${JSON.stringify(pythonImportSentinel)}).write_text("loaded")\n`,
  );
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -eo pipefail",
      "set --",
      extractDashboardPortBootstrap(source),
      'printf "CHAT_UI_URL=%s\\n" "${CHAT_UI_URL:-}"',
      'printf "DASHBOARD_PUBLIC_PORT=%s\\n" "$DASHBOARD_PUBLIC_PORT"',
      'printf "PUBLIC_PORT=%s\\n" "$PUBLIC_PORT"',
    ].join("\n"),
    { mode: 0o700 },
  );

  try {
    const result = spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      timeout: 5000,
      env: { ...BASE_BOOTSTRAP_ENV, PYTHONPATH: tmpDir, ...env },
    });
    return Object.assign(result, {
      pythonImportSentinelExists: fs.existsSync(pythonImportSentinel),
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function runHermesDashboardArgs(tuiValue: string) {
  const source = fs.readFileSync(START_SCRIPT, "utf-8");
  return runBashHarness([
    extractShellFunction(source, "truthy_env"),
    extractShellFunction(source, "hermes_dashboard_tui_enabled"),
    extractShellFunction(source, "build_hermes_dashboard_args"),
    "DASHBOARD_INTERNAL_PORT=19119",
    `HERMES_DASHBOARD_TUI=${shellQuote(tuiValue)}`,
    "build_hermes_dashboard_args",
    'printf "%s\\n" "${HERMES_DASHBOARD_ARGS[@]}"',
  ]);
}

function runHermesPortValidation(opts: {
  publicPort?: number;
  internalPort?: number;
  dashboardPublicPort?: number;
  dashboardInternalPort?: number;
}) {
  const source = fs.readFileSync(START_SCRIPT, "utf-8");
  return runBashHarness([
    extractShellFunction(source, "validate_tcp_port"),
    extractShellFunction(source, "validate_port_configuration"),
    `PUBLIC_PORT=${opts.publicPort ?? 8642}`,
    `INTERNAL_PORT=${opts.internalPort ?? 18642}`,
    `DASHBOARD_PUBLIC_PORT=${opts.dashboardPublicPort ?? 18789}`,
    `DASHBOARD_INTERNAL_PORT=${opts.dashboardInternalPort ?? 19119}`,
    "validate_port_configuration",
  ]);
}

describe("agents/hermes/start.sh port bootstrap", () => {
  it("derives a non-default dashboard port through the isolated parser", () => {
    const run = runHermesDashboardPortBootstrap({
      CHAT_UI_URL: "https://hermes.example.test:29443",
    });

    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("CHAT_UI_URL=https://hermes.example.test:29443");
    expect(run.stdout).toContain("DASHBOARD_PUBLIC_PORT=29443");
    expect(run.stdout).toContain("PUBLIC_PORT=8642");
    expect(run.pythonImportSentinelExists).toBe(false);
  });

  it("rejects invalid and API-colliding dashboard ports", () => {
    const collision = runHermesDashboardPortBootstrap({
      CHAT_UI_URL: "http://127.0.0.1:8642",
    });
    expect(collision.status).toBe(1);
    expect(collision.stderr).toContain("reserved for the Hermes OpenAI-compatible API");

    const invalid = runHermesDashboardPortBootstrap({
      NEMOCLAW_DASHBOARD_PORT: "not-a-port",
    });
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("Invalid NEMOCLAW_DASHBOARD_PORT");
  });

  it("keeps the dashboard isolated and makes the in-browser TUI opt-in", () => {
    const defaultArgs = runHermesDashboardArgs("0");
    expect(defaultArgs.status, defaultArgs.stderr).toBe(0);
    expect(defaultArgs.stdout.split("\n")).toEqual(
      expect.arrayContaining(["dashboard", "--isolated"]),
    );
    expect(defaultArgs.stdout.split("\n")).not.toContain("--tui");

    const optInArgs = runHermesDashboardArgs("1");
    expect(optInArgs.status, optInArgs.stderr).toBe(0);
    expect(optInArgs.stdout.split("\n")).toEqual(expect.arrayContaining(["--isolated", "--tui"]));
  });

  it("rejects cross-collisions between API and dashboard ports", () => {
    const publicCollision = runHermesPortValidation({ dashboardPublicPort: 18642 });
    expect(publicCollision.status).toBe(1);
    expect(publicCollision.stderr).toContain("DASHBOARD_PUBLIC_PORT must not equal INTERNAL_PORT");

    const internalCollision = runHermesPortValidation({ dashboardInternalPort: 8642 });
    expect(internalCollision.status).toBe(1);
    expect(internalCollision.stderr).toContain(
      "DASHBOARD_INTERNAL_PORT must not equal PUBLIC_PORT",
    );
  });
});
