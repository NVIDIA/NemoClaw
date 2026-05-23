// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import { OLLAMA_PORT } from "../core/ports";
import { sleepSeconds, waitForHttp } from "../core/wait";
import { cliName } from "./branding";
import {
  ensureManagedOllamaLoopbackSystemdOverride,
  type OllamaLoopbackSystemdOverrideState,
} from "./ollama-systemd";

const {
  runCapture,
  runCaptureEx,
  runShell,
  shellQuote,
}: typeof import("../runner") = require("../runner");
const {
  findReachableOllamaHost,
}: typeof import("../inference/local") = require("../inference/local");

/**
 * Install location modes.
 *
 *  - `system`     installs into `/usr/local` via the official Ollama
 *                 installer script (`https://ollama.com/install.sh`). Requires
 *                 sudo, configures a systemd service, and writes to a system
 *                 user (`ollama`). This is the historical path.
 *  - `user-local` installs into `${HOME}/.local` by downloading the official
 *                 release tarball directly and extracting it as the invoking
 *                 user. No sudo, no systemd, no system user. The daemon is
 *                 launched once via a backgrounded `ollama serve`; reboot
 *                 persistence is the user's responsibility.
 */
export type InstallOllamaLinuxMode = "system" | "user-local";

export type InstallOllamaLinuxResult = {
  ok: boolean;
  mode: InstallOllamaLinuxMode;
  binPath: string;
};

export type InstallOllamaLinuxOptions = {
  /** Returns true when onboard is running headless (NEMOCLAW_NON_INTERACTIVE=1
   *  or the `--non-interactive` flag was passed). Used to decide whether sudo
   *  prompts are viable and whether the systemd override may prompt. */
  isNonInteractive: () => boolean;
  /** Test seam: override the auto-detected install mode. */
  modeOverride?: InstallOllamaLinuxMode;
  /** Test seam: override the `sudo -n true` probe result. */
  canSudoNonInteractive?: () => boolean;
  /** Test seam: override `process.getuid()`. */
  getEuid?: () => number | undefined;
  /** Test seam: override stdin TTY detection. */
  isTty?: () => boolean;
  /** Test seam: override `os.homedir()`. */
  homedir?: () => string;
  /** Test seam: override `process.arch`. */
  arch?: () => NodeJS.Architecture;
  /** Test seam: override `runCapture`. */
  runCaptureImpl?: typeof runCapture;
  /** Test seam: override `runCaptureEx`. */
  runCaptureExImpl?: typeof runCaptureEx;
  /** Test seam: override `runShell`. */
  runShellImpl?: typeof runShell;
  /** Test seam: override systemd loopback override. */
  ensureManagedOllamaLoopbackSystemdOverrideImpl?: typeof ensureManagedOllamaLoopbackSystemdOverride;
  /** Test seam: override `findReachableOllamaHost`. */
  findReachableOllamaHostImpl?: typeof findReachableOllamaHost;
  /** Test seam: override `waitForHttp`. */
  waitForHttpImpl?: typeof waitForHttp;
  /** Test seam: override `sleepSeconds`. */
  sleepSecondsImpl?: typeof sleepSeconds;
  /** Test seam: override `fs.existsSync` (for /etc/nv_tegra_release detection). */
  fileExistsImpl?: (path: string) => boolean;
  /** Test seam: override `fs.readFileSync`. */
  readFileImpl?: (path: string) => string;
  /** Test seam: redirect log output. */
  log?: (message: string) => void;
  /** Test seam: redirect error output. */
  errorLog?: (message: string) => void;
};

const INSTALL_MODE_ENV = "NEMOCLAW_OLLAMA_INSTALL_MODE";

/**
 * Resolve the install mode.
 *
 * Order of precedence (highest first):
 *  1. The `NEMOCLAW_OLLAMA_INSTALL_MODE` env var when set to `user` or
 *     `system`. Any other value is rejected.
 *  2. Running as root (`euid === 0`) → `system` (no sudo required).
 *  3. Passwordless sudo available (`sudo -n true` returns 0) → `system`.
 *  4. Non-interactive context (either the `NEMOCLAW_NON_INTERACTIVE=1` flag
 *     or no TTY attached to stdin) → `user-local`. This is the path that
 *     fixes #4114: a headless run that cannot prompt for a sudo password
 *     falls back to a sudo-free user-local install instead of crashing
 *     mid-install.
 *  5. Interactive shell → `system` (sudo can prompt the user for a password).
 */
