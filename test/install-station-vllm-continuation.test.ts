// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { INSTALLER_PAYLOAD, TEST_SYSTEM_PATH } from "./helpers/installer-sourced-env";

function runInstallerSourced(body: string, existingHome?: string) {
  const home = existingHome ?? fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-vllm-resume-"));
  const result = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-c", `source "$INSTALLER_UNDER_TEST" >/dev/null\n${body}`],
    {
      cwd: path.resolve(import.meta.dirname, ".."),
      encoding: "utf-8",
      env: {
        HOME: home,
        PATH: TEST_SYSTEM_PATH,
        INSTALLER_UNDER_TEST: INSTALLER_PAYLOAD,
      },
    },
  );
  return { home, result, output: `${result.stdout}${result.stderr}` };
}

describe("installer Station Local vLLM continuation", () => {
  it("preserves the Local vLLM choice for one installer continuation", () => {
    const { home, result, output } = runInstallerSourced(`
_SELECTED_EXPRESS_PLATFORM='DGX Station'
load_station_vllm_conflict_helpers
_NEMOCLAW_INSTALLER_ARGS=(--force-station-install --yes-i-accept-third-party-software)
NON_INTERACTIVE=1
NON_INTERACTIVE_SOURCE='Station Express'
NEMOCLAW_NON_INTERACTIVE=1
NEMOCLAW_NON_INTERACTIVE_SUDO_MODE=prompt
NEMOCLAW_YES=1
NEMOCLAW_POLICY_MODE=suggested
NEMOCLAW_STATION_EXPRESS=1
NEMOCLAW_PROVIDER=install-vllm
NEMOCLAW_MODEL='nvidia/nemotron-3-ultra-550b-a55b'
NEMOCLAW_VLLM_MODEL='nemotron-3-ultra-550b-a55b'
NEMOCLAW_GATEWAY_PORT=18081
NEMOCLAW_DASHBOARD_PORT=18790
NEMOCLAW_VLLM_PORT=18000
station_installer_revision() { printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; }
station_express_resume_generation() { printf '0123456789abcdef0123456789abcdef'; }
station_existing_vllm_model() { printf 'existing/model'; }
express_prompt_can_read_tty() { return 0; }
read_station_vllm_conflict_choice() { printf '2'; }
classify_dgx_station_release() { printf 'supported-ai-developer-tools'; }
run_station_host_preparation() { return 12; }
ensure_station_express_host
printf 'STATE selected=%s noninteractive=%s provider=%s model=%s station=%s yes=%s policy=%s\n' \
  "\${_SELECTED_EXPRESS_PLATFORM:-}" "\${NON_INTERACTIVE:-}" "\${NEMOCLAW_PROVIDER:-}" \
  "\${NEMOCLAW_MODEL:-}" "\${NEMOCLAW_STATION_EXPRESS:-}" "\${NEMOCLAW_YES:-}" \
  "\${NEMOCLAW_POLICY_MODE:-}"
printf 'CONTINUATION no_express=%s args=%s\n' \
  "\${NEMOCLAW_NO_EXPRESS:-}" "\${_NEMOCLAW_INSTALLER_ARGS[*]:-}"
`);

    expect(result.status, output).toBe(0);
    expect(output).toContain(
      "Continuing with advanced manual Local vLLM setup. The existing workload remains unchanged.",
    );
    expect(output).toContain(
      "STATE selected= noninteractive= provider= model= station= yes= policy=",
    );
    expect(output).toContain("CONTINUATION no_express=1 args=--yes-i-accept-third-party-software");
    expect(
      fs.existsSync(path.join(home, ".nemoclaw", "gateways", "18081", "station-express-resume")),
    ).toBe(false);
    expect(fs.existsSync(path.join(home, ".nemoclaw", "station-local-vllm-resume"))).toBe(true);

    const resumed = runInstallerSourced(
      `
detect_express_platform() { printf 'DGX Station'; }
print_banner() { :; }
preflight_usage_notice_prompt() { :; }
load_station_vllm_conflict_helpers
ps() { printf '219655 1 docker-init docker-init -- /usr/bin/vllm serve hidden-model\n'; }
station_existing_vllm_model() { return 1; }
ensure_docker() {
  printf 'RESUMED no_express=%s force=%s args=%s gateway=%s vllm=%s\n' \
    "$NEMOCLAW_NO_EXPRESS" "\${FORCE_STATION_INSTALL:-}" "\${_NEMOCLAW_INSTALLER_ARGS[*]:-}" \
    "$NEMOCLAW_GATEWAY_PORT" "$NEMOCLAW_VLLM_PORT"
  exit 0
}
ensure_openshell_build_deps() { :; }
main --force-station-install --yes-i-accept-third-party-software
`,
      home,
    );

    expect(resumed.result.status, resumed.output).toBe(0);
    expect(resumed.output).toContain(
      "RESUMED no_express=1 force= args=--yes-i-accept-third-party-software gateway=18081 vllm=18000",
    );
    expect(resumed.output).toContain("Resuming the selected manual Local vLLM setup");
    expect(resumed.output).toContain("Skipping express prompt (NEMOCLAW_NO_EXPRESS=1)");
    expect(fs.existsSync(path.join(home, ".nemoclaw", "station-local-vllm-resume"))).toBe(false);

    const laterRun = runInstallerSourced(
      `
load_station_vllm_conflict_helpers
if consume_station_local_vllm_resume; then
  printf 'UNEXPECTED_LOCAL_RESUME\n'
else
  printf 'EXPRESS_AVAILABLE\n'
fi
`,
      home,
    );

    expect(laterRun.result.status, laterRun.output).toBe(0);
    expect(laterRun.output).toContain("EXPRESS_AVAILABLE");
    expect(laterRun.output).not.toContain("UNEXPECTED_LOCAL_RESUME");
  });

  it("removes unused Local vLLM continuation state after a successful installer run", () => {
    const { home, result, output } = runInstallerSourced(`
load_station_vllm_conflict_helpers
switch_station_express_to_local_vllm
print_done() { :; }
finalize_install
`);

    expect(result.status, output).toBe(0);
    expect(fs.existsSync(path.join(home, ".nemoclaw", "station-local-vllm-resume"))).toBe(false);
  });

  it("rejects Local vLLM continuation state with group-readable permissions", () => {
    const { result, output } = runInstallerSourced(`
load_station_vllm_conflict_helpers
mkdir -p "$HOME/.nemoclaw"
chmod 0700 "$HOME/.nemoclaw"
printf 'version=1\ngateway_port=8080\nvllm_port=8000\n' \
  >"$HOME/.nemoclaw/station-local-vllm-resume"
chmod 0640 "$HOME/.nemoclaw/station-local-vllm-resume"
consume_station_local_vllm_resume
`);

    expect(result.status, output).not.toBe(0);
    expect(output).toContain("Local vLLM resume state must have mode 0600");
  });

  it("offers Express when the saved Local vLLM workload is no longer active", () => {
    const { home, result, output } = runInstallerSourced(`
load_station_vllm_conflict_helpers
switch_station_express_to_local_vllm
`);

    expect(result.status, output).toBe(0);
    expect(fs.existsSync(path.join(home, ".nemoclaw", "station-local-vllm-resume"))).toBe(true);

    const resumed = runInstallerSourced(
      `
load_station_vllm_conflict_helpers
station_vllm_workload_active() { return 1; }
if consume_station_local_vllm_resume; then
  printf 'UNEXPECTED_LOCAL_RESUME\n'
else
  printf 'EXPRESS_AVAILABLE no_express=%s\n' "\${NEMOCLAW_NO_EXPRESS:-}"
fi
`,
      home,
    );

    expect(resumed.result.status, resumed.output).toBe(0);
    expect(resumed.output).toContain("EXPRESS_AVAILABLE no_express=");
    expect(resumed.output).not.toContain("UNEXPECTED_LOCAL_RESUME");
    expect(fs.existsSync(path.join(home, ".nemoclaw", "station-local-vllm-resume"))).toBe(false);
  });

  it("preserves the Local vLLM choice when Docker access requires a login refresh", () => {
    const { home, result, output } = runInstallerSourced(`
load_station_vllm_conflict_helpers
_NEMOCLAW_INSTALLER_ARGS=(--force-station-install --yes-i-accept-third-party-software)
switch_station_express_to_local_vllm
uname() { printf 'Linux\n'; }
is_wsl_host() { return 1; }
docker() { return 1; }
systemctl() { return 0; }
sudo() { return 0; }
id() {
  case "\${1:-}" in
    -u) printf '1000\n' ;;
    -un) printf 'testuser\n' ;;
    -nG) printf 'testuser sudo\n' ;;
  esac
}
ensure_docker
`);

    expect(result.status, output).toBe(0);
    expect(output).toContain("Re-run: curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash");
    expect(fs.existsSync(path.join(home, ".nemoclaw", "station-local-vllm-resume"))).toBe(true);
  });
});
