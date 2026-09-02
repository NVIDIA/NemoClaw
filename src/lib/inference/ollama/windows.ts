// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Windows-host Ollama actions invoked from WSL via PowerShell interop.
// Detection lives in onboard.ts; this module owns the action side.

const { spawn } = require("child_process");
const { run, runCapture } = require("../../runner");
const {
  createOllamaApiCapture,
  getWindowsHostOllamaDockerReachabilityArgs,
  isValidOllamaTagsResponseBody,
  OLLAMA_HOST_DOCKER_INTERNAL,
  setResolvedOllamaHost,
  sleepSeconds,
} = require("../local");
const { OLLAMA_PORT } = require("../../core/ports");

function psSingleQuote(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
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

type WindowsOllamaHostSnapshot = {
  userHost: string | null;
  watcherPath: string | null;
  daemonPath: string | null;
};

function optionalSnapshotPath(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  return value.trim() || null;
}

// Capture every state item that setup mutates before changing the User-scope
// binding or stopping processes. A failed snapshot leaves the host untouched.
function captureWindowsOllamaHostSnapshot(): WindowsOllamaHostSnapshot | null {
  const result = run(
    [
      "powershell.exe",
      "-Command",
      "$userHost = [Environment]::GetEnvironmentVariable('OLLAMA_HOST','User'); " +
        "$watcherPath = Get-Process 'ollama app' -EA SilentlyContinue | Select-Object -First 1 -ExpandProperty Path; " +
        "$daemonPath = Get-Process ollama -EA SilentlyContinue | Select-Object -First 1 -ExpandProperty Path; " +
        "[PSCustomObject]@{userHost=$userHost;watcherPath=$watcherPath;daemonPath=$daemonPath} | ConvertTo-Json -Compress",
    ],
    { ignoreError: true, suppressOutput: true },
  );
  if (result.error || result.status !== 0) return null;
  try {
    const parsed = JSON.parse(String(result.stdout || "")) as Record<string, unknown> | null;
    if (!parsed || (parsed.userHost !== null && typeof parsed.userHost !== "string")) return null;
    const watcherPath = optionalSnapshotPath(parsed.watcherPath);
    const daemonPath = optionalSnapshotPath(parsed.daemonPath);
    if (watcherPath === undefined || daemonPath === undefined) return null;
    return { userHost: parsed.userHost, watcherPath, daemonPath };
  } catch {
    return null;
  }
}

function psUtf8Expression(value: string): string {
  const encoded = Buffer.from(value, "utf8").toString("base64");
  return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`;
}

function psNullableUtf8Expression(value: string | null): string {
  return value === null ? "$null" : psUtf8Expression(value);
}

function runWindowsOllamaStateScript(script: string): boolean {
  const result = run(["powershell.exe", "-Command", `$ErrorActionPreference='Stop'; ${script}`], {
    ignoreError: true,
    suppressOutput: true,
  });
  return !result.error && result.status === 0;
}

// User-scope so the next login-time tray launch keeps the 0.0.0.0 binding
// without NemoClaw being involved.
function persistOllamaHostEnvVar(): boolean {
  return runWindowsOllamaStateScript(
    "[Environment]::SetEnvironmentVariable('OLLAMA_HOST','0.0.0.0:11434','User')",
  );
}

function buildWindowsOllamaRestoreScript(snapshot: WindowsOllamaHostSnapshot): string {
  const script = [
    "Get-Process 'ollama app' -EA SilentlyContinue | Stop-Process -Force",
    "Get-Process ollama -EA SilentlyContinue | Stop-Process -Force",
    `$previousHost = ${psNullableUtf8Expression(snapshot.userHost)}`,
    "[Environment]::SetEnvironmentVariable('OLLAMA_HOST',$previousHost,'User')",
    "$env:OLLAMA_HOST = $previousHost",
  ];
  if (snapshot.watcherPath) {
    script.push(
      `$previousWatcher = ${psUtf8Expression(snapshot.watcherPath)}`,
      "Start-Process -FilePath $previousWatcher -WindowStyle Hidden -ErrorAction Stop",
    );
  } else if (snapshot.daemonPath) {
    script.push(
      `$previousDaemon = ${psUtf8Expression(snapshot.daemonPath)}`,
      "Start-Process -FilePath $previousDaemon -ArgumentList 'serve' -WindowStyle Hidden -ErrorAction Stop",
    );
  }
  return script.join("; ");
}

function rollbackWindowsOllamaHostSnapshot(snapshot: WindowsOllamaHostSnapshot): boolean {
  const script = buildWindowsOllamaRestoreScript(snapshot);
  return runWindowsOllamaStateScript(script);
}

function reportWindowsOllamaRollbackFailure(): void {
  console.error("  Failed to restore the previous Windows Ollama state.");
  console.error(
    "  In Windows PowerShell, stop Ollama, restore your previous User-scope OLLAMA_HOST " +
      "value, and relaunch the previous Ollama app or daemon.",
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
    ["powershell.exe", "-Command", "Get-Process ollama -EA SilentlyContinue | Stop-Process -Force"],
    { ignoreError: true },
  );
}

function awaitWindowsOllamaReady(opts: { prepareDockerEnvironment?: () => unknown } = {}): boolean {
  console.log("  Waiting for Ollama to respond on host.docker.internal...");
  const capture = createOllamaApiCapture(
    runCapture,
    OLLAMA_HOST_DOCKER_INTERNAL,
    opts.prepareDockerEnvironment,
  );
  for (let attempt = 0; attempt < 15; attempt++) {
    sleepSeconds(2);
    const probe = capture(
      [
        "curl",
        "-sf",
        "--connect-timeout",
        "2",
        "--max-time",
        "5",
        `http://${OLLAMA_HOST_DOCKER_INTERNAL}:${OLLAMA_PORT}/api/tags`,
      ],
      { ignoreError: true },
    );
    if (isValidOllamaTagsResponseBody(probe)) {
      setResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL);
      return true;
    }
  }
  return false;
}

