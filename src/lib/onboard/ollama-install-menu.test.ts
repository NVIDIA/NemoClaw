// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  assertOllamaUpgradeApplied,
  resolveOllamaInstallMenuEntry,
  resolveRunningOllamaMenuEntry,
} from "../../../dist/lib/onboard/ollama-install-menu";
import { MIN_OLLAMA_VERSION } from "../../../dist/lib/inference/ollama-version";

const LINUX_NON_WSL = { platform: "linux" as const, isWsl: false };

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
});

describe("resolveOllamaInstallMenuEntry", () => {
  it("offers a fresh install when no Ollama is present", () => {
    const result = resolveOllamaInstallMenuEntry({
      hasOllama: false,
      ollamaRunning: false,
      hasWindowsOllama: false,
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
      installedOllamaVersion: "0.6.2",
      runningOllamaVersion: "0.6.2",
      ...LINUX_NON_WSL,
    });
    expect(result.hasUpgradableOllama).toBe(true);
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
      installedOllamaVersion: "0.24.0",
      runningOllamaVersion: "0.24.0",
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
      ollamaHost: "127.0.0.1",
      installedOllamaVersion: "0.24.0",
      runningOllamaVersion: "0.6.2",
      ...LINUX_NON_WSL,
    });
    expect(result.hasUpgradableOllama).toBe(true);
    // Stale source is the daemon; suffix names "running daemon" with that version.
    expect(result.entry?.label).toBe(
      `Upgrade Ollama (Linux) — upgrade running daemon 0.6.2 to ≥ ${MIN_OLLAMA_VERSION}`,
    );
  });

  it("offers an upgrade entry when the binary is stale even though the daemon is fresh", () => {
    const result = resolveOllamaInstallMenuEntry({
      hasOllama: true,
      ollamaRunning: true,
      hasWindowsOllama: false,
      ollamaHost: "127.0.0.1",
      installedOllamaVersion: "0.6.2",
      runningOllamaVersion: "0.24.0",
      ...LINUX_NON_WSL,
    });
    expect(result.hasUpgradableOllama).toBe(true);
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

  it("omits the entry when only Windows-host Ollama is present", () => {
    const result = resolveOllamaInstallMenuEntry({
      hasOllama: false,
      ollamaRunning: false,
      hasWindowsOllama: true,
      installedOllamaVersion: null,
      ...LINUX_NON_WSL,
    });
    expect(result.entry).toBeNull();
  });

  it("treats null versions as below the minimum to recover stale installs", () => {
    const result = resolveOllamaInstallMenuEntry({
      hasOllama: true,
      ollamaRunning: true,
      hasWindowsOllama: false,
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

  it("accepts the upgrade when the running daemon reports a fresh version", () => {
    const capture = (cmd: readonly string[]) => {
      const joined = cmd.join(" ");
      if (joined.includes("/api/version")) return '{"version":"0.24.0"}';
      if (joined.includes("ollama --version")) return "ollama version is 0.24.0";
      return "";
    };
    const result = assertOllamaUpgradeApplied({ hasUpgradableOllama: true }, capture);
    expect(result.ok).toBe(true);
    expect(result.detectedDaemonVersion).toBe("0.24.0");
    expect(result.detectedBinaryVersion).toBe("0.24.0");
  });

  it("rejects the upgrade when the daemon still serves the stale version even though the binary is fresh", () => {
    const capture = (cmd: readonly string[]) => {
      const joined = cmd.join(" ");
      if (joined.includes("/api/version")) return '{"version":"0.6.2"}';
      if (joined.includes("ollama --version")) return "ollama version is 0.24.0";
      return "";
    };
    const result = assertOllamaUpgradeApplied({ hasUpgradableOllama: true }, capture);
    expect(result.ok).toBe(false);
    expect(result.detectedDaemonVersion).toBe("0.6.2");
    expect(result.detectedBinaryVersion).toBe("0.24.0");
    expect(result.message).toContain("0.6.2");
    expect(result.message).toContain(MIN_OLLAMA_VERSION);
  });

  it("rejects the upgrade when the daemon is unreachable", () => {
    const capture = () => "";
    const result = assertOllamaUpgradeApplied({ hasUpgradableOllama: true }, capture);
    expect(result.ok).toBe(false);
    expect(result.detectedDaemonVersion).toBeNull();
    expect(result.message).toContain("unreachable");
  });

  it("does not return an entry on unsupported platforms", () => {
    const result = resolveOllamaInstallMenuEntry({
      hasOllama: false,
      ollamaRunning: false,
      hasWindowsOllama: false,
      installedOllamaVersion: null,
      platform: "win32",
      isWsl: false,
    });
    expect(result.entry).toBeNull();
  });
});
