// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  clearStationExpressInstallerResume,
  withStationExpressResumeEnvironment,
} from "../src/lib/onboard/station-express-resume";
import { INSTALLER_PAYLOAD, TEST_SYSTEM_PATH } from "./helpers/installer-sourced-env";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const PUBLIC_BOOTSTRAP = path.join(REPO_ROOT, "install.sh");
const STATION_PREPARE = path.join(REPO_ROOT, "scripts", "prepare-dgx-station-host.sh");
const STATION_REVISION = "a".repeat(40);
const STATION_GENERATION = "0123456789abcdef0123456789abcdef";

function runSourced(script: string, body: string, extraEnv: Record<string, string> = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-host-"));
  const result = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-c", `source "$SCRIPT_UNDER_TEST" >/dev/null\n${body}`],
    {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: {
        HOME: home,
        PATH: TEST_SYSTEM_PATH,
        SCRIPT_UNDER_TEST: script,
        ...extraEnv,
      },
      timeout: 15_000,
      killSignal: "SIGKILL",
    },
  );
  return { home, result, output: `${result.stdout}${result.stderr}` };
}

function runNonInteractiveStationSelector(home: string) {
  const result = spawnSync(
    "bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      `
source "$INSTALLER_UNDER_TEST" >/dev/null
detect_express_platform() { printf 'DGX Station'; }
station_installer_revision() { printf '${STATION_REVISION}'; }
NON_INTERACTIVE='1'
NEMOCLAW_PROVIDER=''
NEMOCLAW_NO_EXPRESS=''
maybe_offer_express_install
printf 'RESULT PROVIDER=%s STATION_EXPRESS=%s\n' "\${NEMOCLAW_PROVIDER:-}" "\${NEMOCLAW_STATION_EXPRESS:-}"
`,
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: {
        HOME: home,
        PATH: TEST_SYSTEM_PATH,
        INSTALLER_UNDER_TEST: INSTALLER_PAYLOAD,
      },
      timeout: 15_000,
      killSignal: "SIGKILL",
    },
  );
  return { result, output: `${result.stdout}${result.stderr}` };
}

describe("DGX Station host preparation", () => {
  it("uses the documented plain-Ubuntu probe and verifies the GB300 row", () => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
STATION_HOST_PROFILE=generic-ubuntu
station_pci_device_is_gb300() { return 0; }
sudo() {
  printf 'SUDO %s\\n' "$*" >&2
  printf '00000000:01:00.0, NVIDIA GB300, 610.43.02, 0, 0\\n'
}
run_cdi_test_sudo
run_gpus_test_sudo
`,
    );

    const image =
      "docker.io/library/ubuntu@sha256:7f622ca8766bccb22f04242ecb6f19f770b2f08827dc4b8c707de5e78a6da7ab";
    expect(result.status, output).toBe(0);
    expect(output).toContain(
      `SUDO docker run --rm --device nvidia.com/gpu=all ${image} nvidia-smi --query-gpu=`,
    );
    expect(output).toContain(`SUDO docker run --rm --gpus all ${image} nvidia-smi --query-gpu=`);
    expect(output).toContain("gpu_bdf=0000:01:00.0 gpu=NVIDIA GB300 role=inference");
  });

  it("allows only condition-qualified factory failures and blocks other failed units", () => {
    const qualified = runSourced(
      STATION_PREPARE,
      `
systemctl() { printf 'cloud-init.service loaded failed failed Cloud init\n'; }
cloud_init_failure_is_qualified() { return 0; }
check_failed_units
`,
    );
    expect(qualified.result.status, qualified.output).toBe(0);
    expect(qualified.output).toMatch(
      /condition-qualified generic-image failed unit: cloud-init.service/,
    );

    const unrelated = runSourced(
      STATION_PREPARE,
      `
systemctl() { printf 'ssh.service loaded failed failed SSH\n'; }
check_failed_units
`,
    );
    expect(unrelated.result.status, unrelated.output).not.toBe(0);
    expect(unrelated.output).toMatch(/unqualified failed unit: ssh.service/);
    expect(unrelated.output).toMatch(/Unqualified failed system units block Station preparation/);

    const critical = runSourced(
      STATION_PREPARE,
      `
systemctl() { printf 'docker.service loaded failed failed Docker\n'; }
check_failed_units
`,
    );
    expect(critical.result.status, critical.output).not.toBe(0);
    expect(critical.output).toMatch(/failed preparation-critical unit: docker.service/);
  });

  it("qualifies network-wait failures only after current network health is established", () => {
    const healthy = runSourced(
      STATION_PREPARE,
      `
NETWORK_VALIDATED=1
systemctl() {
  case "$*" in
    'is-active --quiet NetworkManager.service'|'is-active --quiet network-online.target') return 0 ;;
    *) return 1 ;;
  esac
}
network_wait_failure_is_qualified
`,
    );
    expect(healthy.result.status, healthy.output).toBe(0);

    const unvalidated = runSourced(
      STATION_PREPARE,
      `
NETWORK_VALIDATED=0
systemctl() { return 0; }
network_wait_failure_is_qualified
`,
    );
    expect(unvalidated.result.status, unvalidated.output).not.toBe(0);

    const inactiveManager = runSourced(
      STATION_PREPARE,
      `
NETWORK_VALIDATED=1
systemctl() { return 1; }
network_wait_failure_is_qualified
`,
    );
    expect(inactiveManager.result.status, inactiveManager.output).not.toBe(0);
  });

  it("qualifies only the pinned OEM cloud-init bootcmd failure", () => {
    const qualified = runSourced(
      STATION_PREPARE,
      `
NETWORK_VALIDATED=1
stat() { printf 'regular file|0|0|755\n'; }
sha256sum() { printf '%s  %s\n' "$FACTORY_CLOUD_INIT_TELEMETRY_SHA256" "$1"; }
grep() { return 0; }
cloud_init_failure_is_qualified
`,
    );
    expect(qualified.result.status, qualified.output).toBe(0);

    const changedTelemetry = runSourced(
      STATION_PREPARE,
      `
NETWORK_VALIDATED=1
stat() { printf 'regular file|0|0|755\n'; }
sha256sum() { printf '%064d  %s\n' 0 "$1"; }
grep() { return 0; }
cloud_init_failure_is_qualified
`,
    );
    expect(changedTelemetry.result.status, changedTelemetry.output).not.toBe(0);

    const unsafeEvidence = runSourced(
      STATION_PREPARE,
      `
NETWORK_VALIDATED=1
stat() { printf 'regular file|0|0|777\n'; }
sha256sum() { printf '%s  %s\n' "$FACTORY_CLOUD_INIT_TELEMETRY_SHA256" "$1"; }
grep() { return 0; }
cloud_init_failure_is_qualified
`,
    );
    expect(unsafeEvidence.result.status, unsafeEvidence.output).not.toBe(0);
  });

  it("requires exact conditions for auxiliary factory-image failures", () => {
    const maskedFwupd = runSourced(
      STATION_PREPARE,
      `
NETWORK_VALIDATED=1
systemctl() { printf 'masked\n'; }
fwupd_refresh_failure_is_qualified
`,
    );
    expect(maskedFwupd.result.status, maskedFwupd.output).toBe(0);

    const enabledFwupd = runSourced(
      STATION_PREPARE,
      `
NETWORK_VALIDATED=1
systemctl() { printf 'enabled\n'; }
fwupd_refresh_failure_is_qualified
`,
    );
    expect(enabledFwupd.result.status, enabledFwupd.output).not.toBe(0);

    const exactUnits = runSourced(
      STATION_PREPARE,
      `
cloud_init_failure_is_qualified() { return 0; }
network_wait_failure_is_qualified() { return 0; }
fwupd_refresh_failure_is_qualified() { return 0; }
sssd_socket_failure_is_qualified() { return 0; }
for unit in \
  cloud-init.service \
  NetworkManager-wait-online.service \
  systemd-networkd-wait-online.service \
  fwupd-refresh.service \
  sssd-autofs.socket \
  sssd-nss.socket \
  sssd-pam.socket \
  sssd-pam-priv.socket; do
  is_qualified_factory_failed_unit "$unit" || exit 1
done
is_qualified_factory_failed_unit ssh.service && exit 1
exit 0
`,
    );
    expect(exactUnits.result.status, exactUnits.output).toBe(0);
  });

  it("discloses Docker-group root-equivalent access before Station express consent", () => {
    const { result, output } = runSourced(
      INSTALLER_PAYLOAD,
      `
STATION_DEEPSEEK=0
NEMOCLAW_VLLM_MODEL=''
describe_express_install 'DGX Station'
`,
    );

    expect(result.status, output).toBe(0);
    expect(output).toContain("docker group, which grants root-equivalent control");
    expect(output).toContain("only for trusted single-user development hosts");
    expect(output).toContain(
      "shared or managed hosts require an organization-approved Docker access path",
    );
  });

  it("fails closed when failed-service inspection is unavailable", () => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
systemctl() { return 1; }
check_failed_units
`,
    );

    expect(result.status, output).not.toBe(0);
    expect(output).toMatch(/Unable to inspect failed system services/);
  });

  it("reuses exact packages and proceeds directly to runtime probes", () => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
common_preflight() { :; }
require_command() { :; }
acquire_sudo() { :; }
all_packages_ready() { return 0; }
install_boot_marker_matches_current_boot() { return 1; }
driver_loaded_exact() { return 0; }
install_packages() { printf 'INSTALL_PACKAGES\n'; }
finish_runtime() { printf 'FINISH_RUNTIME\n'; }
verify_apply_state() { printf 'VERIFY_APPLY_STATE\n'; }
run_apply
`,
    );

    expect(result.status, output).toBe(0);
    expect(output).toContain("FINISH_RUNTIME");
    expect(output).toContain("VERIFY_APPLY_STATE");
    expect(output).not.toContain("INSTALL_PACKAGES");
    expect(output).toContain("APPLY_RESULT=COMPLETE");
  });

  it("applies the reviewed factory DKMS transition and returns the reboot-required contract", () => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
common_preflight() { :; }
require_command() { :; }
acquire_sudo() { :; }
all_packages_ready() { return 1; }
installed_package_record() {
  if [[ "$1" == "dkms" ]]; then printf 'ii |all|3.0.11-1ubuntu13'; else return 1; fi
}
installed_version() { if [[ "$1" == "dkms" ]]; then printf '3.0.11-1ubuntu13'; fi; }
install_packages() { printf 'INSTALL_PACKAGES\n'; }
ensure_docker_group() { printf 'ENSURE_DOCKER_GROUP\n'; }
require_docker_restart_quiescence() { printf 'RECHECK_RESTART_QUIESCENCE\n'; }
write_install_boot_marker() { printf 'WRITE_BOOT_MARKER\n'; }
sudo() { printf 'SUDO %s\n' "$*"; }
run_apply
`,
    );

    expect(result.status, output).toBe(10);
    expect(output).toContain("package=dkms status=approved_transition");
    expect(output).toContain("INSTALL_PACKAGES");
    expect(output).toContain("ENSURE_DOCKER_GROUP");
    expect(output).toContain("RECHECK_RESTART_QUIESCENCE");
    expect(output).toContain("WRITE_BOOT_MARKER");
    expect(output).toContain(
      "systemctl enable containerd.service docker.service nvidia-cdi-refresh.path nvidia-cdi-refresh.service",
    );
    expect(output).toContain("APPLY_RESULT=REBOOT_REQUIRED");
  });

  it("installs the exact NVIDIA Container Toolkit package contract", () => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
configure_repositories() { printf 'CONFIGURE_REPOSITORIES\n'; }
validate_package_availability() { printf 'VALIDATE_PACKAGES\n'; }
simulate_install() { printf 'SIMULATE_INSTALL\n'; }
require_docker_restart_quiescence() { printf 'RECHECK_RESTART_QUIESCENCE\n'; }
package_state() { printf 'missing\n'; }
package_is_ready() { return 0; }
package_is_exact() { return 0; }
assert_package_transaction_ready() { printf 'PACKAGE_TRANSACTION_READY %s\n' "$1"; }
check_dpkg_database_health() { printf 'DPKG_AUDIT_CLEAN\n'; }
create_apt_transaction_guard() {
  APT_TRANSACTION_GUARD_DIR=/run/nemoclaw-apt-transaction.TEST
  APT_TRANSACTION_HOOK="/bin/bash $APT_TRANSACTION_GUARD_DIR/verify-plan"
}
cleanup_apt_transaction_guard() { :; }
sudo() { printf 'SUDO %s\n' "$*"; }
install_packages
`,
    );

    expect(result.status, output).toBe(0);
    expect(output).toContain("apt-get update");
    expect(output).toContain("apt-get install -y --no-install-recommends");
    expect(output).toContain("RECHECK_RESTART_QUIESCENCE");
    for (const spec of [
      "libnvidia-container-tools=1.19.1-1",
      "libnvidia-container1=1.19.1-1",
      "nvidia-container-toolkit=1.19.1-1",
      "nvidia-container-toolkit-base=1.19.1-1",
    ]) {
      expect(output).toContain(spec);
    }
    expect(output).toContain("prerequisite_packages=ready");
  });
  it("does not refresh CDI when the GPU launch probe already passes", () => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
require_docker_mutation_quiescence() { printf 'RECHECK_MUTATION_QUIESCENCE\n'; }
sudo() { printf 'SUDO %s\n' "$*"; }
run_cdi_test_sudo() { printf 'CDI_TEST\n'; return 0; }
refresh_cdi() { printf 'REFRESH_CDI\n'; }
ensure_cdi_runtime
`,
    );

    expect(result.status, output).toBe(0);
    expect(output).toContain("RECHECK_MUTATION_QUIESCENCE");
    expect(output).toContain("systemctl enable nvidia-cdi-refresh.path nvidia-cdi-refresh.service");
    expect(output).toContain("systemctl start nvidia-cdi-refresh.path");
    expect(output).toContain("cdi_contract=pass_without_configuration_change");
    expect(output).not.toContain("REFRESH_CDI");
  });

  it("refreshes CDI once when the initial GPU launch probe fails", () => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
calls=0
ensure_cdi_refresh_lifecycle() { printf 'ENSURE_CDI_LIFECYCLE\n'; }
run_cdi_test_sudo() {
  calls=$((calls + 1))
  printf 'CDI_TEST_%s\n' "$calls"
  [[ "$calls" -gt 1 ]]
}
refresh_cdi() { printf 'REFRESH_CDI\n'; }
ensure_cdi_runtime
`,
    );

    expect(result.status, output).toBe(0);
    expect(output).toContain("CDI_TEST_1");
    expect(output).toContain("ENSURE_CDI_LIFECYCLE");
    expect(output).toContain("REFRESH_CDI");
    expect(output).toContain("CDI_TEST_2");
    expect(output).toContain("cdi_contract=pass_after_refresh");
  });

  it("ignores the installer process while still blocking a real vLLM workload", () => {
    const selfOnly = runSourced(
      STATION_PREPARE,
      `
ps() {
  printf '%s %s bash bash /tmp/NemoClaw/scripts/prepare-dgx-station-host.sh --apply\n' "$$" "$PPID"
  printf '%s 1 bash bash /tmp/NemoClaw/scripts/install.sh\n' "$PPID"
}
ss() { :; }
check_agent_and_inference_conflicts
`,
    );
    expect(selfOnly.result.status, selfOnly.output).toBe(0);

    const active = runSourced(
      STATION_PREPARE,
      `
ps() { printf '999 1 python python -m vllm serve model\n'; }
ss() { :; }
check_agent_and_inference_conflicts
`,
    );
    expect(active.result.status, active.output).not.toBe(0);
    expect(active.output).toMatch(/Agent or inference workload is active/);
  });

  it("refuses an installed CUDA keyring version that differs from the pin", () => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
assert_root_directory_safe() { :; }
installed_package_record() { printf 'ii |all|2.0-1'; }
installed_version() { printf '2.0-1'; }
ensure_cuda_keyring "$HOME/cuda-keyring.deb"
`,
    );

    expect(result.status, output).not.toBe(0);
    expect(output).toMatch(/refusing to upgrade or downgrade it automatically/);
  });

  it("reuses an exact verified CUDA keyring without downloading it again", () => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
assert_root_directory_safe() { :; }
assert_root_regular_file_safe() { :; }
installed_package_record() { printf 'ii |all|1.1-1'; }
dpkg() { :; }
curl() { printf 'DOWNLOAD\n'; }
sudo() { "$@"; }
verify_key_fingerprint() { printf 'VERIFIED_FINGERPRINT\n'; }
ensure_cuda_keyring "$HOME/cuda-keyring.deb"
`,
    );

    expect(result.status, output).toBe(0);
    expect(output).toContain("cuda_keyring=exact version=1.1-1");
    expect(output).toContain("VERIFIED_FINGERPRINT");
    expect(output).not.toContain("DOWNLOAD");
  });

  it("reuses exact repository files and refuses to overwrite mismatched content", () => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
printf 'validated\n' >"$HOME/source"
cp "$HOME/source" "$HOME/target"
assert_root_directory_safe() { :; }
assert_root_regular_file_safe() { :; }
sudo() { "$@"; }
install_exact_file_or_reuse "$HOME/source" "$HOME/target" 0644 test_repository_file
printf 'modified\n' >"$HOME/target"
install_exact_file_or_reuse "$HOME/source" "$HOME/target" 0644 test_repository_file
`,
    );

    expect(result.status, output).not.toBe(0);
    expect(output).toMatch(/test_repository_file=exact/);
    expect(output).toMatch(/refusing to overwrite/);
  });

  it("rejects privileged files with unsafe ownership, mode, type, or parent metadata", () => {
    for (const metadata of ["1000 0 644", "0 0 666"]) {
      const { result, output } = runSourced(
        STATION_PREPARE,
        `
sudo() {
  if [[ "$1" == "test" ]]; then return 0; fi
  if [[ "$1" == "stat" ]]; then printf '%s\n' "$ROOT_METADATA"; return 0; fi
  return 1
}
assert_root_regular_file_safe /etc/example 0644 test_file
`,
        { ROOT_METADATA: metadata },
      );
      expect(result.status, output).not.toBe(0);
      expect(output).toMatch(/root-owned regular file/);
    }

    const unsafeType = runSourced(
      STATION_PREPARE,
      `
sudo() {
  [[ "$*" == "test ! -L /etc/example" ]] && return 0
  [[ "$*" == "test -f /etc/example" ]] && return 1
  return 1
}
assert_root_regular_file_safe /etc/example 0644 test_file
`,
    );
    expect(unsafeType.result.status, unsafeType.output).not.toBe(0);
    expect(unsafeType.output).toMatch(/root-owned regular file/);

    const unsafeParent = runSourced(
      STATION_PREPARE,
      `
sudo() {
  if [[ "$1" == "test" ]]; then return 0; fi
  if [[ "$1" == "stat" ]]; then printf '0 0 777\n'; return 0; fi
  return 1
}
assert_root_directory_safe /etc/apt/keyrings test_directory
`,
    );
    expect(unsafeParent.result.status, unsafeParent.output).not.toBe(0);
    expect(unsafeParent.output).toMatch(/not group- or other-writable/);
  });

  it("requires a new login after adding Docker group membership", () => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
common_preflight() { :; }
require_command() { :; }
acquire_sudo() { :; }
all_packages_ready() { return 0; }
install_boot_marker_matches_current_boot() { return 1; }
driver_loaded_exact() { return 0; }
finish_runtime() { DOCKER_GROUP_ADDED=1; printf 'FINISH_RUNTIME\n'; }
verify_apply_state() { printf 'VERIFY_APPLY_STATE\n'; }
require_docker_restart_quiescence() { printf 'RECHECK_RESTART_QUIESCENCE\n'; }
run_apply
`,
    );

    expect(result.status, output).toBe(10);
    expect(output).toContain("VERIFY_APPLY_STATE");
    expect(output).toContain("RECHECK_RESTART_QUIESCENCE");
    expect(output).toContain("APPLY_RESULT=REBOOT_REQUIRED");
    expect(output).toMatch(/new login before onboarding/);
  });

  it("fails closed when the packaged CDI refresh service fails", () => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
require_docker_mutation_quiescence() { printf 'RECHECK_MUTATION_QUIESCENCE\n'; }
sudo() {
  printf 'SUDO %s\n' "$*"
  if [[ "$*" == "systemctl restart nvidia-cdi-refresh.service" ]]; then return 1; fi
  return 0
}
refresh_cdi
`,
    );

    expect(result.status, output).not.toBe(0);
    expect(output).toContain("systemctl status nvidia-cdi-refresh.service --no-pager");
    expect(output).toContain("journalctl -u nvidia-cdi-refresh.service --no-pager -n 50");
    expect(output).toContain("RECHECK_MUTATION_QUIESCENCE");
    expect(output).toMatch(/repair nvidia-cdi-refresh\.service/);
    expect(output).not.toContain("nvidia-ctk cdi generate");
  });

  it("fails closed when the packaged CDI refresh produces no GPU device", () => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
require_docker_mutation_quiescence() { printf 'RECHECK_MUTATION_QUIESCENCE\n'; }
sudo() {
  printf 'SUDO %s\n' "$*"
  return 0
}
nvidia-ctk() { :; }
refresh_cdi
`,
    );

    expect(result.status, output).not.toBe(0);
    expect(output).toContain("RECHECK_MUTATION_QUIESCENCE");
    expect(output).toMatch(/completed without advertising nvidia\.com\/gpu=all/);
    expect(output).toContain("systemctl status nvidia-cdi-refresh.service --no-pager");
    expect(output).toContain("journalctl -u nvidia-cdi-refresh.service --no-pager -n 50");
    expect(output).toMatch(/direct CDI generation is not permitted/);
    expect(output).not.toContain("nvidia-ctk cdi generate");
  });

  it("rechecks every workload gate immediately before Docker runtime mutation", () => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
run_gpus_test_sudo() { return 1; }
docker_has_nvidia_runtime_sudo() { return 1; }
sudo() {
  [[ "$*" == "docker ps -aq" ]] && return 0
  [[ "$*" == "test -e /etc/docker/daemon.json" ]] && return 1
  printf 'SUDO %s\n' "$*"
}
require_docker_mutation_quiescence() { printf 'RECHECK_MUTATION_QUIESCENCE\n'; return 1; }
configure_docker_runtime_if_needed
`,
    );

    expect(result.status, output).not.toBe(0);
    expect(output).toContain("RECHECK_MUTATION_QUIESCENCE");
    expect(output).not.toContain("nvidia-ctk runtime configure");
    expect(output).not.toContain("systemctl restart docker.service");
  });

  it("leaves Docker unchanged when the NVIDIA runtime is already registered", () => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
run_gpus_test_sudo() { return 1; }
docker_has_nvidia_runtime_sudo() { return 0; }
sudo() { printf 'SUDO %s\n' "$*"; }
configure_docker_runtime_if_needed
`,
    );

    expect(result.status, output).not.toBe(0);
    expect(output).toMatch(/NVIDIA runtime is registered/);
    expect(output).toMatch(/daemon configuration was left unchanged/);
    expect(output).not.toContain("nvidia-ctk runtime configure");
    expect(output).not.toContain("systemctl restart docker.service");
  });

  it("registers the NVIDIA runtime only when Docker reports it missing", () => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
calls=0
run_gpus_test_sudo() {
  calls=$((calls + 1))
  [[ "$calls" -gt 1 ]]
}
run_cdi_test_sudo() { return 0; }
docker_has_nvidia_runtime_sudo() { return 1; }
require_docker_mutation_quiescence() { printf 'RECHECK_MUTATION_QUIESCENCE\n'; }
require_docker_restart_quiescence() { printf 'RECHECK_RESTART_QUIESCENCE\n'; }
ensure_root_directory_safe() { :; }
assert_root_directory_safe() { :; }
assert_root_regular_file_safe() { :; }
root_regular_file_is_safe() { return 0; }
sudo() {
  if [[ "$*" == "mktemp -d /var/backups/station-bootstrap/docker-runtime.XXXXXXXXXX" ]]; then
    printf '/var/backups/station-bootstrap/docker-runtime.TEST'
    return 0
  fi
  [[ "$*" == "test -e /etc/docker/daemon.json" || "$*" == "test -L /etc/docker/daemon.json" ]] && return 1
  printf 'SUDO %s\n' "$*"
}
configure_docker_runtime_if_needed
`,
    );

    expect(result.status, output).toBe(0);
    expect(output).toContain("Docker reports no NVIDIA runtime");
    expect(output).toContain("nvidia-ctk runtime configure --runtime=docker");
    expect(output).toContain("systemctl restart docker.service");
    expect(output).toContain("docker_gpus_contract=pass");
  });

  it("restores configuration without restarting Docker when a workload appears at the restart boundary", () => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
runtime_configured=0
run_gpus_test_sudo() { return 1; }
run_cdi_test_sudo() { return 0; }
docker_has_nvidia_runtime_sudo() { return 1; }
require_docker_mutation_quiescence() {
  printf 'RECHECK_MUTATION_QUIESCENCE configured=%s\n' "$runtime_configured"
  return 0
}
require_docker_restart_quiescence() {
  printf 'RECHECK_RESTART_QUIESCENCE configured=%s\n' "$runtime_configured"
  [[ "$runtime_configured" == "0" ]]
}
ensure_root_directory_safe() { :; }
assert_root_directory_safe() { :; }
assert_root_regular_file_safe() { :; }
root_regular_file_is_safe() { return 0; }
sudo() {
  if [[ "$*" == "mktemp -d /var/backups/station-bootstrap/docker-runtime.XXXXXXXXXX" ]]; then
    printf '/var/backups/station-bootstrap/docker-runtime.TEST'
    return 0
  fi
  [[ "$*" == "test -e /etc/docker/daemon.json" || "$*" == "test -L /etc/docker/daemon.json" ]] && return 1
  if [[ "$*" == "nvidia-ctk runtime configure --runtime=docker" ]]; then
    runtime_configured=1
  fi
  printf 'SUDO %s\n' "$*"
}
configure_docker_runtime_if_needed
`,
    );

    expect(result.status, output).not.toBe(0);
    expect(output).toContain("RECHECK_RESTART_QUIESCENCE configured=1");
    expect(output).toContain("rm -f -- /etc/docker/daemon.json");
    expect(output).toMatch(/A workload appeared before Docker restart/);
    expect(output).toMatch(/prior Docker daemon configuration was restored/);
    expect(output).not.toContain("systemctl restart docker.service");
  });

  it("restores the prior Docker configuration when a post-mutation launch probe fails", () => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
run_gpus_test_sudo() { printf 'GPU_PROBE\n'; return 1; }
run_cdi_test_sudo() { return 0; }
docker_has_nvidia_runtime_sudo() { return 1; }
require_docker_mutation_quiescence() { printf 'RECHECK_MUTATION_QUIESCENCE\n'; }
require_docker_restart_quiescence() { printf 'RECHECK_RESTART_QUIESCENCE\n'; }
ensure_root_directory_safe() { :; }
assert_root_directory_safe() { :; }
assert_root_regular_file_safe() { :; }
root_regular_file_is_safe() { return 0; }
sudo() {
  if [[ "$*" == "mktemp -d /var/backups/station-bootstrap/docker-runtime.XXXXXXXXXX" ]]; then
    printf '/var/backups/station-bootstrap/docker-runtime.TEST'
    return 0
  fi
  [[ "$*" == "test -e /etc/docker/daemon.json" || "$*" == "test -L /etc/docker/daemon.json" ]] && return 1
  printf 'SUDO %s\n' "$*"
}
configure_docker_runtime_if_needed
`,
    );

    expect(result.status, output).not.toBe(0);
    expect(output).toContain("Restoring the Docker daemon configuration");
    expect(output).toContain("rm -f -- /etc/docker/daemon.json");
    expect(output).toMatch(/prior Docker daemon configuration was restored/);
  });

  it("accepts a successful packaged CDI refresh", () => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
require_docker_mutation_quiescence() { printf 'RECHECK_MUTATION_QUIESCENCE\n'; }
sudo() { printf 'SUDO %s\n' "$*"; }
nvidia-ctk() {
  [[ "$*" == "cdi list" ]] && printf 'nvidia.com/gpu=all\n'
}
refresh_cdi
`,
    );

    expect(result.status, output).toBe(0);
    expect(output).toContain("systemctl enable nvidia-cdi-refresh.path nvidia-cdi-refresh.service");
    expect(output).toContain("systemctl start nvidia-cdi-refresh.path");
    expect(output).toContain("systemctl restart nvidia-cdi-refresh.service");
    expect(output).toContain("cdi=nvidia.com/gpu=all source=packaged_refresh_service");
    expect(output).not.toContain("systemctl status");
    expect(output).not.toContain("cdi generate");
  });

  it("verifies the durable packaged CDI refresh lifecycle", () => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
systemctl() { printf 'SYSTEMCTL %s\n' "$*"; }
verify_cdi_refresh_lifecycle
`,
    );

    expect(result.status, output).toBe(0);
    expect(output).toContain("SYSTEMCTL is-enabled --quiet nvidia-cdi-refresh.path");
    expect(output).toContain("SYSTEMCTL is-enabled --quiet nvidia-cdi-refresh.service");
    expect(output).toContain("SYSTEMCTL is-active --quiet nvidia-cdi-refresh.path");
    expect(output).toContain("cdi_refresh_lifecycle=verified");
  });

  it.each(["--check", "--verify"])("keeps %s read-only under HOME", (mode) => {
    const { home, result, output } = runSourced(
      STATION_PREPARE,
      `
run_check() { :; }
run_verify() { :; }
main "$READ_MODE"
`,
      { READ_MODE: mode },
    );

    expect(result.status, output).toBe(0);
    expect(output).toContain("log=disabled_read_only");
    expect(fs.existsSync(path.join(home, "station-bootstrap-logs"))).toBe(false);
  });

  it("fails verification when exact packages are present but the driver is not loaded", () => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
common_preflight() { :; }
require_command() { :; }
all_packages_ready() { return 0; }
driver_loaded_exact() { return 1; }
run_verify
`,
    );

    expect(result.status, output).not.toBe(0);
    expect(output).toMatch(/Pinned driver is not loaded/);
  });

  it("rejects a symlinked Station bootstrap state directory", () => {
    const { home, result, output } = runSourced(
      STATION_PREPARE,
      `
mkdir -p "$HOME/.local/state" "$HOME/redirect-target"
ln -s "$HOME/redirect-target" "$HOME/.local/state/station-bootstrap"
write_install_boot_marker
`,
    );

    expect(result.status, output).not.toBe(0);
    expect(output).toMatch(/Refusing symbolic link in Station bootstrap state path/);
    expect(fs.existsSync(path.join(home, "redirect-target", "install-boot-id"))).toBe(false);
  });

  it("rejects a direct boot-marker symlink without modifying its target", () => {
    const { home, result, output } = runSourced(
      STATION_PREPARE,
      `
mkdir -p "$HOME/.local/state/station-bootstrap"
chmod 0700 "$HOME/.local/state/station-bootstrap"
printf 'preserve-this-target\n' >"$HOME/marker-target"
ln -s "$HOME/marker-target" "$HOME/.local/state/station-bootstrap/install-boot-id"
write_install_boot_marker
`,
    );

    expect(result.status, output).not.toBe(0);
    expect(output).toMatch(/Refusing symbolic link for Station bootstrap boot marker/);
    expect(fs.readFileSync(path.join(home, "marker-target"), "utf-8")).toBe(
      "preserve-this-target\n",
    );
  });
});

