// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { MIN_OLLAMA_VERSION } from "../inference/ollama-version";
import {
  assertOllamaUpgradeApplied,
  resolveOllamaInstallMenuEntry,
  resolveRunningOllamaMenuEntry,
} from "./ollama-install-menu";

const LINUX_NON_WSL = { platform: "linux" as const, isWsl: false };

function captureOllamaVersions(
  daemonVersion: string | null,
  binaryVersion: string | null,
): (command: readonly string[]) => string {
  const responses = new Map<string, string>([
    [
      JSON.stringify([
        "curl",
        "-sf",
        "--connect-timeout",
        "2",
        "--max-time",
        "5",
        "http://127.0.0.1:11434/api/version",
      ]),
      daemonVersion ? JSON.stringify({ version: daemonVersion }) : "",
    ],
    [
      JSON.stringify(["ollama", "--version"]),
      binaryVersion ? `ollama version is ${binaryVersion}` : "",
    ],
  ]);
  return (command) => responses.get(JSON.stringify(command)) ?? "";
}

describe("resolveRunningOllamaMenuEntry", () => {
  it("labels unsupported Windows-host Ollama without suggesting it", () => {
    const entry = resolveRunningOllamaMenuEntry({
      hasOllama: false,
      ollamaRunning: true,
      ollamaHost: "host.docker.internal",
      isWsl: true,
      ollamaPort: 11434,
      windowsHostLabelSuffix: " (requires Docker Desktop WSL integration)",
    });

    expect(entry).toEqual({
      key: "ollama",
      label:
        "Local Ollama (Windows host:11434) — running (requires Docker Desktop WSL integration)",
    });
  });

  it("renders a start action for installed-but-stopped Ollama on WSL (#6750)", () => {
    const entry = resolveRunningOllamaMenuEntry({
      hasOllama: true,
      ollamaRunning: false,
      ollamaHost: null,
      isWsl: true,
      ollamaPort: 11434,
    });

    expect(entry).toEqual({ key: "ollama", label: "Start local Ollama (WSL:11434)" });
  });

  it("renders a start action for installed-but-stopped Ollama on non-WSL hosts (#6750)", () => {
    const entry = resolveRunningOllamaMenuEntry({
      hasOllama: true,
      ollamaRunning: false,
      ollamaHost: null,
      isWsl: false,
      ollamaPort: 11434,
    });

    expect(entry).toEqual({ key: "ollama", label: "Start local Ollama (localhost:11434)" });
  });
});

