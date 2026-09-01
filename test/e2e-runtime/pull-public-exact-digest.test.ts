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
const retryWarnings = [
  "::warning::GHCR anonymous exact-digest pull outcome=transient-external attempt=1/7 failure=anonymous-unavailable retry-in=2s",
  "::warning::GHCR anonymous exact-digest pull outcome=transient-external attempt=2/7 failure=anonymous-unavailable retry-in=4s",
  "::warning::GHCR anonymous exact-digest pull outcome=transient-external attempt=3/7 failure=anonymous-unavailable retry-in=8s",
  "::warning::GHCR anonymous exact-digest pull outcome=transient-external attempt=4/7 failure=anonymous-unavailable retry-in=16s",
  "::warning::GHCR anonymous exact-digest pull outcome=transient-external attempt=5/7 failure=anonymous-unavailable retry-in=30s",
  "::warning::GHCR anonymous exact-digest pull outcome=transient-external attempt=6/7 failure=anonymous-unavailable retry-in=30s",
];

type Scenario = "exit-one-exhausted" | "exit-one-through-six-then-success" | "success" | "terminal";

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
if [ "$SCENARIO" = "exit-one-exhausted" ] || { [ "$SCENARIO" = "exit-one-through-six-then-success" ] && [ "$count" -le 6 ]; }; then
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
  fs.writeFileSync(
    path.join(fakeBin, "sleep"),
    '#!/usr/bin/env bash\nset -euo pipefail\nprintf \'%s\\n\' "$1" >>"$SLEEP_LOG"\n',
    { mode: 0o755 },
  );

  try {
    const result = spawnSync(puller, [candidateReference, "linux/amd64"], {
      encoding: "utf8",
      env: {
        ...process.env,
        CONFIG_LOG: configLog,
        COUNT_FILE: countFile,
        DOCKER_AUTH_CONFIG: "must-not-reach-docker",
        EXPECTED_REFERENCE: candidateReference,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        RUNNER_TEMP: temporaryRoot,
        SCENARIO: scenario,
        SLEEP_LOG: sleepLog,
      },
    });
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
    expect(result.stdout.trim()).toBe(
      "::notice::GHCR anonymous exact-digest pull outcome=passed-first-attempt attempt=1/7",
    );
  });

  it("reaches a seventh anonymous pull after six exit-1 propagation failures", () => {
    const result = runPuller("exit-one-through-six-then-success");

    expect(result.status, result.stderr).toBe(0);
    expect(result.count).toBe(7);
    expect(result.sleeps).toEqual(["2", "4", "8", "16", "30", "30"]);
    expect(new Set(result.configs).size).toBe(1);
    expect(result.configsWereRemoved).toBe(true);
    expect(result.stderr.trim().split("\n")).toEqual(retryWarnings);
    expect(result.stdout.trim()).toBe(
      "::notice::GHCR anonymous exact-digest pull outcome=passed-after-retry attempt=7/7",
    );
    expect(result.stdout + result.stderr).not.toContain("Head registry manifest: denied");
  });

  it("does not retry a non-1 Docker exit", () => {
    const result = runPuller("terminal");

    expect(result.status).toBe(41);
    expect(result.count).toBe(1);
    expect(result.sleeps).toEqual([]);
    expect(result.configsWereRemoved).toBe(true);
    expect(result.stderr.trim()).toBe(
      "::error::GHCR anonymous exact-digest pull outcome=failed-no-retry attempt=1/7 docker-exit=41",
    );
    expect(result.stderr).not.toContain("unexpected Docker daemon failure");
  });

  it("fails after the bounded anonymous-unavailable retry schedule is exhausted", () => {
    const result = runPuller("exit-one-exhausted");

    expect(result.status).toBe(1);
    expect(result.count).toBe(7);
    expect(result.sleeps).toEqual(["2", "4", "8", "16", "30", "30"]);
    expect(new Set(result.configs).size).toBe(1);
    expect(result.configsWereRemoved).toBe(true);
    expect(result.stderr.trim().split("\n")).toEqual([
      ...retryWarnings,
      "::error::GHCR anonymous exact-digest pull outcome=exhausted attempt=7/7 failure=anonymous-unavailable",
    ]);
    expect(result.stderr).not.toContain("permission_denied");
    expect(result.stderr).not.toContain("manifest unknown");
    expect(result.stderr).not.toContain("anonymous HEAD request");
  });

  it("rejects a mutable or non-GHCR reference before Docker runs", () => {
    const result = runPuller("terminal", "docker.io/nvidia/nemoclaw:latest");

    expect(result.status).toBe(2);
    expect(result.count).toBe(0);
    expect(result.stderr).toContain("must be an exact lowercase GHCR digest");
  });
});
