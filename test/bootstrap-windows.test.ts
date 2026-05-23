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
  itPowerShell("installs Ubuntu 24.04 before continuing when WSL has no registered distro", () => {
    const result = runPowerShellHarness(`
$ErrorActionPreference = 'Stop'
. ${JSON.stringify(BOOTSTRAP_WINDOWS)}

$script:getDistroCalls = 0
$script:nativeCalls = @()
$script:statusMessages = @()

function Resolve-WslExe { return 'wsl.exe' }
function Get-WslDistros {
  $script:getDistroCalls += 1
  if ($script:getDistroCalls -eq 1) { return @() }
  return @('Ubuntu-24.04')
}
function Invoke-NativeCommand {
  param([string]$FilePath, [string[]]$ArgumentList = @(), [switch]$SuppressOutput)
  $script:nativeCalls += ,@($FilePath, ($ArgumentList -join ' '))
  return 0
}
function Invoke-NativeCommandOutput {
  param([string]$FilePath, [string[]]$ArgumentList = @(), [switch]$MergeError)
  return [pscustomobject]@{ ExitCode = 0; Output = 'WSL_OK' }
}
function Ensure-WslDistroVersion2 { param([string]$Name) }
function Write-Status { param([string]$Message, [string]$Level = 'INFO') $script:statusMessages += $Message }

Ensure-UbuntuWsl

[pscustomobject]@{
  nativeCalls = $script:nativeCalls
  statusMessages = $script:statusMessages
} | ConvertTo-Json -Compress
`);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.nativeCalls).toContainEqual(["wsl.exe", "--install Ubuntu-24.04"]);
    expect(parsed.nativeCalls).toContainEqual(["wsl.exe", "--set-default Ubuntu-24.04"]);
    expect(parsed.statusMessages).toContain("WSL distro registered: Ubuntu-24.04");
  });

  itPowerShell("prints the issue 3974 guidance when Ubuntu 24.04 cannot be installed", () => {
    const result = runPowerShellHarness(`
$ErrorActionPreference = 'Stop'
. ${JSON.stringify(BOOTSTRAP_WINDOWS)}

function Resolve-WslExe { return 'wsl.exe' }
function Get-WslDistros { return @() }
function Invoke-NativeCommand {
  param([string]$FilePath, [string[]]$ArgumentList = @(), [switch]$SuppressOutput)
  return 42
}
function Write-Status { param([string]$Message, [string]$Level = 'INFO') Write-Host $Message }

try {
  Ensure-UbuntuWsl
  Write-Host 'UNEXPECTED_SUCCESS'
  exit 3
} catch {
  Write-Host "CAUGHT: $($_.Exception.Message)"
}
`);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("NemoClaw on Windows ARM requires WSL2 Ubuntu 24.04.");
    expect(result.stdout).toContain("Please run: wsl --install Ubuntu-24.04");
    expect(result.stdout).toContain("Then re-run this installer.");
    expect(result.stdout).toContain("CAUGHT: Could not install WSL distro 'Ubuntu-24.04'.");
  });
});
