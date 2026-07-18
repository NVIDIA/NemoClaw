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

  it("allows generic verification to preserve a stopped container baseline (#7153)", () => {
    const { result, output } = runStationPreparation(
      `
DOCKER_BASELINE_CAPTURED=1
DOCKER_CONTAINER_BASELINE='aaaaaaaaaaaaaaaaaaaaaaaa'
DOCKER_CONTAINER_BASELINE_TOTAL=1
package_is_exact() { return 0; }
verify_gpu() { :; }
systemctl() { return 0; }
verify_cdi_refresh_lifecycle() { :; }
id() { printf 'operator docker\n'; }
nvidia-ctk() {
  case "$*" in
    'cdi list') printf 'nvidia.com/gpu=all\n' ;;
    '--version') printf 'NVIDIA Container Toolkit CLI version 1.19.1\n' ;;
    *) return 1 ;;
  esac
}
run_cdi_test_user() { return 0; }
run_gpus_test_user() { return 0; }
docker() {
  case "$*" in
    'info') return 0 ;;
    'image inspect '*) return 0 ;;
    'ps -aq --no-trunc') printf 'aaaaaaaaaaaaaaaaaaaaaaaa\n' ;;
    'version --format {{.Server.Version}}') printf '29.6.1\n' ;;
    *) return 1 ;;
  esac
}
verify_host
`,
      { USER: "operator" },
    );

    expect(result.status, output).toBe(0);
    expect(output).toContain("docker_container_baseline=preserved total=1");
    expect(output).toContain("STATION_HOST_READY");
  });

  it("fails closed before mutation when container inventory changes after baseline capture (#7153)", () => {
    const { result, output } = runStationPreparation(`
ps() { printf '%s %s bash bash prepare-dgx-station-host.sh --apply\n' "$$" "$PPID"; }
ss() { :; }
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
require_docker_mutation_quiescence "refreshing NVIDIA CDI configuration"
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

  it("rechecks running containers after restart-policy inspection (#7153)", () => {
    const { result, output } = runStationPreparation(`
DOCKER_BASELINE_CAPTURED=1
DOCKER_CONTAINER_BASELINE='aaaaaaaaaaaaaaaaaaaaaaaa'
DOCKER_CONTAINER_BASELINE_TOTAL=1
ps() { printf '%s %s bash bash prepare-dgx-station-host.sh --apply\n' "$$" "$PPID"; }
ss() { :; }
docker() {
  local running_checks
  case "$*" in
    'ps -aq --no-trunc') printf 'aaaaaaaaaaaaaaaaaaaaaaaa\n' ;;
    'ps --format {{.ID}} {{.Names}}')
      running_checks="$(cat "$HOME/running-checks" 2>/dev/null || printf '0')"
      running_checks=$((running_checks + 1))
      printf '%s' "$running_checks" >"$HOME/running-checks"
      if ((running_checks > 1)); then
        printf 'aaaaaaaaaaaa background-job\n'
      fi
      ;;
    'inspect --format {{.Id}} {{.Name}} {{.State.Running}} {{.HostConfig.RestartPolicy.Name}} aaaaaaaaaaaaaaaaaaaaaaaa')
      printf 'aaaaaaaaaaaaaaaaaaaaaaaa /background-job true no\n'
      ;;
    *) return 1 ;;
  esac
}
require_docker_restart_quiescence "restarting Docker"
`);

    expect(result.status, output).not.toBe(0);
    expect(output).toMatch(/Running Docker containers block restarting Docker/);
    expect(output).toContain("background-job");
  });

  it("does not restart Docker during rollback after quiescence is lost (#7153)", () => {
    const { result, output } = runStationPreparation(`
root_regular_file_is_safe() { return 0; }
require_docker_restart_quiescence() {
  printf 'ROLLBACK_RESTART_BLOCKED\n'
  return 1
}
sudo() { printf 'SUDO %s\n' "$*"; }
rollback_docker_runtime_config /var/backups/station-bootstrap/docker-runtime.TEST 0 1
`);

    expect(result.status, output).not.toBe(0);
    expect(output).toContain("ROLLBACK_RESTART_BLOCKED");
    expect(output).toContain("SUDO rm -f -- /etc/docker/daemon.json");
    expect(output).not.toContain("systemctl restart docker.service");
  });

  it("does not apply restart-policy blocking when runtime services are already active (#7153)", () => {
    const { result, output } = runStationPreparation(`
systemctl() { return 0; }
require_docker_mutation_quiescence() { printf 'MUTATION_QUIESCENCE\n'; }
require_docker_restart_quiescence() {
  printf 'UNEXPECTED_RESTART_QUIESCENCE\n'
  return 1
}
sudo() { printf 'SUDO %s\n' "$*"; }
ensure_docker_group() { :; }
ensure_acceptance_image() { :; }
ensure_cdi_runtime() { :; }
configure_docker_runtime_if_needed() { :; }
verify_docker_container_baseline() { :; }
finish_runtime
`);

    expect(result.status, output).toBe(0);
    expect(output).toContain("MUTATION_QUIESCENCE");
    expect(output).toContain("systemctl enable --now containerd.service docker.service");
    expect(output).not.toContain("UNEXPECTED_RESTART_QUIESCENCE");
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
