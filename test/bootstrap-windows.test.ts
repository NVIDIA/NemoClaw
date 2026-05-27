// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BOOTSTRAP_WINDOWS = path.join(
  import.meta.dirname,
  "..",
  "scripts",
  "bootstrap-windows.ps1",
);

function resolvePowerShell() {
  for (const command of ["pwsh", "powershell"]) {
    const result = spawnSync(
      command,
      ["-NoLogo", "-NoProfile", "-Command", "$PSVersionTable.PSVersion"],
      { encoding: "utf8" },
    );
    if (result.status === 0) return command;
  }
  return null;
}

const POWERSHELL = resolvePowerShell();
const itPowerShell = POWERSHELL ? it : it.skip;

function runPowerShellHarness(script: string) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bootstrap-windows-"));
  const harness = path.join(tmp, "harness.ps1");
  try {
    fs.writeFileSync(harness, script);
    const result = spawnSync(
      POWERSHELL ?? "pwsh",
      ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", harness],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          NEMOCLAW_BOOTSTRAP_WINDOWS_SOURCE_ONLY: "1",
          SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
        },
      },
    );
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      status: result.status ?? 1,
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe("Windows bootstrap WSL distro preflight", () => {
  itPowerShell("defers missing Ubuntu 24.04 install to a separate handoff window", () => {
    const result = runPowerShellHarness(`
$ErrorActionPreference = 'Stop'
. ${JSON.stringify(BOOTSTRAP_WINDOWS)}

$script:nativeCalls = @()
$script:startProcessCalls = @()
$script:statusMessages = @()

function Resolve-WslExe { return 'wsl.exe' }
function Get-WslDistros { return @() }
function Invoke-NativeCommand {
  param([string]$FilePath, [string[]]$ArgumentList = @(), [switch]$SuppressOutput)
  $script:nativeCalls += ,@($FilePath, ($ArgumentList -join ' '))
  return 0
}
function Start-Process {
  param([string]$FilePath, [string[]]$ArgumentList = @())
  $script:startProcessCalls += ,@($FilePath, ($ArgumentList -join ' '))
  return [pscustomobject]@{}
}
function Write-Status { param([string]$Message, [string]$Level = 'INFO') $script:statusMessages += $Message }

Ensure-UbuntuWsl
Open-UbuntuForInstaller

[pscustomobject]@{
  nativeCalls = $script:nativeCalls
  startProcessCalls = $script:startProcessCalls
  statusMessages = $script:statusMessages
  installDistroAtHandoff = $script:InstallDistroAtHandoff
} | ConvertTo-Json -Compress
`);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.installDistroAtHandoff).toBe(true);
    expect(parsed.nativeCalls).toEqual([]);
    expect(parsed.startProcessCalls).toContainEqual(["wsl.exe", "--install -d Ubuntu-24.04"]);
    expect(parsed.statusMessages).toContain(
      "Ubuntu-24.04 is not registered yet. It will be installed during the final Ubuntu handoff.",
    );
  });

  itPowerShell("prints the issue 3974 guidance when the deferred Ubuntu launch fails", () => {
    const result = runPowerShellHarness(`
$ErrorActionPreference = 'Stop'
. ${JSON.stringify(BOOTSTRAP_WINDOWS)}

function Resolve-WslExe { return 'wsl.exe' }
function Start-Process { throw 'launch failed' }
function Write-Status { param([string]$Message, [string]$Level = 'INFO') Write-Host $Message }

$script:InstallDistroAtHandoff = $true
try {
  Open-UbuntuForInstaller
  Write-Host 'UNEXPECTED_SUCCESS'
  exit 3
} catch {
  Write-Host "CAUGHT: $($_.Exception.Message)"
}
`);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("NemoClaw on Windows ARM requires WSL2 Ubuntu 24.04.");
    expect(result.stdout).toContain("Please run: wsl --install -d Ubuntu-24.04");
    expect(result.stdout).toContain("Then re-run this installer.");
    expect(result.stdout).toContain("CAUGHT: launch failed");
  });
});