describe("DGX Station express host integration", () => {
  it("ships and invokes Station preparation through the public curl bootstrap", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-public-bootstrap-"));
    const fakeBin = path.join(tmp, "bin");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(
      path.join(fakeBin, "git"),
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "init" ]; then
  target="\${@: -1}"
  mkdir -p "$target/scripts"
  cat > "$target/scripts/install.sh" <<'PAYLOAD'
#!/usr/bin/env bash
# NEMOCLAW_VERSIONED_INSTALLER_PAYLOAD=1
set -euo pipefail
source "\${INSTALLER_UNDER_TEST:?}" >/dev/null
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
maybe_offer_express_install() {
  _SELECTED_EXPRESS_PLATFORM='DGX Station'
  NEMOCLAW_VLLM_MODEL='nemotron-3-ultra-550b-a55b'
}
station_installer_revision() { printf '${STATION_REVISION}'; }
station_express_resume_generation() { printf '${STATION_GENERATION}'; }
ensure_docker() { printf 'ENSURE_DOCKER\\n'; }
ensure_openshell_build_deps() { printf 'ENSURE_BUILD_DEPS\\n'; }
prepare_installer_host
PAYLOAD
  cat > "$target/scripts/prepare-dgx-station-host.sh" <<'HELPER'
#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  --classify-dgx-release) printf 'CLASSIFY_STATION\\n' >&2; printf 'generic-ubuntu' ;;
  --apply)
    printf '[station-prepare] 2026-07-17T07:59:07Z version=2026-07-17.4 mode=--apply log=/tmp/station-prepare.log\\n'
    printf 'PREPARE_STATION\\n'
    ;;
  *) exit 2 ;;
esac
HELPER
  chmod +x "$target/scripts/install.sh" "$target/scripts/prepare-dgx-station-host.sh"
  exit 0
fi
if [ "\${1:-}" = "-C" ]; then shift 2; fi
case "\${1:-}" in
  remote|fetch|checkout) exit 0 ;;