export function decideInstallOllamaLinuxMode(
  opts: InstallOllamaLinuxOptions,
): InstallOllamaLinuxMode {
  if (opts.modeOverride) return opts.modeOverride;
  const explicit = String(process.env[INSTALL_MODE_ENV] || "").trim().toLowerCase();
  if (explicit === "user") return "user-local";
  if (explicit === "system") return "system";
  if (explicit) {
    const errorLog = opts.errorLog ?? ((m: string) => console.error(m));
    errorLog(
      `  Unsupported ${INSTALL_MODE_ENV} value: ${explicit}. Use 'system', 'user', or leave it unset.`,
    );
    process.exit(1);
  }
  const getEuid = opts.getEuid ?? (() => process.getuid?.());
  if (getEuid() === 0) return "system";
  if (canRunSudoNonInteractive(opts)) return "system";
  const isTty = opts.isTty ?? (() => Boolean(process.stdin.isTTY));
  if (opts.isNonInteractive() || !isTty()) return "user-local";
  return "system";
}

function canRunSudoNonInteractive(opts: InstallOllamaLinuxOptions): boolean {
  if (opts.canSudoNonInteractive) return opts.canSudoNonInteractive();
  const runCaptureExImpl = opts.runCaptureExImpl ?? runCaptureEx;
  if (!hostCommandExists("sudo", opts)) return false;
  const result = runCaptureExImpl(["sudo", "-n", "true"], { timeout: 2_000 });
  return result.exitCode === 0;
}

function hostCommandExists(name: string, opts: InstallOllamaLinuxOptions): boolean {
  const runCaptureImpl = opts.runCaptureImpl ?? runCapture;
  return !!runCaptureImpl(["sh", "-c", 'command -v "$1"', "--", name], {
    ignoreError: true,
  });
}

/**
 * Map Node's `process.arch` to the architecture suffix Ollama publishes
 * tarballs under (`amd64` / `arm64`). Returns `null` for anything else —
 * callers must surface a clear error rather than guess.
 */
export function resolveOllamaTarballArch(arch: NodeJS.Architecture): "amd64" | "arm64" | null {
  if (arch === "x64") return "amd64";
  if (arch === "arm64") return "arm64";
  return null;
}

/**
 * Detect a JetPack release line from `/etc/nv_tegra_release` to pull the
 * matching CUDA add-on tarball. Mirrors the JetPack branch of the official
 * `install.sh` (L178-187).
 */
function detectJetpackVariant(opts: InstallOllamaLinuxOptions): "jetpack5" | "jetpack6" | null {
  const exists = opts.fileExistsImpl ?? fs.existsSync;
  const read = opts.readFileImpl ?? ((p: string) => fs.readFileSync(p, "utf8"));
  if (!exists("/etc/nv_tegra_release")) return null;
  let body = "";
  try {
    body = read("/etc/nv_tegra_release");
  } catch {
    return null;
  }
  if (/R36/.test(body)) return "jetpack6";
  if (/R35/.test(body)) return "jetpack5";
  return null;
}

/**
 * Run the official `https://ollama.com/install.sh`. Sudo-bound. Configures
 * the systemd `ollama.service`, creates the `ollama` system user, and
 * installs CUDA drivers when applicable.
 */
function runOfficialInstallScript(opts: InstallOllamaLinuxOptions): void {
  const log = opts.log ?? ((m: string) => console.log(m));
  const runShellImpl = opts.runShellImpl ?? runShell;
  ensureOllamaLinuxExtractionDependencies(opts);
  log(
    "  The Ollama installer creates a system user, a systemd service, and writes to /usr/local. " +
      "It uses sudo, may ask for your password, and can take a few minutes; installer output will stream below.",
  );
  runShellImpl("set -o pipefail; curl -fsSL https://ollama.com/install.sh | sh", {
    stdio: "inherit",
  });
}

/**
 * Apt-based zstd bootstrap. Only viable in `system` mode, where sudo is
 * available. The `user-local` branch hard-fails with manual install
 * instructions instead (the script cannot install system packages without
 * elevation).
 */
function ensureOllamaLinuxExtractionDependencies(opts: InstallOllamaLinuxOptions): void {
  if (hostCommandExists("zstd", opts)) return;
  const log = opts.log ?? ((m: string) => console.log(m));
  const runShellImpl = opts.runShellImpl ?? runShell;
  log(
    "  The Ollama Linux installer requires zstd for archive extraction. " +
      "The next step uses sudo to install zstd; you may be prompted for your password.",
  );
  runShellImpl(`if ! command -v apt-get >/dev/null 2>&1; then
  echo "ERROR: Ollama requires zstd for extraction, and only apt-based Linux is supported here." >&2
  echo "Install zstd manually (for example, sudo dnf install zstd or sudo pacman -S zstd), then rerun ${cliName()} onboard." >&2
  exit 1
fi
sudo apt-get update -qq && sudo apt-get install -y -qq --no-install-recommends zstd`);
}

