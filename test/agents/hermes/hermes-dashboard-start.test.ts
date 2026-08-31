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
const EXTERNAL_HOST_HELPER = path.join(
  import.meta.dirname,
  "../../..",
  "agents",
  "hermes",
  "dashboard-external-host.sh",
);

function dashboardPortBootstrap(source: string): string {
  const start = source.indexOf('NEMOCLAW_CMD=("$@")');
  const end = source.indexOf('\nHERMES="$(command -v hermes)"', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end).trimEnd();
}

function environmentWith(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return Object.entries(overrides).reduce<NodeJS.ProcessEnv>(
    (environment, [key, value]) => {
      value === undefined ? delete environment[key] : (environment[key] = value);
      return environment;
    },
    { ...process.env },
  );
}

function runHermesDashboardPortBootstrap(env: Record<string, string | undefined> = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-port-bootstrap-"));
  const scriptPath = path.join(tmpDir, "run.sh");
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -eo pipefail",
      "set --",
      `source ${shellQuote(EXTERNAL_HOST_HELPER)}`,
      dashboardPortBootstrap(fs.readFileSync(START_SCRIPT, "utf-8")),
      'printf "CHAT_UI_URL=%s\\n" "${CHAT_UI_URL:-}"',
      'printf "DASHBOARD_PUBLIC_PORT=%s\\n" "$DASHBOARD_PUBLIC_PORT"',
      'printf "DASHBOARD_INTERNAL_PORT=%s\\n" "$DASHBOARD_INTERNAL_PORT"',
      'printf "PUBLIC_PORT=%s\\n" "$PUBLIC_PORT"',
    ].join("\n"),
    { mode: 0o700 },
  );

  try {
    return spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      timeout: 5000,
      env: environmentWith(env),
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function runHermesDashboardArgs(tuiValue?: string) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-dashboard-args-"));
  const scriptPath = path.join(tmpDir, "run.sh");
  const source = fs.readFileSync(START_SCRIPT, "utf-8");
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      extractShellFunction(source, "truthy_env"),
      extractShellFunction(source, "hermes_dashboard_tui_enabled"),
      extractShellFunction(source, "build_hermes_dashboard_args"),
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
  const source = fs.readFileSync(START_SCRIPT, "utf-8");
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      extractShellFunction(source, "validate_tcp_port"),
      extractShellFunction(source, "validate_port_configuration"),
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

function runHermesDashboardProcess(serviceUser: "current" | "sandbox", chatUiUrl: string) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-dashboard-process-"));
  const scriptPath = path.join(tmpDir, "run.sh");
  const fakeHermes = path.join(tmpDir, "hermes");
  const capturedHost = path.join(tmpDir, "external-host");
  const source = fs.readFileSync(START_SCRIPT, "utf-8");
  fs.writeFileSync(
    fakeHermes,
    '#!/usr/bin/env bash\nprintf "%s" "${_NEMOCLAW_HERMES_DASHBOARD_EXTERNAL_HOST-unset}" > "$NEMOCLAW_TEST_CAPTURE"\n',
    { mode: 0o700 },
  );
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -eo pipefail",
      "set --",
      `source ${shellQuote(EXTERNAL_HOST_HELPER)}`,
      dashboardPortBootstrap(source),
      extractShellFunction(source, "launch_hermes_dashboard_process"),
      `HERMES=${shellQuote(fakeHermes)}`,
      `HERMES_DIR=${shellQuote(path.join(tmpDir, "hermes-home"))}`,
      `HERMES_DASHBOARD_HOME=${shellQuote(path.join(tmpDir, "dashboard-home"))}`,
      `NEMOCLAW_TEST_CAPTURE=${shellQuote(capturedHost)}`,
      "export NEMOCLAW_TEST_CAPTURE",
      "INTERNAL_PORT=18642",
      "HERMES_DASHBOARD_ARGS=(dashboard)",
      "STEP_DOWN_PREFIX_SANDBOX=(env)",
      `launch_hermes_dashboard_process ${serviceUser}`,
      'wait "$DASHBOARD_PID"',
    ].join("\n"),
    { mode: 0o700 },
  );

  try {
    const result = spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      timeout: 5000,
      env: environmentWith({ CHAT_UI_URL: chatUiUrl, NEMOCLAW_DASHBOARD_PORT: undefined }),
    });
    return {
      result,
      externalHost: fs.existsSync(capturedHost) ? fs.readFileSync(capturedHost, "utf-8") : null,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("agents/hermes/start.sh dashboard startup", () => {
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

  it.each(["current", "sandbox"] as const)(
    "passes the canonical external host to the %s dashboard process (#10651)",
    (serviceUser) => {
      const run = runHermesDashboardProcess(
        serviceUser,
        "https://NEMOCLAW0-ABC123.BREVLAB.COM.:29443/dashboard",
      );

      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.externalHost).toBe("nemoclaw0-abc123.brevlab.com");
    },
  );

  it.each(["current", "sandbox"] as const)(
    "passes no external host to the %s dashboard process for loopback CHAT_UI_URL (#10651)",
    (serviceUser) => {
      const run = runHermesDashboardProcess(serviceUser, "http://127.0.0.1:18789");

      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.externalHost).toBe("");
    },
  );

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

  it("rejects an external dashboard URL that cannot supply the Host allowlist", () => {
    const run = runHermesDashboardPortBootstrap({
      CHAT_UI_URL: "http://dashboard.example.test:29443",
      NEMOCLAW_DASHBOARD_PORT: undefined,
    });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("Invalid CHAT_UI_URL for the Hermes dashboard");
    expect(run.stderr).not.toContain("dashboard.example.test");
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
