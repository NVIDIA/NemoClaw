// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Windows-host Ollama actions invoked from WSL via PowerShell interop.
// Detection lives in onboard.ts; this module owns the action side.

const { spawn } = require("child_process");
const { run, runCapture } = require("../../runner");
const {
  createOllamaApiCapture,
  isValidOllamaTagsResponseBody,
  OLLAMA_HOST_DOCKER_INTERNAL,
  setResolvedOllamaHost,
  sleepSeconds,
} = require("../local");
const { OLLAMA_PORT } = require("../../core/ports");

function psSingleQuote(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

type WindowsOllamaInstallerProcess = {
  completion: Promise<void>;
  cancel: () => void;
};

// Pre-set OLLAMA_HOST in both User scope (persists across logins) and the
// current PowerShell session (inherited by the installer's auto-spawned
// ollama_app + daemon) so the new daemon binds 0.0.0.0 from the start.
// Don't use stdio:inherit here. When powershell.exe is spawned through
// WSL interop, its stdout looks like a pipe (not a console), so PowerShell
// holds output in an internal buffer and the user sees long silent gaps.
// Reading the pipe from Node and re-writing to our own TTY shows progress
// as soon as PowerShell flushes a chunk.
function startWindowsOllamaInstaller(): WindowsOllamaInstallerProcess {
  const child = spawn(
    "powershell.exe",
    [
      "-Command",
      "[Environment]::SetEnvironmentVariable('OLLAMA_HOST','0.0.0.0:11434','User'); $env:OLLAMA_HOST='0.0.0.0:11434'; irm https://ollama.com/install.ps1 | iex",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const completion = new Promise<void>((resolve) => {
    child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(chunk));
    child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    child.on("close", () => resolve());
    child.on("error", (err: NodeJS.ErrnoException) => {
      console.error(`  Failed to spawn powershell.exe: ${err.message}`);
      resolve();
    });
  });
  return {
    completion,
    cancel: () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // Rollback below still stops any installer-created Ollama processes.
      }
    },
  };
}

