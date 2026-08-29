// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readYaml, type Workflow } from "../helpers/e2e-workflow-contract";

const workflow = readYaml<Workflow>(".github/workflows/code-scanning.yaml");
const shellcheckSteps = workflow.jobs.shellcheck?.steps ?? [];

function requiredStep(name: string) {
  const step = shellcheckSteps.find((candidate) => candidate.name === name);
  assert(step, `ShellCheck workflow is missing step: ${name}`);
  return step;
}

function writeExecutable(file: string, content: string) {
  fs.writeFileSync(file, content, { mode: 0o755 });
}

function runShellCheckInstall({
  aptUpdateSucceeds = true,
  installedSupportsJson1 = true,
  preinstalledSupportsJson1,
}: {
  aptUpdateSucceeds?: boolean;
  installedSupportsJson1?: boolean;
  preinstalledSupportsJson1: boolean;
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shellcheck-install-"));
  const bin = path.join(root, "bin");
  const trace = path.join(root, "trace");
  const installedMarker = path.join(root, "installed");
  fs.mkdirSync(bin);
  writeExecutable(
    path.join(bin, "shellcheck"),
    `#!/bin/sh
printf 'shellcheck:%s\\n' "$*" >> "$TRACE"
case "$*" in
  *--format=json1*)
    [ "$PREINSTALLED_SUPPORTS_JSON1" = "true" ] ||
      { [ -f "$INSTALLED_MARKER" ] && [ "$INSTALLED_SUPPORTS_JSON1" = "true" ]; }
    ;;
  --version)
    printf 'version: 0.11.0\\n'
    ;;
esac
`,
  );
  writeExecutable(
    path.join(bin, "sudo"),
    `#!/bin/sh
printf 'sudo:%s\\n' "$*" >> "$TRACE"
case "$*" in
  *" update")
    [ "$APT_UPDATE_SUCCEEDS" = "true" ]
    ;;
  *" install -y shellcheck")
    : > "$INSTALLED_MARKER"
    ;;
esac
`,
  );
  const install = requiredStep("Install ShellCheck");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-c", install.run ?? ""], {
    encoding: "utf8",
    env: {
      ...process.env,
      APT_UPDATE_SUCCEEDS: String(aptUpdateSucceeds),
      PATH: `${bin}:${process.env.PATH}`,
      INSTALLED_MARKER: installedMarker,
      INSTALLED_SUPPORTS_JSON1: String(installedSupportsJson1),
      PREINSTALLED_SUPPORTS_JSON1: String(preinstalledSupportsJson1),
      RUNNER_TEMP: root,
      TRACE: trace,
    },
  });
  const calls = fs.readFileSync(trace, "utf8").trim().split("\n");
  fs.rmSync(root, { recursive: true, force: true });
  return { calls, result };
}

describe("ShellCheck SARIF workflow boundary", () => {
  it("keeps a preinstalled ShellCheck only when its json1 formatter works (#7684)", () => {
    const { calls, result } = runShellCheckInstall({ preinstalledSupportsJson1: true });

    expect(result.status, result.stderr).toBe(0);
    expect(calls).toEqual([
      expect.stringContaining("shellcheck:--format=json1"),
      "shellcheck:--version",
    ]);
  });

  it("installs and validates ShellCheck when the preinstalled binary lacks json1 (#7684)", () => {
    const { calls, result } = runShellCheckInstall({ preinstalledSupportsJson1: false });

    expect(result.status, result.stderr).toBe(0);
    expect(calls).toEqual([
      expect.stringContaining("shellcheck:--format=json1"),
      "sudo:apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=15 -o Acquire::https::Timeout=15 update",
      "sudo:apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=15 -o Acquire::https::Timeout=15 install -y shellcheck",
      expect.stringContaining("shellcheck:--format=json1"),
      "shellcheck:--version",
    ]);
  });

  it("fails clearly when the bounded ShellCheck package-index update fails (#7684)", () => {
    const { calls, result } = runShellCheckInstall({
      aptUpdateSucceeds: false,
      preinstalledSupportsJson1: false,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Failed to update apt package indexes for ShellCheck");
    expect(calls).toEqual([
      expect.stringContaining("shellcheck:--format=json1"),
      "sudo:apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=15 -o Acquire::https::Timeout=15 update",
    ]);
  });

  it("rejects an installed ShellCheck without json1 support (#7684)", () => {
    const { calls, result } = runShellCheckInstall({
      installedSupportsJson1: false,
      preinstalledSupportsJson1: false,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Installed ShellCheck does not support --format=json1");
    expect(calls).toEqual([
      expect.stringContaining("shellcheck:--format=json1"),
      "sudo:apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=15 -o Acquire::https::Timeout=15 update",
      "sudo:apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=15 -o Acquire::https::Timeout=15 install -y shellcheck",
      expect.stringContaining("shellcheck:--format=json1"),
    ]);
  });
});
