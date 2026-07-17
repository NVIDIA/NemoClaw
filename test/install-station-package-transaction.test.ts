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
const EXPECTED_PACKAGE_SPECS = [
  "dkms=1:3.4.0-1ubuntu1",
  "nvidia-driver-pinning-610=610-2ubuntu1",
  "nvidia-driver-open=610.43.02-1ubuntu1",
  "containerd.io=2.2.6-1~ubuntu.24.04~noble",
  "docker-buildx-plugin=0.35.0-1~ubuntu.24.04~noble",
  "docker-ce=5:29.6.1-1~ubuntu.24.04~noble",
  "docker-ce-cli=5:29.6.1-1~ubuntu.24.04~noble",
  "libnvidia-container-tools=1.19.1-1",
  "libnvidia-container1=1.19.1-1",
  "nvidia-container-toolkit=1.19.1-1",
  "nvidia-container-toolkit-base=1.19.1-1",
];

function runSourced(body: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-package-transaction-"));
  const result = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-c", `source "$SCRIPT_UNDER_TEST" >/dev/null\n${body}`],
    {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: {
        HOME: home,
        PATH: TEST_SYSTEM_PATH,
        SCRIPT_UNDER_TEST: STATION_PREPARE,
      },
      timeout: 15_000,
      killSignal: "SIGKILL",
    },
  );
  return { result, output: `${result.stdout}${result.stderr}` };
}

describe("DGX Station package transaction", () => {
  it("passes the complete pinned tuple to availability, simulation, and install", () => {
    const { result, output } = runSourced(`
configure_repositories() { printf 'CONFIGURE_REPOSITORIES\n'; }
apt-cache() { printf 'APT_CACHE %s\n' "$*" >>"$HOME/apt-cache-calls"; }
apt-get() { printf 'APT_GET %s\n' "$*"; }
check_no_workloads() { printf 'RECHECK_ALL_WORKLOADS\n'; }
package_is_exact() { return 0; }
sudo() { printf 'SUDO %s\n' "$*"; }
install_packages
cat "$HOME/apt-cache-calls"
`);

    expect(result.status, output).toBe(0);
    const expectedTuple = EXPECTED_PACKAGE_SPECS.join(" ");
    const aptCommands = output
      .split("\n")
      .filter((line) =>
        /^(APT_CACHE show |APT_GET -s install |SUDO env .* apt-get install )/.test(line),
      )
      .sort();
    expect(aptCommands).toEqual(
      [
        ...EXPECTED_PACKAGE_SPECS.map((spec) => `APT_CACHE show ${spec}`),
        `APT_GET -s install --no-install-recommends ${expectedTuple}`,
        `SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${expectedTuple}`,
      ].sort(),
    );
    expect(output).toContain("RECHECK_ALL_WORKLOADS");
    expect(output).toContain("pinned_packages=installed");
  });
});