esac
exit 0
`,
      { mode: 0o755 },
    );

    const result = spawnSync("bash", [], {
      cwd: tmp,
      input: fs.readFileSync(PUBLIC_BOOTSTRAP, "utf-8"),
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmp,
        PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
        INSTALLER_UNDER_TEST: INSTALLER_PAYLOAD,
        NEMOCLAW_INSTALL_REF: "refs/tags/station-fixture",
      },
      timeout: 15_000,
      killSignal: "SIGKILL",
    });
    const output = `${result.stdout}${result.stderr}`;
    const preparationLogIndex = output.indexOf("DGX Station host preparation log");

    expect(result.status, output).toBe(0);
    expect(output).toContain("CLASSIFY_STATION");
    expect(output).toContain("DGX Station host prerequisites are ready");
    expect(preparationLogIndex).toBeGreaterThanOrEqual(0);
    expect(preparationLogIndex).toBeLessThan(output.indexOf("ENSURE_DOCKER"));
    expect(output).not.toContain("PREPARE_STATION");
    expect(output.indexOf("ENSURE_DOCKER")).toBeLessThan(output.indexOf("ENSURE_BUILD_DEPS"));
  });

  it("runs Station preparation before the generic Docker bootstrap", () => {
    const { result, output } = runSourced(
      INSTALLER_PAYLOAD,
      `