function resolveWindowsOllamaInstalledPath(): string {
  return runCapture(
    [
      "powershell.exe",
      "-Command",
      "$env:PATH = [Environment]::GetEnvironmentVariable('PATH','Machine') + ';' + [Environment]::GetEnvironmentVariable('PATH','User'); Get-Command ollama.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source",
    ],
    { ignoreError: true },
  ).trim();
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

const WINDOWS_OLLAMA_RESTORE_HOST_ENV = "NEMOCLAW_OLLAMA_RESTORE_HOST";
const WINDOWS_OLLAMA_RESTORE_HOST_PRESENT_ENV = "NEMOCLAW_OLLAMA_RESTORE_HOST_PRESENT";
const WINDOWS_OLLAMA_RESTORE_WATCHER_ENV = "NEMOCLAW_OLLAMA_RESTORE_WATCHER";
const WINDOWS_OLLAMA_RESTORE_DAEMON_ENV = "NEMOCLAW_OLLAMA_RESTORE_DAEMON";

function runWindowsOllamaStateScript(script: string, env?: NodeJS.ProcessEnv): boolean {
  const result = run(["powershell.exe", "-Command", `$ErrorActionPreference='Stop'; ${script}`], {
    env,
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

function buildWindowsOllamaRestoreScript(): string {
  return [
    `$previousHostPresent = $env:${WINDOWS_OLLAMA_RESTORE_HOST_PRESENT_ENV}`,
    `$previousHost = $env:${WINDOWS_OLLAMA_RESTORE_HOST_ENV}`,
    `$previousWatcher = $env:${WINDOWS_OLLAMA_RESTORE_WATCHER_ENV}`,
    `$previousDaemon = $env:${WINDOWS_OLLAMA_RESTORE_DAEMON_ENV}`,
    `Remove-Item Env:${WINDOWS_OLLAMA_RESTORE_HOST_PRESENT_ENV} -EA SilentlyContinue`,
    `Remove-Item Env:${WINDOWS_OLLAMA_RESTORE_HOST_ENV} -EA SilentlyContinue`,
    `Remove-Item Env:${WINDOWS_OLLAMA_RESTORE_WATCHER_ENV} -EA SilentlyContinue`,
    `Remove-Item Env:${WINDOWS_OLLAMA_RESTORE_DAEMON_ENV} -EA SilentlyContinue`,
    "if ($previousHostPresent -ne '1') { $previousHost = $null }",
    "Get-Process 'ollama app' -EA SilentlyContinue | Stop-Process -Force",
    "Get-Process ollama -EA SilentlyContinue | Stop-Process -Force",
    "[Environment]::SetEnvironmentVariable('OLLAMA_HOST',$previousHost,'User')",
    "$env:OLLAMA_HOST = $previousHost",
    "if ($previousWatcher) { Start-Process -FilePath $previousWatcher -WindowStyle Hidden -ErrorAction Stop } " +
      "elseif ($previousDaemon) { Start-Process -FilePath $previousDaemon -ArgumentList 'serve' -WindowStyle Hidden -ErrorAction Stop }",
  ].join("; ");
}

function rollbackWindowsOllamaHostSnapshot(snapshot: WindowsOllamaHostSnapshot): boolean {
  return runWindowsOllamaStateScript(buildWindowsOllamaRestoreScript(), {
    [WINDOWS_OLLAMA_RESTORE_HOST_PRESENT_ENV]: snapshot.userHost === null ? "0" : "1",
    [WINDOWS_OLLAMA_RESTORE_HOST_ENV]: snapshot.userHost ?? "",
    [WINDOWS_OLLAMA_RESTORE_WATCHER_ENV]: snapshot.watcherPath ?? "",
    [WINDOWS_OLLAMA_RESTORE_DAEMON_ENV]: snapshot.daemonPath ?? "",
  });
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

type WindowsOllamaInstallOperations = WindowsOllamaSetupOperations & {
  startInstaller: () => WindowsOllamaInstallerProcess;
  resolveInstalledPath: () => string;
  awaitReady: () => boolean;
};

export type WindowsOllamaMutationSession = {
  commit: () => void;
  rollback: () => void;
};

export type WindowsOllamaFailureReason = "binding" | "install" | "readiness" | "snapshot";

export type WindowsOllamaInstallResult =
  | { ok: false; path: string; reason: WindowsOllamaFailureReason }
  | ({ ok: true; path: string } & WindowsOllamaMutationSession);

export type WindowsOllamaSetupResult =
  | { ok: false; reason: Exclude<WindowsOllamaFailureReason, "install"> }
  | ({ ok: true } & WindowsOllamaMutationSession);

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

const WINDOWS_OLLAMA_INSTALL_OPERATIONS: WindowsOllamaInstallOperations = {
  ...WINDOWS_OLLAMA_SETUP_OPERATIONS,
  startInstaller: startWindowsOllamaInstaller,
  resolveInstalledPath: resolveWindowsOllamaInstalledPath,
  awaitReady: awaitWindowsOllamaReady,
};

function rollbackWindowsOllamaSetup(
  snapshot: WindowsOllamaHostSnapshot,
  operations: WindowsOllamaSetupOperations,
): void {
  if (!operations.rollbackSnapshot(snapshot)) reportWindowsOllamaRollbackFailure();
}

function beginWindowsOllamaMutation(
  snapshot: WindowsOllamaHostSnapshot,
  operations: WindowsOllamaSetupOperations,
) {
  let active = true;
  let mutated = false;
  let cancelActiveOperation = () => {};
  let removeInterruptHandler = () => {};
  const commit = () => {
    if (!active) return;
    active = false;
    cancelActiveOperation = () => {};
    removeInterruptHandler();
  };
  const rollback = () => {
    if (!active) return;
    active = false;
    removeInterruptHandler();
    const cancel = cancelActiveOperation;
    cancelActiveOperation = () => {};
    try {
      cancel();
    } finally {
      if (mutated) rollbackWindowsOllamaSetup(snapshot, operations);
    }
  };
  removeInterruptHandler = operations.registerInterruptHandler((signal) => {
    try {
      rollback();
    } finally {
      operations.preserveInterrupt(signal);
    }
  });
  return {
    commit,
    markMutated: () => {
      mutated = true;
    },
    rollback,
    setInterruptCancellation: (cancel: () => void) => {
      if (active) cancelActiveOperation = cancel;
    },
  };
}

function applyWindowsOllamaBinding(
  opts: { announceStop?: boolean; installedPath?: string } = {},
  snapshot: WindowsOllamaHostSnapshot,
  operations: WindowsOllamaSetupOperations,
  markMutated: () => void,
): { ok: true } | { ok: false; reason: "binding" | "readiness" } {
  if (!operations.persistBinding()) {
    console.error("  Could not persist the Windows Ollama host binding.");
    return { ok: false, reason: "binding" };
  }
  markMutated();
  if (opts.announceStop) {
    console.log("  Stopping existing Ollama on Windows host...");
  }
  operations.stopProcesses();
  operations.wait(1);
  return launchAndAwaitWindowsOllama(
    {
      watcherPath: snapshot.watcherPath || undefined,
      installedPath: opts.installedPath,
    },
    operations.launchOperations,
  )
    ? { ok: true }
    : { ok: false, reason: "readiness" };
}

async function installOllamaOnWindowsHost(
  opts: { beforeRestart?: () => void } = {},
  operations: WindowsOllamaInstallOperations = WINDOWS_OLLAMA_INSTALL_OPERATIONS,
): Promise<WindowsOllamaInstallResult> {
  const snapshot = operations.captureSnapshot();
  if (!snapshot) {
    console.error("  Could not capture the existing Windows Ollama state; leaving it unchanged.");
    return { ok: false, path: "", reason: "snapshot" };
  }
  const mutation = beginWindowsOllamaMutation(snapshot, operations);
  mutation.markMutated();
  console.log("  Installing Ollama on Windows host...");
  console.log("  This can take several minutes. Output may pause silently");
  try {
    const installer = operations.startInstaller();
    mutation.setInterruptCancellation(installer.cancel);
    await installer.completion;
    mutation.setInterruptCancellation(() => {});
    const installedPath = operations.resolveInstalledPath();
    if (!installedPath) {
      mutation.rollback();
      return { ok: false, path: "", reason: "install" };
    }
    console.log(`  ✓ Installed: ${installedPath}`);
    if (!operations.awaitReady()) {
      console.log("  Installer did not leave a reachable Ollama daemon; restarting it...");
      opts.beforeRestart?.();
      const setupResult = applyWindowsOllamaBinding(
        { installedPath },
        snapshot,
        operations,
        mutation.markMutated,
      );
      if (!setupResult.ok) {
        mutation.rollback();
        return { ok: false, path: installedPath, reason: setupResult.reason };
      }
    }
    return { ok: true, path: installedPath, commit: mutation.commit, rollback: mutation.rollback };
  } catch (error) {
    mutation.rollback();
    throw error;
  }
}

// Used by start and restart paths to force a 0.0.0.0 binding on an already
// installed Ollama. Fresh install fallback passes installedPath to avoid
// relying on a newly-mutated Windows PATH from this process.
function setupWindowsOllamaWith0000Binding(
  opts: { announceStop?: boolean; installedPath?: string } = {},
  operations: WindowsOllamaSetupOperations = WINDOWS_OLLAMA_SETUP_OPERATIONS,
): WindowsOllamaSetupResult {
  const snapshot = operations.captureSnapshot();
  if (!snapshot) {
    console.error("  Could not capture the existing Windows Ollama state; leaving it unchanged.");
    return { ok: false, reason: "snapshot" };
  }
  const mutation = beginWindowsOllamaMutation(snapshot, operations);
  try {
    const setupResult = applyWindowsOllamaBinding(opts, snapshot, operations, mutation.markMutated);
    if (!setupResult.ok) {
      mutation.rollback();
      return setupResult;
    }
    return { ok: true, commit: mutation.commit, rollback: mutation.rollback };
  } catch (error) {
    mutation.rollback();
    throw error;
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
  console.error("  After correcting the Windows process or listener, retry:");
  console.error("    nemoclaw onboard");
  console.error(
    "  NemoClaw repeats the reachability check with an isolated Docker client configuration and removes that temporary configuration afterward.",
  );
}

function printWindowsOllamaSnapshotDiagnostics(): void {
  console.error("  NemoClaw could not inspect the existing Windows Ollama state.");
  console.error(
    "  In Windows PowerShell, verify that the current user can query the User-scope OLLAMA_HOST value and existing Ollama processes, then retry:",
  );
  console.error("    nemoclaw onboard");
}

module.exports = {
  installOllamaOnWindowsHost,
  awaitWindowsOllamaReady,
  setupWindowsOllamaWith0000Binding,
  sleep: sleepSeconds,
  switchToWindowsOllamaHost,
  printWindowsOllamaSnapshotDiagnostics,
  printWindowsOllamaTimeoutDiagnostics,
};
