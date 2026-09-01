// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const puller = path.join(repoRoot, "scripts/checks/pull-public-exact-digest.sh");
const reference = `ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox@sha256:${"a".repeat(64)}`;
const firstRetryWarning =
  "::warning::GHCR anonymous exact-digest pull outcome=transient-external attempt=1/30 failure=anonymous-unavailable elapsed=<seconds> deadline=900s retry-in=2s";

type Scenario =
  | "attempt-cap-exhausted"
  | "deadline-exhausted"
  | "late-success"
  | "success"
  | "terminal";

function normalizeElapsed(output: string): string {
  return output.replace(/elapsed=[0-9]+s/gu, "elapsed=<seconds>");
}

function elapsedSeconds(output: string): number {
  return Number(/\belapsed=([0-9]+)s\b/u.exec(output)?.[1]);
}

function runPuller(scenario: Scenario, candidateReference = reference) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-public-pull-"));
  const fakeBin = path.join(temporaryRoot, "bin");
  const countFile = path.join(temporaryRoot, "count");
  const configLog = path.join(temporaryRoot, "docker-configs");
  const sleepLog = path.join(temporaryRoot, "sleeps");
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(
    path.join(fakeBin, "docker"),
    `#!/usr/bin/env bash
set -euo pipefail
count=0
if [ -f "$COUNT_FILE" ]; then
  count="$(cat "$COUNT_FILE")"
fi
count=$((count + 1))
printf '%s\n' "$count" >"$COUNT_FILE"
printf '%s\n' "$DOCKER_CONFIG" >>"$CONFIG_LOG"
[ -z "\${DOCKER_AUTH_CONFIG+x}" ] || exit 91
[ "$*" = "pull --platform linux/amd64 $EXPECTED_REFERENCE" ] || exit 90
if [ "$SCENARIO" = "terminal" ]; then
  echo "unexpected Docker daemon failure" >&2
  exit 41
fi
if [ "$SCENARIO" = "deadline-exhausted" ] || [ "$SCENARIO" = "attempt-cap-exhausted" ] || { [ "$SCENARIO" = "late-success" ] && [ "$count" -le 26 ]; }; then
  case "$count" in
    1) echo "Error response from daemon: Head registry manifest: denied" >&2 ;;
    2) echo "denied: permission_denied" >&2 ;;
    3) echo "manifest unknown while the public package propagates" >&2 ;;
    4) echo "unexpected status from anonymous HEAD request" >&2 ;;
    *) echo "failed to resolve exact digest from anonymous GHCR" >&2 ;;
  esac
  exit 1
fi
echo "pulled $EXPECTED_REFERENCE"
`,
    { mode: 0o755 },
  );
  try {
    const result = spawnSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
SECONDS=0
sleep() {
  printf '%s\\n' "$1" >>"$SLEEP_LOG"
  if [ "$SCENARIO" = "deadline-exhausted" ]; then
    SECONDS=900
  elif [ "$SCENARIO" = "late-success" ]; then
    SECONDS=$((SECONDS + $1))
  else
    SECONDS=0
  fi
}
source "$PULLER" "$EXPECTED_REFERENCE" linux/amd64
`,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CONFIG_LOG: configLog,
          COUNT_FILE: countFile,
          DOCKER_AUTH_CONFIG: "must-not-reach-docker",
          EXPECTED_REFERENCE: candidateReference,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          PULLER: puller,
          RUNNER_TEMP: temporaryRoot,
          SCENARIO: scenario,
          SLEEP_LOG: sleepLog,
        },
      },
    );
    const count = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, "utf8").trim()) : 0;
    const configs = fs.existsSync(configLog)
      ? fs.readFileSync(configLog, "utf8").trim().split("\n")
      : [];
    const sleeps = fs.existsSync(sleepLog)
      ? fs.readFileSync(sleepLog, "utf8").trim().split("\n")
      : [];
    return {
      ...result,
      configs,
      configsWereRemoved: configs.every((config) => !fs.existsSync(config)),
      count,
      sleeps,
    };
  } finally {
    fs.rmSync(temporaryRoot, { force: true, recursive: true });
  }
}

describe("pull-public-exact-digest", () => {
  it("passes once with a credential-free Docker configuration", () => {
    const result = runPuller("success");

    expect(result.status, result.stderr).toBe(0);
    expect(result.count).toBe(1);
    expect(result.sleeps).toEqual([]);
    expect(result.configsWereRemoved).toBe(true);
    expect(normalizeElapsed(result.stdout.trim())).toBe(
      "::notice::GHCR anonymous exact-digest pull outcome=passed-first-attempt attempt=1/30 elapsed=<seconds> deadline=900s",
    );
  });

  it("accepts anonymous visibility after 600 seconds within the 900-second deadline", () => {
    const result = runPuller("late-success");

    expect(result.status, result.stderr).toBe(0);
    expect(result.count).toBe(27);
    expect(result.sleeps).toHaveLength(26);
    expect(result.sleeps.slice(0, 5)).toEqual(["2", "4", "8", "16", "30"]);
    expect(new Set(result.sleeps.slice(4))).toEqual(new Set(["30"]));
    expect(new Set(result.configs).size).toBe(1);
    expect(result.configsWereRemoved).toBe(true);
    const diagnostics = result.stderr.trim().split("\n");
    expect(diagnostics).toHaveLength(26);
    expect(normalizeElapsed(diagnostics[0] ?? "")).toBe(firstRetryWarning);
    expect(normalizeElapsed(diagnostics[25] ?? "")).toBe(
      "::warning::GHCR anonymous exact-digest pull outcome=transient-external attempt=26/30 failure=anonymous-unavailable elapsed=<seconds> deadline=900s retry-in=30s",
    );
    expect(normalizeElapsed(result.stdout.trim())).toBe(
      "::notice::GHCR anonymous exact-digest pull outcome=passed-after-retry attempt=27/30 elapsed=<seconds> deadline=900s",
    );
    expect(elapsedSeconds(result.stdout)).toBeGreaterThanOrEqual(690);
    expect(elapsedSeconds(result.stdout)).toBeLessThan(900);
    expect(result.stdout + result.stderr).not.toContain("Head registry manifest: denied");
  });

  it("does not retry a non-1 Docker exit", () => {
    const result = runPuller("terminal");

    expect(result.status).toBe(41);
    expect(result.count).toBe(1);
    expect(result.sleeps).toEqual([]);
    expect(result.configsWereRemoved).toBe(true);
    expect(result.stderr.trim()).toBe(
      "::error::GHCR anonymous exact-digest pull outcome=failed-no-retry attempt=1/30 docker-exit=41",
    );
    expect(result.stderr).not.toContain("unexpected Docker daemon failure");
  });

  it("stops at the hard attempt cap even when no elapsed time passes", () => {
    const result = runPuller("attempt-cap-exhausted");

    expect(result.status).toBe(1);
    expect(result.count).toBe(30);
    expect(result.sleeps).toHaveLength(29);
    expect(result.sleeps.slice(0, 5)).toEqual(["2", "4", "8", "16", "30"]);
    expect(new Set(result.sleeps.slice(4))).toEqual(new Set(["30"]));
    expect(new Set(result.configs).size).toBe(1);
    expect(result.configsWereRemoved).toBe(true);
    const diagnostics = result.stderr.trim().split("\n");
    expect(diagnostics).toHaveLength(30);
    expect(normalizeElapsed(diagnostics[0] ?? "")).toBe(firstRetryWarning);
    expect(normalizeElapsed(diagnostics[28] ?? "")).toBe(
      "::warning::GHCR anonymous exact-digest pull outcome=transient-external attempt=29/30 failure=anonymous-unavailable elapsed=<seconds> deadline=900s retry-in=30s",
    );
    expect(normalizeElapsed(diagnostics[29] ?? "")).toBe(
      "::error::GHCR anonymous exact-digest pull outcome=exhausted attempt=30/30 failure=anonymous-unavailable limit=attempt-cap elapsed=<seconds> deadline=900s",
    );
    expect(result.stderr).not.toContain("permission_denied");
    expect(result.stderr).not.toContain("manifest unknown");
    expect(result.stderr).not.toContain("anonymous HEAD request");
  });

  it("stops at the elapsed deadline before another anonymous pull", () => {
    const result = runPuller("deadline-exhausted");

    expect(result.status).toBe(1);
    expect(result.count).toBe(1);
    expect(result.sleeps).toEqual(["2"]);
    expect(result.configsWereRemoved).toBe(true);
    const diagnostics = result.stderr.trim().split("\n");
    expect(diagnostics).toHaveLength(2);
    expect(normalizeElapsed(diagnostics[0] ?? "")).toBe(firstRetryWarning);
    expect(normalizeElapsed(diagnostics[1] ?? "")).toBe(
      "::error::GHCR anonymous exact-digest pull outcome=exhausted attempt=1/30 failure=anonymous-unavailable limit=elapsed-deadline elapsed=<seconds> deadline=900s",
    );
    expect(elapsedSeconds(diagnostics[1] ?? "")).toBeGreaterThanOrEqual(900);
  });

  it("rejects a mutable or non-GHCR reference before Docker runs", () => {
    const result = runPuller("terminal", "docker.io/nvidia/nemoclaw:latest");

    expect(result.status).toBe(2);
    expect(result.count).toBe(0);
    expect(result.stderr).toContain("must be an exact lowercase GHCR digest");
  });
});