maybe_offer_express_install() { printf 'SELECT_EXPRESS\n'; _SELECTED_EXPRESS_PLATFORM='DGX Station'; }
ensure_station_express_host() { printf 'PREPARE_STATION\n'; }
ensure_docker() { printf 'ENSURE_DOCKER\n'; }
ensure_openshell_build_deps() { printf 'ENSURE_BUILD_DEPS\n'; }
prepare_installer_host
`,
    );

    expect(result.status, output).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "SELECT_EXPRESS",
      "PREPARE_STATION",
      "ENSURE_DOCKER",
      "ENSURE_BUILD_DEPS",
    ]);
  });

  it("pins Station preparation to the local default Docker context (#7103)", () => {
    const { result, output } = runSourced(
      INSTALLER_PAYLOAD,
      `
DOCKER_HOST='tcp://remote.example:2376'
DOCKER_CONTEXT='remote-cluster'
maybe_offer_express_install() { _SELECTED_EXPRESS_PLATFORM='DGX Station'; }
ensure_station_express_host() {
  printf 'PREPARE DOCKER_HOST=%s DOCKER_CONTEXT=%s\n' "\${DOCKER_HOST-unset}" "\${DOCKER_CONTEXT-unset}"
}
ensure_docker() { :; }
ensure_openshell_build_deps() { :; }
prepare_installer_host
`,
    );

    expect(result.status, output).toBe(0);
    expect(result.stdout.trim()).toBe("PREPARE DOCKER_HOST=unset DOCKER_CONTEXT=default");
  });

  it("skips Station preparation before Docker bootstrap on non-Station platforms", () => {
    const { result, output } = runSourced(
      INSTALLER_PAYLOAD,
      `
