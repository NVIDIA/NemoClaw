// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { INSTALLER_PAYLOAD, TEST_SYSTEM_PATH } from "./helpers/installer-sourced-env";

describe("installer express install prompt (sourced)", () => {
  function runInstallerSourced(body: string) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-express-sourced-"));
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
    return { result, output: `${result.stdout}${result.stderr}` };
  }

  function runExpressPromptWithTty(
    answer: string,
    stdinMode: "pipe" | "tty",
    platform = "DGX Spark",
    extraEnv: Record<string, string> = {},
    entrypoint: "prompt" | "accepted-station-main" = "prompt",
    entrypointArgs: string[] = [],
  ) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-express-prompt-"));
    const python =
      spawnSync("bash", ["--noprofile", "--norc", "-c", "command -v python3"], {
        encoding: "utf-8",
      }).stdout.trim() || "python3";
    const ptyRunner = `
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
entrypoint_args = sys.argv[6:]
if entrypoint == "accepted-station-main":
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
  printf "RESULT NON_INTERACTIVE=%s SUDO_MODE=%s PROVIDER=%s MODEL=%s VLLM_MODEL=%s POLICY=%s YES=%s SANDBOX=%s STATION_EXPRESS=%s\\n" \
    "\${NON_INTERACTIVE:-}" "\${NEMOCLAW_NON_INTERACTIVE_SUDO_MODE:-}" "\${NEMOCLAW_PROVIDER:-}" "\${NEMOCLAW_MODEL:-}" \
    "\${NEMOCLAW_VLLM_MODEL:-}" "\${NEMOCLAW_POLICY_MODE:-}" "\${NEMOCLAW_YES:-}" "\${NEMOCLAW_SANDBOX_NAME:-}" \
    "\${NEMOCLAW_STATION_EXPRESS:-}"
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
printf "RESULT NON_INTERACTIVE=%s SUDO_MODE=%s PROVIDER=%s MODEL=%s VLLM_MODEL=%s POLICY=%s YES=%s SANDBOX=%s STATION_EXPRESS=%s\\n" \\
  "\${NON_INTERACTIVE:-}" "\${NEMOCLAW_NON_INTERACTIVE_SUDO_MODE:-}" "\${NEMOCLAW_PROVIDER:-}" "\${NEMOCLAW_MODEL:-}" \\
  "\${NEMOCLAW_VLLM_MODEL:-}" "\${NEMOCLAW_POLICY_MODE:-}" "\${NEMOCLAW_YES:-}" "\${NEMOCLAW_SANDBOX_NAME:-}" \\
  "\${NEMOCLAW_STATION_EXPRESS:-}"
'''
env = dict(os.environ)
env["INSTALLER_UNDER_TEST"] = installer
env["EXPRESS_PLATFORM"] = platform
pid, fd = pty.fork()
if pid == 0:
    if stdin_mode == "pipe":
        devnull = os.open(os.devnull, os.O_RDONLY)
        os.dup2(devnull, 0)
        os.close(devnull)
    os.execvpe("bash", ["bash", "-c", script, "nemoclaw-express-prompt", *entrypoint_args], env)

output = bytearray()
os.set_blocking(fd, False)
sent = False
exit_code = 124
deadline = time.time() + 10
while True:
    ready, _, _ = select.select([fd], [], [], 0.1)
    if ready:
        try:
            chunk = os.read(fd, 4096)
        except BlockingIOError:
            chunk = b""
        except OSError:
            chunk = b""
        if chunk:
            output.extend(chunk)
        if (not sent) and b"[Y/n]" in output:
            os.write(fd, answer)
            sent = True
    waited = os.waitpid(pid, os.WNOHANG)
    if waited[0] == pid:
        exit_code = os.waitstatus_to_exitcode(waited[1])
        break
    if time.time() > deadline:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass
        break

try:
    os.close(fd)
except OSError:
    pass
sys.stdout.buffer.write(output)
sys.exit(exit_code)
`;
    return spawnSync(
      python,
      [
        "-c",
        ptyRunner,
        INSTALLER_PAYLOAD,
        answer,
        stdinMode,
        platform,
        entrypoint,
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
  }

  function detectExpressPlatform(
    productName: string,
    releasePath: string,
    extraEnv: Record<string, string> = {},
  ) {
    return spawnSync(
      "bash",
      [
        "-c",
        `
source "$INSTALLER_UNDER_TEST" >/dev/null
classify_dgx_station_release() {
  if [[ -z "$EXPRESS_DGX_RELEASE_PATH" ]]; then
    bash "$STATION_PREPARE" --classify-dgx-release
    return
  fi
  bash -c '
    source "$STATION_PREPARE" >/dev/null
    dgx_station_release_file_is_safe() { return 0; }
    dgx_station_release_state "$EXPRESS_DGX_RELEASE_PATH"
  '
}
function [ {
  if [[ "$#" -eq 3 && "$1" = "-r" && "$2" = "/sys/class/dmi/id/product_name" && "$3" = "]" ]]; then
    return 0
  fi
  builtin [ "$@"
}
cat() {
  if [[ "$#" -eq 1 && "$1" = "/sys/class/dmi/id/product_name" ]]; then
    printf "%s" "$EXPRESS_PRODUCT_NAME"
    return
  fi
  command cat "$@"
}
is_wsl_host() { return 1; }
detect_express_platform
`,
      ],
      {
        cwd: path.join(import.meta.dirname, ".."),
        encoding: "utf-8",
        env: {
          HOME: fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-express-platform-detect-")),
          PATH: TEST_SYSTEM_PATH,
          INSTALLER_UNDER_TEST: INSTALLER_PAYLOAD,
          STATION_PREPARE: path.join(
            path.resolve(import.meta.dirname, ".."),
            "scripts",
            "prepare-dgx-station-host.sh",
          ),
          EXPRESS_PRODUCT_NAME: productName,
          EXPRESS_DGX_RELEASE_PATH: releasePath,
          ...extraEnv,
        },
      },
    );
  }

  function detectExpressPlatformForProductName(productName: string) {
    return detectExpressPlatform(productName, "");
  }

  function detectExpressPlatformForStockDgxRelease(productName: string, dgxRelease: string) {
    const releasePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dgx-release-")),
      "dgx-release",
    );
    fs.writeFileSync(releasePath, dgxRelease);
    return detectExpressPlatform(productName, releasePath);
  }

  function stockDgxRelease(
    version: string,
    platform = "DGX Server for GALAXY-GB300",
    otaPrettyName: string | null = "DGX OS",
  ) {
    return [
      'DGX_NAME="DGX Server"',
      'DGX_PRETTY_NAME="NVIDIA DGX Server"',
      ...(otaPrettyName === null ? [] : [`DGX_OTA_PRETTY_NAME="${otaPrettyName}"`]),
      `DGX_OTA_VERSION="${version}"`,
      'DGX_OTA_DATE="Mon Jul 13 21:29:13 UTC 2026"',
      `DGX_PLATFORM="${platform}"`,
      'DGX_SERIAL_NUMBER="Unknown"',
      "",
    ].join("\n");
  }

  function noOtaFactoryRelease(profile: "colossus-baseos" | "ai-developer-tools") {
    const identity =
      profile === "colossus-baseos"
        ? {
            pretty: "NVIDIA DGX Server",
            version: "7.5.0-GB300ws-GB200ws",
            buildDate: "2026-04-02-08-20-16",
          }
        : {
            pretty: "NVIDIA DGX GB300WS",
            version: "7.5.0",
            buildDate: "2026-06-16-11-48-10",
          };
    return [
      'DGX_NAME="DGX Server"',
      `DGX_PRETTY_NAME="${identity.pretty}"`,
      `DGX_SWBUILD_DATE="${identity.buildDate}"`,
      `DGX_SWBUILD_VERSION="${identity.version}"`,
      'DGX_PLATFORM="DGX Server for GALAXY-GB300"',
      'DGX_SERIAL_NUMBER="host-specific-value"',
      "",
    ].join("\n");
  }

  it("parses and documents the DGX Station DeepSeek override", () => {
    const result = spawnSync("bash", [INSTALLER_PAYLOAD, "--station-deepseek", "--help"], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf-8",
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(output).toMatch(
      /--station-deepseek\s+Use DeepSeek V4 Flash for DGX Station express install/,
    );
  });

  it("parses and documents the metadata-only Station override", () => {
    const result = spawnSync("bash", [INSTALLER_PAYLOAD, "--force-station-install", "--help"], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf-8",
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(output).toMatch(
      /--force-station-install\s+Bypass only the DGX release-metadata allowlist/,
    );
  });

  it("offers express install when curl-piped stdin still has a controlling TTY", () => {
    const result = runExpressPromptWithTty("y\n", "pipe");
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).toBe(0);
    expect(output).toMatch(/Detected DGX Spark/);
    expect(output).toMatch(
      /Express install will configure managed local vLLM using the DGX Spark profile default model/,
    );
    expect(output).toMatch(
      /Managed vLLM pulls the configured vLLM image\/model and runs a local vLLM inference container/,
    );
    expect(output).toMatch(/Sandbox name: my-assistant/);
    expect(output).toMatch(/Sandbox policy: suggested mode, tier 'balanced'/);
    expect(output).toMatch(/Run express install/);
    expect(output).toMatch(/Using express install for DGX Spark/);
    expect(output).toMatch(
      /RESULT NON_INTERACTIVE=1 SUDO_MODE=prompt PROVIDER=install-vllm MODEL= VLLM_MODEL= POLICY=suggested YES=1 SANDBOX=my-assistant/,
    );
    expect(output).toMatch(/STATION_EXPRESS=\s/);
  });

  it("preserves a preset Spark vLLM model in the prompt and exported env", () => {
    const result = runExpressPromptWithTty("y\n", "pipe", "DGX Spark", {
      NEMOCLAW_VLLM_MODEL: "custom-qwen3.6",
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).toBe(0);
    expect(output).toMatch(/Detected DGX Spark/);
    expect(output).toMatch(
      /Express install will configure managed local vLLM with model custom-qwen3\.6/,
    );
    expect(output).toMatch(
      /Managed vLLM pulls the configured vLLM image\/model and runs a local vLLM inference container/,
    );
    expect(output).toMatch(
      /RESULT NON_INTERACTIVE=1 SUDO_MODE=prompt PROVIDER=install-vllm MODEL= VLLM_MODEL=custom-qwen3\.6 POLICY=suggested YES=1 SANDBOX=my-assistant/,
    );
  });

  it("preserves an explicit NEMOCLAW_SANDBOX_NAME over the DGX Spark default (#6525)", () => {
    const result = runExpressPromptWithTty("y\n", "pipe", "DGX Spark", {
      NEMOCLAW_SANDBOX_NAME: "custom-spark",
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).toBe(0);
    expect(output).toMatch(/Detected DGX Spark/);
    expect(output).toMatch(/Sandbox name: custom-spark/);
    expect(output).toMatch(
      /RESULT NON_INTERACTIVE=1 SUDO_MODE=prompt PROVIDER=install-vllm MODEL= VLLM_MODEL= POLICY=suggested YES=1 SANDBOX=custom-spark/,
    );
  });

  it("uses the Nemotron Ultra recipe without follow-up choices on DGX Station", () => {
    const result = runExpressPromptWithTty("\n", "pipe", "DGX Station");
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).toBe(0);
    expect(output).toMatch(/Detected DGX Station/);
    expect(output).toMatch(
      /Express install will configure managed local vLLM with NVIDIA Nemotron 3 Ultra 550B/,
    );
    expect(output).toMatch(/approximately 352 GB model/);
    expect(output).toMatch(
      /installs missing pinned driver, Docker, and NVIDIA Container Toolkit packages/,
    );
    expect(output).toMatch(/DGX Station remains Deferred/);
    expect(output).toMatch(/Using express install for DGX Station/);
    expect(output).toMatch(
      /RESULT NON_INTERACTIVE=1 SUDO_MODE=prompt PROVIDER=install-vllm MODEL=nvidia\/nemotron-3-ultra-550b-a55b VLLM_MODEL=nemotron-3-ultra-550b-a55b POLICY=suggested YES=1 SANDBOX=my-assistant/,
    );
    expect(output).toMatch(/STATION_EXPRESS=1/);
  });

  it("keeps Station preparation details in the log while showing warnings and errors", () => {
    const { result, output } = runInstallerSourced(`
printf '%s\n' \
  '[station-prepare] 2026-07-17T07:59:07Z version=2026-07-17.4 mode=--apply log=/tmp/station-prepare.log' \
  '[station-prepare] 2026-07-17T07:59:07Z platform=Dell Pro Max with Station GB300 profile=generic-ubuntu' \
  '[station-prepare] 2026-07-17T07:59:08Z WARNING: condition-qualified generic-image failed unit: cloud-init.service' \
  'NVIDIA-SMI 610.43.02' \
  '[station-prepare] 2026-07-17T07:59:20Z ERROR: example failure' \
  | filter_station_host_preparation_output
`);

    expect(result.status, output).toBe(0);
    expect(output).toContain("DGX Station host preparation log: /tmp/station-prepare.log");
    expect(output).toContain("condition-qualified generic-image failed unit: cloud-init.service");
    expect(output).toContain("ERROR: example failure");
    expect(output).not.toMatch(/platform=Dell Pro Max|NVIDIA-SMI/);
  });

  it("preserves the Station helper exit status while filtering installer output", () => {
    const { result, output } = runInstallerSourced(`
bash() {
  printf '%s\n' \
    '[station-prepare] 2026-07-17T07:59:07Z version=2026-07-17.4 mode=--apply log=/tmp/station-prepare.log' \
    '[station-prepare] 2026-07-17T07:59:08Z runtime_setup=complete'
  return 10
}
if run_station_host_preparation; then
  printf 'STATUS=0\n'
else
  printf 'STATUS=%s\n' "$?"
fi
`);

    expect(result.status, output).toBe(0);
    expect(output).toContain("STATUS=10");
    expect(output).toContain("DGX Station host preparation log: /tmp/station-prepare.log");
    expect(output).not.toContain("runtime_setup=complete");
  });

  it.each([
    [
      "supported-colossus-baseos",
      "Qualified BaseOS setup preserves the factory kernel, driver, DKMS, Docker, and NVIDIA Container Toolkit packages",
    ],
    [
      "supported-ai-developer-tools",
      "Factory Ubuntu with NVIDIA AI Developer Tools reuses its driver and container stack",
    ],
  ])("describes the %s Station mutation boundary before consent", (release, expected) => {
    const result = spawnSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        `source "$INSTALLER_UNDER_TEST" >/dev/null
classify_dgx_station_release() { printf '%s' "$FACTORY_RELEASE"; }
describe_express_install 'DGX Station'`,
      ],
      {
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-consent-")),
          PATH: TEST_SYSTEM_PATH,
          INSTALLER_UNDER_TEST: INSTALLER_PAYLOAD,
          FACTORY_RELEASE: release,
        },
      },
    );
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(output).toContain(expected);
    expect(output).not.toContain("installs missing pinned driver");
  });

  it("normalizes the canonical Ultra served alias to the registered model slug", () => {
    const result = runExpressPromptWithTty("\n", "pipe", "DGX Station", {
      NEMOCLAW_VLLM_MODEL: "nvidia/nemotron-3-ultra-550b-a55b",
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).toBe(0);
    expect(output).toMatch(
      /MODEL=nvidia\/nemotron-3-ultra-550b-a55b VLLM_MODEL=nemotron-3-ultra-550b-a55b POLICY=/,
    );
  });

  it("uses DeepSeek V4 Flash for the Station demo override with one confirmation", () => {
    const result = runExpressPromptWithTty("\n", "pipe", "DGX Station", {
      STATION_DEEPSEEK: "1",
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).toBe(0);
    expect(output).toMatch(
      /Express install will configure managed local vLLM with DeepSeek V4 Flash/,
    );
    expect(output.match(/Run express install with these settings\?/g)).toHaveLength(1);
    expect(output).toMatch(/Using express install for DGX Station/);
    expect(output).toMatch(
      /RESULT NON_INTERACTIVE=1 SUDO_MODE=prompt PROVIDER=install-vllm MODEL=deepseek-ai\/DeepSeek-V4-Flash VLLM_MODEL=deepseek-v4-flash POLICY=suggested YES=1 SANDBOX=my-assistant/,
    );
  });

  it("pre-stages complete Station Express intent and ports before a Docker-group relogin (#7203)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-relogin-"));
    const revision = "a".repeat(40);
    const generation = "0123456789abcdef0123456789abcdef";
    const result = spawnSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        `source "$INSTALLER_UNDER_TEST" >/dev/null
_SELECTED_EXPRESS_PLATFORM='DGX Station'
NEMOCLAW_VLLM_MODEL='deepseek-v4-flash'
classify_dgx_station_release() { printf 'supported-ai-developer-tools'; }
station_installer_revision() { printf '${revision}'; }
station_express_resume_generation() { printf '${generation}'; }
run_station_host_preparation() {
  [[ -f "$(station_express_resume_file)" ]] && printf 'RECEIPT_PRESTAGED=yes\n'
  return 11
}
ensure_station_express_host`,
      ],
      {
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: home,
          PATH: TEST_SYSTEM_PATH,
          INSTALLER_UNDER_TEST: INSTALLER_PAYLOAD,
          NEMOCLAW_AGENT: "Hermes",
          NEMOCLAW_SANDBOX_NAME: "custom-agent",
          NEMOCLAW_POLICY_TIER: "restricted",
          NEMOCLAW_GATEWAY_PORT: "18081",
          NEMOCLAW_DASHBOARD_PORT: "18790",
          NEMOCLAW_VLLM_PORT: "18000",
        },
      },
    );
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(11);
    expect(output).toContain("RECEIPT_PRESTAGED=yes");
    expect(
      fs.readFileSync(
        path.join(home, ".nemoclaw", "gateways", "18081", "station-express-resume"),
        "utf8",
      ),
    ).toBe(
      `revision=${revision}\nmodel=deepseek-v4-flash\ngeneration=${generation}\n` +
        "agent=hermes\nsandbox=custom-agent\npolicy_tier=restricted\n" +
        "gateway_port=18081\ndashboard_port=18790\nvllm_port=18000\n",
    );
    expect(output).toContain("A reboot is not required");
    expect(output).toContain(
      `NEMOCLAW_INSTALL_TAG=${revision} NEMOCLAW_AGENT=hermes NEMOCLAW_SANDBOX_NAME=custom-agent NEMOCLAW_POLICY_TIER=restricted NEMOCLAW_GATEWAY_PORT=18081 NEMOCLAW_DASHBOARD_PORT=18790 NEMOCLAW_VLLM_PORT=18000 bash`,
    );
  });

  it("does not invoke Station host preparation when the accepted receipt cannot be staged (#7203)", () => {
    const { result, output } = runInstallerSourced(`
mkdir "$HOME/receipt-target"
ln -s "$HOME/receipt-target" "$HOME/.nemoclaw"
_SELECTED_EXPRESS_PLATFORM='DGX Station'
NEMOCLAW_VLLM_MODEL='deepseek-v4-flash'
station_installer_revision() { printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; }
station_express_resume_generation() { printf '0123456789abcdef0123456789abcdef'; }
classify_dgx_station_release() { printf 'supported-ai-developer-tools'; }
run_station_host_preparation() { printf 'HOST_PREPARATION_INVOKED\n'; }
ensure_station_express_host
`);

    expect(result.status, output).not.toBe(0);
    expect(output).toContain("Refusing symbolic link in NemoClaw state path");
    expect(output).not.toContain("HOST_PREPARATION_INVOKED");
  });

  it("rejects numerically equivalent Station Express ports before host preparation (#7203)", () => {
    const { result, output } = runInstallerSourced(`
_SELECTED_EXPRESS_PLATFORM='DGX Station'
NEMOCLAW_VLLM_MODEL='deepseek-v4-flash'
NEMOCLAW_GATEWAY_PORT='18081'
NEMOCLAW_DASHBOARD_PORT='018000'
NEMOCLAW_VLLM_PORT='18000'
station_installer_revision() { printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; }
station_express_resume_generation() { printf '0123456789abcdef0123456789abcdef'; }
classify_dgx_station_release() { printf 'supported-ai-developer-tools'; }
run_station_host_preparation() { printf 'HOST_PREPARATION_INVOKED\n'; }
ensure_station_express_host
`);

    expect(result.status, output).not.toBe(0);
    expect(output).toContain("NEMOCLAW_DASHBOARD_PORT conflicts with NEMOCLAW_VLLM_PORT (18000)");
    expect(output).not.toContain("HOST_PREPARATION_INVOKED");
  });

  it("restores custom Station Express ports from the accepted receipt without another prompt (#7203)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-port-resume-"));
    const revision = "a".repeat(40);
    const generation = "0123456789abcdef0123456789abcdef";
    const stateDir = path.join(home, ".nemoclaw", "gateways", "18081");
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(path.join(home, ".nemoclaw"), 0o700);
    fs.chmodSync(path.join(home, ".nemoclaw", "gateways"), 0o700);
    fs.writeFileSync(
      path.join(stateDir, "station-express-resume"),
      `revision=${revision}\nmodel=deepseek-v4-flash\ngeneration=${generation}\n` +
        "agent=hermes\nsandbox=custom-agent\npolicy_tier=restricted\n" +
        "gateway_port=18081\ndashboard_port=18790\nvllm_port=18000\n",
      { mode: 0o600 },
    );
    const result = spawnSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        `source "$INSTALLER_UNDER_TEST" >/dev/null
detect_express_platform() { printf 'DGX Station'; }
station_installer_revision() { printf '${revision}'; }
NON_INTERACTIVE=''
NEMOCLAW_PROVIDER=''
NEMOCLAW_NO_EXPRESS=''
maybe_offer_express_install
printf 'PORTS gateway=%s dashboard=%s vllm=%s\n' "$NEMOCLAW_GATEWAY_PORT" "$NEMOCLAW_DASHBOARD_PORT" "$NEMOCLAW_VLLM_PORT"`,
      ],
      {
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: home,
          PATH: TEST_SYSTEM_PATH,
          INSTALLER_UNDER_TEST: INSTALLER_PAYLOAD,
          NEMOCLAW_AGENT: "hermes",
          NEMOCLAW_GATEWAY_PORT: "18081",
        },
      },
    );
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(output).toContain("Resuming the accepted express install");
    expect(output).not.toContain("Run express install with these settings?");
    expect(output).toContain("PORTS gateway=18081 dashboard=18790 vllm=18000");

    const mismatched = spawnSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        `source "$INSTALLER_UNDER_TEST" >/dev/null
detect_express_platform() { printf 'DGX Station'; }
station_installer_revision() { printf '${revision}'; }
NON_INTERACTIVE=''
NEMOCLAW_PROVIDER=''
NEMOCLAW_NO_EXPRESS=''
maybe_offer_express_install`,
      ],
      {
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: home,
          PATH: TEST_SYSTEM_PATH,
          INSTALLER_UNDER_TEST: INSTALLER_PAYLOAD,
          NEMOCLAW_AGENT: "hermes",
          NEMOCLAW_GATEWAY_PORT: "18081",
          NEMOCLAW_DASHBOARD_PORT: "19999",
        },
      },
    );
    const mismatchedOutput = `${mismatched.stdout}${mismatched.stderr}`;
    expect(mismatched.status, mismatchedOutput).not.toBe(0);
    expect(mismatchedOutput).toContain("requires NEMOCLAW_DASHBOARD_PORT=18790");
    expect(mismatchedOutput).not.toContain("Run express install with these settings?");
  });

  it("allows a matching explicit DeepSeek model with the Station demo override", () => {
    const result = runExpressPromptWithTty("\n", "pipe", "DGX Station", {
      STATION_DEEPSEEK: "1",
      NEMOCLAW_VLLM_MODEL: "deepseek-ai/DeepSeek-V4-Flash",
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).toBe(0);
    expect(output).toMatch(/managed local vLLM with DeepSeek V4 Flash/);
    expect(output).toMatch(/MODEL=deepseek-ai\/DeepSeek-V4-Flash VLLM_MODEL=deepseek-v4-flash/);
  });

  it("rejects a conflicting explicit model with the Station demo override", () => {
    const result = runExpressPromptWithTty("\n", "pipe", "DGX Station", {
      STATION_DEEPSEEK: "1",
      NEMOCLAW_VLLM_MODEL: "nemotron-3-ultra-550b-a55b",
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).not.toBe(0);
    expect(output).toMatch(
      /--station-deepseek conflicts with NEMOCLAW_VLLM_MODEL='nemotron-3-ultra-550b-a55b'/,
    );
    expect(output).not.toMatch(/Run express install/);
  });

  it("rejects the Station demo override on non-Station platforms", () => {
    const result = runExpressPromptWithTty("\n", "pipe", "DGX Spark", {
      STATION_DEEPSEEK: "1",
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).not.toBe(0);
    expect(output).toMatch(
      /--station-deepseek requires a detected DGX Station \(detected: DGX Spark\)/,
    );
    expect(output).not.toMatch(/Run express install/);
  });

  it.each([
    {
      name: "a forced Station install on DGX Spark",
      args: ["--force-station-install"],
      platform: "DGX Spark",
      env: {},
      message:
        /--force-station-install requires DGX Station GB300 hardware \(detected: DGX Spark\)/,
    },
    {
      name: "a forced Station install in non-interactive mode",
      args: ["--force-station-install", "--non-interactive"],
      platform: "DGX Station",
      env: { EXPRESS_RELEASE_STATE: "unsupported-dgx-os" },
      message:
        /--force-station-install selects the DGX Station express prompt and cannot be combined with non-interactive mode \(triggered by: the --non-interactive flag\)/,
    },
    ...[
      "generic-ubuntu",
      "supported-dgx-os",
      "supported-colossus-baseos",
      "supported-ai-developer-tools",
    ].map((releaseState) => ({
      name: `an unnecessary forced Station install on ${releaseState}`,
      args: ["--force-station-install"],
      platform: "DGX Station",
      env: { EXPRESS_RELEASE_STATE: releaseState },
      message: new RegExp(
        `This host is already supported \\(${releaseState}\\); omit --force-station-install`,
      ),
    })),
    {
      name: "a Station-only flag on DGX Spark",
      args: ["--station-deepseek"],
      platform: "DGX Spark",
      env: {},
      message: /--station-deepseek requires a detected DGX Station \(detected: DGX Spark\)/,
    },
    {
      name: "a conflicting non-interactive flag (names the flag as the trigger)",
      args: ["--station-deepseek", "--non-interactive"],
      platform: "DGX Station",
      env: {},
      message:
        /--station-deepseek selects the DGX Station express prompt and cannot be combined with non-interactive mode \(triggered by: the --non-interactive flag\)/,
    },
    {
      name: "a conflicting NEMOCLAW_NON_INTERACTIVE env var (names the env var as the trigger)",
      args: ["--station-deepseek"],
      platform: "DGX Station",
      env: { NEMOCLAW_NON_INTERACTIVE: "1" },
      message:
        /--station-deepseek selects the DGX Station express prompt and cannot be combined with non-interactive mode \(triggered by: NEMOCLAW_NON_INTERACTIVE=1\)/,
    },
    {
      name: "a conflicting Station model",
      args: ["--station-deepseek"],
      platform: "DGX Station",
      env: { NEMOCLAW_VLLM_MODEL: "nemotron-3-ultra-550b-a55b" },
      message: /--station-deepseek conflicts with NEMOCLAW_VLLM_MODEL='nemotron-3-ultra-550b-a55b'/,
    },
  ])("rejects $name before Docker or build-dependency mutation", ({
    args,
    platform,
    env,
    message,
  }) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-flag-preflight-"));
    const mutationLog = path.join(tmp, "host-mutations.log");
    const result = spawnSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        `
source "$INSTALLER_UNDER_TEST" >/dev/null
detect_express_platform() { printf "%s" "$EXPRESS_PLATFORM"; }
classify_dgx_station_release() { printf "%s" "\${EXPRESS_RELEASE_STATE:-generic-ubuntu}"; }
ensure_docker() { printf "ensure_docker\\n" >>"$MUTATION_LOG"; }
ensure_openshell_build_deps() { printf "ensure_openshell_build_deps\\n" >>"$MUTATION_LOG"; }
main "$@"
`,
        "_",
        ...args,
      ],
      {
        cwd: tmp,
        encoding: "utf-8",
        env: {
          HOME: tmp,
          PATH: TEST_SYSTEM_PATH,
          INSTALLER_UNDER_TEST: INSTALLER_PAYLOAD,
          MUTATION_LOG: mutationLog,
          EXPRESS_PLATFORM: platform,
          ...env,
        },
      },
    );
    const output = `${result.stdout}${result.stderr}`;
    const mutations = fs.existsSync(mutationLog) ? fs.readFileSync(mutationLog, "utf-8") : "";

    expect(result.status, output).not.toBe(0);
    expect(output).toMatch(message);
    expect(mutations).toBe("");
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it.each<{
    name: string;
    extraEnv: Record<string, string>;
    entrypointArgs: string[];
  }>([
    {
      name: "environment notice acceptance",
      extraEnv: { NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1" },
      entrypointArgs: ["--station-deepseek"],
    },
    {
      name: "the CLI notice-acceptance flag",
      extraEnv: {},
      entrypointArgs: ["--station-deepseek", "--yes-i-accept-third-party-software"],
    },
  ])("reaches and accepts the DeepSeek express prompt through main with $name (#7008)", ({
    extraEnv,
    entrypointArgs,
  }) => {
    const result = runExpressPromptWithTty(
      "\n",
      "pipe",
      "DGX Station",
      extraEnv,
      "accepted-station-main",
      entrypointArgs,
    );
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).toBe(0);
    expect(output).toMatch(
      /Express install will configure managed local vLLM with DeepSeek V4 Flash/,
    );
    expect(output.match(/Run express install with these settings\?/g)).toHaveLength(1);
    expect(output).toMatch(/Using express install for DGX Station/);
    expect(output).toMatch(
      /RESULT NON_INTERACTIVE=1 SUDO_MODE=prompt PROVIDER=install-vllm MODEL=deepseek-ai\/DeepSeek-V4-Flash VLLM_MODEL=deepseek-v4-flash POLICY=suggested YES=1 SANDBOX=my-assistant/,
    );
    expect(output).not.toMatch(/cannot be combined with non-interactive mode/);
  });

  it.each<{
    name: string;
    extraEnv: Record<string, string>;
    entrypointArgs: string[];
  }>([
    {
      name: "environment notice acceptance",
      extraEnv: {
        NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
        EXPRESS_RELEASE_STATE: "unsupported-dgx-os",
      },
      entrypointArgs: ["--force-station-install"],
    },
    {
      name: "the CLI notice-acceptance flag",
      extraEnv: { EXPRESS_RELEASE_STATE: "unsupported-dgx-os" },
      entrypointArgs: ["--force-station-install", "--yes-i-accept-third-party-software"],
    },
  ])("reaches and accepts the forced Station express prompt through main with $name", ({
    extraEnv,
    entrypointArgs,
  }) => {
    const result = runExpressPromptWithTty(
      "\n",
      "pipe",
      "DGX Station",
      extraEnv,
      "accepted-station-main",
      entrypointArgs,
    );
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(output).toMatch(/Explicit --force-station-install intent bypasses only/);
    expect(output.match(/Run express install with these settings\?/g)).toHaveLength(1);
    expect(output).toMatch(/Using express install for DGX Station/);
    expect(output).toMatch(/PROVIDER=install-vllm/);
    expect(output).not.toMatch(/cannot be combined with non-interactive mode/);
  });

  it("errors instead of silently skipping --station-deepseek when no interactive terminal is available (#7014)", () => {
    // Python's start_new_session runs main without a controlling terminal, and
    // stdin is /dev/null — so neither `-t 0` nor /dev/tty is available. This is
    // deterministic on both Linux and macOS regardless of the test runner TTY.
    // Docker / build deps are mocked to prove the error fires before any host
    // mutation (the preflight validation path).
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-notty-"));
    try {
      const mutationLog = path.join(tmp, "host-mutations.log");
      const python =
        spawnSync("bash", ["--noprofile", "--norc", "-c", "command -v python3"], {
          encoding: "utf-8",
        }).stdout.trim() || "python3";
      const shellScript = `
source "$INSTALLER_UNDER_TEST" >/dev/null
detect_express_platform() { printf "%s" "$EXPRESS_PLATFORM"; }
ensure_docker() { printf "ensure_docker\\n" >>"$MUTATION_LOG"; }
ensure_openshell_build_deps() { printf "ensure_openshell_build_deps\\n" >>"$MUTATION_LOG"; }
main "$@"
`;
      const result = spawnSync(
        python,
        [
          "-c",
          `
import os
import subprocess
import sys

result = subprocess.run(
    ["bash", "--noprofile", "--norc", "-c", sys.argv[1], "_", "--station-deepseek"],
    cwd=os.getcwd(),
    env=os.environ.copy(),
    stdin=subprocess.DEVNULL,
    capture_output=True,
    start_new_session=True,
    timeout=10,
)
sys.stdout.buffer.write(result.stdout)
sys.stderr.buffer.write(result.stderr)
sys.exit(result.returncode)
`,
          shellScript,
        ],
        {
          cwd: tmp,
          encoding: "utf-8",
          timeout: 15_000,
          killSignal: "SIGKILL",
          env: {
            HOME: tmp,
            PATH: TEST_SYSTEM_PATH,
            INSTALLER_UNDER_TEST: INSTALLER_PAYLOAD,
            MUTATION_LOG: mutationLog,
            EXPRESS_PLATFORM: "DGX Station",
          },
        },
      );
      const output = `${result.stdout}${result.stderr}`;
      expect(result.error, output).toBeUndefined();
      const mutations = fs.existsSync(mutationLog) ? fs.readFileSync(mutationLog, "utf-8") : "";
      expect(result.status, output).not.toBe(0);
      expect(output).toMatch(/--station-deepseek.*needs an interactive terminal/);
      // Failed at preflight, before Docker / build-dependency mutation.
      expect(mutations).toBe("");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails closed if the Station DeepSeek prompt becomes unreadable after preflight (#7014)", () => {
    const result = runExpressPromptWithTty("", "tty", "DGX Station", {
      FORCE_EXPRESS_PROMPT_READ_FAILURE: "1",
      STATION_DEEPSEEK: "1",
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.error, output).toBeUndefined();
    expect(result.status, output).not.toBe(0);
    expect(output).toMatch(/--station-deepseek.*needs an interactive terminal/);
    expect(output).not.toMatch(/Using express install/);
    expect(output).not.toMatch(/RESULT NON_INTERACTIVE=/);
  });

  it("fails closed if the forced Station prompt becomes unreadable after preflight (#7138)", () => {
    const result = runExpressPromptWithTty("", "tty", "DGX Station", {
      EXPRESS_RELEASE_STATE: "unsupported-dgx-os",
      FORCE_EXPRESS_PROMPT_READ_FAILURE: "1",
      FORCE_STATION_INSTALL: "1",
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.error, output).toBeUndefined();
    expect(result.status, output).not.toBe(0);
    expect(output).toMatch(/--force-station-install.*needs an interactive terminal/);
    expect(output).not.toMatch(/Skipping express install/);
    expect(output).not.toMatch(/RESULT NON_INTERACTIVE=/);
  });

  it.each([
    ["Unsupported DGX Station OS", { NEMOCLAW_NO_EXPRESS: "1" }],
    ["Unsupported DGX Station generation", { NEMOCLAW_PROVIDER: "openai" }],
  ])("allows an explicit non-express path on %s", (platform, overrides) => {
    const result = spawnSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        `
source "$INSTALLER_UNDER_TEST" >/dev/null
validate_express_platform_boundary "$EXPRESS_PLATFORM"
printf 'NON_EXPRESS_ALLOWED\n'
`,
      ],
      {
        cwd: path.join(import.meta.dirname, ".."),
        encoding: "utf-8",
        env: {
          HOME: fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-express-platform-override-")),
          PATH: TEST_SYSTEM_PATH,
          INSTALLER_UNDER_TEST: INSTALLER_PAYLOAD,
          EXPRESS_PLATFORM: platform,
          ...overrides,
        },
      },
    );
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(output).toContain("NON_EXPRESS_ALLOWED");
  });

  it.each([
    ["NEMOCLAW_NO_EXPRESS", "1", /cannot be combined with NEMOCLAW_NO_EXPRESS=1/],
    // Set directly (bypasses main's flag parsing), so the origin is unknown and
    // the "(triggered by: …)" clause is omitted.
    ["NON_INTERACTIVE", "1", /cannot be combined with non-interactive mode\./],
    ["NEMOCLAW_PROVIDER", "install-vllm", /conflicts with NEMOCLAW_PROVIDER=install-vllm/],
  ])("rejects %s when the Station demo override would otherwise be ignored", (name, value, message) => {
    const result = runExpressPromptWithTty("\n", "pipe", "DGX Station", {
      STATION_DEEPSEEK: "1",
      [name]: value,
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).not.toBe(0);
    expect(output).toMatch(message);
    expect(output).not.toMatch(/Run express install/);
  });

  it("describes and preserves an explicit DGX Station model override", () => {
    const result = runExpressPromptWithTty("\n", "pipe", "DGX Station", {
      NEMOCLAW_VLLM_MODEL: "custom-station-model",
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).toBe(0);
    expect(output).toMatch(/managed local vLLM with model custom-station-model/);
    expect(output).toMatch(/pulls the configured vLLM image\/model/);
    expect(output).not.toMatch(/approximately 352 GB model/);
    expect(output).toMatch(
      /RESULT NON_INTERACTIVE=1 SUDO_MODE=prompt PROVIDER=install-vllm MODEL= VLLM_MODEL=custom-station-model POLICY=suggested YES=1 SANDBOX=my-assistant/,
    );
  });

  it("treats a whitespace-only DGX Station model override as unset", () => {
    const result = runExpressPromptWithTty("\n", "pipe", "DGX Station", {
      NEMOCLAW_VLLM_MODEL: "  \t ",
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).toBe(0);
    expect(output).toMatch(/managed local vLLM with NVIDIA Nemotron 3 Ultra 550B/);
    expect(output).toMatch(/approximately 352 GB model/);
    expect(output).toMatch(
      /RESULT NON_INTERACTIVE=1 SUDO_MODE=prompt PROVIDER=install-vllm MODEL=nvidia\/nemotron-3-ultra-550b-a55b VLLM_MODEL=nemotron-3-ultra-550b-a55b POLICY=suggested YES=1 SANDBOX=my-assistant/,
    );
  });

  it("detects Windows WSL as an express install platform", () => {
    const result = spawnSync(
      "bash",
      [
        "-c",
        `
source "$INSTALLER_UNDER_TEST" >/dev/null
detect_express_platform
`,
      ],
      {
        cwd: path.join(import.meta.dirname, ".."),
        encoding: "utf-8",
        env: {
          HOME: fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-express-wsl-detect-")),
          PATH: TEST_SYSTEM_PATH,
          INSTALLER_UNDER_TEST: INSTALLER_PAYLOAD,
          WSL_DISTRO_NAME: "Ubuntu",
        },
      },
    );

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toBe("Windows WSL");
  });

  it.each([
    "Dell Pro Max with Station GB300",
    "NVIDIA DGX Station GB300",
  ])("recognizes supported Station GB300 firmware as DGX Station: %s", (productName) => {
    const result = detectExpressPlatformForProductName(productName);

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toBe("DGX Station");
  });

  it.each(["7.2.0", "7.4.0", "7.5.0"])("recognizes stock DGX OS %s on Station GB300", (version) => {
    const result = detectExpressPlatformForStockDgxRelease(
      "DGX Station GB300",
      stockDgxRelease(version),
    );

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toBe("DGX Station");
  });

  it.each([
    "colossus-baseos",
    "ai-developer-tools",
  ] as const)("recognizes the exact no-OTA %s Station profile", (profile) => {
    const result = detectExpressPlatformForStockDgxRelease(
      "DGX Station GB300",
      noOtaFactoryRelease(profile),
    );

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toBe("DGX Station");
  });

  it("requires explicit intent before treating unrecognized metadata as Station Express", () => {
    const releasePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dgx-release-force-")),
      "dgx-release",
    );
    fs.writeFileSync(
      releasePath,
      [
        'DGX_NAME="DGX Server"',
        'DGX_PRETTY_NAME="NVIDIA DGX GB300WS"',
        'DGX_SWBUILD_DATE="2026-04-02-08-20-16"',
        'DGX_SWBUILD_VERSION="7.5.0-GB300ws-GB200ws"',
        'DGX_PLATFORM="DGX Server for GALAXY-GB300"',
        "",
      ].join("\n"),
    );

    const rejected = detectExpressPlatform("DGX Station GB300", releasePath);
    const forced = detectExpressPlatform("DGX Station GB300", releasePath, {
      FORCE_STATION_INSTALL: "1",
    });

    expect(rejected.status, `${rejected.stdout}${rejected.stderr}`).toBe(0);
    expect(rejected.stdout).toBe("Unsupported DGX Station OS");
    expect(forced.status, `${forced.stdout}${forced.stderr}`).toBe(0);
    expect(forced.stdout).toBe("DGX Station");
  });

  it("does not let the metadata override impersonate Station GB300 hardware", () => {
    const result = detectExpressPlatform("DGX Spark", "", { FORCE_STATION_INSTALL: "1" });

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toBe("DGX Spark");
  });

  it.each([
    ["unreviewed version", stockDgxRelease("7.6.0")],
    ["wrong DGX platform", stockDgxRelease("7.5.0", "DGX Server for GALAXY-GB200")],
    ["missing DGX_OTA_PRETTY_NAME", stockDgxRelease("7.5.0", "DGX Server for GALAXY-GB300", null)],
    ["BaseOS identity", stockDgxRelease("7.5.0", "DGX Server for GALAXY-GB300", "NVIDIA BaseOS")],
    [
      "duplicate non-history field",
      `${stockDgxRelease("7.5.0")}DGX_PLATFORM="DGX Server for GALAXY-GB300"\n`,
    ],
    ["shell payload", `${stockDgxRelease("7.5.0")}PAYLOAD="$(touch /tmp/nope)"\n`],
  ])("rejects a stock DGX OS marker with %s", (_scenario, marker) => {
    const result = detectExpressPlatformForStockDgxRelease("DGX Station GB300", marker);

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toBe("Unsupported DGX Station OS");
  });

  it.each([
    ["P3830", ""],
    ["NVIDIA P3830 Rev A", ""],
    ["Acme XP3830 Workstation", ""],
    ["Acme Workstation GB300", ""],
    ["NVIDIA DGX Station GB300X", "Unsupported DGX Station generation"],
    ["Dell Pro Max with Station GB200", ""],
    ["Dell Pro Max with GB300", ""],
  ])("rejects partial or unsupported Station product identifier: %s (#7103)", (productName, expected) => {
    const result = detectExpressPlatformForProductName(productName);

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toBe(expected);
  });

  it("classifies older DGX Station generations as unsupported", () => {
    const result = detectExpressPlatformForProductName("NVIDIA DGX Station A100");

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toBe("Unsupported DGX Station generation");
  });

  it.each([
    "Unsupported DGX Station OS",
    "Unsupported DGX Station generation",
  ])("rejects %s before the express prompt", (platform) => {
    const result = spawnSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        `
source "$INSTALLER_UNDER_TEST" >/dev/null
validate_express_platform_boundary "$EXPRESS_PLATFORM"
printf 'PROMPT_REACHED\n'
`,
      ],
      {
        cwd: path.join(import.meta.dirname, ".."),
        encoding: "utf-8",
        env: {
          HOME: fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-express-platform-reject-")),
          PATH: TEST_SYSTEM_PATH,
          INSTALLER_UNDER_TEST: INSTALLER_PAYLOAD,
          EXPRESS_PLATFORM: platform,
        },
      },
    );
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).not.toBe(0);
    expect(output).toMatch(/outside the validated Station/);
    expect(output).not.toContain("PROMPT_REACHED");
  });

  it("explains the supported boundary for an unrecognized DGX OS before Station preparation", () => {
    const result = spawnSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        `
source "$INSTALLER_UNDER_TEST" >/dev/null
validate_express_platform_boundary "Unsupported DGX Station OS"
printf 'PROMPT_REACHED\n'
`,
      ],
      {
        cwd: path.join(import.meta.dirname, ".."),
        encoding: "utf-8",
        env: {
          HOME: fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-express-dgx-os-guidance-")),
          PATH: TEST_SYSTEM_PATH,
          INSTALLER_UNDER_TEST: INSTALLER_PAYLOAD,
        },
      },
    );
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).not.toBe(0);
    expect(output).toContain("outside the validated Station express boundary");
    expect(output).toContain("generic Ubuntu 24.04 ARM64");
    expect(output).toContain("stock DGX OS 7.2.0, 7.4.0, or 7.5.0");
    expect(output).not.toContain("PROMPT_REACHED");
  });

  it("maps Windows WSL express install to Windows-host Ollama", () => {
    const result = runExpressPromptWithTty("\n", "pipe", "Windows WSL");
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).toBe(0);
    expect(output).toMatch(/Detected Windows WSL/);
    expect(output).toMatch(
      /Express install will configure Windows-host Ollama through host\.docker\.internal/,
    );
    expect(output).toMatch(/Sandbox policy: suggested mode, tier 'balanced'/);
    expect(output).toMatch(/Run express install/);
    expect(output).toMatch(/Using express install for Windows WSL/);
    expect(output).toMatch(
      /RESULT NON_INTERACTIVE=1 SUDO_MODE=prompt PROVIDER=install-windows-ollama MODEL= VLLM_MODEL= POLICY=suggested YES=1 SANDBOX=/,
    );
  });

  it.skipIf(process.platform === "darwin")(
    "skips express install without a controlling TTY",
    () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-express-no-tty-"));
      const result = spawnSync(
        "setsid",
        [
          "bash",
          "-c",
          `
source "$INSTALLER_UNDER_TEST" >/dev/null
detect_express_platform() { printf "DGX Spark"; }
NON_INTERACTIVE=""
NEMOCLAW_PROVIDER=""
NEMOCLAW_NO_EXPRESS=""
maybe_offer_express_install
printf "RESULT NON_INTERACTIVE=%s SUDO_MODE=%s PROVIDER=%s MODEL=%s VLLM_MODEL=%s POLICY=%s YES=%s SANDBOX=%s\\n" \\
  "\${NON_INTERACTIVE:-}" "\${NEMOCLAW_NON_INTERACTIVE_SUDO_MODE:-}" "\${NEMOCLAW_PROVIDER:-}" "\${NEMOCLAW_MODEL:-}" \\
  "\${NEMOCLAW_VLLM_MODEL:-}" "\${NEMOCLAW_POLICY_MODE:-}" "\${NEMOCLAW_YES:-}" "\${NEMOCLAW_SANDBOX_NAME:-}"
`,
        ],
        {
          cwd: tmp,
          encoding: "utf-8",
          input: "",
          env: {
            HOME: tmp,
            PATH: TEST_SYSTEM_PATH,
            INSTALLER_UNDER_TEST: INSTALLER_PAYLOAD,
          },
        },
      );
      const output = `${result.stdout}${result.stderr}`;
      expect(result.status, output).toBe(0);
      expect(output).toMatch(/Detected DGX Spark/);
      expect(output).toMatch(/Skipping express prompt \(no TTY\)/);
      expect(output).not.toMatch(/Run express install/);
      expect(output).toMatch(
        /RESULT NON_INTERACTIVE= SUDO_MODE= PROVIDER= MODEL= VLLM_MODEL= POLICY= YES= SANDBOX=/,
      );
    },
  );
});