describe("resolveOllamaInstallMenuEntry", () => {
  it("offers a fresh install when no Ollama is present", () => {
    const result = resolveOllamaInstallMenuEntry({
      hasOllama: false,
      ollamaRunning: false,
      hasWindowsOllama: false,
      windowsHostOllamaSupported: true,
      installedOllamaVersion: null,
      ...LINUX_NON_WSL,
    });
    expect(result.hasUpgradableOllama).toBe(false);
    expect(result.entry?.key).toBe("install-ollama");
    expect(result.entry?.label).toBe("Install Ollama (Linux)");
  });

  it("offers an upgrade entry when host Ollama is below the minimum", () => {
    const result = resolveOllamaInstallMenuEntry({
      hasOllama: true,
      ollamaRunning: true,
      hasWindowsOllama: false,
      windowsHostOllamaSupported: true,
      installedOllamaVersion: "0.6.2",
      runningOllamaVersion: "0.6.2",
      ...LINUX_NON_WSL,
    });
    expect(result.hasUpgradableOllama).toBe(true);
    expect(result.binaryNeedsUpgrade).toBe(true);
    expect(result.entry?.key).toBe("install-ollama");
    expect(result.entry?.label).toBe(
      `Upgrade Ollama (Linux) — upgrade installed binary 0.6.2 to ≥ ${MIN_OLLAMA_VERSION}`,
    );
  });

  it("omits the entry when host Ollama meets the minimum", () => {
    const result = resolveOllamaInstallMenuEntry({
      hasOllama: true,
      ollamaRunning: true,
      hasWindowsOllama: false,
      windowsHostOllamaSupported: true,
      installedOllamaVersion: "0.32.9",
      runningOllamaVersion: "0.32.9",
      ...LINUX_NON_WSL,
    });
    expect(result.hasUpgradableOllama).toBe(false);
    expect(result.entry).toBeNull();
  });

  it("offers an upgrade entry when the running daemon is stale even though the binary is fresh", () => {
    const result = resolveOllamaInstallMenuEntry({
      hasOllama: true,
      ollamaRunning: true,
      hasWindowsOllama: false,
      windowsHostOllamaSupported: true,
      ollamaHost: "127.0.0.1",
      installedOllamaVersion: "0.32.9",
      runningOllamaVersion: "0.6.2",
      ...LINUX_NON_WSL,
    });
    expect(result.hasUpgradableOllama).toBe(true);
    expect(result.binaryNeedsUpgrade).toBe(false);
    // Stale source is the daemon; suffix names "running daemon" with that version.
    expect(result.entry?.label).toBe(
      `Upgrade Ollama (Linux) — upgrade running daemon 0.6.2 to ≥ ${MIN_OLLAMA_VERSION}`,
    );
  });

  it("requires a binary install when a stale daemon is reachable without a local binary", () => {
    const result = resolveOllamaInstallMenuEntry({
      hasOllama: false,
      ollamaRunning: true,
      hasWindowsOllama: false,
      windowsHostOllamaSupported: true,
      ollamaHost: "127.0.0.1",
      installedOllamaVersion: null,
      runningOllamaVersion: "0.6.2",
      ...LINUX_NON_WSL,
    });
    expect(result.hasUpgradableOllama).toBe(true);
    expect(result.binaryNeedsUpgrade).toBe(true);
    expect(result.entry?.label).toBe(
      `Upgrade Ollama (Linux) — upgrade running daemon 0.6.2 to ≥ ${MIN_OLLAMA_VERSION}`,
    );
  });

  it("offers an upgrade entry when the binary is stale even though the daemon is fresh", () => {
    const result = resolveOllamaInstallMenuEntry({
      hasOllama: true,
      ollamaRunning: true,
      hasWindowsOllama: false,
      windowsHostOllamaSupported: true,
      ollamaHost: "127.0.0.1",
      installedOllamaVersion: "0.6.2",
      runningOllamaVersion: "0.32.9",
      ...LINUX_NON_WSL,
    });
    expect(result.hasUpgradableOllama).toBe(true);
    expect(result.binaryNeedsUpgrade).toBe(true);
    // Stale source is the binary; suffix names "installed binary" with that version.
    expect(result.entry?.label).toBe(
      `Upgrade Ollama (Linux) — upgrade installed binary 0.6.2 to ≥ ${MIN_OLLAMA_VERSION}`,
    );
  });

  it("does not flag the daemon as upgradable when the running Ollama is the Windows host (WSL)", () => {
    const result = resolveOllamaInstallMenuEntry({
      hasOllama: false,
      ollamaRunning: true,
      hasWindowsOllama: true,
      windowsHostOllamaSupported: true,
      ollamaHost: "host.docker.internal",
      // Pretend the local-loopback probe would have returned a stale version
      // if it were applied. The Windows-host case must short-circuit and not
      // surface an `install-ollama` (WSL Linux) entry.
      runningOllamaVersion: "0.6.2",
      platform: "linux",
      isWsl: true,
    });
    expect(result.hasUpgradableOllama).toBe(false);
    expect(result.entry).toBeNull();
  });

  it("does not route mirrored Windows-host Ollama through the WSL installer (#9300)", () => {
    const result = resolveOllamaInstallMenuEntry({
      hasOllama: true,
      ollamaRunning: true,
      hasWindowsOllama: true,
      windowsHostOllamaSupported: true,
      isWindowsHostOllama: true,
      ollamaHost: "127.0.0.1",
      installedOllamaVersion: "0.32.5",
      runningOllamaVersion: "0.32.5",
      platform: "linux",
      isWsl: true,
    });

    expect(result).toEqual({
      entry: null,
      hasUpgradableOllama: false,
      binaryNeedsUpgrade: false,
    });
  });

  it("omits the entry when only Windows-host Ollama is present", () => {
    const result = resolveOllamaInstallMenuEntry({
      hasOllama: false,
      ollamaRunning: false,
      hasWindowsOllama: true,
      windowsHostOllamaSupported: true,
      installedOllamaVersion: null,
      ...LINUX_NON_WSL,
    });
    expect(result.entry).toBeNull();
  });

  it("offers a WSL-local install when the sandbox cannot reach the Windows-host Ollama (#8199)", () => {
    const result = resolveOllamaInstallMenuEntry({
      hasOllama: false,
      ollamaRunning: false,
      hasWindowsOllama: true,
      windowsHostOllamaSupported: false,
      installedOllamaVersion: null,
      platform: "linux",
      isWsl: true,
    });
    expect(result.entry?.key).toBe("install-ollama");
    expect(result.entry?.label).toBe("Install Ollama (WSL Linux)");
  });

  it("treats null versions as below the minimum to recover stale installs", () => {
    const result = resolveOllamaInstallMenuEntry({
      hasOllama: true,
      ollamaRunning: true,
      hasWindowsOllama: false,
      windowsHostOllamaSupported: true,
      installedOllamaVersion: null,
      ...LINUX_NON_WSL,
    });
    expect(result.hasUpgradableOllama).toBe(true);
    expect(result.entry?.label).toBe(
      `Upgrade Ollama (Linux) — upgrade installed binary unknown to ≥ ${MIN_OLLAMA_VERSION}`,
    );
  });

  it("labels WSL Linux distinctly when the host is WSL", () => {
    const result = resolveOllamaInstallMenuEntry({
      hasOllama: false,
      ollamaRunning: false,
      hasWindowsOllama: false,
      windowsHostOllamaSupported: true,
      installedOllamaVersion: null,
      platform: "linux",
      isWsl: true,
    });
    expect(result.entry?.label).toBe("Install Ollama (WSL Linux)");
  });

  it("labels macOS distinctly", () => {
    const result = resolveOllamaInstallMenuEntry({
      hasOllama: false,
      ollamaRunning: false,
      hasWindowsOllama: false,
      windowsHostOllamaSupported: true,
      installedOllamaVersion: null,
      platform: "darwin",
      isWsl: false,
    });
    expect(result.entry?.label).toBe("Install Ollama (macOS)");
  });

  it("labels macOS upgrade case so the Homebrew branch can pick brew upgrade", () => {
    const result = resolveOllamaInstallMenuEntry({
      hasOllama: true,
      ollamaRunning: true,
      hasWindowsOllama: false,
      windowsHostOllamaSupported: true,
      installedOllamaVersion: "0.6.2",
      runningOllamaVersion: "0.6.2",
      platform: "darwin",
      isWsl: false,
    });
    expect(result.hasUpgradableOllama).toBe(true);
    expect(result.entry?.label).toBe(
      `Upgrade Ollama (macOS) — upgrade installed binary 0.6.2 to ≥ ${MIN_OLLAMA_VERSION}`,
    );
  });

  it("treats a non-upgrade context as already applied", () => {
    const result = assertOllamaUpgradeApplied({ hasUpgradableOllama: false });
    expect(result.ok).toBe(true);
  });

  it("accepts the upgrade when the daemon and installed binary meet the minimum", () => {
    const capture = captureOllamaVersions("0.32.9", "0.32.9");
    const result = assertOllamaUpgradeApplied({ hasUpgradableOllama: true }, capture);
    expect(result.ok).toBe(true);
    expect(result.detectedDaemonVersion).toBe("0.32.9");
    expect(result.detectedBinaryVersion).toBe("0.32.9");
  });

  it("rejects the upgrade when the daemon still serves the stale version even though the binary is fresh", () => {
    const capture = captureOllamaVersions("0.6.2", "0.32.9");
    const result = assertOllamaUpgradeApplied({ hasUpgradableOllama: true }, capture);
    expect(result.ok).toBe(false);
    expect(result.detectedDaemonVersion).toBe("0.6.2");
    expect(result.detectedBinaryVersion).toBe("0.32.9");
    expect(result.message).toContain("0.6.2");
    expect(result.message).toContain(MIN_OLLAMA_VERSION);
    expect(result.message).toContain("systemctl restart ollama");
  });

  it("rejects a stale binary when the running daemon meets the minimum (#9276)", () => {
    const capture = captureOllamaVersions("0.32.9", "0.23.4");
    const result = assertOllamaUpgradeApplied({ hasUpgradableOllama: true }, capture);
    expect(result.ok).toBe(false);
    expect(result.detectedDaemonVersion).toBe("0.32.9");
    expect(result.detectedBinaryVersion).toBe("0.23.4");
    expect(result.message).toContain(`did not deliver ${MIN_OLLAMA_VERSION} on this host`);
    expect(result.message).toContain(`OLLAMA_VERSION=${MIN_OLLAMA_VERSION} sh`);
    expect(result.message).not.toContain("systemctl restart ollama");
  });

  it("reports a known daemon when the installed binary version is unavailable (#9276)", () => {
    const capture = captureOllamaVersions("0.23.4", null);
    const result = assertOllamaUpgradeApplied({ hasUpgradableOllama: true }, capture);
    expect(result.ok).toBe(false);
    expect(result.detectedDaemonVersion).toBe("0.23.4");
    expect(result.detectedBinaryVersion).toBeNull();
    expect(result.message).toContain("running daemon reports 0.23.4 (binary: unknown)");
    expect(result.message).toContain("installed binary version could not be read");
    expect(result.message).not.toContain("Neither the daemon nor the binary could be read");
  });

  it("rejects the upgrade when the daemon is unreachable", () => {
    const capture = () => "";
    const result = assertOllamaUpgradeApplied({ hasUpgradableOllama: true }, capture);
    expect(result.ok).toBe(false);
    expect(result.detectedDaemonVersion).toBeNull();
    expect(result.message).toContain("unreachable");
    expect(result.message).toContain("Neither the daemon nor the binary could be read");
  });

  it("does not return an entry on unsupported platforms", () => {
    const result = resolveOllamaInstallMenuEntry({
      hasOllama: false,
      ollamaRunning: false,
      hasWindowsOllama: false,
      windowsHostOllamaSupported: true,
      installedOllamaVersion: null,
      platform: "win32",
      isWsl: false,
    });
    expect(result.entry).toBeNull();
  });
});
