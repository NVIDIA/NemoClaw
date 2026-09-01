// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { runInstallerSourcedBody } from "../helpers/installer-run-fixture";
import { TEST_SYSTEM_PATH } from "../helpers/installer-sourced-env";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const STATION_PREPARE = path.join(REPO_ROOT, "scripts", "prepare-dgx-station-host.sh");

function runSourced(body: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-controller-"));
  const result = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-c", `source "$SCRIPT_UNDER_TEST" >/dev/null\n${body}`],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { HOME: home, PATH: TEST_SYSTEM_PATH, SCRIPT_UNDER_TEST: STATION_PREPARE },
      timeout: 15_000,
      killSignal: "SIGKILL",
    },
  );
  return { home, result, output: `${result.stdout}${result.stderr}` };
}

const runInstallerBody = (body: string, extraEnv: Record<string, string> = {}) => {
  const run = runInstallerSourcedBody(body, {
    homePrefix: "nemoclaw-station-migration-",
    extraEnv,
    includeNodeOnPath: true,
    timeoutMs: 15_000,
  });
  onTestFinished(run.remove);
  return run;
};

function runInstallerOrderHarness(onboardStatus: 0 | 1) {
  return runInstallerBody(
    `
record_order() { printf '%s\n' "$1" >>"$HOME/order.trace"; }
resolve_nemoclaw_gateway_port() { printf '18789'; }
preflight_explicit_express_flags() { :; }
print_banner() { :; }
preflight_usage_notice_prompt() { :; }
prepare_installer_host() { _SELECTED_EXPRESS_PLATFORM='DGX Station'; }
bash() { :; }
step() { :; }
install_nodejs() { :; }
ensure_supported_runtime() { :; }
ensure_station_express_pair() { record_order qualify; }
fix_npm_permissions() { :; }
preinstall_backup_and_retire_legacy_gateway() { :; }
install_nemoclaw() { record_order install; }
verify_nemoclaw() { :; }
require_reportable_openshell_version() { :; }
command_exists() { return 0; }
registered_sandbox_count() { printf '0\n'; }
run_installer_host_preflight() { return 0; }
recover_preexisting_sandboxes_before_onboard() { return 0; }
run_onboard() { record_order onboard; return "$ONBOARD_STATUS"; }
restore_onboard_forward_after_post_checks() { return 0; }
finalize_install() { record_order finalize; }
clear_station_dual_pair_resume() { record_order clear; }
clear_station_express_resume() { :; }
main --non-interactive --yes-i-accept-third-party-software
`,
    { ONBOARD_STATUS: String(onboardStatus) },
  );
}

