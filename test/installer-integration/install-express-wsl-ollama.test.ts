// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { resolveRequestedProviderSelection } from "../../src/lib/onboard/provider-selection.js";
import { runInstallerSourcedBody } from "../helpers/installer-run-fixture";
import {
  INSTALLER_PAYLOAD,
  TEST_SYSTEM_PATH,
  writeExecutable,
} from "../helpers/installer-sourced-env";

describe("installer Windows WSL express Ollama selection (sourced)", () => {
  const runInstallerSourced = (body: string, extraEnv: Record<string, string> = {}) => {
    const run = runInstallerSourcedBody(body, {
      homePrefix: "nemoclaw-express-wsl-sourced-",
      extraEnv,
    });
    onTestFinished(run.remove);
    return run;
  };

  function dockerStubBin(operatingSystem: string, exitCode = 0) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-stub-"));
    writeExecutable(path.join(dir, "timeout"), '#!/usr/bin/env bash\nshift\nexec "$@"\n');
    writeExecutable(
      path.join(dir, "docker"),
      `#!/usr/bin/env bash\nif [ "$1" = "info" ]; then\n  printf '%s\\n' "${operatingSystem}"\nfi\nexit ${exitCode}\n`,
    );
    return dir;
  }

  function runWslExpressPrompt(extraEnv: Record<string, string>) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-express-wsl-prompt-"));
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
script = r'''
source "$INSTALLER_UNDER_TEST" >/dev/null
detect_express_platform() { printf "Windows WSL"; }
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
pid, fd = pty.fork()
if pid == 0:
    devnull = os.open(os.devnull, os.O_RDONLY)
    os.dup2(devnull, 0)
    os.close(devnull)
    os.execvpe("bash", ["bash", "-c", script, "nemoclaw-express-wsl-prompt"], env)

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
            os.write(fd, b"\\n")
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
    return spawnSync(python, ["-c", ptyRunner, INSTALLER_PAYLOAD], {
      cwd: tmp,
      encoding: "utf-8",
      timeout: 15_000,
      killSignal: "SIGKILL",
      env: {
        HOME: tmp,
        PATH: TEST_SYSTEM_PATH,
        ...extraEnv,
      },
    });
  }

  it("maps Windows WSL express install to Windows-host Ollama under Docker Desktop", () => {
    const dockerBin = dockerStubBin("Docker Desktop");
    const result = runWslExpressPrompt({ PATH: `${dockerBin}:${TEST_SYSTEM_PATH}` });
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

  it("maps a qualifying N1x WSL host to managed Qwen 3.6 llama.cpp (#10102)", () => {
    const { result, output } = runInstallerSourced(
      `uname() { printf 'aarch64\\n'; }\n` +
        `timeout() { shift; "$@"; }\n` +
        `powershell.exe() { printf 'RTX Spark N1X\\r\\n'; }\n` +
        `nvidia-smi() { printf '49088\\n'; }\n` +
        `express_wsl_docker_operating_system() { printf 'Docker Desktop\\n'; }\n` +
        `describe_express_install "Windows WSL"\n` +
        `activate_express_install "Windows WSL"\n` +
        `printf 'PROVIDER=%s RECIPE=%s\\n' "$NEMOCLAW_PROVIDER" "$NEMOCLAW_LLAMACPP_RECIPE"\n`,
    );
    expect(result.status, output).toBe(0);
    expect(output).toContain(
      "PROVIDER=install-llama-cpp RECIPE=llama-cpp.qwen3-6-35b-a3b.n1x-wsl.v1",
    );
  });

  it("rejects managed N1x WSL selection for a remote Docker target (#10102)", () => {
    const { result, output } = runInstallerSourced(
      `export DOCKER_HOST=tcp://10.0.0.5:2375\n` +
        `uname() { printf 'aarch64\\n'; }\n` +
        `timeout() { shift; "$@"; }\n` +
        `powershell.exe() { printf 'RTX Spark N1X\\r\\n'; }\n` +
        `nvidia-smi() { printf '49088\\n'; }\n` +
        `express_wsl_docker_operating_system() { printf 'Docker Desktop\\n'; }\n` +
        `activate_express_install "Windows WSL"\n` +
        `printf 'PROVIDER=%s RECIPE=%s\\n' "$NEMOCLAW_PROVIDER" "\${NEMOCLAW_LLAMACPP_RECIPE:-}"\n`,
    );
    expect(result.status, output).toBe(0);
    expect(output).toContain("PROVIDER=install-ollama RECIPE=");
  });

  it.each([
    ["a non-N1x product", "Generic ARM64 PC", "49088"],
    ["insufficient GPU memory", "RTX Spark N1X", "47999"],
  ])("keeps Windows-host Ollama for %s (#10102)", (_scenario, product, memoryMb) => {
    const { result, output } = runInstallerSourced(
      `uname() { printf 'aarch64\\n'; }\n` +
        `timeout() { shift; "$@"; }\n` +
        `powershell.exe() { printf '${product}\\r\\n'; }\n` +
        `nvidia-smi() { printf '${memoryMb}\\n'; }\n` +
        `express_wsl_can_use_windows_host_ollama() { return 0; }\n` +
        `activate_express_install "Windows WSL"\n` +
        `printf 'PROVIDER=%s RECIPE=%s\\n' "$NEMOCLAW_PROVIDER" "\${NEMOCLAW_LLAMACPP_RECIPE:-}"\n`,
    );
    expect(result.status, output).toBe(0);
    expect(output).toContain("PROVIDER=install-windows-ollama RECIPE=");
  });

  it("maps Windows WSL express install to WSL-local Ollama under native Docker Engine", () => {
    const dockerBin = dockerStubBin("Ubuntu 24.04.4 LTS");
    const result = runWslExpressPrompt({ PATH: `${dockerBin}:${TEST_SYSTEM_PATH}` });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).toBe(0);
    expect(output).toMatch(/Detected Windows WSL/);
    expect(output).toMatch(
      /Express install will configure WSL-local Ollama, with a sandbox auth proxy when containers cannot reach host loopback/,
    );
    expect(output).not.toMatch(/native Docker Engine detected/);
    expect(output).toMatch(/Using express install for Windows WSL/);
    expect(output).toMatch(
      /RESULT NON_INTERACTIVE=1 SUDO_MODE=prompt PROVIDER=install-ollama MODEL= VLLM_MODEL= POLICY=suggested YES=1 SANDBOX=/,
    );
  });

  it("uses a runtime-neutral WSL-local Ollama summary when the docker probe fails", () => {
    const dockerBin = dockerStubBin("", 1);
    const result = runWslExpressPrompt({ PATH: `${dockerBin}:${TEST_SYSTEM_PATH}` });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).toBe(0);
    expect(output).toMatch(
      /Express install will configure WSL-local Ollama, with a sandbox auth proxy when containers cannot reach host loopback/,
    );
    expect(output).not.toMatch(/native Docker Engine detected/);
    expect(output).toMatch(
      /RESULT NON_INTERACTIVE=1 SUDO_MODE=prompt PROVIDER=install-ollama MODEL= VLLM_MODEL= POLICY=suggested YES=1 SANDBOX=/,
    );
  });

  it("activate_express_install keeps Windows-host Ollama when Docker Desktop is detected", () => {
    const { result, output } = runInstallerSourced(
      `express_wsl_docker_operating_system() { printf 'Docker Desktop\\n'; }\n` +
        `activate_express_install "Windows WSL"\n` +
        `printf 'PROVIDER=%s\\n' "$NEMOCLAW_PROVIDER"\n`,
    );
    expect(result.status, output).toBe(0);
    expect(output).toContain("PROVIDER=install-windows-ollama");
  });

  it("activate_express_install falls back to WSL-local Ollama under native Docker Engine", () => {
    const { result, output } = runInstallerSourced(
      `express_wsl_docker_operating_system() { printf 'Ubuntu 24.04.4 LTS\\n'; }\n` +
        `activate_express_install "Windows WSL"\n` +
        `printf 'PROVIDER=%s\\n' "$NEMOCLAW_PROVIDER"\n`,
    );
    expect(result.status, output).toBe(0);
    expect(output).toContain("PROVIDER=install-ollama");
  });

  it("activate_express_install falls back to WSL-local Ollama when the docker probe fails or times out", () => {
    const { result, output } = runInstallerSourced(
      `express_wsl_docker_operating_system() { return 124; }\n` +
        `activate_express_install "Windows WSL"\n` +
        `printf 'PROVIDER=%s\\n' "$NEMOCLAW_PROVIDER"\n`,
    );
    expect(result.status, output).toBe(0);
    expect(output).toContain("PROVIDER=install-ollama");
  });

  it("activate_express_install rejects a remote Docker Desktop target via DOCKER_HOST", () => {
    const { result, output } = runInstallerSourced(
      `export DOCKER_HOST=tcp://10.0.0.5:2375\n` +
        `express_wsl_docker_operating_system() { printf 'Docker Desktop\\n'; }\n` +
        `activate_express_install "Windows WSL"\n` +
        `printf 'PROVIDER=%s\\n' "$NEMOCLAW_PROVIDER"\n`,
    );
    expect(result.status, output).toBe(0);
    expect(output).toContain("PROVIDER=install-ollama");
  });

  it("does not defer a DOCKER_HOST override when Node.js is unavailable (#8199)", () => {
    const { result, output } = runInstallerSourced(
      `mkdir -p "$HOME/.docker"\n` +
        `printf '%s' '{}' > "$HOME/.docker/config.json"\n` +
        `export DOCKER_HOST=tcp://10.0.0.5:2375\n` +
        `express_wsl_docker_operating_system() { printf 'Docker Desktop\\n'; }\n` +
        `activate_express_install "Windows WSL"\n` +
        `printf 'DEFERRED=%s PROVIDER=%s\\n' "\${_EXPRESS_WSL_PROVIDER_PENDING:-}" "\${NEMOCLAW_PROVIDER:-}"\n`,
    );
    expect(result.status, output).toBe(0);
    expect(output).toContain("DEFERRED= PROVIDER=install-ollama");
  });

  it("activate_express_install rejects a remote Docker Desktop target via DOCKER_CONTEXT", () => {
    const { result, output } = runInstallerSourced(
      `export DOCKER_CONTEXT=my-remote\n` +
        `express_wsl_docker_operating_system() { printf 'Docker Desktop\\n'; }\n` +
        `activate_express_install "Windows WSL"\n` +
        `printf 'PROVIDER=%s\\n' "$NEMOCLAW_PROVIDER"\n`,
    );
    expect(result.status, output).toBe(0);
    expect(output).toContain("PROVIDER=install-ollama");
  });

  it("activate_express_install does not trust a desktop-linux context name as local", () => {
    const { result, output } = runInstallerSourced(
      `export DOCKER_CONTEXT=desktop-linux\n` +
        `express_wsl_docker_operating_system() { printf 'Docker Desktop\\n'; }\n` +
        `activate_express_install "Windows WSL"\n` +
        `printf 'PROVIDER=%s\\n' "$NEMOCLAW_PROVIDER"\n`,
    );
    expect(result.status, output).toBe(0);
    expect(output).toContain("PROVIDER=install-ollama");
  });

  it("activate_express_install fails closed on a persisted remote currentContext", () => {
    const { result, output } = runInstallerSourced(
      `mkdir -p "$HOME/.docker"\n` +
        `printf '%s' '{"currentContext":"remote-prod"}' > "$HOME/.docker/config.json"\n` +
        `express_wsl_docker_operating_system() { printf 'Docker Desktop\\n'; }\n` +
        `activate_express_install "Windows WSL"\n` +
        `printf 'PROVIDER=%s\\n' "$NEMOCLAW_PROVIDER"\n`,
      { PATH: `${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}` },
    );
    expect(result.status, output).toBe(0);
    expect(output).toContain("PROVIDER=install-ollama");
  });

  it("activate_express_install fails closed on a multiline persisted remote currentContext", () => {
    const { result, output } = runInstallerSourced(
      `mkdir -p "$HOME/.docker"\n` +
        `cat > "$HOME/.docker/config.json" <<'JSON'\n` +
        `{\n` +
        `  "auths": {},\n` +
        `  "currentContext":\n` +
        `    "remote-prod"\n` +
        `}\n` +
        `JSON\n` +
        `express_wsl_docker_operating_system() { printf 'Docker Desktop\\n'; }\n` +
        `activate_express_install "Windows WSL"\n` +
        `printf 'PROVIDER=%s\\n' "$NEMOCLAW_PROVIDER"\n`,
      { PATH: `${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}` },
    );
    expect(result.status, output).toBe(0);
    expect(output).toContain("PROVIDER=install-ollama");
  });

  it("activate_express_install fails closed when a readable Docker config cannot be parsed", () => {
    const { result, output } = runInstallerSourced(
      `mkdir -p "$HOME/.docker"\n` +
        `printf '%s' '{"currentContext":"default"' > "$HOME/.docker/config.json"\n` +
        `express_wsl_docker_operating_system() { printf 'Docker Desktop\\n'; }\n` +
        `activate_express_install "Windows WSL"\n` +
        `printf 'PROVIDER=%s\\n' "$NEMOCLAW_PROVIDER"\n`,
      { PATH: `${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}` },
    );
    expect(result.status, output).toBe(0);
    expect(output).toContain("PROVIDER=install-ollama");
  });

  it("activate_express_install fails closed on malformed Docker configuration after Node.js is installed", () => {
    const { result, output } = runInstallerSourced(
      `mkdir -p "$HOME/.docker"\n` +
        `printf '%s' 'not-json {"currentContext":"default"}' > "$HOME/.docker/config.json"\n` +
        `express_wsl_docker_operating_system() { printf 'Docker Desktop\\n'; }\n` +
        `activate_express_install "Windows WSL"\n` +
        `printf 'DEFERRED=%s PROVIDER=%s\\n' "\${_EXPRESS_WSL_PROVIDER_PENDING:-}" "\${NEMOCLAW_PROVIDER:-}"\n` +
        `PATH="$NODE_BIN_DIR:$PATH"\n` +
        `resolve_pending_express_wsl_provider\n` +
        `printf 'PROVIDER=%s\\n' "$NEMOCLAW_PROVIDER"\n`,
      { NODE_BIN_DIR: path.dirname(process.execPath) },
    );
    expect(result.status, output).toBe(0);
    expect(output).toContain("DEFERRED=1 PROVIDER=");
    expect(output).toContain("PROVIDER=install-ollama");
  });

  it("accepts deferred Windows-host selection in onboarding provider resolution (#8199)", () => {
    const { result, output } = runInstallerSourced(
      `mkdir -p "$HOME/.docker"\n` +
        `printf '%s' '{}' > "$HOME/.docker/config.json"\n` +
        `printf 'NODE_BEFORE=%s\\n' "$(command -v node || true)"\n` +
        `express_wsl_docker_operating_system() { printf 'Docker Desktop\\n'; }\n` +
        `activate_express_install "Windows WSL"\n` +
        `printf 'DEFERRED=%s PROVIDER=%s\\n' "\${_EXPRESS_WSL_PROVIDER_PENDING:-}" "\${NEMOCLAW_PROVIDER:-}"\n` +
        `PATH="$NODE_BIN_DIR:$PATH"\n` +
        `resolve_pending_express_wsl_provider\n` +
        `printf 'PROVIDER=%s\\n' "$NEMOCLAW_PROVIDER"\n`,
      { NODE_BIN_DIR: path.dirname(process.execPath) },
    );
    expect(result.status, output).toBe(0);
    expect(output).toContain("NODE_BEFORE=\n");
    expect(output).toContain("DEFERRED=1 PROVIDER=");
    expect(output).toContain("PROVIDER=install-windows-ollama");

    const requestedProvider = output.match(/^PROVIDER=(.+)$/m)?.[1];
    expect(requestedProvider).toBe("install-windows-ollama");

    const resolution = resolveRequestedProviderSelection({
      options: [
        {
          key: "start-windows-ollama",
          label: "Start Ollama on Windows host (suggested)",
        },
      ],
      requestedProvider: requestedProvider ?? null,
      sandboxName: null,
      remoteProviderConfig: {},
      isWsl: true,
      isWindowsHostOllama: false,
      windowsHostOllamaSupported: true,
      hermesProviderAvailable: false,
      readRecordedProvider: () => null,
      readRecordedNimContainer: () => null,
      readRecordedModel: () => null,
    });
    expect(resolution).toMatchObject({
      kind: "selected",
      selected: { key: "start-windows-ollama" },
    });
  });

  it("describes a deferred Windows WSL selection before Node.js is installed (#8199)", () => {
    const { result, output } = runInstallerSourced(
      `mkdir -p "$HOME/.docker"\n` +
        `printf '%s' '{}' > "$HOME/.docker/config.json"\n` +
        `express_wsl_docker_operating_system() { printf 'Docker Desktop\\n'; }\n` +
        `describe_express_install "Windows WSL"\n`,
    );
    expect(result.status, output).toBe(0);
    expect(output).toMatch(
      /Express install will configure local inference, selected once the installed Node\.js runtime reads the Docker configuration/,
    );
  });

  it("keeps a resolved Windows WSL selection out of the deferred path", () => {
    const dockerBin = dockerStubBin("Docker Desktop");
    const { result, output } = runInstallerSourced(
      `mkdir -p "$HOME/.docker"\n` +
        `printf '%s' '{"currentContext":"default"}' > "$HOME/.docker/config.json"\n` +
        `activate_express_install "Windows WSL"\n` +
        `printf 'DEFERRED=%s PROVIDER=%s\\n' "\${_EXPRESS_WSL_PROVIDER_PENDING:-}" "\${NEMOCLAW_PROVIDER:-}"\n` +
        `resolve_pending_express_wsl_provider\n` +
        `printf 'PROVIDER=%s\\n' "$NEMOCLAW_PROVIDER"\n`,
      { PATH: `${dockerBin}:${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}` },
    );
    expect(result.status, output).toBe(0);
    expect(output).toContain("DEFERRED= PROVIDER=install-windows-ollama");
    expect(output).toContain("PROVIDER=install-windows-ollama");
  });

  it("activate_express_install fails closed on an unreadable Docker config", () => {
    const { result, output } = runInstallerSourced(
      `mkdir -p "$HOME/.docker"\n` +
        `printf '%s' '{"currentContext":"remote-prod"}' > "$HOME/.docker/config.json"\n` +
        `chmod 000 "$HOME/.docker/config.json"\n` +
        `express_wsl_docker_operating_system() { printf 'Docker Desktop\\n'; }\n` +
        `activate_express_install "Windows WSL"\n` +
        `printf 'PROVIDER=%s\\n' "$NEMOCLAW_PROVIDER"\n`,
    );
    expect(result.status, output).toBe(0);
    expect(output).toContain("PROVIDER=install-ollama");
  });

  it("activate_express_install treats a default persisted currentContext as local", () => {
    const { result, output } = runInstallerSourced(
      `mkdir -p "$HOME/.docker"\n` +
        `printf '%s' '{"currentContext":"default"}' > "$HOME/.docker/config.json"\n` +
        `express_wsl_docker_operating_system() { printf 'Docker Desktop\\n'; }\n` +
        `activate_express_install "Windows WSL"\n` +
        `printf 'PROVIDER=%s\\n' "$NEMOCLAW_PROVIDER"\n`,
      { PATH: `${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}` },
    );
    expect(result.status, output).toBe(0);
    expect(output).toContain("PROVIDER=install-windows-ollama");
  });
});
