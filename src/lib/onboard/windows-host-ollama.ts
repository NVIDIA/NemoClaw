// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { OLLAMA_PORT } from "../core/ports";
import { isWsl, windowsProcessListensOnlyOnLoopback } from "../platform";
import { runCapture } from "../runner";

export interface WindowsHostOllamaState {
  // True when an ollama install is observable on the Windows host (either
  // on the user PATH, or as a running process whose executable path we
  // can recover).
  installed: boolean;
  // Absolute Windows path to ollama.exe. Empty when we could not recover
  // it — in that case we deliberately leave `installed` false so the
  // restart path does not kill a daemon we cannot relaunch.
  installedPath: string;
  // True when the running daemon is listening on 127.0.0.1 only and not
  // on 0.0.0.0 / ::. Windows-host reuse requires this state; wildcard
  // listeners are routed through the loopback repair action.
  loopbackOnly: boolean;
}

const POWERSHELL = "powershell.exe";
const WINDOWS_HOST_OLLAMA_PROBE_TIMEOUT_MS = 5_000;

const GET_COMMAND_OLLAMA =
  "Get-Command ollama.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source";

const GET_PROCESS_OLLAMA_PATH =
  "Get-Process ollama -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path";

const GET_KNOWN_OLLAMA_INSTALL_PATH =
  "$candidates = @(); " +
  "if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\\Ollama\\ollama.exe') }; " +
  "if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'Ollama\\ollama.exe') }; " +
  "if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'Ollama\\ollama.exe') }; " +
  "$candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1";

export interface DetectWindowsHostOllamaDeps {
  isWsl: () => boolean;
  runCapture: typeof runCapture;
}

function resolveDeps(
  overrides: Partial<DetectWindowsHostOllamaDeps> = {},
): DetectWindowsHostOllamaDeps {
  return {
    isWsl: overrides.isWsl ?? isWsl,
    runCapture: overrides.runCapture ?? runCapture,
  };
}

function powershell(script: string, deps: DetectWindowsHostOllamaDeps): string {
  return deps
    .runCapture([POWERSHELL, "-Command", script], {
      ignoreError: true,
      timeout: WINDOWS_HOST_OLLAMA_PROBE_TIMEOUT_MS,
    })
    .trim();
}

function probeInstalledPath(deps: DetectWindowsHostOllamaDeps): string {
  const onPath = powershell(GET_COMMAND_OLLAMA, deps);
  if (onPath.length > 0) return onPath;
  // PATH miss: service-style installs and any installer that does not
  // update the calling user's PATH leave ollama.exe invisible to
  // Get-Command even when the daemon is running. Recover the path from
  // the live process so the restart launcher in windows.ts can target
  // the verified executable instead of falling back to a broken PATH
  // lookup (#3949).
  const processPath = powershell(GET_PROCESS_OLLAMA_PATH, deps);
  if (processPath.length > 0) return processPath;
  // Silent installs often land in fixed locations without updating PATH or
  // leaving a running daemon to probe. Check those paths even when no PID is
  // visible so WSL onboarding offers Start instead of Install (#4066).
  return powershell(GET_KNOWN_OLLAMA_INSTALL_PATH, deps);
}

function probeLoopbackOnly(deps: DetectWindowsHostOllamaDeps): boolean {
  return windowsProcessListensOnlyOnLoopback(deps.runCapture, {
    processName: "ollama",
    port: OLLAMA_PORT,
    timeoutMs: WINDOWS_HOST_OLLAMA_PROBE_TIMEOUT_MS,
  });
}

export function detectWindowsHostOllama(
  overrides: Partial<DetectWindowsHostOllamaDeps> = {},
): WindowsHostOllamaState {
  const deps = resolveDeps(overrides);
  if (!deps.isWsl()) {
    return { installed: false, installedPath: "", loopbackOnly: false };
  }
  const installedPath = probeInstalledPath(deps);
  // `installed` reflects binary presence on disk, not a live daemon. Onboard
  // still gates Start/Restart on reachability and loopback binding (#3949).
  const installed = installedPath.length > 0;
  const loopbackOnly = installed ? probeLoopbackOnly(deps) : false;
  return { installed, installedPath, loopbackOnly };
}
