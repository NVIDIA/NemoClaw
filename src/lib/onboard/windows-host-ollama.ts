// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isWsl } from "../platform";
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
  // on 0.0.0.0 / ::. Drives the "Restart Ollama on Windows host with
  // 0.0.0.0 binding" menu variant (#3949).
  loopbackOnly: boolean;
}

const POWERSHELL = "powershell.exe";

const GET_COMMAND_OLLAMA =
  "Get-Command ollama.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source";

const GET_PROCESS_OLLAMA_PATH =
  "Get-Process ollama -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path";

const GET_PROCESS_OLLAMA_ID =
  "Get-Process ollama -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Id";

const GET_KNOWN_OLLAMA_INSTALL_PATH =
  "$candidates = @(); " +
  "if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\\Ollama\\ollama.exe') }; " +
  "if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'Ollama\\ollama.exe') }; " +
  "if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'Ollama\\ollama.exe') }; " +
  "$candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1";

const GET_NETTCP_OLLAMA_LISTEN =
  "Get-NetTCPConnection -LocalPort 11434 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalAddress";

function powershell(script: string): string {
  return runCapture([POWERSHELL, "-Command", script], { ignoreError: true }).trim();
}

function probeInstalledPath(): string {
  const onPath = powershell(GET_COMMAND_OLLAMA);
  if (onPath.length > 0) return onPath;
  // PATH miss: service-style installs and any installer that does not
  // update the calling user's PATH leave ollama.exe invisible to
  // Get-Command even when the daemon is running. Recover the path from
  // the live process so the restart launcher in windows.ts can target
  // the verified executable instead of falling back to a broken PATH
  // lookup (#3949).
  const processPath = powershell(GET_PROCESS_OLLAMA_PATH);
  if (processPath.length > 0) return processPath;
  // Silent installs often land in fixed locations without updating PATH or
  // leaving a running daemon to probe. Check those paths even when no PID is
  // visible so WSL onboarding offers Start instead of Install (#4066).
  return powershell(GET_KNOWN_OLLAMA_INSTALL_PATH);
}

function probeLoopbackOnly(): boolean {
  const pid = powershell(GET_PROCESS_OLLAMA_ID);
  if (!pid) return false;
  const listenAddrs = runCapture([POWERSHELL, "-Command", GET_NETTCP_OLLAMA_LISTEN], {
    ignoreError: true,
  });
  return /127\.0\.0\.1/.test(listenAddrs) && !/0\.0\.0\.0|^::\s*$/m.test(listenAddrs);
}

export function detectWindowsHostOllama(): WindowsHostOllamaState {
  if (!isWsl()) {
    return { installed: false, installedPath: "", loopbackOnly: false };
  }
  const installedPath = probeInstalledPath();
  // `installed` reflects binary presence on disk, not a live daemon. Onboard
  // still gates Start/Restart on reachability and loopback binding (#3949).
  const installed = installedPath.length > 0;
  const loopbackOnly = installed ? probeLoopbackOnly() : false;
  return { installed, installedPath, loopbackOnly };
}
