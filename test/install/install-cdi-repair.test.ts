// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  writeInstallerReadinessModuleStubs,
  writeNodeStub,
} from "../helpers/installer-readiness-stubs";
import { createInstallerCheckout, type InstallerCheckout } from "../helpers/installer-run-fixture";
import {
  INSTALLER_PAYLOAD,
  TEST_SYSTEM_PATH,
  writeExecutable,
} from "../helpers/installer-sourced-env";

function installerCheckout(prefix: string): InstallerCheckout {
  const checkout = createInstallerCheckout(prefix);
  onTestFinished(() => checkout.remove());
  return checkout;
}

/**
 * Run an installer snippet under a real pseudo-terminal.
 *
 * `stdinMode: "tty"` is an interactive shell. `stdinMode: "pipe"` replaces fd 0
 * with /dev/null while the fork keeps the PTY as its controlling terminal, which
 * is the shape of the documented `curl … | bash` install: `[ -t 0 ]` is false but
 * /dev/tty is open. Both are needed because `authorize_sudo` distinguishes them.
 */
function runInstallerSnippetWithTty(
  snippet: string,
  stdinMode: "tty" | "pipe",
  options: { cwd: string; env: Record<string, string> },
) {
  const pythonLookup = spawnSync("bash", ["--noprofile", "--norc", "-c", "command -v python3"], {
    encoding: "utf-8",
  });
  expect(pythonLookup.error, "Python discovery failed").toBeUndefined();
  const python = pythonLookup.stdout.trim() || "python3";
  const ptyRunner = `
import errno
import os
import pty
import select
import signal
import sys
import time

snippet = sys.argv[1]
stdin_mode = sys.argv[2]
pid, fd = pty.fork()
if pid == 0:
    if stdin_mode == "pipe":
        devnull = os.open(os.devnull, os.O_RDONLY)
        os.dup2(devnull, 0)
        os.close(devnull)
    os.execvpe("bash", ["bash", "-c", snippet], os.environ)

output = bytearray()
os.set_blocking(fd, False)
exit_code = 124
deadline = time.monotonic() + 30
pty_closed = False

def read_output():
    try:
        chunk = os.read(fd, 4096)
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
    waited = os.waitpid(pid, os.WNOHANG)
    if waited[0] == pid:
        exit_code = os.waitstatus_to_exitcode(waited[1])
        break
    if time.monotonic() > deadline:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.waitpid(pid, 0)
        break

while not pty_closed:
    ready, _, _ = select.select([fd], [], [], 0.05)
    if not ready:
        break
    pty_closed = read_output()

try:
    os.close(fd)
except OSError:
    pass
sys.stdout.buffer.write(output)
sys.exit(exit_code)
`;
  const result = spawnSync(python, ["-c", ptyRunner, snippet, stdinMode], {
    cwd: options.cwd,
    encoding: "utf-8",
    timeout: 40_000,
    killSignal: "SIGKILL",
    env: options.env,
  });
  expect(result.error, `PTY runner failed to start with ${python}`).toBeUndefined();
  return result;
}

