// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { OLLAMA_HOST_DOCKER_INTERNAL, validateOllamaPortConfiguration } from "../inference/local";
import { OLLAMA_PORT } from "../core/ports";
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
  return {
    key: "ollama",
    label: `Local Ollama (${hostDisplay})${runningSuffix}${windowsHostSuffix}${suggestionSuffix}`,
  };
}

export interface OllamaInstallMenuEntry {
  key: "install-ollama";
  label: string;
}

export interface OllamaInstallMenuResult {
  entry: OllamaInstallMenuEntry | null;
  hasUpgradableOllama: boolean;
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
 *   1. No Ollama anywhere (host, running, or Windows) — offer a fresh install
 *      as a fallback (e.g. when the NVIDIA API server is down and cloud keys
 *      are unavailable).
 *   2. Host Ollama exists but its version is below `MIN_OLLAMA_VERSION` —
 *      offer an explicit upgrade so the express setup path doesn't reuse a
 *      daemon that crashes loading newer starter models.
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
  const daemonProbeApplies = input.ollamaRunning && isLocalOllamaHost(input.ollamaHost);
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
  const binaryNeedsUpgrade =
    input.hasOllama && !isOllamaVersionAtLeast(installedOllamaVersion, MIN_OLLAMA_VERSION);
  const daemonNeedsUpgrade =
    daemonProbeApplies && !isOllamaVersionAtLeast(runningOllamaVersion, MIN_OLLAMA_VERSION);
  const hasUpgradableOllama = binaryNeedsUpgrade || daemonNeedsUpgrade;
  const showEntry =
    (!input.hasOllama && !input.ollamaRunning && !input.hasWindowsOllama) || hasUpgradableOllama;
  if (!showEntry) {
    return { entry: null, hasUpgradableOllama };
  }
  const osTag = osTagFor(input.platform, input.isWsl);
  if (osTag === null) {
    return { entry: null, hasUpgradableOllama };
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
  };
}

export interface OllamaUpgradeApplied {
  ok: boolean;
  detectedDaemonVersion: string | null;
  detectedBinaryVersion: string | null;
  message?: string;
}

/**
 * After the install/upgrade command, confirm the running Ollama daemon
 * actually advanced past `MIN_OLLAMA_VERSION`. The CLI binary on `PATH`
 * is not sufficient: a user-local install can put a newer binary on
 * `${HOME}/.local/bin` while the system daemon still owns `:11434`, and
 * `brew upgrade ollama` can fail silently with no daemon restart. Probe
 * `/api/version` on the daemon so the verdict matches what NemoClaw will
 * actually use for inference. The binary version is captured alongside
 * for diagnostics only.
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
  if (isOllamaVersionAtLeast(detectedDaemonVersion, MIN_OLLAMA_VERSION)) {
    return { ok: true, detectedDaemonVersion, detectedBinaryVersion };
  }
  const daemonLabel = detectedDaemonVersion ?? "unreachable";
  const binaryLabel = detectedBinaryVersion ?? "unknown";
  return {
    ok: false,
    detectedDaemonVersion,
    detectedBinaryVersion,
    message:
      `Ollama upgrade did not take effect — running daemon reports ${daemonLabel} (binary: ${binaryLabel}), need ≥ ${MIN_OLLAMA_VERSION}. ` +
      "Restart the system daemon and rerun, or upgrade Ollama manually (https://ollama.com/download).",
  };
}
