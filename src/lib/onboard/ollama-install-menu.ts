// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { OLLAMA_PORT } from "../core/ports";
import { OLLAMA_HOST_DOCKER_INTERNAL, validateOllamaPortConfiguration } from "../inference/local";
import {
  getInstalledOllamaVersion,
  getRunningOllamaDaemonVersion,
  isOllamaVersionAtLeast,
  MIN_OLLAMA_VERSION,
  type OllamaVersionRunCapture,
} from "../inference/ollama-version";

export interface OllamaInstallMenuInput {
  hasOllama: boolean;
  ollamaRunning: boolean;
  hasWindowsOllama: boolean;
  /** Whether the sandbox can reach a Windows-host Ollama daemon at all. A
   *  Windows install behind a container runtime without `host.docker.internal`
   *  routing covers nothing, so the WSL-local install entry stays on offer.
   *  Only read when `hasWindowsOllama` is set; defaults to reachable. */
  windowsHostOllamaSupported?: boolean;
  /** True when the responding daemon is known to run on Windows, including
   *  WSL mirrored networking where it is observed through distro loopback. */
  isWindowsHostOllama?: boolean;
  platform: NodeJS.Platform;
  isWsl: boolean;
  /** Resolved host for the running Ollama daemon. `host.docker.internal`
   *  means the Windows host (NemoClaw routes the WSL sandbox there); the
   *  Linux `install-ollama` entry does not apply in that case, so the
   *  helper skips the daemon-version gate.
   *  Null when no daemon is running locally. */
  ollamaHost?: string | null;
  /** Override for tests. Defaults to a live `ollama --version` probe. */
  installedOllamaVersion?: string | null;
  /** Override for tests. Defaults to a live `/api/version` probe on the
   *  resolved `ollamaHost`. */
  runningOllamaVersion?: string | null;
}

function buildDaemonEndpoint(host: string): string {
  return `http://${host}:${OLLAMA_PORT}/api/version`;
}

function isLocalOllamaHost(host: string | null | undefined): boolean {
  return Boolean(host) && host !== OLLAMA_HOST_DOCKER_INTERNAL;
}

export interface RunningOllamaMenuInput {
  hasOllama: boolean;
  ollamaRunning: boolean;
  isWsl: boolean;
  ollamaPort: number;
  ollamaHost?: string | null;
  windowsHostLabelSuffix?: string;
}

export function checkOllamaPortsOrWarn(input: { isNonInteractive: () => boolean }): boolean {
  const portValidation = validateOllamaPortConfiguration();
  if (!portValidation.ok) {
    console.error(`  ${portValidation.message}`);
    if (input.isNonInteractive()) {
      process.exit(1);
    }
    console.log("  Choose a different local inference provider or fix the port settings.");
    console.log("");
    return false;
  }
  return true;
}

export function resolveRunningOllamaMenuEntry(
  input: RunningOllamaMenuInput,
): { key: "ollama"; label: string } | null {
  if (!input.hasOllama && !input.ollamaRunning) return null;
  let hostDisplay: string;
  if (input.ollamaHost === OLLAMA_HOST_DOCKER_INTERNAL) {
    hostDisplay = `Windows host:${input.ollamaPort}`;
  } else if (input.isWsl) {
    hostDisplay = `WSL:${input.ollamaPort}`;
  } else {
    hostDisplay = `localhost:${input.ollamaPort}`;
  }
  const windowsHostSuffix =
    input.ollamaHost === OLLAMA_HOST_DOCKER_INTERNAL ? input.windowsHostLabelSuffix || "" : "";
  const suggested =
    input.ollamaRunning &&
    (input.ollamaHost === OLLAMA_HOST_DOCKER_INTERNAL ? !windowsHostSuffix : !input.isWsl);
  const runningSuffix = input.ollamaRunning ? " — running" : "";
  const suggestionSuffix = suggested ? " (suggested)" : "";
  // A stopped daemon renders as an action, not a status: selecting the entry
  // starts Ollama, and a bare "Local Ollama (WSL:11434)" reads as a
  // reachability claim when the daemon is down (#6750).
  const labelPrefix = input.ollamaRunning ? "Local Ollama" : "Start local Ollama";
  return {
    key: "ollama",
    label: `${labelPrefix} (${hostDisplay})${runningSuffix}${windowsHostSuffix}${suggestionSuffix}`,
  };
}