type WindowsOllamaLaunchAttempt = {
  kind: "watcher" | "installed" | "path";
  label: string;
  script: string;
};

type WindowsOllamaLaunchOperations = {
  runAttempt: (attempt: WindowsOllamaLaunchAttempt) => {
    status: number | null;
    stderr?: string;
    error?: Error;
  };
  awaitReady: () => boolean;
  stopProcesses: () => void;
  wait: (seconds: number) => void;
};

const WINDOWS_OLLAMA_LAUNCH_OPERATIONS: WindowsOllamaLaunchOperations = {
  runAttempt: (attempt) =>
    run(["powershell.exe", "-Command", attempt.script], {
      ignoreError: true,
      suppressOutput: true,
    }),
  awaitReady: awaitWindowsOllamaReady,
  stopProcesses: killWindowsOllamaProcesses,
  wait: sleepSeconds,
};

// Relaunch via the watcher path when available so the tray icon and the
// watcher's auto-restart survive; fall back through the verified installed
// path and finally refreshed PATH because stale watcher paths are possible.
function launchAndAwaitWindowsOllama(
  opts: { watcherPath?: string; installedPath?: string } = {},
  operations: WindowsOllamaLaunchOperations = WINDOWS_OLLAMA_LAUNCH_OPERATIONS,
): boolean {
  console.log("  Starting Ollama on Windows host via WSL interop...");
  const watcherPath = typeof opts.watcherPath === "string" ? opts.watcherPath.trim() : "";
  const installedPath = typeof opts.installedPath === "string" ? opts.installedPath.trim() : "";
  const launchAttempts: WindowsOllamaLaunchAttempt[] = [];
  if (watcherPath) {
    launchAttempts.push({
      kind: "watcher",
      label: "Ollama tray app",
      script:
        `$env:OLLAMA_HOST='0.0.0.0:11434'; Start-Process -FilePath ${psSingleQuote(watcherPath)} ` +
        "-WindowStyle Hidden",
    });
  }
  if (installedPath) {
    launchAttempts.push({
      kind: "installed",
      label: "verified ollama.exe",
      script:
        `$env:OLLAMA_HOST='0.0.0.0:11434'; Start-Process -FilePath ${psSingleQuote(installedPath)} ` +
        "-ArgumentList 'serve' -WindowStyle Hidden",
    });
  }
  launchAttempts.push({
    kind: "path",
    label: "refreshed Windows PATH",
    script:
      "$env:PATH = [Environment]::GetEnvironmentVariable('PATH','Machine') + ';' + [Environment]::GetEnvironmentVariable('PATH','User'); " +
      "$env:OLLAMA_HOST='0.0.0.0:11434'; Start-Process -FilePath ollama.exe -ArgumentList serve -WindowStyle Hidden",
  });

  for (let i = 0; i < launchAttempts.length; i++) {
    const attempt = launchAttempts[i];
    const result = operations.runAttempt(attempt);
    if (result.status === 0 && operations.awaitReady()) {
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
      operations.stopProcesses();
      operations.wait(1);
    }
  }
  return false;
}

type WindowsOllamaInterruptSignal = "SIGINT" | "SIGTERM";

type WindowsOllamaSetupOperations = {
  captureSnapshot: () => WindowsOllamaHostSnapshot | null;
  persistBinding: () => boolean;
  stopProcesses: () => void;
  wait: (seconds: number) => void;
  launchOperations: WindowsOllamaLaunchOperations;
  rollbackSnapshot: (snapshot: WindowsOllamaHostSnapshot) => boolean;
  registerInterruptHandler: (handler: (signal: WindowsOllamaInterruptSignal) => void) => () => void;
  preserveInterrupt: (signal: WindowsOllamaInterruptSignal) => void;
};

