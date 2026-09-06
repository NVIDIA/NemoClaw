// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Windows-host Ollama actions invoked from WSL via PowerShell interop.
// Detection lives in onboard.ts; this module owns the action side.

const { spawn } = require("child_process");
const { detectContainerRuntimeFromDockerInfo } = require("../../adapters/docker/runtime");
const { isWsl } = require("../../platform");
const { run, runCapture } = require("../../runner");
const {
  getWindowsHostOllamaDockerHostValidationArgs,
  getWindowsHostOllamaDockerReachabilityArgs,
  OLLAMA_HOST_DOCKER_INTERNAL,
  probeWindowsHostOllamaRouteProtection,
  setResolvedOllamaHost,
} = require("../local");
// Avoid starting a subprocess for each fixed readiness delay.
// The supported Windows-host Ollama path runs through WSL PowerShell interop.
// Native Windows activation remains gated by #8178.
const sleepBuffer = new SharedArrayBuffer(4);
const sleepArray = new Int32Array(sleepBuffer);
const OLLAMA_LOOPBACK_HOST = "127.0.0.1:11434";

function sleep(seconds: number): void {
  if (seconds <= 0) return;
  Atomics.wait(sleepArray, 0, 0, seconds * 1000);
}

function psSingleQuote(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// Pre-set OLLAMA_HOST in both User scope (persists across logins) and the
// current PowerShell session (inherited by the installer's auto-spawned
// ollama_app + daemon) so the new daemon stays on Windows loopback. Ollama
// enables its Host-header validation only for loopback listeners, which is
// required to reject same-host DNS-rebinding requests.
// Don't use stdio:inherit here. When powershell.exe is spawned through
// WSL interop, its stdout looks like a pipe (not a console), so PowerShell
// holds output in an internal buffer and the user sees long silent gaps.
// Reading the pipe from Node and re-writing to our own TTY shows progress
// as soon as PowerShell flushes a chunk.
async function installOllamaOnWindowsHost(): Promise<{ ok: boolean; path: string }> {
  console.log("  Installing Ollama on Windows host...");
  console.log("  This can take several minutes. Output may pause silently");
  if (!persistOllamaLoopbackHostEnvVar()) {
    console.error("  Failed to persist the Windows Ollama loopback binding.");
    return { ok: false, path: "" };
  }
  await new Promise<void>((resolve) => {
    const child = spawn(
      "powershell.exe",
      [
        "-Command",
        `$env:OLLAMA_HOST='${OLLAMA_LOOPBACK_HOST}'; irm https://ollama.com/install.ps1 | iex`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(chunk));
    child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    child.on("close", () => resolve());
    child.on("error", (err: NodeJS.ErrnoException) => {
      console.error(`  Failed to spawn powershell.exe: ${err.message}`);
      resolve();
    });
  });
  const installedPath = runCapture(
    [
      "powershell.exe",
      "-Command",
      "$env:PATH = [Environment]::GetEnvironmentVariable('PATH','Machine') + ';' + [Environment]::GetEnvironmentVariable('PATH','User'); Get-Command ollama.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source",
    ],
    { ignoreError: true },
  ).trim();
  if (!installedPath) {
    return { ok: false, path: "" };
  }
  console.log(`  ✓ Installed: ${installedPath}`);
  return { ok: true, path: installedPath };
}

// Capture the watcher path so we can relaunch from the same exe after kill,
// preserving the tray icon and the watcher's auto-restart behavior.
function captureWindowsOllamaWatcherPath(): string {
  return runCapture(
    [
      "powershell.exe",
      "-Command",
      "Get-Process 'ollama app' -EA SilentlyContinue | Select-Object -First 1 -ExpandProperty Path",
    ],
    { ignoreError: true },
  ).trim();
}

// User-scope so the next login-time tray launch remains loopback-only without
// NemoClaw being involved. This also replaces legacy wildcard configuration.
function persistOllamaLoopbackHostEnvVar(): boolean {
  const persistedHost = runCapture(
    [
      "powershell.exe",
      "-Command",
      `[Environment]::SetEnvironmentVariable('OLLAMA_HOST','${OLLAMA_LOOPBACK_HOST}','User'); ` +
        "[Environment]::GetEnvironmentVariable('OLLAMA_HOST','User')",
    ],
    { ignoreError: true },
  ).trim();
  return persistedHost === OLLAMA_LOOPBACK_HOST;
}

// Order matters: kill 'ollama app' (the tray watcher) before 'ollama'
// (the daemon). The watcher auto-respawns the daemon as soon as it dies.
// If the daemon goes first, the watcher can launch a fresh daemon with
// default env (127.0.0.1) before we get to kill it. That respawned daemon
// then holds port 11434 and blocks our explicit loopback relaunch.
function killWindowsOllamaProcesses(): void {
  runCapture(
    [
      "powershell.exe",
      "-Command",
      "Get-Process 'ollama app' -EA SilentlyContinue | Stop-Process -Force",
    ],
    { ignoreError: true },
  );
  runCapture(
    ["powershell.exe", "-Command", "Get-Process ollama -EA SilentlyContinue | Stop-Process -Force"],
    { ignoreError: true },
  );
}

function awaitWindowsOllamaReady(
  opts: { prepareDockerEnvironment?: () => unknown; delay?: (seconds: number) => void } = {},
): boolean {
  console.log("  Waiting for Ollama to respond on host.docker.internal...");
  const delay = opts.delay ?? sleep;
  for (let attempt = 0; attempt < 15; attempt++) {
    delay(2);
    const protection = probeWindowsHostOllamaRouteProtection(runCapture, {
      runtime: detectContainerRuntimeFromDockerInfo(),
      wslDetection: { isWsl: isWsl() },
      prepareDockerEnvironment: opts.prepareDockerEnvironment,
    });
    if (protection.protected) {
      setResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL);
      return true;
    }
  }
  return false;
}

// Relaunch via the watcher path when available so the tray icon and the
// watcher's auto-restart survive; fall back through the verified installed
// path and finally refreshed PATH because stale watcher paths are possible.
function launchAndAwaitWindowsOllama(
  opts: { watcherPath?: string; installedPath?: string; delay?: (seconds: number) => void } = {},
): boolean {
  console.log("  Starting Ollama on Windows host via WSL interop...");
  const delay = opts.delay ?? sleep;
  const watcherPath = typeof opts.watcherPath === "string" ? opts.watcherPath.trim() : "";
  const installedPath = typeof opts.installedPath === "string" ? opts.installedPath.trim() : "";
  const launchAttempts: Array<{ label: string; script: string }> = [];
  if (watcherPath) {
    launchAttempts.push({
      label: "Ollama tray app",
      script:
        `$env:OLLAMA_HOST='127.0.0.1:11434'; Start-Process -FilePath ${psSingleQuote(watcherPath)} ` +
        "-WindowStyle Hidden",
    });
  }
  if (installedPath) {
    launchAttempts.push({
      label: "verified ollama.exe",
      script:
        `$env:OLLAMA_HOST='127.0.0.1:11434'; Start-Process -FilePath ${psSingleQuote(installedPath)} ` +
        "-ArgumentList 'serve' -WindowStyle Hidden",
    });
  }
  launchAttempts.push({
    label: "refreshed Windows PATH",
    script:
      "$env:PATH = [Environment]::GetEnvironmentVariable('PATH','Machine') + ';' + [Environment]::GetEnvironmentVariable('PATH','User'); " +
      "$env:OLLAMA_HOST='127.0.0.1:11434'; Start-Process -FilePath ollama.exe -ArgumentList serve -WindowStyle Hidden",
  });

  for (let i = 0; i < launchAttempts.length; i++) {
    const attempt = launchAttempts[i];
    const result = run(["powershell.exe", "-Command", attempt.script], {
      ignoreError: true,
      suppressOutput: true,
    });
    if (result.status === 0 && awaitWindowsOllamaReady({ delay })) {
      return true;
    }

    const stderr = String(result.stderr || "").trim();
    const error = result.error?.message;
    const detail =
      result.status === 0
        ? "Ollama did not become reachable"
        : error || `exit ${result.status}${stderr ? `: ${stderr}` : ""}`;
    console.error(`  PowerShell launch via ${attempt.label} failed: ${detail}`);
    if (i < launchAttempts.length - 1) {
      killWindowsOllamaProcesses();
      delay(1);
    }
  }
  return false;
}

// Used by start and restart paths to force a loopback-only binding on an
// already installed Ollama. Fresh install fallback passes installedPath to
// avoid relying on a newly-mutated Windows PATH from this process.
function setupWindowsOllamaLoopbackBinding(
  opts: {
    announceStop?: boolean;
    installedPath?: string;
    delay?: (seconds: number) => void;
  } = {},
): boolean {
  const delay = opts.delay ?? sleep;
  const watcherPath = captureWindowsOllamaWatcherPath();
  if (!persistOllamaLoopbackHostEnvVar()) {
    console.error("  Failed to persist the Windows Ollama loopback binding.");
    return false;
  }
  if (opts.announceStop) {
    console.log("  Stopping existing Ollama on Windows host...");
  }
  killWindowsOllamaProcesses();
  delay(1);
  const launched = launchAndAwaitWindowsOllama({
    watcherPath: watcherPath || undefined,
    installedPath: opts.installedPath,
    delay,
  });
  if (!launched) {
    console.error(
      `  The Windows user OLLAMA_HOST=${OLLAMA_LOOPBACK_HOST} setting was persisted, and Ollama may now be stopped.`,
    );
    console.error(
      "  Resolve the launch or probe failure below, then rerun `nemoclaw onboard` to retry the bounded restart.",
    );
  }
  return launched;
}

function printWindowsOllamaTimeoutDiagnostics(): void {
  console.error(
    "  Timed out waiting for loopback-only Ollama with Host validation on the Windows host.",
  );
  console.error("  Diagnose Windows-side Ollama state with:");
  console.error('    powershell.exe -Command "Get-Process ollama* -ErrorAction SilentlyContinue"');
  console.error(
    '    powershell.exe -Command "Get-NetTCPConnection -LocalPort 11434 -State Listen -ErrorAction SilentlyContinue"',
  );
  console.error(`    docker ${getWindowsHostOllamaDockerReachabilityArgs().join(" ")}`);
  console.error(`    docker ${getWindowsHostOllamaDockerHostValidationArgs().join(" ")}`);
  console.error("      Expected output: 403 (other values mean Host validation is disabled).");
}

module.exports = {
  installOllamaOnWindowsHost,
  awaitWindowsOllamaReady,
  setupWindowsOllamaLoopbackBinding,
  sleep,
  printWindowsOllamaTimeoutDiagnostics,
};