/**
 * Download and extract the Ollama release tarball into `installDir` without
 * sudo. Mirrors `download_and_extract` from `install.sh` (L130-157) with the
 * `$SUDO` invocations stripped. zstd is the primary format; falls back to
 * `.tgz` for tags where the zst asset is unpublished.
 *
 * Hard-fails when zstd is unavailable: we cannot bootstrap it without sudo
 * elevation in user-local mode, so we surface the same per-distro install
 * hint that `install.sh` does.
 */
function downloadAndExtractUserLocal(
  tarballName: string,
  installDir: string,
  opts: InstallOllamaLinuxOptions,
): void {
  const runShellImpl = opts.runShellImpl ?? runShell;
  const runCaptureExImpl = opts.runCaptureExImpl ?? runCaptureEx;
  const errorLog = opts.errorLog ?? ((m: string) => console.error(m));
  const log = opts.log ?? ((m: string) => console.log(m));

  const zstUrl = `https://ollama.com/download/${tarballName}.tar.zst`;
  const tgzUrl = `https://ollama.com/download/${tarballName}.tgz`;

  const headProbe = runCaptureExImpl(
    ["curl", "--fail", "--silent", "--head", "--location", zstUrl],
    { timeout: 15_000 },
  );
  const zstExists = headProbe.exitCode === 0;

  const quotedInstallDir = shellQuote(installDir);
  if (zstExists) {
    if (!hostCommandExists("zstd", opts)) {
      errorLog(
        `  ERROR: ${tarballName} ships as .tar.zst but zstd is not installed and ${cliName()} cannot bootstrap it without sudo.\n` +
          `         Install zstd manually, then rerun ${cliName()} onboard:\n` +
          "           - Debian/Ubuntu: sudo apt-get install zstd\n" +
          "           - RHEL/CentOS/Fedora: sudo dnf install zstd\n" +
          "           - Arch: sudo pacman -S zstd",
      );
      process.exit(1);
    }
    log(`  Downloading ${tarballName}.tar.zst`);
    runShellImpl(
      `set -o pipefail; curl --fail --show-error --location ${shellQuote(zstUrl)} | zstd -d | tar -xf - -C ${quotedInstallDir}`,
      { stdio: "inherit" },
    );
    return;
  }

  log(`  Downloading ${tarballName}.tgz`);
  runShellImpl(
    `set -o pipefail; curl --fail --show-error --location ${shellQuote(tgzUrl)} | tar -xzf - -C ${quotedInstallDir}`,
    { stdio: "inherit" },
  );
}

/**
 * Sudo-free, ~/.local-rooted install. Replicates the binary-extraction
 * portion of the official `install.sh` (L159-187) but skips the parts that
 * require root: the `install -o0 -g0` chown, the systemd service file, and
 * the CUDA driver setup. The daemon is launched once at the end of the
 * install with a backgrounded `ollama serve`. Manual re-launch is required
 * after a reboot (this is documented in `docs/inference/use-local-inference.mdx`).
 *
 * Refuses to proceed on unsupported architectures.
 */
function installOllamaUserLocal(opts: InstallOllamaLinuxOptions): InstallOllamaLinuxResult {
  const log = opts.log ?? ((m: string) => console.log(m));
  const errorLog = opts.errorLog ?? ((m: string) => console.error(m));
  const runShellImpl = opts.runShellImpl ?? runShell;
  const homedir = opts.homedir ?? (() => os.homedir());
  const arch = opts.arch ?? (() => process.arch);

  const ollamaArch = resolveOllamaTarballArch(arch());
  if (!ollamaArch) {
    errorLog(
      `  ERROR: User-local Ollama install does not support architecture '${arch()}'. ` +
        "Set NEMOCLAW_OLLAMA_INSTALL_MODE=system and run onboard interactively, " +
        "or install Ollama manually before re-running onboard.",
    );
    return { ok: false, mode: "user-local", binPath: "" };
  }

  const installDir = nodePath.join(homedir(), ".local");
  const binDir = nodePath.join(installDir, "bin");
  const binPath = nodePath.join(binDir, "ollama");
  const libDir = nodePath.join(installDir, "lib", "ollama");

  log(
    `  Installing Ollama in user-local mode (${installDir}). ` +
      "No sudo, no systemd; the daemon will be launched manually and must be restarted after a reboot.",
  );

  runShellImpl(`mkdir -p ${shellQuote(binDir)} ${shellQuote(libDir)}`);
  downloadAndExtractUserLocal(`ollama-linux-${ollamaArch}`, installDir, opts);
  const jetpack = detectJetpackVariant(opts);
  if (jetpack) {
    log(`  Detected NVIDIA JetPack (${jetpack}); pulling matching add-on.`);
    downloadAndExtractUserLocal(`ollama-linux-${ollamaArch}-${jetpack}`, installDir, opts);
  }

  if (!startUserLocalOllamaDaemon(binPath, opts)) {
    errorLog(`  Ollama did not become ready on :${OLLAMA_PORT} within timeout.`);
    return { ok: false, mode: "user-local", binPath };
  }

  warnIfLocalBinNotOnPath(binDir, opts);

  return { ok: true, mode: "user-local", binPath };
}

