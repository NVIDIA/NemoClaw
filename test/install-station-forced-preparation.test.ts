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

function runSourced(body: string, extraEnv: Record<string, string> = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-forced-"));
  const result = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-c", `source "$STATION_PREPARE" >/dev/null\n${body}`],
    {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: {
        HOME: home,
        PATH: TEST_SYSTEM_PATH,
        STATION_PREPARE,
        ...extraEnv,
      },
      timeout: 15_000,
      killSignal: "SIGKILL",
    },
  );
  return { result, output: `${result.stdout}${result.stderr}` };
}

describe("DGX Station forced-factory-runtime preparation", () => {
  it.each([
    ["ibacm.service"],
    ["rtkit-daemon.service"],
  ])("tolerates the unrelated failed unit %s (#7236)", (unit) => {
    const tolerated = runSourced(
      `
STATION_HOST_PROFILE=forced-factory-runtime
systemctl() { printf '${unit} loaded failed failed Unrelated\n'; }
check_failed_units
`,
    );
    expect(tolerated.result.status, tolerated.output).toBe(0);
    expect(tolerated.output).toMatch(
      new RegExp(`condition-qualified forced-factory-runtime failed unit: ${unit}`),
    );
  });

  it("still blocks unrelated and preparation-critical failed units (#7236)", () => {
    const unrelated = runSourced(
      `
STATION_HOST_PROFILE=forced-factory-runtime
systemctl() { printf 'ssh.service loaded failed failed SSH\n'; }
check_failed_units
`,
    );
    expect(unrelated.result.status, unrelated.output).not.toBe(0);
    expect(unrelated.output).toMatch(/unqualified failed unit: ssh.service/);
    expect(unrelated.output).toMatch(/Unqualified failed system units block Station preparation/);

    const critical = runSourced(
      `
STATION_HOST_PROFILE=forced-factory-runtime
systemctl() { printf 'containerd.service loaded failed failed containerd\n'; }
check_failed_units
`,
    );
    expect(critical.result.status, critical.output).not.toBe(0);
    expect(critical.output).toMatch(/failed preparation-critical unit: containerd.service/);
  });
});
