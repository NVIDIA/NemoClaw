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

function extractDashboardPortBootstrap(src: string): string {
  const start = src.indexOf('NEMOCLAW_CMD=("$@")');
  const end = src.indexOf('\nHERMES="$(command -v hermes)"', start);
  expect(start, "dashboard port bootstrap start marker").toBeGreaterThanOrEqual(0);
  expect(end, "dashboard port bootstrap end marker").toBeGreaterThan(start);
  return src.slice(start, end).trimEnd();
}

function runHermesDashboardPortBootstrap(
  env: Record<string, string | undefined> = {},
  hostilePythonPath = false,
) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-port-bootstrap-"));
  const scriptPath = path.join(tmpDir, "run.sh");
  const pythonImportSentinel = path.join(tmpDir, "python-import-sentinel");
  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  void (hostilePythonPath
    ? fs.writeFileSync(
        path.join(tmpDir, "sitecustomize.py"),
        `from pathlib import Path\nPath(${JSON.stringify(pythonImportSentinel)}).write_text("loaded")\n`,
      )
    : undefined);
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -eo pipefail",
      "set --",
      extractDashboardPortBootstrap(src),
      'printf "CHAT_UI_URL=%s\\n" "${CHAT_UI_URL:-}"',
      'printf "DASHBOARD_PUBLIC_PORT=%s\\n" "$DASHBOARD_PUBLIC_PORT"',
      'printf "PUBLIC_PORT=%s\\n" "$PUBLIC_PORT"',
    ].join("\n"),
    { mode: 0o700 },
  );

  try {
    const childEnv = { ...process.env, ...env };
    Object.keys(env)
      .filter((key) => env[key] === undefined)
      .forEach((key) => delete childEnv[key]);
    void (hostilePythonPath ? (childEnv.PYTHONPATH = tmpDir) : undefined);
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

function runHermesDashboardArgs(tuiValue?: string) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-dashboard-args-"));
  const scriptPath = path.join(tmpDir, "run.sh");
  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      extractShellFunction(src, "truthy_env"),
      extractShellFunction(src, "hermes_dashboard_tui_enabled"),
      extractShellFunction(src, "build_hermes_dashboard_args"),
      "DASHBOARD_INTERNAL_PORT=19119",
      tuiValue === undefined
        ? 'HERMES_DASHBOARD_TUI="${HERMES_DASHBOARD_TUI:-0}"'
        : `HERMES_DASHBOARD_TUI=${shellQuote(tuiValue)}`,
      "build_hermes_dashboard_args",
      'printf "%s\\n" "${HERMES_DASHBOARD_ARGS[@]}"',
    ].join("\n"),
    { mode: 0o700 },
  );

  try {
    return spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      timeout: 5000,
      env: process.env,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function runHermesPortValidation(opts: {
  publicPort?: number;
  internalPort?: number;
  dashboardPublicPort?: number;
  dashboardInternalPort?: number;
}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-port-validation-"));
  const scriptPath = path.join(tmpDir, "run.sh");
  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      extractShellFunction(src, "validate_tcp_port"),
      extractShellFunction(src, "validate_port_configuration"),
      `PUBLIC_PORT=${opts.publicPort ?? 8642}`,
      `INTERNAL_PORT=${opts.internalPort ?? 18642}`,
      `DASHBOARD_PUBLIC_PORT=${opts.dashboardPublicPort ?? 18789}`,
      `DASHBOARD_INTERNAL_PORT=${opts.dashboardInternalPort ?? 19119}`,
      "validate_port_configuration",
    ].join("\n"),
    { mode: 0o700 },
  );

  try {
    return spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      timeout: 5000,
      env: process.env,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("agents/hermes/start.sh port validation", () => {
  it("derives the dashboard port from CHAT_UI_URL while preserving API port 8642", () => {
    const run = runHermesDashboardPortBootstrap({
      CHAT_UI_URL: "https://hermes.example.test:29443",
      NEMOCLAW_DASHBOARD_PORT: undefined,
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("CHAT_UI_URL=https://hermes.example.test:29443");
    expect(run.stdout).toContain("DASHBOARD_PUBLIC_PORT=29443");
    expect(run.stdout).toContain("PUBLIC_PORT=8642");
  });

  it("isolates CHAT_UI_URL parsing from an inherited Python import path", () => {
    const run = runHermesDashboardPortBootstrap(
      {
        CHAT_UI_URL: "https://hermes.example.test:29443",
        NEMOCLAW_DASHBOARD_PORT: undefined,
      },
      true,
    );
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("DASHBOARD_PUBLIC_PORT=29443");
    expect(run.pythonImportSentinelExists).toBe(false);
  });

  it("rejects dashboard ports that collide with the API port during bootstrap", () => {
    const fromChatUrl = runHermesDashboardPortBootstrap({
      CHAT_UI_URL: "http://127.0.0.1:8642",
      NEMOCLAW_DASHBOARD_PORT: undefined,
    });
    expect(fromChatUrl.status).toBe(1);
    expect(fromChatUrl.stderr).toContain("reserved for the Hermes OpenAI-compatible API");

    const invalidOverride = runHermesDashboardPortBootstrap({
      CHAT_UI_URL: undefined,
      NEMOCLAW_DASHBOARD_PORT: "not-a-port",
    });
    expect(invalidOverride.status).toBe(1);
    expect(invalidOverride.stderr).toContain("Invalid NEMOCLAW_DASHBOARD_PORT");
  });

  it("keeps the managed dashboard isolated and its in-browser Hermes TUI opt-in", () => {
    const defaultArgs = runHermesDashboardArgs();
    expect(defaultArgs.status).toBe(0);
    expect(defaultArgs.stdout.split("\n")).not.toContain("--tui");

    const optInArgs = runHermesDashboardArgs("1");
    expect(optInArgs.status).toBe(0);
    expect(optInArgs.stdout.split("\n")).toEqual(expect.arrayContaining(["--isolated", "--tui"]));
  });

  it("rejects cross-collisions between API and dashboard ports", () => {
    const dashboardPublicOnApiInternal = runHermesPortValidation({
      dashboardPublicPort: 18642,
    });
    expect(dashboardPublicOnApiInternal.status).toBe(1);
    expect(dashboardPublicOnApiInternal.stderr).toContain(
      "DASHBOARD_PUBLIC_PORT must not equal INTERNAL_PORT",
    );

    const dashboardInternalOnApiPublic = runHermesPortValidation({
      dashboardInternalPort: 8642,
    });
    expect(dashboardInternalOnApiPublic.status).toBe(1);
    expect(dashboardInternalOnApiPublic.stderr).toContain(
      "DASHBOARD_INTERNAL_PORT must not equal PUBLIC_PORT",
    );
  });
});