maybe_offer_express_install() { _SELECTED_EXPRESS_PLATFORM='DGX Spark'; }
ensure_station_express_host() {
  [[ "$_SELECTED_EXPRESS_PLATFORM" == 'DGX Station' ]] && printf 'PREPARE_STATION\n'
  return 0
}
ensure_docker() { printf 'ENSURE_DOCKER\n'; }
ensure_openshell_build_deps() { printf 'ENSURE_BUILD_DEPS\n'; }
prepare_installer_host
`,
    );

    expect(result.status, output).toBe(0);
    expect(output).not.toContain("PREPARE_STATION");
    expect(result.stdout.trim().split("\n")).toEqual(["ENSURE_DOCKER", "ENSURE_BUILD_DEPS"]);
  });

  it("persists the selected model and ports when host preparation requires a reboot (#7203)", () => {
    const { home, result, output } = runSourced(
      INSTALLER_PAYLOAD,
      `
_SELECTED_EXPRESS_PLATFORM='DGX Station'
NEMOCLAW_VLLM_MODEL='nemotron-3-ultra-550b-a55b'
NEMOCLAW_GATEWAY_PORT='18081'
NEMOCLAW_DASHBOARD_PORT='18790'
NEMOCLAW_VLLM_PORT='18000'
station_installer_revision() { printf '${STATION_REVISION}'; }
station_express_resume_generation() { printf '${STATION_GENERATION}'; }
run_station_host_preparation() { return 10; }
ensure_station_express_host
`,
    );
    const stateFile = path.join(home, ".nemoclaw", "gateways", "18081", "station-express-resume");

    expect(result.status, output).toBe(10);
    expect(fs.readFileSync(stateFile, "utf-8")).toBe(
      `revision=${STATION_REVISION}\nmodel=nemotron-3-ultra-550b-a55b\ngeneration=${STATION_GENERATION}\n` +
        "agent=openclaw\nsandbox=my-assistant\npolicy_tier=balanced\n" +
        "gateway_port=18081\ndashboard_port=18790\nvllm_port=18000\n",
    );
    expect(fs.statSync(stateFile).mode & 0o777).toBe(0o600);
    expect(output).toContain(
      `NEMOCLAW_INSTALL_TAG=${STATION_REVISION} NEMOCLAW_AGENT=openclaw NEMOCLAW_SANDBOX_NAME=my-assistant NEMOCLAW_POLICY_TIER=balanced NEMOCLAW_GATEWAY_PORT=18081 NEMOCLAW_DASHBOARD_PORT=18790 NEMOCLAW_VLLM_PORT=18000 bash`,
    );
  });

  it("rejects a resume-state symlink without loading its target", () => {
    const { home, result, output } = runSourced(
      INSTALLER_PAYLOAD,
      `