describe("DGX Station controller UID binding", () => {
  it("keeps ordinary Station verification independent of dual-pair binding", () => {
    const { home, result, output } = runSourced(`
require_command() { :; }
common_preflight() { STATION_HOST_PROFILE=ai-developer-tools; }
station_uses_factory_runtime() { return 0; }
verify_dgx_os_runtime_user() { printf 'FACTORY_RUNTIME_VERIFIED\\n'; }
verify_dual_station_controller_uid_binding() {
  printf 'UNEXPECTED_PAIR_BINDING_CHECK\\n'
  return 1
}
run_verify
`);
    try {
      expect(result.status, output).toBe(0);
      expect(output).toContain("FACTORY_RUNTIME_VERIFIED");
      expect(output).not.toContain("UNEXPECTED_PAIR_BINDING_CHECK");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("runs binding-only preparation without workload inspection and retains sudo acquisition", () => {
    const { home, result, output } = runSourced(`
require_command() { :; }
acquire_sudo() { sudo_mode='acquired'; printf 'ACQUIRE_SUDO\\n'; }
check_platform() { printf 'CHECK_PLATFORM\\n'; }
check_no_workloads() { printf 'WORKLOAD_CHECK_MUST_NOT_RUN\\n'; return 1; }
ensure_dual_station_controller_uid_binding() { printf 'ENSURE_CONTROLLER_BINDING sudo=%s\\n' "$sudo_mode"; }
run_bind_controller
`);
    try {
      expect(result.status, output).toBe(0);
      expect(output).toContain("ACQUIRE_SUDO");
      expect(output).toContain("CHECK_PLATFORM");
      expect(output).toContain("ENSURE_CONTROLLER_BINDING sudo=acquired");
      expect(output).toContain("CONTROLLER_UID_BINDING_READY");
      expect(output).not.toContain("WORKLOAD_CHECK_MUST_NOT_RUN");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("creates one exact binding, reuses it, and requires administrator removal to rebind", () => {
    const { home, result, output } = runSourced(`
config_dir="$HOME/etc/nemoclaw"
binding_file="$config_dir/dual-station-controller-uid"
mkdir -p "$HOME/etc"
controller_uid=1001
binding_owned=0
preparation_controller_uid() { printf '%s\\n' "$controller_uid"; }
ensure_root_directory_safe() { mkdir -p "$1"; }
assert_root_directory_safe() { [[ -d "$1" ]]; }
root_regular_file_is_safe() { ((binding_owned == 1)) && [[ -f "$1" ]]; }
root_directory_is_safe_unprivileged() { [[ -d "$1" ]]; }
root_regular_file_is_safe_unprivileged() { ((binding_owned == 1)) && [[ -f "$1" ]]; }
sudo() {
  if [[ "$1" == "chown" && "$2" == "root:root" && "$3" == "\${config_dir}/.dual-station-controller-uid."* ]]; then
    binding_owned=1
    return 0
  fi
  "$@"
}
ensure_dual_station_controller_uid_binding "$config_dir" "$binding_file"
ensure_dual_station_controller_uid_binding "$config_dir" "$binding_file"
controller_uid=1002
ensure_dual_station_controller_uid_binding "$config_dir" "$binding_file"
`);

    try {
      expect(result.status, output).not.toBe(0);
      expect(output.match(/dual_station_controller_uid=installed/g)).toHaveLength(1);
      expect(output).toMatch(/administrator must remove .* before rebinding/);
      const binding = path.join(home, "etc/nemoclaw/dual-station-controller-uid");
      expect(fs.readFileSync(binding, "utf8")).toBe("1001\n");
      expect(fs.statSync(binding).mode & 0o777).toBe(0o644);
      expect(
        fs
          .readdirSync(path.dirname(binding))
          .filter((name) => name.startsWith(".dual-station-controller-uid.")),
      ).toEqual([]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("never lets an atomic publication loser replace the winner", () => {
    const { home, result, output } = runSourced(`
config_dir="$HOME/etc/nemoclaw"
binding_file="$config_dir/dual-station-controller-uid"
mkdir -p "$HOME/etc"
preparation_controller_uid() { printf '1001\\n'; }
ensure_root_directory_safe() { mkdir -p "$1"; }
assert_root_directory_safe() { [[ -d "$1" ]]; }
root_regular_file_is_safe() { [[ -f "$1" ]]; }
root_directory_is_safe_unprivileged() { [[ -d "$1" ]]; }
root_regular_file_is_safe_unprivileged() { [[ -f "$1" ]]; }
sudo() {
  if [[ "$1" == "chown" ]]; then return 0; fi
  if [[ "$1" == "ln" ]]; then
    printf '1002\\n' >"$binding_file"
    chmod 0644 "$binding_file"
    return 1
  fi
  "$@"
}
ensure_dual_station_controller_uid_binding "$config_dir" "$binding_file"
`);

    try {
      expect(result.status, output).not.toBe(0);
      expect(output).toMatch(/administrator must remove .* before rebinding/);
      expect(
        fs.readFileSync(path.join(home, "etc/nemoclaw/dual-station-controller-uid"), "utf8"),
      ).toBe("1002\n");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects a symlink without modifying its target", () => {
    const { home, result, output } = runSourced(`
config_dir="$HOME/etc/nemoclaw"
binding_file="$config_dir/dual-station-controller-uid"
mkdir -p "$config_dir"
printf 'preserve\\n' >"$HOME/target"
ln -s "$HOME/target" "$binding_file"
preparation_controller_uid() { printf '1001\\n'; }
ensure_root_directory_safe() { :; }
root_directory_is_safe_unprivileged() { return 0; }
sudo() { "$@"; }
ensure_dual_station_controller_uid_binding "$config_dir" "$binding_file"
`);

    try {
      expect(result.status, output).not.toBe(0);
      expect(output).toMatch(/must not be a symbolic link/);
      expect(fs.readFileSync(path.join(home, "target"), "utf8")).toBe("preserve\n");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects an existing mode-0700 configuration directory before creating a binding", () => {
    const { home, result, output } = runSourced(`
config_dir="$HOME/etc/nemoclaw"
binding_file="$config_dir/dual-station-controller-uid"
mkdir -p "$config_dir"
chmod 0700 "$config_dir"
preparation_controller_uid() { printf '1001\\n'; }
ensure_root_directory_safe() { :; }
root_directory_is_safe_unprivileged() { return 1; }
sudo() { printf 'SUDO_AFTER_MODE_CHECK\\n' >&2; return 97; }
ensure_dual_station_controller_uid_binding "$config_dir" "$binding_file"
`);
    try {
      expect(result.status, output).not.toBe(0);
      expect(output).toMatch(/must be root-owned with mode 0755 before binding/);
      expect(output).not.toContain("SUDO_AFTER_MODE_CHECK");
      expect(fs.existsSync(path.join(home, "etc/nemoclaw/dual-station-controller-uid"))).toBe(
        false,
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("fails verification on unsafe binding metadata", () => {
    const { home, result, output } = runSourced(`
root_directory_is_safe_unprivileged() { return 0; }
root_regular_file_is_safe_unprivileged() { return 1; }
verify_dual_station_controller_uid_binding 1001 /etc/nemoclaw /etc/nemoclaw/dual-station-controller-uid
`);
    try {
      expect(result.status, output).not.toBe(0);
      expect(output).toMatch(/root-owned regular file with mode 0644/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("verifies readable root metadata and exact content without invoking sudo", () => {
    const { home, result, output } = runSourced(`
config_dir="$HOME/etc/nemoclaw"
binding_file="$config_dir/dual-station-controller-uid"
mkdir -p "$config_dir"
printf '1001\\n' >"$binding_file"
stat() {
  if [[ "\${@: -1}" == "$config_dir" ]]; then printf '0 0 755\\n'; else printf '0 0 644\\n'; fi
}
sudo() { printf 'SUDO_MUST_NOT_RUN\\n' >&2; return 97; }
verify_dual_station_controller_uid_binding 1001 "$config_dir" "$binding_file"
`);
    try {
      expect(result.status, output).toBe(0);
      expect(output).toContain("dual_station_controller_uid=verified uid=1001");
      expect(output).not.toContain("SUDO_MUST_NOT_RUN");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects root preparation without an original non-root sudo UID", () => {
    const { home, result, output } = runSourced(`preparation_controller_uid_for 0 ''`);
    try {
      expect(result.status, output).not.toBe(0);
      expect(output).toMatch(/must be run by a non-root controller account/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([
    ["direct root", "0", "", "1002", "pid=42 process=openshell"],
    ["non-root controller", "1001", "", "1001", "pid=42 process=openshell"],
    ["another non-root user", "1001", "", "1002", ""],
    ["sudo controller", "0", "1001", "1001", "pid=42 process=openshell"],
    ["another sudo user", "0", "1001", "1002", ""],
  ])("scopes agent conflicts for %s", (_case, effectiveUid, sudoUid, ownerUid, expected) => {
    const { home, result, output } = runSourced(
      `agent_process_conflicts '${ownerUid} 42 1 openshell x' '${effectiveUid}' '${sudoUid}' 99 98`,
    );
    try {
      expect(result.status, output).toBe(0);
      expect(output.trim()).toBe(expected);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("recognizes only the frozen legacy head and routes it around workload preparation", () => {
    const digest =
      "vllm/vllm-openai@sha256:0fec7ec5f3e6bc168e54899935fb0557da908a4832a1dbc88e2debcf2f889416";
    const inspection = ["/nemoclaw-vllm", "true", digest, "true", ...Array(8).fill("-")].join("|");
    const detected = runInstallerBody(
      `command_exists() { return 0; }; docker() { printf '%s\\n' "$INSPECTION"; }; station_migratable_legacy_single_head_running`,
      { INSPECTION: inspection },
    );
    const routed = runInstallerBody(`
_SELECTED_EXPRESS_PLATFORM='DGX Station'
station_dual_model_requested() { return 0; }
station_managed_dual_head_running() { return 1; }
station_migratable_legacy_single_head_running() { return 0; }
run_station_host_preparation() { printf 'FULL_PREP_MUST_NOT_RUN\\n'; return 1; }
ensure_station_express_host
printf 'MIGRATE=%s REUSE=%s\\n' "$_STATION_EXPRESS_MIGRATING_LEGACY_HEAD" "$_STATION_EXPRESS_DEFERRED_MANAGED_PAIR"
`);
    try {
      expect(detected.result.status, detected.output).toBe(0);
      expect(routed.result.status, routed.output).toBe(0);
      expect(routed.output).toContain("MIGRATE=1 REUSE=0");
      expect(routed.output).not.toContain("FULL_PREP_MUST_NOT_RUN");
    } finally {
      fs.rmSync(detected.home, { recursive: true, force: true });
      fs.rmSync(routed.home, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "managed dual",
      [
        "/nemoclaw-vllm",
        "true",
        "true",
        "head",
        "3",
        "c".repeat(64),
        "d".repeat(64),
        "e".repeat(64),
        "f".repeat(32),
      ].join(" "),
      "REUSE=1 MIGRATE=0",
      1,
    ],
    [
      "legacy single",
      [
        "/nemoclaw-vllm",
        "true",
        "vllm/vllm-openai@sha256:0fec7ec5f3e6bc168e54899935fb0557da908a4832a1dbc88e2debcf2f889416",
        "true",
        ...Array(8).fill("-"),
      ].join("|"),
      "REUSE=0 MIGRATE=1",
      2,
    ],
  ] as const)(
    "uses canonical local Docker to preserve a hidden %s head",
    (_kind, localInspection, expectedFlags, expectedInspections) => {
      const { result, output, home } = runInstallerBody(
        `
command_exists() { return 0; }
docker() {
  printf 'host=%s context=%s args=%s,%s\n' "\${DOCKER_HOST-unset}" "\${DOCKER_CONTEXT-unset}" "$1" "$2" >>"$HOME/docker.trace"
  if [[ "\${DOCKER_HOST+x}" != x && "\${DOCKER_CONTEXT+x}" != x && "$1" == --context && "$2" == default ]]; then
    printf '%s\n' "$LOCAL_DOCKER_INSPECTION"
  fi
}
station_dual_model_requested() { return 0; }
run_station_host_preparation() { printf 'FULL_PREP_MUST_NOT_RUN\n'; return 97; }
_SELECTED_EXPRESS_PLATFORM='DGX Station'
ensure_station_express_host
printf 'REUSE=%s MIGRATE=%s\n' "$_STATION_EXPRESS_DEFERRED_MANAGED_PAIR" "$_STATION_EXPRESS_MIGRATING_LEGACY_HEAD"
`,
        {
          DOCKER_CONTEXT: "ambient-remote",
          DOCKER_HOST: "ssh://remote-builder.example.test",
          LOCAL_DOCKER_INSPECTION: localInspection,
        },
      );
      try {
        expect(result.status, output).toBe(0);
        expect(output).toContain(expectedFlags);
        expect(output).not.toContain("FULL_PREP_MUST_NOT_RUN");
        expect(fs.readFileSync(path.join(home, "docker.trace"), "utf8")).toBe(
          "host=unset context=unset args=--context,default\n".repeat(expectedInspections),
        );
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it("passes legacy migration to the coordinator without managed-pair reuse", () => {
    const argsFile = path.join(os.tmpdir(), `nemoclaw-legacy-args-${process.pid}-${Date.now()}`);
    const { home, result, output } = runInstallerBody(
      `
node() {
  if [[ "\${1:-}" == "--no-warnings" ]]; then
    printf '%s\\n' "$*" >"$ARGS_FILE"
    printf '%s\\n' '{"kind":"single-station","reason":"fixture"}'
    return 0
  fi
  command node "$@"
}
station_installer_revision() { printf '%040d' 0; }
_SELECTED_EXPRESS_PLATFORM='DGX Station'
_STATION_EXPRESS_MODEL_WAS_EXPLICIT=0
_STATION_INSTALL_MODE='express'
_STATION_EXPRESS_DEFERRED_MANAGED_PAIR=0
_STATION_EXPRESS_MIGRATING_LEGACY_HEAD=1
NEMOCLAW_VLLM_MODEL='nemotron-3-ultra-550b-a55b'
unset NEMOCLAW_DGX_STATION_PEER
ensure_station_express_pair
`,
      { ARGS_FILE: argsFile },
    );
    try {
      expect(result.status, output).not.toBe(0);
      const args = fs.readFileSync(argsFile, "utf8");
      expect(args).toContain("--migrate-legacy-single-head");
      expect(args).not.toContain("--reuse-existing-managed-pair");
      expect(output).toMatch(/legacy single-Station head.*refusing migration/u);
    } finally {
      fs.rmSync(argsFile, { force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("qualifies before install/onboarding and clears pair state only after success", () => {
    const success = runInstallerOrderHarness(0);
    const failure = runInstallerOrderHarness(1);
    try {
      expect(success.result.status, success.output).toBe(0);
      expect(fs.readFileSync(path.join(success.home, "order.trace"), "utf8")).toBe(
        "qualify\ninstall\nonboard\nfinalize\nclear\n",
      );

      expect(failure.result.status, failure.output).not.toBe(0);
      expect(fs.readFileSync(path.join(failure.home, "order.trace"), "utf8")).toBe(
        "qualify\ninstall\nonboard\n",
      );
    } finally {
      fs.rmSync(success.home, { recursive: true, force: true });
      fs.rmSync(failure.home, { recursive: true, force: true });
    }
  });
});