function registerWindowsOllamaInterruptHandler(
  handler: (signal: WindowsOllamaInterruptSignal) => void,
): () => void {
  const onSigint = () => handler("SIGINT");
  const onSigterm = () => handler("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  return () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  };
}

const WINDOWS_OLLAMA_SETUP_OPERATIONS: WindowsOllamaSetupOperations = {
  captureSnapshot: captureWindowsOllamaHostSnapshot,
  persistBinding: persistOllamaHostEnvVar,
  stopProcesses: killWindowsOllamaProcesses,
  wait: sleepSeconds,
  launchOperations: WINDOWS_OLLAMA_LAUNCH_OPERATIONS,
  rollbackSnapshot: rollbackWindowsOllamaHostSnapshot,
  registerInterruptHandler: registerWindowsOllamaInterruptHandler,
  preserveInterrupt: (signal) => {
    process.kill(process.pid, signal);
  },
};

function rollbackWindowsOllamaSetup(
  snapshot: WindowsOllamaHostSnapshot,
  operations: WindowsOllamaSetupOperations,
): void {
  if (!operations.rollbackSnapshot(snapshot)) reportWindowsOllamaRollbackFailure();
}

// Used by start and restart paths to force a 0.0.0.0 binding on an already
// installed Ollama. Fresh install fallback passes installedPath to avoid
// relying on a newly-mutated Windows PATH from this process.
function setupWindowsOllamaWith0000Binding(
  opts: { announceStop?: boolean; installedPath?: string } = {},
  operations: WindowsOllamaSetupOperations = WINDOWS_OLLAMA_SETUP_OPERATIONS,
): boolean {
  const snapshot = operations.captureSnapshot();
  if (!snapshot) {
    console.error("  Could not capture the existing Windows Ollama state; leaving it unchanged.");
    return false;
  }
  let rollbackRequired = false;
  let removeInterruptHandler = () => {};
  const handleInterrupt = (signal: WindowsOllamaInterruptSignal) => {
    const shouldRollback = rollbackRequired;
    rollbackRequired = false;
    try {
      if (shouldRollback) rollbackWindowsOllamaSetup(snapshot, operations);
    } finally {
      removeInterruptHandler();
      operations.preserveInterrupt(signal);
    }
  };
  removeInterruptHandler = operations.registerInterruptHandler(handleInterrupt);
  try {
    if (!operations.persistBinding()) {
      console.error(
        "  Could not persist the Windows Ollama host binding; leaving processes running.",
      );
      return false;
    }
    rollbackRequired = true;
    if (opts.announceStop) {
      console.log("  Stopping existing Ollama on Windows host...");
    }
    operations.stopProcesses();
    operations.wait(1);
    const launched = launchAndAwaitWindowsOllama(
      {
        watcherPath: snapshot.watcherPath || undefined,
        installedPath: opts.installedPath,
      },
      operations.launchOperations,
    );
    if (launched) {
      rollbackRequired = false;
      return true;
    }
    rollbackRequired = false;
    rollbackWindowsOllamaSetup(snapshot, operations);
    return false;
  } catch (error) {
    const shouldRollback = rollbackRequired;
    rollbackRequired = false;
    if (shouldRollback) rollbackWindowsOllamaSetup(snapshot, operations);
    throw error;
  } finally {
    removeInterruptHandler();
  }
}

function switchToWindowsOllamaHost(): void {
  setResolvedOllamaHost(OLLAMA_HOST_DOCKER_INTERNAL);
  console.log(`  ✓ Using Ollama on host.docker.internal:${OLLAMA_PORT}`);
}

function printWindowsOllamaTimeoutDiagnostics(): void {
  console.error("  Timed out waiting for Ollama to start on the Windows host.");
  console.error("  Diagnose Windows-side Ollama state with:");
  console.error('    powershell.exe -Command "Get-Process ollama* -ErrorAction SilentlyContinue"');
  console.error(
    '    powershell.exe -Command "Get-NetTCPConnection -LocalPort 11434 -State Listen -ErrorAction SilentlyContinue"',
  );
  console.error(`    docker ${getWindowsHostOllamaDockerReachabilityArgs().join(" ")}`);
}

module.exports = {
  installOllamaOnWindowsHost,
  awaitWindowsOllamaReady,
  setupWindowsOllamaWith0000Binding,
  sleep: sleepSeconds,
  switchToWindowsOllamaHost,
  printWindowsOllamaTimeoutDiagnostics,
};