mkdir -p "$HOME/.nemoclaw"
chmod 0700 "$HOME/.nemoclaw"
printf 'deepseek-v4-flash\n' >"$HOME/resume-target"
ln -s "$HOME/resume-target" "$HOME/.nemoclaw/station-express-resume"
load_station_express_resume
`,
    );
    const target = path.join(home, "resume-target");
    const stateFile = path.join(home, ".nemoclaw", "station-express-resume");

    expect(result.status, output).toBe(1);
    expect(output).toMatch(/Refusing symbolic link in NemoClaw state path/);
    expect(fs.readFileSync(target, "utf-8")).toBe("deepseek-v4-flash\n");
    expect(fs.lstatSync(stateFile).isSymbolicLink()).toBe(true);
  });

  it("rejects a resume-state symlink without modifying its target", () => {
    const { home, result, output } = runSourced(
      INSTALLER_PAYLOAD,
      `
mkdir -p "$HOME/.nemoclaw"
chmod 0700 "$HOME/.nemoclaw"
printf 'preserve-this-target\n' >"$HOME/resume-target"
ln -s "$HOME/resume-target" "$HOME/.nemoclaw/station-express-resume"
_SELECTED_EXPRESS_PLATFORM='DGX Station'
NEMOCLAW_VLLM_MODEL='nemotron-3-ultra-550b-a55b'
station_installer_revision() { printf '${STATION_REVISION}'; }
run_station_host_preparation() { return 10; }
ensure_station_express_host
`,
    );
    const target = path.join(home, "resume-target");
    const stateFile = path.join(home, ".nemoclaw", "station-express-resume");

    expect(result.status, output).toBe(1);
    expect(output).toMatch(/Refusing symbolic link in NemoClaw state path/);
    expect(fs.readFileSync(target, "utf-8")).toBe("preserve-this-target\n");
    expect(fs.lstatSync(stateFile).isSymbolicLink()).toBe(true);
  });

  it("resumes the accepted Station recipe without another prompt", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-resume-"));
    const stateDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(stateDir, { mode: 0o700 });
    fs.writeFileSync(
      path.join(stateDir, "station-express-resume"),
      `revision=${STATION_REVISION}\nmodel=nemotron-3-ultra-550b-a55b\ngeneration=${STATION_GENERATION}\n`,
      { mode: 0o600 },
    );
    const result = spawnSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        `