export interface OllamaInstallMenuEntry {
  key: "install-ollama";
  label: string;
}

export interface OllamaInstallMenuResult {
  entry: OllamaInstallMenuEntry | null;
  hasUpgradableOllama: boolean;
  /** Whether recovery must install or replace the binary, rather than only restart its daemon. */
  binaryNeedsUpgrade?: boolean;
}

function osTagFor(platform: NodeJS.Platform, isWsl: boolean): string | null {
  if (platform === "darwin") return "macOS";
  if (platform === "linux") return isWsl ? "WSL Linux" : "Linux";
  return null;
}

/**
 * Decide whether the onboard provider menu should expose an `install-ollama`
 * entry, and which label to render. Two cases:
 *
 *   1. No usable Ollama anywhere (host, running, or a Windows install the
 *      sandbox can reach) — offer a fresh install as a fallback (e.g. when the
 *      NVIDIA API server is down and cloud keys are unavailable).
 *   2. Host Ollama exists but its version is unavailable or below
 *      `MIN_OLLAMA_VERSION` — offer an explicit upgrade so onboarding does
 *      not reuse a daemon that can return tool calls as message text.
 */
export function resolveOllamaInstallMenuEntry(
  input: OllamaInstallMenuInput,
): OllamaInstallMenuResult {
  const installedOllamaVersion =
    input.installedOllamaVersion !== undefined
      ? input.installedOllamaVersion
      : input.hasOllama
        ? getInstalledOllamaVersion()
        : null;
  // Only consider the running daemon's version when it is the one NemoClaw
  // would actually upgrade through this entry: a local daemon on
  // 127.0.0.1/localhost. A Windows-host daemon reached via
  // `host.docker.internal` is handled by separate menu entries
  // (`install-windows-ollama` / `start-windows-ollama`).
  const localUpgradeApplies = input.isWindowsHostOllama !== true;
  const daemonProbeApplies =
    localUpgradeApplies && input.ollamaRunning && isLocalOllamaHost(input.ollamaHost);
  const runningOllamaVersion =
    input.runningOllamaVersion !== undefined
      ? input.runningOllamaVersion
      : daemonProbeApplies && input.ollamaHost
        ? getRunningOllamaDaemonVersion(undefined, buildDaemonEndpoint(input.ollamaHost))
        : null;
  // Catch both stale-binary and stale-daemon cases: a user-local install can
  // put a fresh `ollama` on `PATH` while the system daemon keeps `:11434`
  // on the old version (and vice versa). Upgrade when either source is below
  // the minimum.
  const installedBinaryMeetsMinimum =
    localUpgradeApplies &&
    input.hasOllama &&
    isOllamaVersionAtLeast(installedOllamaVersion, MIN_OLLAMA_VERSION);
  const daemonNeedsUpgrade =
    daemonProbeApplies && !isOllamaVersionAtLeast(runningOllamaVersion, MIN_OLLAMA_VERSION);
  // Restart-only recovery is safe only with positive evidence that the
  // installed binary meets the floor. A stale daemon without a local binary
  // still needs the installer to provide one.
  const binaryNeedsUpgrade =
    localUpgradeApplies &&
    !installedBinaryMeetsMinimum &&
    (input.hasOllama || daemonNeedsUpgrade);
  const hasUpgradableOllama = binaryNeedsUpgrade || daemonNeedsUpgrade;
  // A Windows-host install only covers the local-inference need when the
  // sandbox can route to it. Under a container runtime without that routing,
  // WSL-local Ollama is the only workable local provider, and suppressing its
  // entry left a requested `install-ollama` with nothing to select (#8199).
  const usableWindowsOllama = input.hasWindowsOllama && (input.windowsHostOllamaSupported ?? true);
  const showEntry =
    (!input.hasOllama && !input.ollamaRunning && !usableWindowsOllama) || hasUpgradableOllama;
  if (!showEntry) {
    return { entry: null, hasUpgradableOllama, binaryNeedsUpgrade };
  }
  const osTag = osTagFor(input.platform, input.isWsl);
  if (osTag === null) {
    return { entry: null, hasUpgradableOllama, binaryNeedsUpgrade };
  }
  const labelPrefix = hasUpgradableOllama ? "Upgrade Ollama" : "Install Ollama";
  // Name the stale source explicitly: "running daemon" when the daemon is
  // the stale side, "installed binary" when the CLI is the stale side. A
  // generic "Ollama" fallback covers the case where we couldn't read either
  // version (binary missing or daemon unreachable).
  let staleSource: string;
  let reportedVersion: string | null;
  if (daemonNeedsUpgrade) {
    staleSource = "running daemon";
    reportedVersion = runningOllamaVersion ?? installedOllamaVersion;
  } else if (binaryNeedsUpgrade) {
    staleSource = "installed binary";
    reportedVersion = installedOllamaVersion ?? runningOllamaVersion;
  } else {
    staleSource = "Ollama";
    reportedVersion = null;
  }
  const upgradeSuffix = hasUpgradableOllama
    ? ` — upgrade ${staleSource} ${reportedVersion ?? "unknown"} to ≥ ${MIN_OLLAMA_VERSION}`
    : "";
  return {
    entry: { key: "install-ollama", label: `${labelPrefix} (${osTag})${upgradeSuffix}` },
    hasUpgradableOllama,
    binaryNeedsUpgrade,
  };
}

