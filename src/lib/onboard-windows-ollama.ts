// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Windows-host Ollama actions invoked from WSL via PowerShell interop.
// Detection lives in onboard.ts; this module owns the action side.

const { spawn, spawnSync } = require("child_process");
const { run, runCapture } = require("./runner");
const { OLLAMA_HOST_DOCKER_INTERNAL, setResolvedOllamaHost } = require("./local-inference");
const { OLLAMA_PORT } = require("./ports");

function sleep(seconds: number): void {
  spawnSync("sleep", [String(seconds)]);
}

// Pre-set OLLAMA_HOST in both User scope (persists across logins) and the
// current PowerShell session (inherited by the installer's auto-spawned
// ollama_app + daemon) so the new daemon binds 0.0.0.0 from the start.
// Don't use stdio:inherit here. When powershell.exe is spawned through
// WSL interop, its stdout looks like a pipe (not a console), so PowerShell
// holds output in an internal buffer and the user sees long silent gaps.
// Reading the pipe from Node and re-writing to our own TTY shows progress
// as soon as PowerShell flushes a chunk.
async function installOllamaOnWindowsHost(): Promise<{ ok: boolean; path: string }> {
  console.log("  Installing Ollama on Windows host...");
  console.log("  This can take several minutes. Output may pause silently");
  await new Promise<void>((resolve) => {
    const child = spawn(
      "powershell.exe",
      [
        "-Command",
        "[Environment]::SetEnvironmentVariable('OLLAMA_HOST','0.0.0.0:11434','User'); $env:OLLAMA_HOST='0.0.0.0:11434'; irm https://ollama.com/install.ps1 | iex",
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

// User-scope so the next login-time tray launch keeps the 0.0.0.0 binding
// without NemoClaw being involved.
function persistOllamaHostEnvVar(): void {
  runCapture(
    [
      "powershell.exe",
      "-Command",
      "[Environment]::SetEnvironmentVariable('OLLAMA_HOST','0.0.0.0:11434','User')",
    ],
    { ignoreError: true },
  );
}

// Order matters: kill 'ollama app' (the tray watcher) before 'ollama'
// (the daemon). The watcher auto-respawns the daemon as soon as it dies.
// If the daemon goes first, the watcher can launch a fresh daemon with
// default env (127.0.0.1) before we get to kill it. That respawned daemon
// then holds port 11434 and blocks our 0.0.0.0 relaunch.
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
    [
      "powershell.exe",
      "-Command",
      "Get-Process ollama -EA SilentlyContinue | Stop-Process -Force",
    ],
    { ignoreError: true },
  );
}

function awaitWindowsOllamaReady(): boolean {
  console.log("  Waiting for Ollama to respond on host.docker.internal...");
  for (let attempt = 0; attempt < 15; attempt++) {
    sleep(2);
    const probe = runCapture(
      [
        "curl",
        "-sf",
        "--connect-timeout",
        "2",
        "--max-time",
        "5",
        `http://host.docker.internal:${OLLAMA_PORT}/api/tags`,
      ],
      { ignoreError: true },
    );
    if (probe) {
      setResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL);
      return true;
    }
  }
  return false;
}

// Relaunch via the watcher path when available so the tray icon and the
// watcher's auto-restart survive; otherwise launch the daemon directly.
function launchAndAwaitWindowsOllama(watcherPath?: string): boolean {
  console.log("  Starting Ollama on Windows host via WSL interop...");
  const launchScript = watcherPath
    ? `$env:OLLAMA_HOST='0.0.0.0:11434'; Start-Process -FilePath '${watcherPath.replace(/'/g, "''")}' -WindowStyle Hidden`
    : "$env:OLLAMA_HOST='0.0.0.0:11434'; Start-Process -FilePath ollama.exe -ArgumentList serve -WindowStyle Hidden";
  const result = run(["powershell.exe", "-Command", launchScript], {
    ignoreError: true,
    suppressOutput: true,
  });
  if (result.status !== 0) {
    const stderr = String(result.stderr || "").trim();
    console.error(
      `  PowerShell launch failed (exit ${result.status})${stderr ? `: ${stderr}` : ""}`,
    );
    return false;
  }
  return awaitWindowsOllamaReady();
}

// Used by start and restart paths to force a 0.0.0.0 binding on an already
// installed Ollama. Install path skips this: the installer's pre-set env
// already lands on the auto-spawned daemon.
function setupWindowsOllamaWith0000Binding(opts: { announceStop?: boolean } = {}): boolean {
  const watcherPath = captureWindowsOllamaWatcherPath();
  persistOllamaHostEnvVar();
  if (opts.announceStop) {
    console.log("  Stopping existing Ollama on Windows host...");
  }
  killWindowsOllamaProcesses();
  sleep(1);
  return launchAndAwaitWindowsOllama(watcherPath || undefined);
}

function switchToWindowsOllamaHost(): void {
  setResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL);
  console.log(`  ✓ Using Ollama on host.docker.internal:${OLLAMA_PORT}`);
}

module.exports = {
  installOllamaOnWindowsHost,
  awaitWindowsOllamaReady,
  setupWindowsOllamaWith0000Binding,
  switchToWindowsOllamaHost,
};