source "$INSTALLER_UNDER_TEST" >/dev/null
detect_express_platform() { printf 'DGX Station'; }
station_installer_revision() { printf '${STATION_REVISION}'; }
NON_INTERACTIVE=''
NEMOCLAW_PROVIDER=''
NEMOCLAW_NO_EXPRESS=''
maybe_offer_express_install
printf 'RESULT PLATFORM=%s PROVIDER=%s MODEL=%s VLLM_MODEL=%s STATION_EXPRESS=%s RESUME_LOADED=%s GENERATION=%s\n' \
  "$_SELECTED_EXPRESS_PLATFORM" "$NEMOCLAW_PROVIDER" "\${NEMOCLAW_MODEL:-}" "$NEMOCLAW_VLLM_MODEL" "$NEMOCLAW_STATION_EXPRESS" "$_STATION_EXPRESS_RESUME_LOADED" "$NEMOCLAW_STATION_EXPRESS_RECEIPT_GENERATION"
`,
      ],
      {
        cwd: REPO_ROOT,
        encoding: "utf-8",
        env: {
          HOME: home,
          PATH: TEST_SYSTEM_PATH,
          INSTALLER_UNDER_TEST: INSTALLER_PAYLOAD,
        },
        timeout: 15_000,
        killSignal: "SIGKILL",
      },
    );
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(output).toMatch(/Resuming the accepted express install/);
    expect(output).not.toMatch(/Run express install with these settings/);
    expect(output).toMatch(
      new RegExp(
        `RESULT PLATFORM=DGX Station PROVIDER=install-vllm MODEL=nvidia/nemotron-3-ultra-550b-a55b VLLM_MODEL=nemotron-3-ultra-550b-a55b STATION_EXPRESS=1 RESUME_LOADED=1 GENERATION=${STATION_GENERATION}`,
      ),
    );
  });

  it("does not restore the Station recipe after an explicit fresh onboard (#7048)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-fresh-"));
    const stateDir = path.join(home, ".nemoclaw");
    const receipt = path.join(stateDir, "station-express-resume");
    fs.mkdirSync(stateDir, { mode: 0o700 });
    fs.writeFileSync(
      receipt,
      `revision=${STATION_REVISION}\nmodel=nemotron-3-ultra-550b-a55b\ngeneration=${STATION_GENERATION}\n`,
      { mode: 0o600 },
    );
    const session = {
      resumable: true,
      status: "failed",
      mode: "non-interactive",
      provider: null,
      model: null,
      stationExpressIntent: {
        version: 1 as const,
        model: "nemotron-3-ultra-550b-a55b",
        sandboxName: "my-assistant",
      },
    };

    try {
      await withStationExpressResumeEnvironment(
        async () => undefined,
        {
          loadSession: () => session,
          clearInstallerResume: () => clearStationExpressInstallerResume({ HOME: home }),
          cleanupReceiptRetirementClaims: () => undefined,
          reconcileReceiptRetirement: () => undefined,
          error: (message) => {
            throw new Error(message);
          },
          exitProcess: (code): never => {
            throw new Error(`exit ${String(code)}`);
          },
        },
        {},
      )({ fresh: true });
      expect(fs.existsSync(receipt)).toBe(false);

      const { result, output } = runNonInteractiveStationSelector(home);

      expect(result.status, output).toBe(0);
      expect(output).toContain("Skipping express prompt (--non-interactive set)");
      expect(output).not.toContain("Resuming the accepted express install");
      expect(output).toContain("RESULT PROVIDER= STATION_EXPRESS=");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not restore the Station recipe after onboarding completes (#7048)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-complete-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    const session = await import("../src/lib/state/onboard-session");
    const receipt = path.join(session.SESSION_DIR, "station-express-resume");

    try {
      session.saveSession(
        session.createSession({
          mode: "non-interactive",
          stationExpressIntent: {
            version: 1,
            model: "nemotron-3-ultra-550b-a55b",
            sandboxName: "my-assistant",
            receiptGeneration: STATION_GENERATION,
          },
        }),
      );
      fs.writeFileSync(
        receipt,
        `revision=${STATION_REVISION}\nmodel=nemotron-3-ultra-550b-a55b\ngeneration=${STATION_GENERATION}\n`,
        { mode: 0o600 },
      );

      session.completeSession();

      expect(fs.existsSync(receipt)).toBe(false);
      expect(session.loadSession()).toMatchObject({
        status: "complete",
        resumable: false,
        stationExpressIntent: null,
      });
      const { result, output } = runNonInteractiveStationSelector(home);
      expect(result.status, output).toBe(0);
      expect(output).toContain("Skipping express prompt (--non-interactive set)");
      expect(output).not.toContain("Resuming the accepted express install");
      expect(output).toContain("RESULT PROVIDER= STATION_EXPRESS=");
    } finally {
      session.clearSession();
      session.releaseOnboardLock();
      vi.unstubAllEnvs();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("preserves an explicit provider even when Station resume state exists", () => {
    const { home, result, output } = runSourced(
      INSTALLER_PAYLOAD,
      `
