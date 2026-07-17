// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { INSTALLER_PAYLOAD, TEST_SYSTEM_PATH } from "./helpers/installer-sourced-env";

describe("installer express install prompt (sourced)", () => {
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
# Stop immediately after the real express prompt configures the DeepSeek
# recipe, before setup-jetson.sh or any installation side effect can run.
bash() {
  printf "RESULT NON_INTERACTIVE=%s SUDO_MODE=%s PROVIDER=%s MODEL=%s VLLM_MODEL=%s POLICY=%s YES=%s SANDBOX=%s\\n" \
    "\${NON_INTERACTIVE:-}" "\${NEMOCLAW_NON_INTERACTIVE_SUDO_MODE:-}" "\${NEMOCLAW_PROVIDER:-}" "\${NEMOCLAW_MODEL:-}" \
    "\${NEMOCLAW_VLLM_MODEL:-}" "\${NEMOCLAW_POLICY_MODE:-}" "\${NEMOCLAW_YES:-}" "\${NEMOCLAW_SANDBOX_NAME:-}"
  exit 0
}
main "$@"
'''
else:
    script = r'''
source "$INSTALLER_UNDER_TEST" >/dev/null
detect_express_platform() { printf "$EXPRESS_PLATFORM"; }
NON_INTERACTIVE="\${NON_INTERACTIVE:-}"
NEMOCLAW_PROVIDER="\${NEMOCLAW_PROVIDER:-}"
NEMOCLAW_NO_EXPRESS="\${NEMOCLAW_NO_EXPRESS:-}"
maybe_offer_express_install
printf "RESULT NON_INTERACTIVE=%s SUDO_MODE=%s PROVIDER=%s MODEL=%s VLLM_MODEL=%s POLICY=%s YES=%s SANDBOX=%s\\n" \\
  "\${NON_INTERACTIVE:-}" "\${NEMOCLAW_NON_INTERACTIVE_SUDO_MODE:-}" "\${NEMOCLAW_PROVIDER:-}" "\${NEMOCLAW_MODEL:-}" \\
  "\${NEMOCLAW_VLLM_MODEL:-}" "\${NEMOCLAW_POLICY_MODE:-}" "\${NEMOCLAW_YES:-}" "\${NEMOCLAW_SANDBOX_NAME:-}"
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

  function detectExpressPlatformForProductName(productName: string) {
    return spawnSync(
      "bash",
      [
        "-c",
        `
source "$INSTALLER_UNDER_TEST" >/dev/null
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
          EXPRESS_PRODUCT_NAME: productName,
        },
      },
    );
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

  it("recognizes Station GB300 OEM firmware as DGX Station", () => {
    const result = detectExpressPlatformForProductName("Dell Pro Max with Station GB300");

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toBe("DGX Station");
  });

  it("requires both Station and GB300 for the OEM firmware match", () => {
    for (const productName of ["Dell Pro Max with Station GB200", "Dell Pro Max with GB300"]) {
      const result = detectExpressPlatformForProductName(productName);

      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(result.stdout).toBe("");
    }
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