export interface OllamaUpgradeApplied {
  ok: boolean;
  detectedDaemonVersion: string | null;
  detectedBinaryVersion: string | null;
  message?: string;
}

/**
 * After an upgrade command, confirm that the running Ollama daemon and the
 * installed binary both meet `MIN_OLLAMA_VERSION`. A user-local install
 * can put a newer binary on `PATH` while the system daemon still owns `:11434`.
 * The reverse mismatch can leave an older binary on `PATH` after the daemon
 * restarts. Probe both versions so onboarding rejects either incomplete state.
 */
export function assertOllamaUpgradeApplied(
  menu: { hasUpgradableOllama: boolean },
  runCaptureImpl?: OllamaVersionRunCapture,
): OllamaUpgradeApplied {
  if (!menu.hasUpgradableOllama) {
    return { ok: true, detectedDaemonVersion: null, detectedBinaryVersion: null };
  }
  const detectedDaemonVersion = getRunningOllamaDaemonVersion(runCaptureImpl);
  const detectedBinaryVersion = getInstalledOllamaVersion(runCaptureImpl);
  if (
    isOllamaVersionAtLeast(detectedDaemonVersion, MIN_OLLAMA_VERSION) &&
    isOllamaVersionAtLeast(detectedBinaryVersion, MIN_OLLAMA_VERSION)
  ) {
    return { ok: true, detectedDaemonVersion, detectedBinaryVersion };
  }
  const daemonLabel = detectedDaemonVersion ?? "unreachable";
  const binaryLabel = detectedBinaryVersion ?? "unknown";
  const state = `running daemon reports ${daemonLabel} (binary: ${binaryLabel}), need ≥ ${MIN_OLLAMA_VERSION}`;
  return {
    ok: false,
    detectedDaemonVersion,
    detectedBinaryVersion,
    message: `Ollama upgrade did not take effect — ${state}. ${resolveUpgradeRemedy(detectedDaemonVersion, detectedBinaryVersion)}`,
  };
}

function resolveUpgradeRemedy(
  detectedDaemonVersion: string | null,
  detectedBinaryVersion: string | null,
): string {
  if (isOllamaVersionAtLeast(detectedBinaryVersion, MIN_OLLAMA_VERSION)) {
    return (
      "The installed binary meets the minimum, so the service is still serving the old one. " +
      "Restart it with 'sudo systemctl restart ollama' and rerun."
    );
  }
  if (!detectedBinaryVersion) {
    if (!detectedDaemonVersion) {
      return (
        "Neither the daemon nor the binary could be read. Check that Ollama is installed and " +
        "running, then rerun, or install it manually (https://ollama.com/download)."
      );
    }
    return (
      "The installed binary version could not be read. Check that the Ollama binary is installed " +
      "and available on PATH, then rerun, or install it manually (https://ollama.com/download)."
    );
  }
  return (
    `The installer did not deliver ${MIN_OLLAMA_VERSION} on this host. Install it directly with ` +
    `'curl -fsSL https://ollama.com/install.sh | OLLAMA_VERSION=${MIN_OLLAMA_VERSION} sh' and rerun.`
  );
}
