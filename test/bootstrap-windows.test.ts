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
          TEMP: process.env.TEMP ?? process.env.TMPDIR ?? os.tmpdir(),
          TMP: process.env.TMP ?? process.env.TMPDIR ?? os.tmpdir(),
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
  itPowerShell("starts Docker Desktop without restart when it was not already running", () => {
    const result = runPowerShellHarness(`
$ErrorActionPreference = 'Stop'
. ${JSON.stringify(BOOTSTRAP_WINDOWS)}

$script:DockerDesktopExe = 'Docker Desktop.exe'
$script:DockerCli = 'docker.exe'
$script:events = @()

function Test-Path { param([string]$LiteralPath) return $true }
function Test-DockerDesktopRunning { return $false }
function Wait-DockerDesktopEngine { param([int]$TimeoutSeconds) $script:events += 'wait-ready'; return $true }
function Restart-DockerDesktop { $script:events += 'restart' }
function Minimize-DockerDesktopWindow { $script:events += 'minimize' }
function Set-InstallerWindowForeground { $script:events += 'foreground' }
function Start-Process { param([string]$FilePath) $script:events += "start-$FilePath"; return [pscustomobject]@{} }
function Write-Status { param([string]$Message, [string]$Level = 'INFO') }

Start-DockerDesktop

$script:events | ConvertTo-Json -Compress
`);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "[]");
    expect(parsed).toEqual(["start-Docker Desktop.exe", "wait-ready", "minimize", "foreground"]);
  });

  itPowerShell("restarts Docker Desktop when it was already running before settings changed", () => {
    const result = runPowerShellHarness(`
$ErrorActionPreference = 'Stop'
. ${JSON.stringify(BOOTSTRAP_WINDOWS)}

$script:DockerDesktopExe = 'Docker Desktop.exe'
$script:DockerCli = 'docker.exe'
$script:events = @()

function Test-Path { param([string]$LiteralPath) return $true }
function Test-DockerDesktopRunning { return $true }
function Wait-DockerDesktopEngine { param([int]$TimeoutSeconds) $script:events += 'wait-ready'; return $true }
function Restart-DockerDesktop { $script:events += 'restart' }
function Minimize-DockerDesktopWindow { $script:events += 'minimize' }
function Set-InstallerWindowForeground { $script:events += 'foreground' }
function Start-Process { param([string]$FilePath) $script:events += "start-$FilePath"; return [pscustomobject]@{} }
function Write-Status { param([string]$Message, [string]$Level = 'INFO') }

Start-DockerDesktop

$script:events | ConvertTo-Json -Compress
`);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "[]");
    expect(parsed).toEqual(["start-Docker Desktop.exe", "wait-ready", "restart"]);
  });

  itPowerShell("installs missing Ubuntu 24.04 through first-run setup before Docker integration", () => {
    const result = runPowerShellHarness(`
$ErrorActionPreference = 'Stop'
. ${JSON.stringify(BOOTSTRAP_WINDOWS)}

$script:nativeCalls = @()
$script:startProcessCalls = @()
$script:statusMessages = @()

function Resolve-WslExe { return 'wsl.exe' }
function Get-WslDistros { return @() }
function Wait-WslDistroRegistration { param([string]$Name) return $true }
function Wait-WslDefaultUserReady { param([string]$Name) return 1000 }
function Ensure-WslDistroVersion2 { param([string]$Name) }
function Stop-WslDistroForDockerIntegration { param([string]$Name, [string]$Reason) $script:nativeCalls += ,@('Stop-WslDistroForDockerIntegration', $Name) }
function Ensure-WslDockerCliConfigDirectory { param([string]$Name) $script:nativeCalls += ,@('Ensure-WslDockerCliConfigDirectory', $Name) }
function Invoke-NativeCommand {
  param([string]$FilePath, [string[]]$ArgumentList = @(), [switch]$SuppressOutput)
  $script:nativeCalls += ,@($FilePath, ($ArgumentList -join ' '))
  return 0
}
function Start-Process {
  param([string]$FilePath, [object]$ArgumentList = @())
  $argsText = if ($ArgumentList -is [array]) { $ArgumentList -join ' ' } else { [string]$ArgumentList }
  $script:startProcessCalls += ,@($FilePath, $argsText)
  return [pscustomobject]@{}
}
function Write-Status { param([string]$Message, [string]$Level = 'INFO') $script:statusMessages += $Message }

Ensure-UbuntuWsl

[pscustomobject]@{
  nativeCalls = $script:nativeCalls
  startProcessCalls = $script:startProcessCalls
  statusMessages = $script:statusMessages
  installDistroAtHandoff = $script:InstallDistroAtHandoff
} | ConvertTo-Json -Compress
`);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}");
    expect(parsed.installDistroAtHandoff).toBe(false);
    expect(parsed.startProcessCalls).toHaveLength(1);
    expect(parsed.startProcessCalls[0][0]).toBe("powershell.exe");
    expect(parsed.startProcessCalls[0][1]).toContain("--install -d 'Ubuntu-24.04'");
    expect(parsed.startProcessCalls[0][1]).not.toContain("--no-launch");
    expect(parsed.nativeCalls).not.toContainEqual(["wsl.exe", "--set-default Ubuntu-24.04"]);
    expect(parsed.nativeCalls).toContainEqual(["wsl.exe", "-d Ubuntu-24.04 -- echo WSL_OK"]);
    expect(parsed.nativeCalls).toContainEqual(["Stop-WslDistroForDockerIntegration", "Ubuntu-24.04"]);
    expect(parsed.nativeCalls).toContainEqual(["Ensure-WslDockerCliConfigDirectory", "Ubuntu-24.04"]);
    expect(parsed.statusMessages).toContain(
      "WSL distro registered: Ubuntu-24.04",
    );
    expect(parsed.statusMessages).toContain("Ubuntu-24.04 first-run user is registered (UID 1000).");
  });

  itPowerShell("verifies WSL startup even when Docker Desktop install is disabled", () => {
    const result = runPowerShellHarness(`
$ErrorActionPreference = 'Stop'
. ${JSON.stringify(BOOTSTRAP_WINDOWS)}

$InstallDockerDesktop = $false
$script:nativeCalls = @()
$script:statusMessages = @()

function Resolve-WslExe { return 'wsl.exe' }
function Get-WslDistros { return @('Ubuntu-24.04') }
function Ensure-WslDistroVersion2 { param([string]$Name) }
function Invoke-NativeCommand {
  param([string]$FilePath, [string[]]$ArgumentList = @(), [switch]$SuppressOutput)
  $script:nativeCalls += ,@($FilePath, ($ArgumentList -join ' '))
  return 0
}
function Write-Status { param([string]$Message, [string]$Level = 'INFO') $script:statusMessages += $Message }

Ensure-UbuntuWsl

[pscustomobject]@{
  nativeCalls = $script:nativeCalls
  statusMessages = $script:statusMessages
} | ConvertTo-Json -Depth 5 -Compress
`);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}");
    expect(parsed.nativeCalls).toContainEqual(["wsl.exe", "-d Ubuntu-24.04 -- echo WSL_OK"]);
    expect(parsed.statusMessages).toContain("Verified WSL distro 'Ubuntu-24.04' starts.");
    expect(parsed.statusMessages).toContain("Ubuntu-24.04 is ready.");
  });

  itPowerShell("fails an already registered distro that cannot start", () => {
    const result = runPowerShellHarness(`
$ErrorActionPreference = 'Stop'
. ${JSON.stringify(BOOTSTRAP_WINDOWS)}

$InstallDockerDesktop = $false
$script:nativeCalls = @()
$script:statusMessages = @()
$script:outcome = 'success'

function Resolve-WslExe { return 'wsl.exe' }
function Get-WslDistros { return @('Ubuntu-24.04') }
function Ensure-WslDistroVersion2 { param([string]$Name) }
function Invoke-NativeCommand {
  param([string]$FilePath, [string[]]$ArgumentList = @(), [switch]$SuppressOutput)
  $script:nativeCalls += ,@($FilePath, ($ArgumentList -join ' '))
  return 1
}
function Write-Status { param([string]$Message, [string]$Level = 'INFO') $script:statusMessages += $Message }

try {
  Ensure-UbuntuWsl
} catch {
  $script:outcome = $_.Exception.Message
}

[pscustomobject]@{
  nativeCalls = $script:nativeCalls
  statusMessages = $script:statusMessages
  outcome = $script:outcome
} | ConvertTo-Json -Depth 5 -Compress
`);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}");
    expect(parsed.nativeCalls).toContainEqual(["wsl.exe", "-d Ubuntu-24.04 -- echo WSL_OK"]);
    expect(parsed.outcome).toContain("WSL distro 'Ubuntu-24.04' is registered but could not start");
    expect(parsed.statusMessages).not.toContain("Ubuntu-24.04 is ready.");
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

  itPowerShell("opens the final Ubuntu handoff as one plain PowerShell-hosted WSL launch", () => {
    const result = runPowerShellHarness(`
$ErrorActionPreference = 'Stop'
. ${JSON.stringify(BOOTSTRAP_WINDOWS)}

$script:nativeCalls = @()
$script:startProcessCalls = @()
$script:stopCalls = @()

function Resolve-WslExe { return 'wsl.exe' }
function Stop-WslDistroForDockerIntegration { param([string]$Name, [string]$Reason) $script:stopCalls += $Name }
function Invoke-NativeCommand {
  param([string]$FilePath, [string[]]$ArgumentList = @(), [switch]$SuppressOutput)
  $script:nativeCalls += ,@($FilePath, ($ArgumentList -join ' '))
  return 0
}
function Start-Process {
  param([string]$FilePath, [object]$ArgumentList = @(), [switch]$Wait, [switch]$PassThru)
  $argsText = if ($ArgumentList -is [array]) { $ArgumentList -join ' ' } else { [string]$ArgumentList }
  $script:startProcessCalls += ,@($FilePath, $argsText)
  return [pscustomobject]@{ ExitCode = 0 }
}

Open-UbuntuForInstaller

[pscustomobject]@{
  nativeCalls = $script:nativeCalls
  stopCalls = $script:stopCalls
  startProcessCalls = $script:startProcessCalls
} | ConvertTo-Json -Compress
`);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}");
    expect(parsed.nativeCalls).toEqual([]);
    expect(parsed.stopCalls).toEqual([]);
    expect(parsed.startProcessCalls).toHaveLength(1);
    expect(parsed.startProcessCalls[0][0]).toBe("powershell.exe");
    expect(parsed.startProcessCalls[0][1]).toContain("-Command");
    expect(parsed.startProcessCalls[0][1]).toContain("& 'wsl.exe' -d 'Ubuntu-24.04'");
    for (const launch of parsed.startProcessCalls.map((call: string[]) => call[1])) {
      expect(launch).not.toContain("-- ");
      expect(launch).not.toContain("bash");
      expect(launch).not.toContain("curl");
      expect(launch).not.toContain("true");
      expect(launch).not.toContain("nemoclaw.sh");
    }
  });

  itPowerShell("repairs Docker Desktop WSL integration settings for the target distro", () => {
    const result = runPowerShellHarness(`
$ErrorActionPreference = 'Stop'
. ${JSON.stringify(BOOTSTRAP_WINDOWS)}

$settingsDir = Join-Path $env:TEMP ('docker-settings-test-' + [guid]::NewGuid().ToString('N'))
$env:APPDATA = $settingsDir
$dockerDir = Join-Path $settingsDir 'Docker'
New-Item -ItemType Directory -Path $dockerDir -Force | Out-Null
$settingsPath = Join-Path $dockerDir 'settings-store.json'
@{
  wslEngineEnabled = $false
  enableIntegrationWithDefaultWslDistro = $false
  integratedWslDistros = @('Debian')
} | ConvertTo-Json | Set-Content -Path $settingsPath -Encoding UTF8

Enable-DockerDesktopWslIntegration -Name 'Ubuntu-24.04'

$settings = Get-Content -Path $settingsPath -Raw | ConvertFrom-Json
$result = [pscustomobject]@{
  wslEngineEnabled = $settings.wslEngineEnabled
  enableIntegrationWithDefaultWslDistro = $settings.enableIntegrationWithDefaultWslDistro
  integratedWslDistros = $settings.integratedWslDistros
  backupCount = @(Get-ChildItem -Path $dockerDir -Filter 'settings-store.json.bak.*').Count
}
Remove-Item -Path $settingsDir -Recurse -Force
$result | ConvertTo-Json -Compress
`);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}");
    expect(parsed.wslEngineEnabled).toBe(true);
    expect(parsed.enableIntegrationWithDefaultWslDistro).toBe(false);
    expect(parsed.integratedWslDistros).toContain("Debian");
    expect(parsed.integratedWslDistros).toContain("Ubuntu-24.04");
    expect(parsed.backupCount).toBe(1);
  });

  itPowerShell("creates Docker Desktop WSL integration settings when the settings file is missing", () => {
    const result = runPowerShellHarness(`
$ErrorActionPreference = 'Stop'
. ${JSON.stringify(BOOTSTRAP_WINDOWS)}

$settingsDir = Join-Path $env:TEMP ('docker-settings-missing-test-' + [guid]::NewGuid().ToString('N'))
$env:APPDATA = $settingsDir
$dockerDir = Join-Path $settingsDir 'Docker'
$settingsPath = Join-Path $dockerDir 'settings-store.json'

Enable-DockerDesktopWslIntegration -Name 'Ubuntu-24.04'

$settings = Get-Content -Path $settingsPath -Raw | ConvertFrom-Json
[pscustomobject]@{
  settingsExists = Test-Path -Path $settingsPath
  wslEngineEnabled = $settings.wslEngineEnabled
  enableIntegrationWithDefaultWslDistro = $settings.enableIntegrationWithDefaultWslDistro
  integratedWslDistros = $settings.integratedWslDistros
  backupCount = @(Get-ChildItem -Path $dockerDir -Filter 'settings-store.json.bak.*' -ErrorAction SilentlyContinue).Count
} | ConvertTo-Json -Compress
`);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}");
    expect(parsed.settingsExists).toBe(true);
    expect(parsed.wslEngineEnabled).toBe(true);
    expect(parsed.enableIntegrationWithDefaultWslDistro).toBe(false);
    expect(parsed.integratedWslDistros).toContain("Ubuntu-24.04");
    expect(parsed.backupCount).toBe(0);
  });
});
