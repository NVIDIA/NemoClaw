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

function runStationPreparation(body: string, extraEnv: Record<string, string> = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-containers-"));
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

describe("DGX Station Docker container coexistence", () => {
  it("uses sudo to inspect containers during apply until Docker group access is active", () => {
    const { result, output } = runStationPreparation(
      `
MODE='--apply'
ps() { printf '%s %s bash bash prepare-dgx-station-host.sh --apply\n' "$$" "$PPID"; }
ss() { :; }
docker() { return 1; }
sudo() {
  if [[ "$1" == "-n" ]]; then shift; fi
  case "$*" in
    'docker ps -aq --no-trunc'|'docker ps -q --no-trunc') return 0 ;;
    *) return 1 ;;
  esac
}
systemctl() { return 0; }
capture_docker_container_baseline
`,
      { PATH: `${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}` },
    );

    expect(result.status, output).toBe(0);
    expect(output).toContain("docker_access=sudo_until_group_membership_is_active");
    expect(output).toContain("docker_container_baseline_total=0 running=0");
  });

  it("fails closed when Docker is installed but its container state cannot be queried", () => {
    const { result, output } = runStationPreparation(
      `
MODE='--apply'
ps() { printf '%s %s bash bash prepare-dgx-station-host.sh --apply\n' "$$" "$PPID"; }
ss() { :; }
docker() { return 1; }
sudo() { return 1; }
systemctl() { return 1; }
capture_docker_container_baseline
`,
      { PATH: `${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}` },
    );

    expect(result.status, output).not.toBe(0);
    expect(output).toMatch(/container state cannot be verified safely/);
  });

  it("captures and preserves the pre-existing container baseline (#7153)", () => {
    const { result, output } = runStationPreparation(`
docker() {
  case "$*" in
    'ps -aq --no-trunc') printf 'bbbbbbbbbbbb\naaaaaaaaaaaa\n' ;;
    'ps -q --no-trunc') return 0 ;;
    'ps --format {{.ID}} {{.Names}}') return 0 ;;
    *) return 1 ;;
  esac
}
capture_docker_container_baseline
require_no_running_docker_containers "initial Station host preparation"
verify_docker_container_baseline
`);

    expect(result.status, output).toBe(0);
    expect(output).toContain("docker_container_baseline_total=2 running=0");
    expect(output).toContain("Existing Docker container records will be preserved");
    expect(output).toContain("docker_container_baseline=preserved total=2");
  });

  it("fails closed when container inventory changes after baseline capture (#7153)", () => {
    const { result, output } = runStationPreparation(`
docker() {
  case "$*" in
    'ps -aq --no-trunc')
      if [[ -e "$HOME/inventory-changed" ]]; then
        printf 'aaaaaaaaaaaa\ncccccccccccc\n'
      else
        printf 'aaaaaaaaaaaa\n'
      fi
      ;;
    'ps -q --no-trunc') return 0 ;;
    *) return 1 ;;
  esac
}
capture_docker_container_baseline
touch "$HOME/inventory-changed"
verify_docker_container_baseline
`);

    expect(result.status, output).not.toBe(0);
    expect(output).toMatch(/container inventory changed during Station preparation/);
    expect(output).toContain("before=1, after=2");
  });

  it("blocks a running container at a Docker mutation boundary (#7153)", () => {
    const { result, output } = runStationPreparation(`
docker() {
  [[ "$*" == "ps --format {{.ID}} {{.Names}}" ]] || return 1
  printf 'abc123def456 active-nim\n'
}
require_no_running_docker_containers "configuring the NVIDIA Docker runtime"
`);

    expect(result.status, output).not.toBe(0);
    expect(output).toMatch(/Running Docker containers block configuring the NVIDIA Docker runtime/);
    expect(output).toContain("abc123def456 active-nim");
  });

  it("blocks daemon restart when a stopped container may automatically restart (#7153)", () => {
    const { result, output } = runStationPreparation(`
docker() {
  case "$*" in
    'ps -aq --no-trunc') printf 'aaaaaaaaaaaaaaaaaaaaaaaa\n' ;;
    'inspect --format {{.Id}} {{.Name}} {{.State.Running}} {{.HostConfig.RestartPolicy.Name}} aaaaaaaaaaaaaaaaaaaaaaaa')
      printf 'aaaaaaaaaaaaaaaaaaaaaaaa /background-job false unless-stopped\n'
      ;;
    *) return 1 ;;
  esac
}
require_no_autorestarting_stopped_containers "restarting Docker"
`);

    expect(result.status, output).not.toBe(0);
    expect(output).toMatch(/Stopped containers with restart policies block restarting Docker/);
    expect(output).toContain("background-job restart=unless-stopped");
  });

  it("permits a stopped container with restart policy no (#7153)", () => {
    const { result, output } = runStationPreparation(`
docker() {
  case "$*" in
    'ps -aq --no-trunc') printf 'aaaaaaaaaaaaaaaaaaaaaaaa\n' ;;
    'inspect --format {{.Id}} {{.Name}} {{.State.Running}} {{.HostConfig.RestartPolicy.Name}} aaaaaaaaaaaaaaaaaaaaaaaa')
      printf 'aaaaaaaaaaaaaaaaaaaaaaaa /archived-job false no\n'
      ;;
    *) return 1 ;;
  esac
}
require_no_autorestarting_stopped_containers "restarting Docker"
`);

    expect(result.status, output).toBe(0);
    expect(output).toContain("autorestarting_stopped_containers=none action=restarting Docker");
  });
});
