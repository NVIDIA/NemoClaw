// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { INSTALLER_PAYLOAD, TEST_SYSTEM_PATH } from "./installer-sourced-env";

export type InstallerExpressPtyFixture =
  | {
      mode: "post-exit-tail";
      pidFile: string;
      timeoutSeconds?: number;
    }
  | {
      mode: "timeout";
      timeoutSeconds?: number;
    };

const DEFAULT_INSTALLER_EXPRESS_PTY_HARNESS_MODE: "installer" = "installer";

export function runExpressPromptWithTty(
  answer: string,
  stdinMode: "pipe" | "tty",
  platform = "DGX Spark",
  extraEnv: Record<string, string> = {},
  entrypoint: "prompt" | "accepted-station-main" | "n1x-standard-main" = "prompt",
  entrypointArgs: string[] = [],
  harnessFixture?: InstallerExpressPtyFixture,
) {
  const python =
    spawnSync("bash", ["--noprofile", "--norc", "-c", "command -v python3"], {
      encoding: "utf-8",
    }).stdout.trim() || "python3";
  const ptyRunner = `
import errno
import os
import pty
import select
import signal
import sys
import time

installer = sys.argv[1]
answer = sys.argv[2].encode()
stdin_mode = sys.argv[3]
platform = sys.argv[4]
entrypoint = sys.argv[5]
harness_mode = sys.argv[6]
timeout_seconds = float(sys.argv[7])
pid_file = sys.argv[8]
entrypoint_args = sys.argv[9:]
if entrypoint == "n1x-standard-main":
    script = r'''
source "$INSTALLER_UNDER_TEST" >/dev/null
node() { ${JSON.stringify(process.execPath)} "$@"; }
detect_express_platform() { printf "$EXPRESS_PLATFORM"; }
validate_express_platform_boundary() { :; }
validate_force_station_install_override() { :; }
validate_station_deepseek_override() { :; }
describe_express_install() { :; }
load_station_vllm_conflict_helpers() { :; }
consume_station_local_vllm_resume() { return 1; }
resolve_nemoclaw_gateway_port() { printf '8080'; }
preflight_explicit_express_flags() { :; }
print_banner() { :; }
preflight_usage_notice_prompt() { :; }
validate_station_pair_selection() { :; }
ensure_station_express_host() { :; }
prepare_portable_experimental_runtime_override() { :; }
installer_requires_legacy_docker_bootstrap() { return 1; }
ensure_openshell_build_deps() { :; }
step() { :; }
show_usage_notice() { :; }
nemoclaw_state_dir() { printf '%s' "$HOME/state"; }
registered_sandbox_count() { printf '0'; }
recover_preexisting_sandboxes_before_onboard() {
  _PREEXISTING_SANDBOX_RECOVERY_RAN=false
  return 0
}
restore_onboard_forward_after_post_checks() { return 0; }
finalize_install() { :; }
clear_station_resume_after_completed_onboarding() { :; }
repair_installer_nvidia_cdi_spec() { :; }
install_nemoclaw_before_onboarding() {
  repo_root="$(cd "$(dirname "$INSTALLER_UNDER_TEST")/.." && pwd)"
  NEMOCLAW_SOURCE_ROOT="$PWD/source"
  onboard_dir="$NEMOCLAW_SOURCE_ROOT/dist/lib/onboard"
  readiness_dir="$NEMOCLAW_SOURCE_ROOT/dist/lib/readiness"
  provider_dir="$onboard_dir/inference-providers"
  mkdir -p "$onboard_dir/experimental" "$readiness_dir" "$provider_dir"
  printf '%s\n' \
    'exports.assessHost = () => ({ runtime: "docker", isWsl: false });' \
    'exports.planHostAdvisories = () => [];' \
    >"$onboard_dir/preflight.js"
  printf '%s\n' \
    'exports.loadGatewayManagementDeclaration = () => ({ ok: true, declaration: null });' \
    >"$onboard_dir/gateway-management.js"
  printf '%s\n' \
    'exports.configuredRuntimeProviderOwnsHostReadiness = () => false;' \
    >"$onboard_dir/docker-driver-gateway-env.js"
  printf '%s\n' \
    'exports.isPortableExperimentalProfile = () => false;' \
    >"$onboard_dir/experimental/portable-profile.js"
  printf '%s\n' \
    'exports.createHostReadinessReport = () => ({' \
    '  schemaVersion: "1.1.0", status: "incompatible", exitCode: 2, observations: [],' \
    '  capabilities: [' \
    '    { id: "host.docker.available", state: "present" },' \
    '    { id: "host.docker.daemon_reachable", state: "present" },' \
    '    { id: "host.docker.runtime_supported", state: "present" },' \
    '    { id: "host.docker.storage_compatible", state: "present" },' \
    '    { id: "host.gpu.nvidia_available", state: "present" },' \
    '    { id: "host.gpu.container_toolkit_available", state: "present" },' \
    '    { id: "host.gpu.cdi_healthy", state: "present" },' \
    '    { id: "host.platform.supported", state: "absent" },' \
    '    { id: "host.platform.n1x", state: "present" },' \
    '  ],' \
    '  findings: [{ id: "host.platform.n1x_validation_pending", severity: "blocking", summary: "N1x validation pending" }],' \
    '});' \
    >"$readiness_dir/host.js"
  cp "$repo_root/dist/lib/readiness/onboard-admission.js" "$readiness_dir/onboard-admission.js"
  cp "$repo_root/dist/lib/onboard/inference-providers/provider-selection-keys.js" \
    "$provider_dir/provider-selection-keys.js"
  fake_cli="$PWD/nemoclaw-under-test"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'printf "ONBOARD NO_EXPRESS=%s PROVIDER=%s ARGS=%s\\n" "\${NEMOCLAW_NO_EXPRESS:-}" "\${NEMOCLAW_PROVIDER:-}" "$*"' \
    >"$fake_cli"
  chmod +x "$fake_cli"
  _CLI_BIN="nemoclaw"
  _CLI_PATH="$fake_cli"
}
main "$@"
'''
elif entrypoint == "accepted-station-main":
    script = r'''
source "$INSTALLER_UNDER_TEST" >/dev/null
detect_express_platform() { printf "$EXPRESS_PLATFORM"; }
print_banner() { :; }
ensure_docker() { :; }
ensure_openshell_build_deps() { :; }
# Stop immediately after the real Station express prompt configures its recipe,
# before setup-jetson.sh or any installation side effect can run.
classify_dgx_station_release() { printf "%s" "\${EXPRESS_RELEASE_STATE:-generic-ubuntu}"; }
station_installer_revision() { printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; }
station_express_resume_generation() { printf '0123456789abcdef0123456789abcdef'; }
bash() {
  printf "RESULT NON_INTERACTIVE=%s SUDO_MODE=%s PROVIDER=%s MODEL=%s VLLM_MODEL=%s POLICY=%s YES=%s SANDBOX=%s STATION_EXPRESS=%s PROFILE_GATE=%s PROFILE_RUNTIME=%s SPARK_SELECTION=%s NO_EXPRESS=%s\\n" \
    "\${NON_INTERACTIVE:-}" "\${NEMOCLAW_NON_INTERACTIVE_SUDO_MODE:-}" "\${NEMOCLAW_PROVIDER:-}" "\${NEMOCLAW_MODEL:-}" \
    "\${NEMOCLAW_VLLM_MODEL:-}" "\${NEMOCLAW_POLICY_MODE:-}" "\${NEMOCLAW_YES:-}" "\${NEMOCLAW_SANDBOX_NAME:-}" \
    "\${NEMOCLAW_STATION_EXPRESS:-}" "\${NEMOCLAW_ENABLE_LOCAL_MODEL_PROFILE:-}" "\${NEMOCLAW_LOCAL_MODEL_RUNTIME:-}" \
    "\${_SPARK_EXPRESS_INFERENCE_SELECTION:-}" "\${NEMOCLAW_NO_EXPRESS:-}"
  exit 0
}
main "$@"
'''
else:
    script = r'''
source "$INSTALLER_UNDER_TEST" >/dev/null
detect_express_platform() { printf "$EXPRESS_PLATFORM"; }
classify_dgx_station_release() { printf "%s" "\${EXPRESS_RELEASE_STATE:-generic-ubuntu}"; }
NON_INTERACTIVE="\${NON_INTERACTIVE:-}"
NEMOCLAW_PROVIDER="\${NEMOCLAW_PROVIDER:-}"
NEMOCLAW_NO_EXPRESS="\${NEMOCLAW_NO_EXPRESS:-}"
if [ "\${FORCE_EXPRESS_PROMPT_READ_FAILURE:-}" = "1" ]; then
  read() { return 1; }
fi
maybe_offer_express_install
printf "RESULT NON_INTERACTIVE=%s SUDO_MODE=%s PROVIDER=%s MODEL=%s VLLM_MODEL=%s POLICY=%s YES=%s SANDBOX=%s STATION_EXPRESS=%s PROFILE_GATE=%s PROFILE_RUNTIME=%s SPARK_SELECTION=%s NO_EXPRESS=%s\\n" \\
  "\${NON_INTERACTIVE:-}" "\${NEMOCLAW_NON_INTERACTIVE_SUDO_MODE:-}" "\${NEMOCLAW_PROVIDER:-}" "\${NEMOCLAW_MODEL:-}" \\
  "\${NEMOCLAW_VLLM_MODEL:-}" "\${NEMOCLAW_POLICY_MODE:-}" "\${NEMOCLAW_YES:-}" "\${NEMOCLAW_SANDBOX_NAME:-}" \\
  "\${NEMOCLAW_STATION_EXPRESS:-}" "\${NEMOCLAW_ENABLE_LOCAL_MODEL_PROFILE:-}" "\${NEMOCLAW_LOCAL_MODEL_RUNTIME:-}" \\
  "\${_SPARK_EXPRESS_INFERENCE_SELECTION:-}" "\${NEMOCLAW_NO_EXPRESS:-}"
'''
env = dict(os.environ)
env["INSTALLER_UNDER_TEST"] = installer
env["EXPRESS_PLATFORM"] = platform
pid, fd = pty.fork()
if pid == 0:
    if harness_mode == "post-exit-tail":
        os.write(1, b"PTY_POST_EXIT_TAIL\\n")
        with open(pid_file, "w", encoding="utf-8") as marker:
            marker.write(str(os.getpid()))
        os._exit(0)
    if harness_mode == "timeout":
        os.write(1, b"PTY_TIMEOUT_STARTED\\n")
        while True:
            signal.pause()
    if stdin_mode == "pipe":
        devnull = os.open(os.devnull, os.O_RDONLY)
        os.dup2(devnull, 0)
        os.close(devnull)
    os.execvpe("bash", ["bash", "-c", script, "nemoclaw-express-prompt", *entrypoint_args], env)

output = bytearray()
os.set_blocking(fd, False)
sent = False
exit_code = 124
deadline = time.monotonic() + timeout_seconds
pty_closed = False
# Leave unread PTY bytes after the first read so this fixture exercises the post-exit drain.
read_size = 1 if harness_mode == "post-exit-tail" else 4096

if harness_mode == "post-exit-tail":
    while not os.path.exists(pid_file):
        if time.monotonic() > deadline:
            raise TimeoutError("PTY tail fixture did not start")
        time.sleep(0.01)
    time.sleep(0.05)

def read_output():
    try:
        chunk = os.read(fd, read_size)
    except BlockingIOError:
        return False
    except OSError as error:
        if error.errno == errno.EIO:
            return True
        raise
    if not chunk:
        return True
    output.extend(chunk)
    return False

while True:
    if not pty_closed:
        ready, _, _ = select.select([fd], [], [], 0.1)
        if ready:
            pty_closed = read_output()
        spark_choice_ready = (
            b"Choose the DGX Spark inference setup" in output
            and b"Choose 1 or 2 [1]:" in output
        )
        if (not sent) and (spark_choice_ready or b"[Y/n]" in output):
            os.write(fd, answer)
            sent = True
    if pty_closed:
        waited = os.waitpid(pid, os.WNOHANG)
        if waited[0] == pid:
            exit_code = os.waitstatus_to_exitcode(waited[1])
            break
        time.sleep(0.01)
    if time.monotonic() > deadline:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        drain_deadline = time.monotonic() + 1.0
        while not pty_closed and time.monotonic() < drain_deadline:
            ready, _, _ = select.select([fd], [], [], 0.05)
            if ready:
                pty_closed = read_output()
        waited_pid, _ = os.waitpid(pid, 0)
        if waited_pid == pid:
            output.extend(b"PTY_CHILD_REAPED\\n")
        break

try:
    os.close(fd)
except OSError:
    pass
sys.stdout.buffer.write(output)
sys.exit(exit_code)
`;
  const harnessMode: InstallerExpressPtyFixture["mode"] | "installer" =
    harnessFixture?.mode ?? DEFAULT_INSTALLER_EXPRESS_PTY_HARNESS_MODE;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-express-prompt-"));
  try {
    const result = spawnSync(
      python,
      [
        "-c",
        ptyRunner,
        INSTALLER_PAYLOAD,
        answer,
        stdinMode,
        platform,
        entrypoint,
        harnessMode,
        String(harnessFixture?.timeoutSeconds ?? 10),
        harnessFixture?.mode === "post-exit-tail" ? harnessFixture.pidFile : "",
        ...entrypointArgs,
      ],
      {
        cwd: tmp,
        encoding: "utf-8",
        timeout: 15_000,
        killSignal: "SIGKILL",
        env: {
          HOME: tmp,
          PATH: TEST_SYSTEM_PATH,
          ...extraEnv,
        },
      },
    );
    return Object.assign(result, { temporaryDirectory: tmp });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
