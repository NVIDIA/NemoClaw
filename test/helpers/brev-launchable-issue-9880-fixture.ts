// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const SCRIPT = path.join(REPO_ROOT, "tools/e2e/brev-launchable-issue-9880.sh");
const roots: string[] = [];

function executable(file: string, source: string): void {
  fs.writeFileSync(file, source, { mode: 0o755 });
}

export function cleanupIssue9880Fixtures(): void {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
}

export function issue9880Fixture(): {
  calls: string;
  env: NodeJS.ProcessEnv;
  run: (overrides?: NodeJS.ProcessEnv, args?: string[]) => ReturnType<typeof spawnSync>;
  state: string;
  workDir: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-issue-9880-"));
  roots.push(root);
  const bin = path.join(root, "bin");
  const calls = path.join(root, "calls.log");
  const state = path.join(root, "workspace.json");
  const workDir = path.join(root, "evidence");
  fs.mkdirSync(bin);
  fs.mkdirSync(workDir);

  executable(
    path.join(bin, "timeout"),
    String.raw`#!/usr/bin/env bash
set -euo pipefail
signal=""
if [ "${"$"}{1:-}" = --signal=KILL ]; then signal="--signal=KILL "; shift; fi
duration="$1"
shift
printf 'timeout %s%s %s\n' "$signal" "$duration" "$*" >> "$FAKE_CALLS"
if [ "${"$"}{FAKE_BLOCK_COMMAND:-}" = "brev refresh" ] && [ "${"$"}{1:-} ${"$"}{2:-}" = "brev refresh" ]; then
  /bin/sleep "${"$"}{duration%s}"
  exit 124
fi
if [ "${"$"}{FAKE_BLOCK_COMMAND:-}" = ssh ] && [ "${"$"}{1:-}" = ssh ]; then
  /bin/sleep "${"$"}{duration%s}"
  exit 124
fi
exec "$@"
`,
  );
  executable(
    path.join(bin, "sleep"),
    String.raw`#!/usr/bin/env bash
printf 'sleep %s\n' "$1" >> "$FAKE_CALLS"
/bin/sleep "$1"
`,
  );
  executable(
    path.join(bin, "ssh"),
    String.raw`#!/usr/bin/env bash
printf 'ssh %s\n' "$*" >> "$FAKE_CALLS"
exit 34
`,
  );
  executable(
    path.join(bin, "brev"),
    String.raw`#!/usr/bin/env bash
set -euo pipefail
printf 'brev %s\n' "$*" >> "$FAKE_CALLS"
case "${"$"}{1:-}" in
  ls)
    if [ -f "$FAKE_STATE" ]; then
      printf '{"workspaces":['; cat "$FAKE_STATE"; printf ']}\n'
    else
      printf '{"workspaces":[]}\n'
    fi ;;
  create)
    printf '%s\n' '{"name":"issue-9880-test","id":"ws-1","status":"RUNNING","shell_status":"READY","build_status":"COMPLETED"}' > "$FAKE_STATE" ;;
  refresh) exit 0 ;;
  delete) rm -f "$FAKE_STATE" ;;
  *) exit 2 ;;
esac
`,
  );
  executable(
    path.join(bin, "gh"),
    String.raw`#!/usr/bin/env bash
set -euo pipefail
printf 'gh %s\n' "$*" >> "$FAKE_CALLS"
if [ "${"$"}{1:-}" = api ]; then
  printf '%s\n' '{"workflow_runs":[{"id":123,"display_title":"Build Launchable E2E image for NemoClaw test","created_at":"2026-08-23T00:00:00Z"}]}'
elif [ "${"$"}{1:-} ${"$"}{2:-}" = 'run download' ]; then
  directory=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = --dir ]; then shift; directory="$1"; fi
    shift
  done
  mkdir -p "$directory"
  printf '%s\n' '{"schemaVersion":1,"kind":"nemoclaw-exact-image-manifest","imageRepository":"brevdev/nemoclaw-image","producerWorkflow":".github/workflows/build-launchable-e2e-image.yml","workflowRunId":"123","workflowRunAttempt":1,"status":"READY","channel":"staging","variant":"cpu","observedFamily":"nemoclaw-brev-staging-cpu","project":"brevdevprod","imageName":"nemoclaw-test-image","nemoclawSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","imageRepositorySha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}' > "$directory/nemoclaw-image-manifest.v1.json"
else
  exit 2
fi
`,
  );

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    BREV_LAUNCHABLE_ID: "env-staging123",
    FAKE_BLOCK_COMMAND: "",
    FAKE_CALLS: calls,
    FAKE_STATE: state,
    GH_TOKEN: "github-test-token",
    INSTANCE_NAME: "issue-9880-test",
    NVIDIA_API_KEY: "nvapi-test-value",
    POLL_SECONDS: "1",
    RUNNER_TEMP: root,
    WORK_DIR: workDir,
  };

  return {
    calls,
    env,
    state,
    workDir,
    run: (overrides = {}, args = []) =>
      spawnSync("bash", [SCRIPT, ...args], {
        encoding: "utf8",
        env: { ...env, ...overrides },
        timeout: 20_000,
      }),
  };
}
