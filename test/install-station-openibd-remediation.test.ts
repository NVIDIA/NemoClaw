// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TEST_SYSTEM_PATH } from "./helpers/installer-sourced-env";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const STATION_PREPARE = path.join(REPO_ROOT, "scripts", "prepare-dgx-station-host.sh");

function checkFailedUnit(unit: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-openibd-"));
  const result = spawnSync(
    "bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      `
source "$SCRIPT_UNDER_TEST" >/dev/null
systemctl() {
  if [[ "$*" != "--failed --no-legend --plain" ]]; then
    printf 'unexpected systemctl call: %s\\n' "$*" >&2
    exit 97
  fi
  printf '%s loaded failed failed fixture\\n' "$FAILED_UNIT"
}
check_failed_units
`,
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: {
        HOME: home,
        PATH: TEST_SYSTEM_PATH,
        SCRIPT_UNDER_TEST: STATION_PREPARE,
        FAILED_UNIT: unit,
      },
      timeout: 15_000,
      killSignal: "SIGKILL",
    },
  );
  return { result, output: `${result.stdout}${result.stderr}` };
}

describe("DGX Station OpenIB remediation", () => {
  it("explains how owners can resolve a failed OpenIB service without changing it (#7151)", () => {
    const openibd = checkFailedUnit("openibd.service");

    expect(openibd.result.error, openibd.output).toBeUndefined();
    expect(openibd.result.status, openibd.output).toBe(1);
    expect(openibd.output).toMatch(/unqualified failed unit: openibd.service/);
    expect(openibd.output).toMatch(/NemoClaw does not require RDMA/);
    expect(openibd.output).toMatch(/ip route get 1\.1\.1\.1/);
    expect(openibd.output).toMatch(/findmnt -rn -t nfs,nfs4 -o TARGET,OPTIONS/);
    expect(openibd.output).toMatch(/checks are not exhaustive/);
    expect(openibd.output).toMatch(/sudo systemctl disable openibd.service/);
    expect(openibd.output).toMatch(/repair OpenIB\/OFED/);
    expect(openibd.output).toMatch(/NemoClaw did not change systemd or networking state/);
    expect(openibd.output).toMatch(/Unqualified failed system units block Station preparation/);
  });

  it("keeps unrelated failed units on the generic fail-closed path (#7151)", () => {
    const unrelated = checkFailedUnit("ssh.service");

    expect(unrelated.result.error, unrelated.output).toBeUndefined();
    expect(unrelated.result.status, unrelated.output).toBe(1);
    expect(unrelated.output).toMatch(/unqualified failed unit: ssh.service/);
    expect(unrelated.output).not.toMatch(/NemoClaw does not require RDMA/);
    expect(unrelated.output).not.toMatch(/sudo systemctl disable openibd.service/);
    expect(unrelated.output).toMatch(/Unqualified failed system units block Station preparation/);
  });
});
