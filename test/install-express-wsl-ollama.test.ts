// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  INSTALLER_PAYLOAD,
  TEST_SYSTEM_PATH,
  writeExecutable,
} from "./helpers/installer-sourced-env";

describe("installer Windows WSL express Ollama selection (sourced)", () => {
  function runInstallerSourced(body: string, extraEnv: Record<string, string> = {}) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-express-wsl-sourced-"));
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
          ...extraEnv,
        },
      },
    );
    return { home, result, output: `${result.stdout}${result.stderr}` };
  }

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

  it("activate_express_install fails closed on malformed Docker config when Node is unavailable", () => {
    const { result, output } = runInstallerSourced(
      `mkdir -p "$HOME/.docker"\n` +
        `printf '%s' 'not-json {"currentContext":"default"}' > "$HOME/.docker/config.json"\n` +
        `express_wsl_docker_operating_system() { printf 'Docker Desktop\\n'; }\n` +
        `activate_express_install "Windows WSL"\n` +
        `printf 'PROVIDER=%s\\n' "$NEMOCLAW_PROVIDER"\n`,
    );
    expect(result.status, output).toBe(0);
    expect(output).toContain("PROVIDER=install-ollama");
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
