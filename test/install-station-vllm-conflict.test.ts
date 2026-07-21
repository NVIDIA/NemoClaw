// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { INSTALLER_PAYLOAD, TEST_SYSTEM_PATH } from "./helpers/installer-sourced-env";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

function runInstallerSourced(body: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-vllm-conflict-"));
  const result = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-c", `source "$INSTALLER_UNDER_TEST" >/dev/null\n${body}`],
    {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: {
        HOME: home,
        PATH: TEST_SYSTEM_PATH,
        INSTALLER_UNDER_TEST: INSTALLER_PAYLOAD,
      },
    },
  );
  return { result, output: `${result.stdout}${result.stderr}` };
}

describe("Station vLLM conflict output", () => {
  it("captures a sanitized stop command from the Station conflict (#7287)", () => {
    const { result, output } = runInstallerSourced(`
bash() {
  printf '%s\n' \
    "[station-prepare] 2026-07-17T07:59:20Z ERROR: vLLM inference workload is active: container_id=1234567890ab stop_command='docker stop -- 1234567890ab'."
  return 12
}
if run_station_host_preparation; then
  printf 'STATUS=0\n'
else
  printf 'STATUS=%s COMMAND=%s\n' "$?" "\${_STATION_VLLM_STOP_COMMAND:-}"
fi
`);

    expect(result.status, output).toBe(0);
    expect(output).toContain("STATUS=12 COMMAND=docker stop -- 1234567890ab");
  });

  it("rejects arbitrary stop-command text from the Station conflict (#7287)", () => {
    const { result, output } = runInstallerSourced(`
bash() {
  printf '%s\n' \
    "[station-prepare] 2026-07-17T07:59:20Z ERROR: vLLM inference workload is active: stop_command='docker stop -- container; unsafe-command'."
  return 12
}
if run_station_host_preparation; then
  printf 'STATUS=0\n'
else
  printf 'STATUS=%s COMMAND=%s\n' "$?" "\${_STATION_VLLM_STOP_COMMAND:-}"
fi
`);

    expect(result.status, output).toBe(0);
    expect(output).toContain("STATUS=12 COMMAND=");
    expect(output).not.toContain("COMMAND=docker stop");
  });
});