function startUserLocalOllamaDaemon(
  binPath: string,
  opts: InstallOllamaLinuxOptions,
): boolean {
  const log = opts.log ?? ((m: string) => console.log(m));
  const runShellImpl = opts.runShellImpl ?? runShell;
  const waitForHttpImpl = opts.waitForHttpImpl ?? waitForHttp;
  log("  Starting Ollama...");
  runShellImpl(
    `OLLAMA_HOST=127.0.0.1:${OLLAMA_PORT} nohup ${shellQuote(binPath)} serve > /dev/null 2>&1 &`,
    { ignoreError: true },
  );
  return waitForHttpImpl(`http://127.0.0.1:${OLLAMA_PORT}/`, 10);
}

/**
 * Emit a one-line PATH hint when `~/.local/bin` is missing from `PATH`. We
 * intentionally do not edit shell rc files here: that is the operator's
 * choice and `scripts/install.sh` already owns shell-profile rewrites for
 * the NemoClaw CLI itself.
 */
function warnIfLocalBinNotOnPath(binDir: string, opts: InstallOllamaLinuxOptions): void {
  const log = opts.log ?? ((m: string) => console.log(m));
  const pathEntries = String(process.env.PATH || "").split(nodePath.delimiter);
  if (pathEntries.includes(binDir)) return;
  log(
    `  Note: ${binDir} is not on your PATH. ` +
      `Add 'export PATH="${binDir}:$PATH"' to your shell profile to invoke 'ollama' directly.`,
  );
}

/**
 * Sudo-driven path. Runs the official installer, then forces the systemd
 * service to bind only to loopback (so the Docker bridge cannot reach raw
 * Ollama). Falls back to a manual `ollama serve` launch when systemd is
 * unavailable (e.g. WSL without systemd, minimal containers).
 */
function installOllamaSystem(opts: InstallOllamaLinuxOptions): InstallOllamaLinuxResult {
  const log = opts.log ?? ((m: string) => console.log(m));
  const errorLog = opts.errorLog ?? ((m: string) => console.error(m));
  const runShellImpl = opts.runShellImpl ?? runShell;
  const sleepSecondsImpl = opts.sleepSecondsImpl ?? sleepSeconds;
  const waitForHttpImpl = opts.waitForHttpImpl ?? waitForHttp;
  const findReachableOllamaHostImpl =
    opts.findReachableOllamaHostImpl ?? findReachableOllamaHost;
  const ensureOverrideImpl =
    opts.ensureManagedOllamaLoopbackSystemdOverrideImpl
    ?? ensureManagedOllamaLoopbackSystemdOverride;

  runOfficialInstallScript(opts);
  sleepSecondsImpl(2);

  const overrideState: OllamaLoopbackSystemdOverrideState = ensureOverrideImpl({
    isNonInteractive: opts.isNonInteractive,
  });
  if (overrideState === "failed") {
    errorLog("  Ollama systemd restart did not recover after applying the loopback override.");
    return { ok: false, mode: "system", binPath: "/usr/local/bin/ollama" };
  }

  if (overrideState === "not-applicable" && !findReachableOllamaHostImpl()) {
    log("  Starting Ollama...");
    runShellImpl(`OLLAMA_HOST=127.0.0.1:${OLLAMA_PORT} ollama serve > /dev/null 2>&1 &`, {
      ignoreError: true,
    });
    if (!waitForHttpImpl(`http://127.0.0.1:${OLLAMA_PORT}/`, 10)) {
      errorLog(`  Ollama did not become ready on :${OLLAMA_PORT} within timeout.`);
      return { ok: false, mode: "system", binPath: "/usr/local/bin/ollama" };
    }
  }

  return { ok: true, mode: "system", binPath: "/usr/local/bin/ollama" };
}

/**
 * Entry point: decide an install mode (see `decideInstallOllamaLinuxMode`)
 * and run the matching install path. Returns `{ ok: false, ... }` rather
 * than throwing so the caller (the onboard selection loop) can continue to
 * the next menu entry on interactive runs.
 */
export function installOllamaOnLinux(
  opts: InstallOllamaLinuxOptions,
): InstallOllamaLinuxResult {
  const mode = decideInstallOllamaLinuxMode(opts);
  if (mode === "user-local") return installOllamaUserLocal(opts);
  return installOllamaSystem(opts);
}
