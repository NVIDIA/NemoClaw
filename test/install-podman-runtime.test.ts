// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

const INSTALLER = path.join(import.meta.dirname, "..", "scripts", "install.sh");

function runSourced(
  body: string,
  env: Record<string, string> = {},
): { output: string; status: number | null } {
  const result = spawnSync(
    "bash",
    [
      "-c",
      `
set -euo pipefail
source "${INSTALLER}" >/dev/null
error() { printf 'ERROR:%s\\n' "$*" >&2; exit 1; }
info() { printf 'INFO:%s\\n' "$*"; }
ok() { printf 'OK:%s\\n' "$*"; }
${body}
`,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, ...env },
    },
  );
  return { output: `${result.stdout}${result.stderr}`, status: result.status };
}

const PODMAN_STUB = String.raw`
uname() {
  if [ "\${1:-}" = "-m" ]; then printf '%s\n' "\${TEST_ARCH:-x86_64}"; else printf '%s\n' "\${TEST_OS:-Linux}"; fi
}
command_exists() { [ "$1" = "podman" ]; }
podman_socket_is_owned_by_current_user() { [ "\${TEST_SOCKET_OK:-1}" = "1" ]; }
docker() { printf 'DOCKER_INVOKED\n' >&2; exit 97; }
podman() {
  case "$*" in
    "--version")
      printf 'podman version %s\n' "\${TEST_PODMAN_VERSION:-5.6.2}"
      ;;
    "--url "*" info --format json")
      printf '{"host":{"arch":"%s","os":"%s","cgroupVersion":"%s","security":{"rootless":%s}}}\n' \
        "\${TEST_SERVICE_ARCH:-amd64}" "\${TEST_SERVICE_OS:-linux}" \
        "\${TEST_CGROUP:-v2}" "\${TEST_ROOTLESS:-true}"
      ;;
    "unshare cat /proc/self/uid_map")
      printf '%b' "\${TEST_UID_MAP:-0 1000 1\\n1 100000 65536\\n}"
      ;;
    "unshare cat /proc/self/gid_map")
      printf '%b' "\${TEST_GID_MAP:-0 1000 1\\n1 100000 65536\\n}"
      ;;
    *)
      printf 'unexpected podman invocation: %s\n' "$*" >&2
      exit 98
      ;;
  esac
}
_INSTALLER_CONTAINER_RUNTIME=podman
OPENSHELL_PODMAN_SOCKET=/run/user/1000/podman/podman.sock
`.replaceAll("\\${", "${");

function runMainRuntimeBoundaries(options: {
  flag?: "auto" | "podman";
  envDriver?: "docker" | "podman" | "";
}): { output: string; status: number | null } {
  const driverArg = options.flag ? `--compute-driver ${JSON.stringify(options.flag)}` : "";
  return runSourced(
    `
events=""
record() { events="\${events}\${events:+,}$1"; }
uname() {
  if [ "\${1:-}" = "-m" ]; then printf 'x86_64\\n'; else printf 'Linux\\n'; fi
}
load_station_vllm_conflict_helpers() { record station-conflict; }
consume_station_local_vllm_resume() { record station-resume; return 1; }
preflight_explicit_express_flags() { record station-classification; }
resolve_nemoclaw_gateway_port() { printf '18789\\n'; }
print_banner() { :; }
preflight_usage_notice_prompt() { :; }
maybe_offer_express_install() { record station-express; }
validate_station_pair_selection() { record station-selection; }
ensure_station_express_host() { record station-host; }
ensure_docker() { record docker; }
ensure_native_podman() {
  record podman
  OPENSHELL_PODMAN_SOCKET=/runtime/podman.sock
  export OPENSHELL_PODMAN_SOCKET
}
ensure_openshell_build_deps() { record build-deps; }
bash() { record jetson; }
step() { :; }
install_nodejs() { :; }
ensure_supported_runtime() { :; }
ensure_station_express_pair() { record station-pair; }
fix_npm_permissions() { :; }
preinstall_backup_and_retire_legacy_gateway() { :; }
install_nemoclaw() { :; }
verify_nemoclaw() { _CLI_PATH=/usr/bin/true; }
require_reportable_openshell_version() { :; }
registered_sandbox_count() { printf '1\\n'; }
run_installer_host_preflight() {
  installer_uses_native_podman && return 0
  record cdi
}
recover_preexisting_sandboxes_before_onboard() {
  _PREEXISTING_SANDBOX_RECOVERY_RAN=true
  return 0
}
station_express_receipt_retirement_pending() {
  record station-reconcile
  return 1
}
run_onboard() { record station-onboard; }
print_done() { :; }
clear_station_local_vllm_resume() { record station-local-clear; }
clear_station_resume_after_completed_onboarding() { record station-final-clear; }
command_exists() { return 1; }
_CLI_BIN=nemoclaw-test
_STATION_LOCAL_VLLM_SELECTED=1
_PREEXISTING_SANDBOX_ORPHANED=false
main --non-interactive --yes-i-accept-third-party-software ${driverArg}
printf 'events=%s request=%s runtime=%s exported=%s\\n' \
  "$events" "$_INSTALLER_COMPUTE_DRIVER_REQUEST" \
  "$_INSTALLER_CONTAINER_RUNTIME" "$NEMOCLAW_COMPUTE_DRIVER"
`,
    { NEMOCLAW_COMPUTE_DRIVER: options.envDriver ?? "" },
  );
}