mkdir -p "$HOME/.nemoclaw"
chmod 0700 "$HOME/.nemoclaw"
printf 'nemotron-3-ultra-550b-a55b\n' >"$HOME/.nemoclaw/station-express-resume"
chmod 0600 "$HOME/.nemoclaw/station-express-resume"
detect_express_platform() { printf 'DGX Station'; }
NON_INTERACTIVE=''
NEMOCLAW_PROVIDER='openai'
NEMOCLAW_NO_EXPRESS=''
maybe_offer_express_install
printf 'RESULT PROVIDER=%s\n' "$NEMOCLAW_PROVIDER"
`,
    );

    expect(result.status, output).toBe(0);
    expect(output).toContain("NEMOCLAW_PROVIDER=openai already set");
    expect(output).toContain("RESULT PROVIDER=openai");
    expect(output).not.toContain("Resuming the accepted express install");
    expect(fs.existsSync(path.join(home, ".nemoclaw", "station-express-resume"))).toBe(false);
  });

  it("clears pending Station resume state when express install is explicitly disabled", () => {
    const { home, result, output } = runSourced(
      INSTALLER_PAYLOAD,
      `
mkdir -p "$HOME/.nemoclaw"
chmod 0700 "$HOME/.nemoclaw"
printf 'revision=${STATION_REVISION}\nmodel=nemotron-3-ultra-550b-a55b\ngeneration=${STATION_GENERATION}\n' >"$HOME/.nemoclaw/station-express-resume"
chmod 0600 "$HOME/.nemoclaw/station-express-resume"
claim="$HOME/.nemoclaw/station-express-resume.retiring-${STATION_GENERATION}-ABC123"
mkdir -m 0700 "$claim"
printf 'revision=${STATION_REVISION}\nmodel=nemotron-3-ultra-550b-a55b\ngeneration=${STATION_GENERATION}\n' >"$claim/receipt"
: >"$claim/retired"
chmod 0600 "$claim/receipt" "$claim/retired"
: >"$claim/unexpected"
(clear_station_express_resume) && exit 91
[[ -f "$claim/receipt" ]] || exit 92
rm "$claim/unexpected"
chmod 0644 "$claim/retired"
(clear_station_express_resume) && exit 93
[[ -f "$claim/receipt" ]] || exit 94
chmod 0600 "$claim/retired"
detect_express_platform() { printf 'DGX Station'; }
NON_INTERACTIVE=''
NEMOCLAW_PROVIDER=''
NEMOCLAW_NO_EXPRESS='1'
maybe_offer_express_install
`,
    );

    expect(result.status, output).toBe(0);
    expect(output).toContain("NEMOCLAW_NO_EXPRESS=1");
    expect(fs.existsSync(path.join(home, ".nemoclaw", "station-express-resume"))).toBe(false);
    expect(
      fs.existsSync(
        path.join(
          home,
          ".nemoclaw",
          `station-express-resume.retiring-${STATION_GENERATION}-ABC123`,
        ),
      ),
    ).toBe(false);
  });

  it("refuses claim-only cleanup through a group-accessible gateway ancestor", () => {
    const { home, result, output } = runSourced(
      INSTALLER_PAYLOAD,
      `
NEMOCLAW_GATEWAY_PORT=28080
state_dir="$HOME/.nemoclaw/gateways/28080"
claim="$state_dir/station-express-resume.retiring-${STATION_GENERATION}-ABC123"
mkdir -p "$claim"
chmod 0700 "$HOME/.nemoclaw" "$state_dir" "$claim"
chmod 0770 "$HOME/.nemoclaw/gateways"
: >"$claim/retired"
chmod 0600 "$claim/retired"
clear_station_express_resume
`,
    );

    expect(result.status, output).toBe(1);
    expect(output).toContain("must not be accessible by group or other users");
    expect(
      fs.existsSync(
        path.join(
          home,
          ".nemoclaw/gateways/28080",
          `station-express-resume.retiring-${STATION_GENERATION}-ABC123/retired`,
        ),
      ),
    ).toBe(true);
  });

  it("does not load Station resume state on DGX Spark", () => {
    const { result, output } = runSourced(
      INSTALLER_PAYLOAD,
      `
mkdir -p "$HOME/.nemoclaw"
chmod 0700 "$HOME/.nemoclaw"
printf 'nemotron-3-ultra-550b-a55b\n' >"$HOME/.nemoclaw/station-express-resume"
chmod 0600 "$HOME/.nemoclaw/station-express-resume"
detect_express_platform() { printf 'DGX Spark'; }
NON_INTERACTIVE='1'
NEMOCLAW_PROVIDER=''
NEMOCLAW_NO_EXPRESS=''
NEMOCLAW_VLLM_MODEL=''
maybe_offer_express_install
printf 'RESULT MODEL=%s\n' "$NEMOCLAW_VLLM_MODEL"
`,
    );

    expect(result.status, output).toBe(0);
    expect(output).toContain("Detected DGX Spark. Skipping express prompt (--non-interactive set)");
    expect(output).toContain("RESULT MODEL=");
    expect(output).not.toContain("Resuming the accepted express install");
    expect(output).not.toContain("nemotron-3-ultra-550b-a55b");
  });

  it("rejects a multi-line Station resume state", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-resume-invalid-"));
    const stateDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(stateDir, { mode: 0o700 });
    fs.writeFileSync(
      path.join(stateDir, "station-express-resume"),
      `revision=${STATION_REVISION}\nmodel=nemotron-3-ultra-550b-a55b\ngeneration=${STATION_GENERATION}\nunexpected\n`,
      { mode: 0o600 },
    );
    const result = spawnSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        `source "$INSTALLER_UNDER_TEST" >/dev/null; load_station_express_resume`,
      ],
      {
        cwd: REPO_ROOT,
        encoding: "utf-8",
        env: {
          HOME: home,
          PATH: TEST_SYSTEM_PATH,
          INSTALLER_UNDER_TEST: INSTALLER_PAYLOAD,
        },
        timeout: 15_000,
        killSignal: "SIGKILL",
      },
    );
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).not.toBe(0);
    expect(output).toMatch(/resume state is invalid/);
  });

  it("rejects resume under a different installer revision with exact rerun guidance", () => {
    const savedRevision = "b".repeat(40);
    const currentRevision = "c".repeat(40);
    const { result, output } = runSourced(
      INSTALLER_PAYLOAD,
      `
mkdir -p "$HOME/.nemoclaw"
chmod 0700 "$HOME/.nemoclaw"
printf 'revision=${savedRevision}\nmodel=nemotron-3-ultra-550b-a55b\ngeneration=${STATION_GENERATION}\n' >"$HOME/.nemoclaw/station-express-resume"
chmod 0600 "$HOME/.nemoclaw/station-express-resume"
station_installer_revision() { printf '${currentRevision}'; }
load_station_express_resume
`,
    );

    expect(result.status, output).not.toBe(0);
    expect(output).toContain(`requires NemoClaw revision ${savedRevision}`);
    expect(output).toContain(`NEMOCLAW_INSTALL_TAG=${savedRevision}`);
  });
});
