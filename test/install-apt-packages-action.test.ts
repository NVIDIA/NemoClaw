// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadE2eWorkflowContract } from "./helpers/e2e-workflow-contract";

type InstallAptActionRunResult = {
  status: number | null;
  stderr: string;
  sudoLog: string;
  sleepLog: string;
};

function readIfExists(pathname: string): string {
  return existsSync(pathname) ? readFileSync(pathname, "utf8") : "";
}

function runInstallAptActionScript(
  script: string,
  aptPackages: string,
  options: { updateFailures?: number } = {},
): InstallAptActionRunResult {
  const tempDir = mkdtempSync(path.join(tmpdir(), "nemoclaw-install-apt-action-"));
  const binDir = path.join(tempDir, "bin");
  const sudoLog = path.join(tempDir, "sudo.log");
  const sleepLog = path.join(tempDir, "sleep.log");
  const updateCount = path.join(tempDir, "update-count");
  try {
    mkdirSync(binDir);
    writeFileSync(
      path.join(binDir, "sudo"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'printf "%s\\n" "$*" >> "$SUDO_LOG"',
        'if [ "$*" = "apt-get update" ]; then',
        "  count=0",
        '  if [ -f "$SUDO_UPDATE_COUNT_FILE" ]; then',
        '    count="$(cat "$SUDO_UPDATE_COUNT_FILE")"',
        "  fi",
        "  count=$((count + 1))",
        '  printf "%s" "$count" > "$SUDO_UPDATE_COUNT_FILE"',
        '  if [ "$count" -le "${SUDO_UPDATE_FAILURES:-0}" ]; then',
        "    exit 42",
        "  fi",
        "fi",
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    writeFileSync(
      path.join(binDir, "sleep"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'printf "sleep %s\\n" "$*" >> "$SLEEP_LOG"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: {
        PATH: [binDir, process.env.PATH ?? ""].filter(Boolean).join(":"),
        APT_PACKAGES: aptPackages,
        SLEEP_LOG: sleepLog,
        SUDO_LOG: sudoLog,
        SUDO_UPDATE_COUNT_FILE: updateCount,
        SUDO_UPDATE_FAILURES: String(options.updateFailures ?? 0),
      },
      timeout: 5000,
    });

    return {
      status: result.status,
      stderr: String(result.stderr ?? ""),
      sudoLog: readIfExists(sudoLog),
      sleepLog: readIfExists(sleepLog),
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe("install-apt-packages action", () => {
  const { installAptAction } = loadE2eWorkflowContract();
  const installScript = String(
    installAptAction.runs.steps.find((step) => step.name === "Install apt packages")?.run ?? "",
  );

  it("validates package input at runtime before invoking sudo", () => {
    for (const [aptPackages, expectedError] of [
      ["", "::error::No apt packages requested."],
      ["pkg; rm -rf /", "::error::Invalid apt package name: pkg;"],
      ["pkg:amd64", "::error::Invalid apt package name: pkg:amd64"],
      ["-oDebug::NoLocking=1", "::error::Invalid apt package name: -oDebug::NoLocking=1"],
      ["libssl3", "::error::Unsupported apt package: libssl3"],
    ] as const) {
      const result = runInstallAptActionScript(installScript, aptPackages);

      expect(result.status, aptPackages).toBe(1);
      expect(result.stderr, aptPackages).toContain(expectedError);
      expect(result.sudoLog, aptPackages).toBe("");
    }
  });

  it("accepts reviewed host tool package literals", () => {
    for (const packageName of ["expect", "iptables"]) {
      const result = runInstallAptActionScript(installScript, packageName);

      expect(result.status, packageName).toBe(0);
      expect(result.stderr, packageName).not.toContain("::error::Invalid apt package name");
      expect(result.sudoLog.trim().split("\n"), packageName).toEqual([
        "apt-get update",
        `apt-get install -y --no-install-recommends ${packageName}`,
      ]);
    }
  });

  it("installs validated packages and retries apt metadata refresh at runtime", () => {
    const success = runInstallAptActionScript(installScript, "expect iptables");
    expect(success.status).toBe(0);
    expect(success.sudoLog.trim().split("\n")).toEqual([
      "apt-get update",
      "apt-get install -y --no-install-recommends expect iptables",
    ]);

    const retried = runInstallAptActionScript(installScript, "expect", { updateFailures: 2 });
    expect(retried.status).toBe(0);
    expect(retried.stderr).toContain("::warning::apt-get update attempt 1 failed; retrying.");
    expect(retried.stderr).toContain("::warning::apt-get update attempt 2 failed; retrying.");
    expect(retried.sudoLog.trim().split("\n")).toEqual([
      "apt-get update",
      "apt-get update",
      "apt-get update",
      "apt-get install -y --no-install-recommends expect",
    ]);
    expect(retried.sleepLog.trim().split("\n")).toEqual(["sleep 5", "sleep 10"]);

    const failed = runInstallAptActionScript(installScript, "expect", { updateFailures: 3 });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("::error::apt-get update failed after 3 attempts.");
    expect(failed.sudoLog.trim().split("\n")).toEqual([
      "apt-get update",
      "apt-get update",
      "apt-get update",
    ]);
    expect(failed.sleepLog.trim().split("\n")).toEqual(["sleep 5", "sleep 10"]);
  });
});