describe("install.sh native Podman runtime selection", () => {
  it("publishes and parses the installer compute-driver option", () => {
    const help = spawnSync("bash", [INSTALLER, "--help"], {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    const invalid = spawnSync("bash", [INSTALLER, "--compute-driver", "container"], {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    });

    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain("--compute-driver <auto|docker|podman>");
    expect(help.stdout).toContain("NEMOCLAW_COMPUTE_DRIVER");
    expect(invalid.status).toBe(1);
    expect(`${invalid.stdout}${invalid.stderr}`).toContain(
      "NEMOCLAW_COMPUTE_DRIVER and --compute-driver must be one of: auto, docker, podman",
    );
  });

  it.each([
    ["unset request", {}, "", "auto", "docker"],
    ["environment request", { NEMOCLAW_COMPUTE_DRIVER: " PODMAN " }, "", "podman", "podman"],
    ["flag precedence", { NEMOCLAW_COMPUTE_DRIVER: "podman" }, "docker", "docker", "docker"],
  ])("resolves %s with the onboard flag/environment precedence", (_name, env, flag, request, runtime) => {
    const result = runSourced(
      `
INSTALLER_COMPUTE_DRIVER_FLAG=${JSON.stringify(flag)}
resolve_installer_compute_driver
printf 'request=%s runtime=%s exported=%s\\n' \
  "$_INSTALLER_COMPUTE_DRIVER_REQUEST" "$_INSTALLER_CONTAINER_RUNTIME" "$NEMOCLAW_COMPUTE_DRIVER"
`,
      env,
    );

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain(`request=${request} runtime=${runtime} exported=${request}`);
  });

  it("rejects unknown runtime requests before host preparation", () => {
    const result = runSourced(`
INSTALLER_COMPUTE_DRIVER_FLAG=container
resolve_installer_compute_driver
printf 'MUTATED\\n'
`);

    expect(result.status).toBe(1);
    expect(result.output).toContain(
      "NEMOCLAW_COMPUTE_DRIVER and --compute-driver must be one of: auto, docker, podman",
    );
    expect(result.output).not.toContain("MUTATED");
  });

  it("qualifies Podman 5, its exact rootless socket, cgroups v2, and subordinate IDs", () => {
    const result = runSourced(`${PODMAN_STUB}
ensure_native_podman
printf 'socket=%s\\n' "$OPENSHELL_PODMAN_SOCKET"
`);

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("Rootless Podman 5.6.2 is ready");
    expect(result.output).toContain("socket=/run/user/1000/podman/podman.sock");
    expect(result.output).not.toContain("DOCKER_INVOKED");
  });

  it.each([
    [{ TEST_PODMAN_VERSION: "4.9.9" }, "requires Podman 5.0 or newer"],
    [{ TEST_ROOTLESS: "false" }, "requires a rootless Podman API service"],
    [{ TEST_CGROUP: "v1" }, "requires cgroups v2"],
    [{ TEST_SERVICE_OS: "darwin" }, "service is not reporting Linux"],
    [{ TEST_SERVICE_ARCH: "arm64" }, "service is not reporting x86_64"],
    [{ TEST_UID_MAP: "0 1000 1\\n" }, "subordinate UID range"],
    [{ TEST_GID_MAP: "0 1000 1\\n" }, "subordinate GID range"],
    [{ TEST_SOCKET_OK: "0" }, "current-user-owned, non-symlink Unix socket"],
  ])("fails closed when the Podman contract is incomplete: %s", (env, message) => {
    const result = runSourced(
      `${PODMAN_STUB}
ensure_native_podman
`,
      env,
    );

    expect(result.status).toBe(1);
    expect(result.output).toContain(message);
    expect(result.output).not.toContain("DOCKER_INVOKED");
  });

  it("rejects Podman outside Linux x86_64 before invoking a runtime", () => {
    const result = runSourced(
      `${PODMAN_STUB}
validate_installer_compute_driver_platform
`,
      { TEST_ARCH: "arm64" },
    );

    expect(result.status).toBe(1);
    expect(result.output).toContain("requires Linux x86_64; detected Linux arm64");
    expect(result.output).not.toContain("DOCKER_INVOKED");
  });

  it("skips every Docker/Station preparation boundary for Podman", () => {
    const result = runSourced(`
events=""
record() { events="\${events}\${events:+,}$1"; }
ensure_native_podman() { record podman; export OPENSHELL_PODMAN_SOCKET=/runtime/podman.sock; }
ensure_openshell_build_deps() { record build-deps; }
maybe_offer_express_install() { record express; }
validate_station_pair_selection() { record station-selection; }
ensure_station_express_host() { record station-host; }
ensure_docker() { record docker; return 97; }
_INSTALLER_CONTAINER_RUNTIME=podman
prepare_installer_host
run_installer_platform_setup
run_installer_host_preflight
printf 'events=%s\\n' "$events"
`);

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("events=podman,build-deps");
    expect(result.output).not.toMatch(/events=.*(?:docker|express|station)/);
  });

  it("preserves the existing Docker preparation path for auto/default installs", () => {
    const result = runSourced(`
events=""
record() { events="\${events}\${events:+,}$1"; }
maybe_offer_express_install() { record express; }
validate_station_pair_selection() { record station-selection; }
ensure_station_express_host() { record station-host; }
ensure_docker() { record docker; }
ensure_openshell_build_deps() { record build-deps; }
_INSTALLER_CONTAINER_RUNTIME=docker
prepare_installer_host
printf 'events=%s\\n' "$events"
`);

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain(
      "events=express,station-selection,station-host,docker,build-deps",
    );
  });

  it.each([
    ["the unset default", undefined, "", "auto"],
    ["an explicit auto flag over Podman env", "auto", "podman", "auto"],
  ] as const)("keeps every main-level Docker/Station boundary for %s", (_name, flag, envDriver, request) => {
    const result = runMainRuntimeBoundaries({ envDriver, flag });

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain(
      "events=station-conflict,station-resume,station-classification,station-express," +
        "station-selection,station-host,docker,build-deps,jetson,station-pair,cdi," +
        "station-reconcile,station-local-clear,station-final-clear",
    );
    expect(result.output).toContain(`request=${request} runtime=docker exported=${request}`);
    expect(result.output).not.toContain("events=podman");
  });

  it("bypasses every main-level Docker/Station boundary for explicit Podman", () => {
    const result = runMainRuntimeBoundaries({
      envDriver: "docker",
      flag: "podman",
    });

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain(
      "events=podman,build-deps request=podman runtime=podman exported=podman",
    );
    expect(result.output).not.toMatch(
      /events=.*(?:docker|station|jetson|cdi|express|conflict|reconcile)/,
    );
  });

  it("forwards the installer selection to the actual onboard command", () => {
    const result = runSourced(`
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cli="$tmp/nemoclaw"
argv="$tmp/argv"
printf '#!/usr/bin/env bash\\nprintf \"%%s\\\\n\" \"$@\" > %q\\n' "$argv" >"$cli"
chmod 755 "$cli"
_CLI_BIN=nemoclaw
_CLI_PATH="$cli"
_INSTALLER_COMPUTE_DRIVER_REQUEST=podman
NON_INTERACTIVE=1
ACCEPT_THIRD_PARTY_SOFTWARE=1
show_usage_notice() { :; }
command_exists() { return 1; }
nemoclaw_state_dir() { printf '%s' "$tmp"; }
run_onboard
printf '%s\\n' "\$(paste -sd, "$argv")"
`);

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("onboard,--compute-driver,podman,--non-interactive");
  });
});