describe("installer NVIDIA CDI repair", () => {
  function runNvidiaCdiInstallerRepairTest({
    systemctlScript,
    isWsl = false,
    runtime = "docker",
    stale = false,
    toolkitInstalled = true,
    passwordlessSudo = "all",
    terminal = "none",
    nonInteractive = false,
    nonInteractiveSudoMode = "",
  }: {
    systemctlScript: string;
    isWsl?: boolean;
    runtime?: string;
    stale?: boolean;
    toolkitInstalled?: boolean;
    /**
     * Which commands `sudo -n` accepts. `"none"` models a host whose sudoers
     * requires a password for everything, so the installer must skip the repair
     * rather than prompt where no terminal can answer. `"probe-only"` models a
     * command-specific sudoers entry where `true` is passwordless but the
     * repair's own commands are not — the probe must not be read as authorizing
     * them.
     */
    passwordlessSudo?: "all" | "probe-only" | "none";
    /**
     * The terminal shape the installer runs under. `"none"` is a plain pipe with
     * no controlling terminal (CI, the deploy notebook). `"tty"` is an
     * interactive shell. `"pipe-with-tty"` is the documented
     * `curl … | bash` install: stdin is the script pipe, but /dev/tty is open.
     */
    terminal?: "none" | "tty" | "pipe-with-tty";
    nonInteractive?: boolean;
    nonInteractiveSudoMode?: "" | "prompt";
  }) {
    const { root: tmp, binDir: fakeBin } = installerCheckout("nemoclaw-install-cdi-repair-");
    const sourceRoot = path.join(tmp, "source");
    const cdiDir = path.join(tmp, "cdi");
    const cdiState = path.join(tmp, "cdi-generated");
    const sudoAuthorized = path.join(tmp, "sudo-authorized");
    const sudoLog = path.join(tmp, "sudo.log");
    const systemctlLog = path.join(tmp, "systemctl.log");
    fs.mkdirSync(path.join(sourceRoot, "dist", "lib", "onboard"), { recursive: true });

    fs.writeFileSync(
      path.join(sourceRoot, "dist", "lib", "onboard", "preflight.js"),
      `
const fs = require("fs");
exports.assessHost = () => ({
  runtime: ${JSON.stringify(runtime)},
  isWsl: ${isWsl ? "true" : "false"},
  notes: [],
  dockerCdiSpecDirs: [process.env.CDI_DIR],
  cdiNvidiaGpuSpecMissing: ${stale ? "false" : "!fs.existsSync(process.env.CDI_STATE)"},
  cdiNvidiaGpuSpecStale: ${stale ? "!fs.existsSync(process.env.CDI_STATE)" : "false"},
  cdiNvidiaGpuSpecNeedsRepair: !fs.existsSync(process.env.CDI_STATE),
  cdiNvidiaGpuSpecMismatch: process.env.CDI_STALE_FILE + " /dev/nvidia-uvm=498:0, live=499:0",
  nvidiaContainerToolkitInstalled: ${toolkitInstalled ? "true" : "false"},
});
exports.getNvidiaCdiSpecPath = (host) =>
  String(host.dockerCdiSpecDirs[0]).replace(/\\/+$/, "") + "/nvidia.yaml";
exports.isWslDockerDesktopRuntime = (host) =>
  Boolean(host && host.isWsl && host.runtime === "docker-desktop");
exports.planHostAdvisories = (host) =>
  host.cdiNvidiaGpuSpecMissing
    ? host.isWsl && host.runtime === "docker-desktop"
      ? [{
          title: "Use Docker Desktop WSL GPU compatibility path",
          reason: "missing nvidia.com/gpu CDI; using Docker --gpus",
          commands: ["verify Docker --gpus support from WSL"],
          severity: "info",
        }]
      : [{
          title: "Generate NVIDIA CDI device specs",
          reason: "missing nvidia.com/gpu",
          commands: ["sudo nvidia-ctk cdi generate --output=" + exports.getNvidiaCdiSpecPath(host)],
          severity: "blocking",
        }]
    : host.cdiNvidiaGpuSpecStale && !host.nvidiaContainerToolkitInstalled
      ? [{
          title: "Install NVIDIA Container Toolkit and refresh CDI device specs",
          reason: "nvidia-container-toolkit missing",
          commands: ["sudo apt-get install -y nvidia-container-toolkit"],
          severity: "blocking",
        }]
    : [];
`,
    );
    writeInstallerReadinessModuleStubs(path.join(sourceRoot, "dist", "lib", "readiness"));
    writeNodeStub(fakeBin);
    writeExecutable(
      path.join(fakeBin, "sudo"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$SUDO_LOG"
if [ "\${1:-}" = "-n" ]; then
  case "$PASSWORDLESS_SUDO" in
    all) shift ;;
    probe-only) [ "\${2:-}" = "true" ] || exit 1; shift ;;
    *) [ -f "$SUDO_AUTHORIZED" ] || exit 1; shift ;;
  esac
fi
if [ "\${1:-}" = "-v" ]; then
  [ -t 0 ] || exit 1
  : > "$SUDO_AUTHORIZED"
  exit 0
fi
exec "$@"
`,
    );
    writeExecutable(path.join(fakeBin, "systemctl"), systemctlScript);
    writeExecutable(
      path.join(fakeBin, "nvidia-ctk"),
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "cdi" ] && [ "\${2:-}" = "generate" ]; then
  printf 'noisy nvidia-ctk generate stdout\\n'
  printf 'noisy nvidia-ctk generate stderr\\n' >&2
  touch "$CDI_STATE"
  exit 0
fi
if [ "\${1:-}" = "cdi" ] && [ "\${2:-}" = "list" ]; then
  if [ -f "$CDI_STATE" ]; then
    printf 'nvidia.com/gpu=all\\n'
    exit 0
  fi
  exit 1
fi
exit 99
`,
    );
    writeExecutable(
      path.join(fakeBin, "id"),
      `#!/usr/bin/env bash
if [ "\${1:-}" = "-u" ]; then
  printf '1000\\n'
  exit 0
fi
exec /usr/bin/id "$@"
`,
    );

    const snippet = `
source "$INSTALLER_UNDER_TEST" >/dev/null
NEMOCLAW_SOURCE_ROOT="$SOURCE_ROOT"
run_installer_host_preflight
`;
    const env = {
      HOME: tmp,
      PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
      INSTALLER_UNDER_TEST: INSTALLER_PAYLOAD,
      SOURCE_ROOT: sourceRoot,
      CDI_DIR: cdiDir,
      CDI_STATE: cdiState,
      CDI_STALE_FILE: path.join(cdiDir, "nvidia.yaml"),
      SUDO_AUTHORIZED: sudoAuthorized,
      SUDO_LOG: sudoLog,
      SYSTEMCTL_LOG: systemctlLog,
      PASSWORDLESS_SUDO: passwordlessSudo,
      NON_INTERACTIVE: nonInteractive ? "1" : "",
      NEMOCLAW_NON_INTERACTIVE_SUDO_MODE: nonInteractiveSudoMode,
    };
    const result =
      terminal === "none"
        ? spawnSync("bash", ["-c", snippet], { cwd: tmp, encoding: "utf-8", env })
        : runInstallerSnippetWithTty(snippet, terminal === "tty" ? "tty" : "pipe", {
            cwd: tmp,
            env,
          });

    return {
      cdiDir,
      output: `${result.stdout}${result.stderr}`,
      result,
      cdiStateExists: fs.existsSync(cdiState),
      sudoLog: fs.existsSync(sudoLog) ? fs.readFileSync(sudoLog, "utf-8") : "",
      systemctlLog: fs.existsSync(systemctlLog) ? fs.readFileSync(systemctlLog, "utf-8") : "",
    };
  }

  it("enables nvidia-cdi-refresh before installer host preflight blocks", () => {
    const { output, result, sudoLog, systemctlLog } = runNvidiaCdiInstallerRepairTest({
      systemctlScript: `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$SYSTEMCTL_LOG"
if [ "\${1:-}" = "enable" ]; then
  touch "$CDI_STATE"
  exit 0
fi
exit 99
`,
    });

    expect(result.status, output).toBe(0);
    expect(output).toMatch(
      /NVIDIA GPU passthrough uses CDI specs so Docker\/OpenShell can request nvidia\.com\/gpu devices/,
    );
    expect(output).toMatch(
      /Docker is configured for CDI, but the nvidia\.com\/gpu spec is missing/,
    );
    expect(output).toMatch(
      /You may be asked for your password to authorize these host-level admin changes/,
    );
    expect(output).toMatch(/Trying NVIDIA CDI refresh service \(auto-generates GPU CDI specs\)/);
    expect(output).toMatch(/Enabled NVIDIA CDI refresh service/);
    expect(output).not.toMatch(/falling back to direct generation/);
    expect(output).not.toMatch(/Host preflight found issues/);
    expect(output).not.toMatch(/noisy nvidia-ctk generate/);
    expect(systemctlLog).toMatch(
      /^enable --now nvidia-cdi-refresh\.path nvidia-cdi-refresh\.service$/m,
    );
    expect(sudoLog).toMatch(/^-n true$/m);
    // The later command keeps `-n`, so it cannot prompt after the probe.
    expect(sudoLog).toMatch(/^-n systemctl enable --now /m);
    expect(sudoLog).not.toMatch(/^-v$/m);
    expect(sudoLog).not.toMatch(/nvidia-ctk cdi generate/);
  });

  it("repairs stale NVIDIA CDI specs with the refresh service only", () => {
    const { cdiStateExists, output, result, sudoLog, systemctlLog } =
      runNvidiaCdiInstallerRepairTest({
        stale: true,
        systemctlScript: `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$SYSTEMCTL_LOG"
if [ "\${1:-}" = "start" ]; then
  touch "$CDI_STATE"
fi
exit 0
`,
      });

    expect(result.status, output).toBe(0);
    expect(cdiStateExists).toBe(true);
    expect(output).toMatch(/Refreshing NVIDIA CDI device spec with NVIDIA's CDI refresh service/);
    expect(output).toMatch(/effective nvidia\.com\/gpu spec may be stale/);
    expect(output).toMatch(/refreshed the service-managed NVIDIA CDI device spec/);
    expect(output).not.toMatch(/falling back to direct generation/);
    expect(output).not.toMatch(/Host preflight found issues/);
    expect(systemctlLog).toMatch(
      /^enable --now nvidia-cdi-refresh\.path nvidia-cdi-refresh\.service$/m,
    );
    expect(systemctlLog).toMatch(/^start nvidia-cdi-refresh\.service$/m);
    expect(sudoLog).toMatch(/^-n true$/m);
    expect(sudoLog).not.toMatch(/^-v$/m);
    expect(sudoLog).not.toMatch(/nvidia-ctk cdi generate/);
    expect(sudoLog).not.toMatch(/mkdir -p/);
    expect(sudoLog).not.toMatch(/rm -f/);
  });

  it("skips NVIDIA CDI repair when sudo needs a password and no terminal can answer", () => {
    const { cdiStateExists, output, result, sudoLog, systemctlLog } =
      runNvidiaCdiInstallerRepairTest({
        passwordlessSudo: "none",
        systemctlScript: `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$SYSTEMCTL_LOG"
touch "$CDI_STATE"
exit 0
`,
      });

    expect(result.status, output).toBe(1);
    expect(cdiStateExists).toBe(false);
    expect(output).toMatch(
      /Could not obtain sudo credentials for NVIDIA CDI device spec generation/,
    );
    // The passwordless probe runs; `sudo -v` must not, because there is no
    // terminal and a credential prompt stalls the installer instead of failing.
    expect(sudoLog).toMatch(/^-n true$/m);
    expect(sudoLog).not.toMatch(/^-v$/m);
    expect(systemctlLog).toBe("");
  });

  it("prompts for NVIDIA CDI repair on an interactive terminal", () => {
    const { cdiStateExists, output, sudoLog, systemctlLog } = runNvidiaCdiInstallerRepairTest({
      passwordlessSudo: "none",
      terminal: "tty",
      systemctlScript: `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$SYSTEMCTL_LOG"
if [ "\${1:-}" = "enable" ]; then
  touch "$CDI_STATE"
  exit 0
fi
exit 99
`,
    });

    expect(cdiStateExists).toBe(true);
    expect(output).toMatch(/Enabled NVIDIA CDI refresh service/);
    expect(sudoLog).toMatch(/^-n true$/m);
    expect(sudoLog).toMatch(/^-v$/m);
    // The exact repair command must use the timestamp without another prompt.
    expect(systemctlLog).toMatch(
      /^enable --now nvidia-cdi-refresh\.path nvidia-cdi-refresh\.service$/m,
    );
    expect(sudoLog).toMatch(/^-n systemctl enable --now /m);
  });

  it("prompts for NVIDIA CDI repair when stdin is piped but /dev/tty is open", () => {
    const { cdiStateExists, output, sudoLog, systemctlLog } = runNvidiaCdiInstallerRepairTest({
      passwordlessSudo: "none",
      terminal: "pipe-with-tty",
      systemctlScript: `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$SYSTEMCTL_LOG"
if [ "\${1:-}" = "enable" ]; then
  touch "$CDI_STATE"
  exit 0
fi
exit 99
`,
    });

    // `curl … | bash` leaves stdin as the script pipe. Testing only `[ -t 0 ]`
    // would skip the repair here even though the user can answer on /dev/tty.
    expect(cdiStateExists).toBe(true);
    expect(output).toMatch(
      /Installer stdin is piped; validating sudo credentials through \/dev\/tty/,
    );
    expect(output).toMatch(/Enabled NVIDIA CDI refresh service/);
    expect(output).not.toMatch(
      /Could not obtain sudo credentials for NVIDIA CDI device spec generation/,
    );
    expect(sudoLog).toMatch(/^-n true$/m);
    expect(sudoLog).toMatch(/^-v$/m);
    expect(sudoLog).toMatch(/^-n systemctl enable --now /m);
    expect(systemctlLog).toMatch(
      /^enable --now nvidia-cdi-refresh\.path nvidia-cdi-refresh\.service$/m,
    );
  });

  it.each(["tty", "pipe-with-tty"] as const)(
    "does not prompt for NVIDIA CDI repair in non-interactive %s mode",
    (terminal) => {
      const { cdiStateExists, output, result, sudoLog, systemctlLog } =
        runNvidiaCdiInstallerRepairTest({
          nonInteractive: true,
          passwordlessSudo: "none",
          terminal,
          systemctlScript: `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$SYSTEMCTL_LOG"
touch "$CDI_STATE"
exit 0
`,
        });

      expect(result.status, output).toBe(1);
      expect(cdiStateExists).toBe(false);
      expect(output).toMatch(
        /Could not obtain sudo credentials for NVIDIA CDI device spec generation/,
      );
      expect(output).not.toMatch(/validating sudo credentials/);
      expect(sudoLog).toMatch(/^-n true$/m);
      expect(sudoLog).not.toMatch(/^-v$/m);
      expect(systemctlLog).toBe("");
    },
  );

  it("allows an explicit sudo prompt during non-interactive piped installation", () => {
    const { cdiStateExists, output, sudoLog, systemctlLog } = runNvidiaCdiInstallerRepairTest({
      nonInteractive: true,
      nonInteractiveSudoMode: "prompt",
      passwordlessSudo: "none",
      terminal: "pipe-with-tty",
      systemctlScript: `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$SYSTEMCTL_LOG"
if [ "\${1:-}" = "enable" ]; then
  touch "$CDI_STATE"
  exit 0
fi
exit 99
`,
    });

    expect(cdiStateExists).toBe(true);
    expect(output).toMatch(/validating sudo credentials through \/dev\/tty/);
    expect(sudoLog).toMatch(/^-v$/m);
    expect(sudoLog).toMatch(/^-n systemctl enable --now /m);
    expect(systemctlLog).toMatch(
      /^enable --now nvidia-cdi-refresh\.path nvidia-cdi-refresh\.service$/m,
    );
  });

  it("keeps direct CDI generation non-prompting after /dev/tty authorization", () => {
    const { cdiDir, cdiStateExists, output, sudoLog } = runNvidiaCdiInstallerRepairTest({
      passwordlessSudo: "none",
      terminal: "pipe-with-tty",
      systemctlScript: `#!/usr/bin/env bash
set -euo pipefail
exit 1
`,
    });

    expect(cdiStateExists).toBe(true);
    expect(output).toMatch(
      /Installer stdin is piped; validating sudo credentials through \/dev\/tty/,
    );
    expect(output).toMatch(/Generated NVIDIA CDI device spec/);
    expect(sudoLog).toMatch(/^-v$/m);
    expect(sudoLog).toMatch(/^-n systemctl enable --now /m);
    expect(sudoLog).toContain(`-n mkdir -p ${cdiDir}`);
    expect(sudoLog).toContain(`-n nvidia-ctk cdi generate --output=${cdiDir}/nvidia.yaml`);
  });

  it("keeps NVIDIA CDI repair non-prompting when only the sudo probe is passwordless", () => {
    const { cdiStateExists, output, result, sudoLog, systemctlLog } =
      runNvidiaCdiInstallerRepairTest({
        passwordlessSudo: "probe-only",
        terminal: "pipe-with-tty",
        systemctlScript: `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$SYSTEMCTL_LOG"
touch "$CDI_STATE"
exit 0
`,
      });

    // In this fixture, only `true` can run without a prompt. The repair commands
    // keep `-n`, so they fail instead of prompting through /dev/tty.
    expect(result.status, output).toBe(1);
    expect(cdiStateExists).toBe(false);
    expect(sudoLog).toMatch(/^-n true$/m);
    expect(sudoLog).toMatch(/^-n systemctl enable --now /m);
    expect(sudoLog).not.toMatch(/^-v$/m);
    expect(systemctlLog).toBe("");
    expect(output).toMatch(/Could not generate the NVIDIA CDI device spec automatically/);
  });

  it("does not auto-repair stale NVIDIA CDI specs before toolkit installation", () => {
    const { cdiStateExists, output, result, sudoLog, systemctlLog } =
      runNvidiaCdiInstallerRepairTest({
        stale: true,
        toolkitInstalled: false,
        systemctlScript: `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$SYSTEMCTL_LOG"
touch "$CDI_STATE"
exit 0
`,
      });

    expect(result.status, output).toBe(1);
    expect(cdiStateExists).toBe(false);
    expect(output).toMatch(/Host preflight found issues/);
    expect(output).toMatch(/Install NVIDIA Container Toolkit and refresh CDI device specs/);
    expect(output).not.toMatch(
      /Refreshing NVIDIA CDI device spec with NVIDIA's CDI refresh service/,
    );
    expect(systemctlLog).toBe("");
    expect(sudoLog).toBe("");
  });

  it("falls back to direct NVIDIA CDI generation when refresh service does not repair", () => {
    const { cdiDir, output, result, sudoLog, systemctlLog } = runNvidiaCdiInstallerRepairTest({
      systemctlScript: `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$SYSTEMCTL_LOG"
exit 1
`,
    });

    expect(result.status, output).toBe(0);
    expect(output).toMatch(/Refreshing NVIDIA CDI device spec/);
    expect(output).toMatch(/NemoClaw will first enable NVIDIA's CDI refresh service/);
    expect(output).toMatch(/NemoClaw does not store your password/);
    expect(output).toMatch(/Generated NVIDIA CDI device spec/);
    expect(output).toMatch(/Trying NVIDIA CDI refresh service \(auto-generates GPU CDI specs\)/);
    expect(output).toMatch(/falling back to direct generation/);
    expect(output).not.toMatch(/Host preflight found issues/);
    expect(output).not.toMatch(/noisy nvidia-ctk generate/);
    expect(systemctlLog).toMatch(
      /^enable --now nvidia-cdi-refresh\.path nvidia-cdi-refresh\.service$/m,
    );
    expect(sudoLog).toMatch(/^-n true$/m);
    expect(sudoLog).not.toMatch(/^-v$/m);
    expect(sudoLog).toContain(`nvidia-ctk cdi generate --output=${cdiDir}/nvidia.yaml`);
  });

  it("skips Linux NVIDIA CDI auto-repair on WSL Docker Desktop", () => {
    const { cdiStateExists, output, result, sudoLog, systemctlLog } =
      runNvidiaCdiInstallerRepairTest({
        isWsl: true,
        runtime: "docker-desktop",
        systemctlScript: `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$SYSTEMCTL_LOG"
touch "$CDI_STATE"
exit 0
`,
      });

    expect(result.status, output).toBe(0);
    expect(cdiStateExists).toBe(false);
    expect(output).toMatch(/Host preflight found warnings/);
    expect(output).toMatch(/Use Docker Desktop WSL GPU compatibility path/);
    expect(output).not.toMatch(/Trying NVIDIA CDI refresh service/);
    expect(output).not.toMatch(/Generated NVIDIA CDI device spec/);
    expect(systemctlLog).toBe("");
    expect(sudoLog).toBe("");
  });
});
