// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeAll, describe, expect, it } from "vitest";

import { testTimeout, testTimeoutOptions } from "./helpers/timeouts";
import {
  BOOTSTRAP_WINDOWS,
  POWERSHELL_BATCH_EXEC_TIMEOUT_MS,
  POWERSHELL_PROCESS_EXEC_TIMEOUT_MS,
  type PowerShellBatchCase,
  type PowerShellHarnessResult,
  requirePowerShellBatchResult,
  resolvePowerShell,
  runPowerShellBatch,
  runPowerShellProcess,
} from "./support/bootstrap-windows-test-helpers";

const POWERSHELL_TEST_TIMEOUT = testTimeoutOptions(
  Math.max(30_000, POWERSHELL_PROCESS_EXEC_TIMEOUT_MS + 5_000),
);
const POWERSHELL = resolvePowerShell();
const POWERSHELL_BATCH_CASES: PowerShellBatchCase[] = [];
let powerShellBatchResults: ReadonlyMap<string, PowerShellHarnessResult> = new Map();
const POWERSHELL_BATCH_TEST_TIMEOUT_MS = testTimeout(
  Math.max(65_000, POWERSHELL_BATCH_EXEC_TIMEOUT_MS + 5_000),
);
const itPowerShellProcess = (name: string, fn: () => void) =>
  (POWERSHELL ? it : it.skip)(name, POWERSHELL_TEST_TIMEOUT, fn);
const itPowerShell = (
  name: string,
  script: string,
  assertions: (result: PowerShellHarnessResult) => void,
) => {
  POWERSHELL_BATCH_CASES.push({ id: name, script });
  (POWERSHELL ? it : it.skip)(name, POWERSHELL_TEST_TIMEOUT, () =>
    assertions(requirePowerShellBatchResult(powerShellBatchResults, name)),
  );
};

describe("Windows bootstrap WSL distro preflight", () => {
  beforeAll(
    POWERSHELL
      ? () => {
          powerShellBatchResults = runPowerShellBatch(POWERSHELL, POWERSHELL_BATCH_CASES);
        }
      : () => undefined,
    POWERSHELL_BATCH_TEST_TIMEOUT_MS,
  );

  itPowerShell(
    "starts Docker Desktop without restart when it was not already running",
    `
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
`,
    (result) => {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const parsed = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "[]");
      expect(parsed).toEqual(["start-Docker Desktop.exe", "wait-ready", "minimize", "foreground"]);
    },
  );

  itPowerShell(
    "restarts Docker Desktop when it was already running before settings changed",
    `
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
`,
    (result) => {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const parsed = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "[]");
      expect(parsed).toEqual(["start-Docker Desktop.exe", "wait-ready", "restart"]);
    },
  );

  itPowerShell(
    "repairs WSL when status reports the runtime is missing",
    `
$ErrorActionPreference = 'Stop'
. ${JSON.stringify(BOOTSTRAP_WINDOWS)}

$script:nativeCalls = @()
$script:requestReboot = $false
$script:outcome = 'success'

function Resolve-WslExe { return 'wsl.exe' }
function Invoke-NativeCommandOutput {
  param([string]$FilePath, [string[]]$ArgumentList = @(), [switch]$MergeError)
  $argsText = $ArgumentList -join ' '
  $script:nativeCalls += ,@($FilePath, $argsText)
  if ($argsText -eq '--status') {
    return [pscustomobject]@{
      ExitCode = 0
      Output = @'
The Windows Subsystem for Linux is not installed. You can install by running 'wsl.exe --install'.
For more information please visit https://aka.ms/wslinstall
'@
    }
  }
  if ($argsText -eq '--install --no-distribution') {
    return [pscustomobject]@{
      ExitCode = 0
      Output = 'The requested operation is successful. Changes will not be effective until the system is rebooted.'
    }
  }
  throw "Unexpected native call: $argsText"
}
function Request-Reboot {
  $script:requestReboot = $true
  throw 'REBOOT_REQUESTED'
}

try {
  Assert-WslRuntimeAvailable
} catch {
  $script:outcome = $_.Exception.Message
}

[pscustomobject]@{
  nativeCalls = $script:nativeCalls
  requestReboot = $script:requestReboot
  outcome = $script:outcome
} | ConvertTo-Json -Depth 5 -Compress
`,
    (result) => {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Windows reports that the WSL runtime is not installed");
      expect(result.stdout).toContain("Attempting WSL repair: wsl --install --no-distribution");
      expect(result.stdout).toContain("WSL repair command completed successfully.");
      const parsed = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}");
      expect(parsed.nativeCalls).toContainEqual(["wsl.exe", "--status"]);
      expect(parsed.nativeCalls).toContainEqual(["wsl.exe", "--install --no-distribution"]);
      expect(parsed.requestReboot).toBe(true);
      expect(parsed.outcome).toContain("REBOOT_REQUESTED");
    },
  );

  itPowerShell(
    "continues when WSL repair succeeds without a reboot-required message",
    `
$ErrorActionPreference = 'Stop'
. ${JSON.stringify(BOOTSTRAP_WINDOWS)}

$script:nativeCalls = @()
$script:statusCalls = 0
$script:outcome = 'success'

function Resolve-WslExe { return 'wsl.exe' }
function Invoke-NativeCommandOutput {
  param([string]$FilePath, [string[]]$ArgumentList = @(), [switch]$MergeError)
  $argsText = $ArgumentList -join ' '
  $script:nativeCalls += ,@($FilePath, $argsText)
  if ($argsText -eq '--status') {
    $script:statusCalls += 1
    if ($script:statusCalls -eq 1) {
      return [pscustomobject]@{
        ExitCode = 0
        Output = "The Windows Subsystem for Linux is not installed."
      }
    }
    return [pscustomobject]@{
      ExitCode = 0
      Output = 'Default Version: 2'
    }
  }
  if ($argsText -eq '--install --no-distribution') {
    return [pscustomobject]@{
      ExitCode = 0
      Output = 'The operation completed successfully.'
    }
  }
  throw "Unexpected native call: $argsText"
}
function Request-Reboot { throw 'UNEXPECTED_REBOOT' }

try {
  Assert-WslRuntimeAvailable
} catch {
  $script:outcome = $_.Exception.Message
}

[pscustomobject]@{
  nativeCalls = $script:nativeCalls
  statusCalls = $script:statusCalls
  outcome = $script:outcome
} | ConvertTo-Json -Depth 5 -Compress
`,
    (result) => {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("WSL repair command completed successfully.");
      expect(result.stdout).toContain("WSL status verified after repair.");
      const parsed = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}");
      expect(parsed.nativeCalls).toEqual([
        ["wsl.exe", "--status"],
        ["wsl.exe", "--install --no-distribution"],
        ["wsl.exe", "--status"],
      ]);
      expect(parsed.statusCalls).toBe(2);
      expect(parsed.outcome).toBe("success");
    },
  );

  itPowerShell(
    "stops when WSL repair succeeds without reboot but status remains unavailable",
    `
$ErrorActionPreference = 'Stop'
. ${JSON.stringify(BOOTSTRAP_WINDOWS)}

$script:nativeCalls = @()
$script:statusCalls = 0
$script:outcome = 'success'

function Resolve-WslExe { return 'wsl.exe' }
function Invoke-NativeCommandOutput {
  param([string]$FilePath, [string[]]$ArgumentList = @(), [switch]$MergeError)
  $argsText = $ArgumentList -join ' '
  $script:nativeCalls += ,@($FilePath, $argsText)
  if ($argsText -eq '--status') {
    $script:statusCalls += 1
    if ($script:statusCalls -eq 1) {
      return [pscustomobject]@{
        ExitCode = 50
        Output = ''
      }
    }
    return [pscustomobject]@{
      ExitCode = 50
      Output = 'Still unavailable after repair.'
    }
  }
  if ($argsText -eq '--install --no-distribution') {
    return [pscustomobject]@{
      ExitCode = 0
      Output = 'The operation completed successfully.'
    }
  }
  throw "Unexpected native call: $argsText"
}
function Request-Reboot { throw 'UNEXPECTED_REBOOT' }

try {
  Assert-WslRuntimeAvailable
} catch {
  $script:outcome = $_.Exception.Message
}

[pscustomobject]@{
  nativeCalls = $script:nativeCalls
  statusCalls = $script:statusCalls
  outcome = $script:outcome
} | ConvertTo-Json -Depth 5 -Compress
`,
    (result) => {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(
        "Automatic WSL repair completed, but WSL still could not be verified.",
      );
      expect(result.stdout).toContain("Still unavailable after repair.");
      expect(result.stdout).toContain(
        "Offline install docs: https://learn.microsoft.com/en-us/windows/wsl/install#offline-install",
      );
      const parsed = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}");
      expect(parsed.nativeCalls).toEqual([
        ["wsl.exe", "--status"],
        ["wsl.exe", "--install --no-distribution"],
        ["wsl.exe", "--status"],
      ]);
      expect(parsed.statusCalls).toBe(2);
      expect(parsed.outcome).toContain("wsl --install --no-distribution completed");
      expect(parsed.outcome).toContain("wsl --status");
    },
  );

  itPowerShell(
    "prints repair instructions when automatic WSL repair fails",
    `
$ErrorActionPreference = 'Stop'
. ${JSON.stringify(BOOTSTRAP_WINDOWS)}

$script:nativeCalls = @()
$script:outcome = 'success'

function Resolve-WslExe { return 'wsl.exe' }
function Invoke-NativeCommandOutput {
  param([string]$FilePath, [string[]]$ArgumentList = @(), [switch]$MergeError)
  $argsText = $ArgumentList -join ' '
  $script:nativeCalls += ,@($FilePath, $argsText)
  if ($argsText -eq '--status') {
    return [pscustomobject]@{
      ExitCode = 50
      Output = ''
    }
  }
  if ($argsText -eq '--install --no-distribution') {
    return [pscustomobject]@{
      ExitCode = 1
      Output = "Forbidden (403).\`n\`n   \`n      \`n\`n"
    }
  }
  throw "Unexpected native call: $argsText"
}

try {
  Assert-WslRuntimeAvailable
} catch {
  $script:outcome = $_.Exception.Message
}

[pscustomobject]@{
  nativeCalls = $script:nativeCalls
  outcome = $script:outcome
} | ConvertTo-Json -Depth 5 -Compress
`,
    (result) => {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Windows Subsystem for Linux could not be verified.");
      expect(result.stdout).toContain(
        "The command 'wsl --status' exited with code 50, so this script cannot safely install or run the Ubuntu-24.04 WSL distro yet.",
      );
      expect(result.stdout).toContain("Attempting WSL repair: wsl --install --no-distribution");
      expect(result.stdout).toContain("Automatic WSL repair did not complete.");
      const normalizedStdout = result.stdout.replace(/\r\n/g, "\n");
      expect(normalizedStdout).toContain(
        "Forbidden (403).\n\nAutomatic WSL repair did not complete.",
      );
      expect(normalizedStdout).not.toMatch(
        /Forbidden \(403\)\.\n(?:[ \t]*\n){2,}Automatic WSL repair/,
      );
      expect(result.stdout).toContain(
        "The command 'wsl --install --no-distribution' exited with code 1.",
      );
      expect(result.stdout).toContain("The online WSL installer returned Forbidden (403)");
      expect(result.stdout).toContain(
        "Offline install docs: https://learn.microsoft.com/en-us/windows/wsl/install#offline-install",
      );
      const parsed = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}");
      expect(parsed.nativeCalls).toContainEqual(["wsl.exe", "--status"]);
      expect(parsed.nativeCalls).toContainEqual(["wsl.exe", "--install --no-distribution"]);
      expect(parsed.outcome).toContain("wsl --install --no-distribution failed");
      expect(parsed.outcome).toContain("exit code 1");
    },
  );

  itPowerShell(
    "attempts WSL repair when WSL 2 cannot start",
    `
$ErrorActionPreference = 'Stop'
. ${JSON.stringify(BOOTSTRAP_WINDOWS)}

$script:nativeCalls = @()
$script:outcome = 'success'

function Resolve-WslExe { return 'wsl.exe' }
function Invoke-NativeCommandOutput {
  param([string]$FilePath, [string[]]$ArgumentList = @(), [switch]$MergeError)
  $argsText = $ArgumentList -join ' '
  $script:nativeCalls += ,@($FilePath, $argsText)
  if ($argsText -eq '--status') {
    return [pscustomobject]@{
      ExitCode = 0
      Output = @'
Default Version: 2
WSL1 is not supported with your current machine configuration.
Please enable the "Windows Subsystem for Linux" optional component to use WSL1.
WSL2 is unable to start since virtualization is not enabled on this machine.
Please ensure the "Virtual Machine Platform" optional component is enabled and virtualization is turned on in your computer's firmware settings.

Enable "Virtual Machine Platform" by running: wsl.exe --install --no-distribution

For information please visit https://aka.ms/enablevirtualization
'@
    }
  }
  if ($argsText -eq '--install --no-distribution') {
    return [pscustomobject]@{
      ExitCode = 1
      Output = 'The virtual machine could not be started because a required feature is not installed.'
    }
  }
  throw "Unexpected native call: $argsText"
}

try {
  Assert-WslRuntimeAvailable
} catch {
  $script:outcome = $_.Exception.Message
}

[pscustomobject]@{
  nativeCalls = $script:nativeCalls
  outcome = $script:outcome
} | ConvertTo-Json -Depth 5 -Compress
`,
    (result) => {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Windows reports that WSL 2 cannot start yet.");
      expect(result.stdout).toContain("reboot");
      expect(result.stdout).toContain("enable virtualization");
      expect(result.stdout).toContain("Attempting WSL repair: wsl --install --no-distribution");
      expect(result.stdout).toContain("Automatic WSL repair did not complete.");
      const parsed = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}");
      expect(parsed.nativeCalls).toContainEqual(["wsl.exe", "--status"]);
      expect(parsed.nativeCalls).toContainEqual(["wsl.exe", "--install --no-distribution"]);
      expect(parsed.outcome).toContain("wsl --install --no-distribution failed");
    },
  );

  itPowerShellProcess("prints a manual resume command before prompting for reboot", () => {
    const result = runPowerShellProcess(
      POWERSHELL ?? "pwsh",
      `
$ErrorActionPreference = 'Stop'
. ${JSON.stringify(BOOTSTRAP_WINDOWS)}

function Register-ResumeRunOnce { Write-Status 'Registered best-effort reboot resume command.' }
function Read-Host { param([string]$Prompt) Write-Host $Prompt; return 'n' }

Request-Reboot
`,
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("This bootstrap may resume automatically");
    expect(result.stdout).toContain(
      "After reboot/sign-in, if no bootstrap window opens, rerun this command from an elevated PowerShell window:",
    );
    expect(result.stdout).toContain("powershell.exe");
    expect(result.stdout).toContain("-Resume");
    expect(result.stdout).toContain("Please reboot now.");
  });

  itPowerShell(
    "installs missing Ubuntu 24.04 through first-run setup before Docker integration",
    `
$ErrorActionPreference = 'Stop'
. ${JSON.stringify(BOOTSTRAP_WINDOWS)}

$script:nativeCalls = @()
$script:startProcessCalls = @()
$script:statusMessages = @()

function Resolve-WslExe { return 'wsl.exe' }
function Get-WslDistros { return @() }
function Wait-WslDistroRegistrationOrInstallExit {
  param([string]$Name, [string]$StatusPath, [int]$TimeoutSeconds = 300)
  return [pscustomobject]@{ Registered = $true; ExitCode = $null }
}
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
  param([string]$FilePath, [object]$ArgumentList = @(), [switch]$Wait, [switch]$PassThru)
  $argsText = if ($ArgumentList -is [array]) { $ArgumentList -join ' ' } else { [string]$ArgumentList }
  $script:startProcessCalls += ,@($FilePath, $argsText)
  return [pscustomobject]@{ Id = 1234 }
}
function Write-Status { param([string]$Message, [string]$Level = 'INFO') $script:statusMessages += $Message }

Ensure-UbuntuWsl

[pscustomobject]@{
  nativeCalls = $script:nativeCalls
  startProcessCalls = $script:startProcessCalls
  statusMessages = $script:statusMessages
  installDistroAtHandoff = $script:InstallDistroAtHandoff
} | ConvertTo-Json -Compress
`,
    (result) => {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const parsed = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}");
      expect(parsed.installDistroAtHandoff).toBe(false);
      expect(parsed.startProcessCalls).toHaveLength(1);
      expect(parsed.startProcessCalls[0][0]).toBe("powershell.exe");
      expect(parsed.startProcessCalls[0][1]).toContain("--install -d 'Ubuntu-24.04'");
      expect(parsed.startProcessCalls[0][1]).not.toContain("--no-launch");
      expect(parsed.startProcessCalls[0][1]).toContain(
        "wsl --install -d Ubuntu-24.04 failed with exit code ",
      );
      expect(parsed.startProcessCalls[0][1]).toContain(
        "Ubuntu installer command exited. This window will close automatically.",
      );
      expect(parsed.startProcessCalls[0][1]).toContain("Start-Transcript");
      expect(parsed.startProcessCalls[0][1]).not.toContain("Tee-Object -FilePath");
      expect(parsed.startProcessCalls[0][1]).not.toContain("Press Enter to close this window");
      expect(parsed.nativeCalls).not.toContainEqual(["wsl.exe", "--set-default Ubuntu-24.04"]);
      expect(parsed.nativeCalls).toContainEqual(["wsl.exe", "-d Ubuntu-24.04 -- echo WSL_OK"]);
      expect(parsed.nativeCalls).toContainEqual([
        "Stop-WslDistroForDockerIntegration",
        "Ubuntu-24.04",
      ]);
      expect(parsed.nativeCalls).toContainEqual([
        "Ensure-WslDockerCliConfigDirectory",
        "Ubuntu-24.04",
      ]);
      expect(parsed.statusMessages).toContain("WSL distro registered: Ubuntu-24.04");
      expect(parsed.statusMessages).toContain(
        "Ubuntu-24.04 first-run user is registered (UID 1000).",
      );
    },
  );

  itPowerShell(
    "requests reboot when Ubuntu install exits before distro registration",
    `
$ErrorActionPreference = 'Stop'
. ${JSON.stringify(BOOTSTRAP_WINDOWS)}

$script:startProcessCalls = @()
$script:statusMessages = @()
$script:requestReboot = $false
$script:outcome = 'success'
$script:statusPath = Join-Path $env:TEMP ('ubuntu-install-' + [guid]::NewGuid().ToString('N') + '.status')
$script:logPath = Join-Path $env:TEMP ('ubuntu-install-' + [guid]::NewGuid().ToString('N') + '.log')

function Resolve-WslExe { return 'wsl.exe' }
function Get-WslDistros { return @() }
function Start-WslInstallInPowerShellWindow {
  param([string]$Name)
  Set-Content -LiteralPath $script:statusPath -Value '0'
  $log = @'
**********************
Windows PowerShell transcript start
Username: EXAMPLE\\bootstrap-user
Benutzername: EXAMPLE\\bootstrap-user
Machine: TEST-HOST (Microsoft Windows NT 10.0.28000.0)
Computer: TEST-HOST (Microsoft Windows NT 10.0.28000.0)
Host Application: powershell.exe -Command $ErrorActionPreference = 'Continue'
$transcriptStarted = $false
try { Start-Transcript -Path $logPath -Force | Out-Null; $transcriptStarted = $true } catch { }
$statusPath = 'status-file'
& 'C:\\WINDOWS\\System32\\wsl.exe' --install -d 'Ubuntu-24.04'
try { [System.IO.File]::WriteAllText($statusPath, [string]$wslExitCode) } catch { }
Process ID: 1234
PSVersion: 5.1.28000.1830
**********************
'@
  $log += [Environment]::NewLine
  $log += ('Transcript started, output file is {0}{1}' -f $script:logPath, [Environment]::NewLine)
  $log += ('Status file is {0}{1}' -f $script:statusPath, [Environment]::NewLine)
  $log += @'
The requested operation is successful. Changes will not be effective until the system is rebooted.
Ubuntu installer command exited. This window will close automatically.
**********************
Windows PowerShell transcript end
End time: 20260628121936
**********************
'@
  Set-Content -LiteralPath $script:logPath -Value $log
  return [pscustomobject]@{ StatusPath = $script:statusPath; LogPath = $script:logPath; ProcessId = 1234 }
}
function Request-Reboot {
  $script:requestReboot = $true
  throw 'REBOOT_REQUESTED'
}
function Write-Status { param([string]$Message, [string]$Level = 'INFO') $script:statusMessages += ('{0}:{1}' -f $Level, $Message) }

try {
  Ensure-UbuntuWsl
} catch {
  $script:outcome = $_.Exception.Message
}

[pscustomobject]@{
  startProcessCalls = $script:startProcessCalls
  statusMessages = $script:statusMessages
  requestReboot = $script:requestReboot
  outcome = $script:outcome
} | ConvertTo-Json -Compress
`,
    (result) => {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const parsed = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}");
      expect(result.stdout).toContain("WSL install output:");
      expect(result.stdout).toContain(
        "The requested operation is successful. Changes will not be effective until the system is rebooted.",
      );
      expect(result.stdout).toContain(
        "Ubuntu installer command exited. This window will close automatically.",
      );
      expect(result.stdout).toContain("[PowerShell transcript metadata redacted.]");
      expect(result.stdout).not.toContain("Windows PowerShell transcript");
      expect(result.stdout).not.toContain("Username:");
      expect(result.stdout).not.toContain("Machine:");
      expect(result.stdout).not.toContain("Host Application:");
      expect(result.stdout).not.toContain("PSVersion:");
      expect(result.stdout).not.toContain("Benutzername:");
      expect(result.stdout).not.toContain("Computer:");
      expect(result.stdout).not.toContain("EXAMPLE\\bootstrap-user");
      expect(result.stdout).not.toContain("TEST-HOST");
      expect(result.stdout).not.toContain("$statusPath = 'status-file'");
      expect(result.stdout).not.toContain("$transcriptStarted = $false");
      expect(result.stdout).not.toContain("Start-Transcript");
      expect(result.stdout).not.toContain("WriteAllText");
      expect(result.stdout).not.toContain(
        "& 'C:\\WINDOWS\\System32\\wsl.exe' --install -d 'Ubuntu-24.04'",
      );
      expect(result.stdout).not.toContain("Transcript started, output file is");
      expect(result.stdout).not.toContain("Status file is");
      expect(result.stdout).not.toContain("End time:");
      expect(parsed.statusMessages).toContain(
        "WARN:Ubuntu-24.04 install command completed, but the distro is not registered yet.",
      );
      expect(parsed.statusMessages).toContain(
        "WARN:A reboot is required before WSL can finish registering the distro.",
      );
      expect(parsed.requestReboot).toBe(true);
      expect(parsed.outcome).toContain("REBOOT_REQUESTED");
    },
  );

  itPowerShell(
    "fails closed when a PowerShell transcript header is incomplete",
    `
$ErrorActionPreference = 'Stop'
. ${JSON.stringify(BOOTSTRAP_WINDOWS)}

$log = @'
**********************
Windows PowerShell transcript start
Username: EXAMPLE\\bootstrap-user
Machine: TEST-HOST
'@

Convert-WslInstallLogForDisplay -Log $log
`,
    (result) => {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim()).toBe("[PowerShell transcript metadata redacted.]");
      expect(result.stdout).not.toContain("EXAMPLE\\bootstrap-user");
      expect(result.stdout).not.toContain("TEST-HOST");
    },
  );

  itPowerShell(
    "redacts transcript markers when separators are missing",
    `
$ErrorActionPreference = 'Stop'
. ${JSON.stringify(BOOTSTRAP_WINDOWS)}

$log = @'
Windows PowerShell transcript start
Username: EXAMPLE\\bootstrap-user
Machine: TEST-HOST
Host Application: powershell.exe -Command Get-Date
Log file: C:\\Users\\example\\install.log
'@

Convert-WslInstallLogForDisplay -Log $log
`,
    (result) => {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim()).toBe("[PowerShell transcript metadata redacted.]");
      expect(result.stdout).not.toContain("EXAMPLE\\bootstrap-user");
      expect(result.stdout).not.toContain("TEST-HOST");
      expect(result.stdout).not.toContain("C:\\Users\\example\\install.log");
    },
  );

  itPowerShell(
    "recognizes transcript separators with a BOM and indentation",
    `
$ErrorActionPreference = 'Stop'
. ${JSON.stringify(BOOTSTRAP_WINDOWS)}

$separator = ([char]0xFEFF) + '  **********************'
$log = @(
  $separator,
  'Windows PowerShell transcript start',
  'Username: EXAMPLE\\bootstrap-user',
  'Machine: TEST-HOST',
  '  **********************',
  'Useful WSL output',
  '  **********************',
  'Windows PowerShell transcript end',
  '  **********************'
) -join [Environment]::NewLine

Convert-WslInstallLogForDisplay -Log $log
`,
    (result) => {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("[PowerShell transcript metadata redacted.]");
      expect(result.stdout).toContain("Useful WSL output");
      expect(result.stdout).not.toContain("EXAMPLE\\bootstrap-user");
      expect(result.stdout).not.toContain("TEST-HOST");
      expect(result.stdout).not.toContain("Windows PowerShell transcript");
    },
  );

  itPowerShell(
    "preserves plain WSL output without transcript evidence",
    `
$ErrorActionPreference = 'Stop'
. ${JSON.stringify(BOOTSTRAP_WINDOWS)}

Convert-WslInstallLogForDisplay -Log 'Invalid distribution name: NotARealDistro'
`,
    (result) => {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim()).toBe("Invalid distribution name: NotARealDistro");
    },
  );

  itPowerShell(
    "does not request reboot when Ubuntu install exits without registering the distro",
    `
$ErrorActionPreference = 'Stop'
. ${JSON.stringify(BOOTSTRAP_WINDOWS)}

$script:statusMessages = @()
$script:requestReboot = $false
$script:outcome = 'success'
$script:statusPath = Join-Path $env:TEMP ('ubuntu-install-' + [guid]::NewGuid().ToString('N') + '.status')
$script:logPath = Join-Path $env:TEMP ('ubuntu-install-' + [guid]::NewGuid().ToString('N') + '.log')

function Resolve-WslExe { return 'wsl.exe' }
function Get-WslDistros { return @() }
function Start-WslInstallInPowerShellWindow {
  param([string]$Name)
  Set-Content -LiteralPath $script:statusPath -Value '0'
  Set-Content -LiteralPath $script:logPath -Value @'
The operation completed successfully.
Ubuntu installer command exited. This window will close automatically.
'@
  return [pscustomobject]@{ StatusPath = $script:statusPath; LogPath = $script:logPath; ProcessId = 1234 }
}
function Request-Reboot {
  $script:requestReboot = $true
  throw 'UNEXPECTED_REBOOT'
}
function Write-Status { param([string]$Message, [string]$Level = 'INFO') $script:statusMessages += ('{0}:{1}' -f $Level, $Message) }

try {
  Ensure-UbuntuWsl
} catch {
  $script:outcome = $_.Exception.Message
}

[pscustomobject]@{
  statusMessages = $script:statusMessages
  requestReboot = $script:requestReboot
  outcome = $script:outcome
  statusPathExists = Test-Path -LiteralPath $script:statusPath
  logPathExists = Test-Path -LiteralPath $script:logPath
} | ConvertTo-Json -Compress
`,
    (result) => {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("WSL install output:");
      expect(result.stdout).toContain("The operation completed successfully.");
      expect(result.stdout).toContain("Please run: wsl --install -d Ubuntu-24.04");
      const parsed = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}");
      expect(parsed.statusMessages).toContain(
        "WARN:Ubuntu-24.04 install command completed, but the distro is not registered yet.",
      );
      expect(parsed.statusMessages).toContain(
        "WARN:The install output did not report that a reboot is required.",
      );
      expect(parsed.statusMessages).not.toContain(
        "WARN:A reboot is required before WSL can finish registering the distro.",
      );
      expect(parsed.requestReboot).toBe(false);
      expect(parsed.outcome).toContain(
        "WSL distro 'Ubuntu-24.04' is still not registered after install.",
      );
      expect(parsed.statusPathExists).toBe(false);
      expect(parsed.logPathExists).toBe(false);
    },
  );

  itPowerShell(
    "reports failed Ubuntu install output in the main window",
    `
$ErrorActionPreference = 'Stop'
. ${JSON.stringify(BOOTSTRAP_WINDOWS)}

$script:statusPath = Join-Path $env:TEMP ('ubuntu-install-' + [guid]::NewGuid().ToString('N') + '.status')
$script:logPath = Join-Path $env:TEMP ('ubuntu-install-' + [guid]::NewGuid().ToString('N') + '.log')
$script:outcome = 'success'

function Resolve-WslExe { return 'wsl.exe' }
function Get-WslDistros { return @() }
function Start-WslInstallInPowerShellWindow {
  param([string]$Name)
  Set-Content -LiteralPath $script:statusPath -Value '87'
  Set-Content -LiteralPath $script:logPath -Value 'Simulated WSL install failure'
  return [pscustomobject]@{ StatusPath = $script:statusPath; LogPath = $script:logPath; ProcessId = 1234 }
}

try {
  Ensure-UbuntuWsl
} catch {
  $script:outcome = $_.Exception.Message
}

[pscustomobject]@{
  outcome = $script:outcome
  statusPathExists = Test-Path -LiteralPath $script:statusPath
  logPathExists = Test-Path -LiteralPath $script:logPath
} | ConvertTo-Json -Compress
`,
    (result) => {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("WSL install output:");
      expect(result.stdout).toContain("Simulated WSL install failure");
      expect(result.stdout).toContain("NemoClaw on Windows ARM requires WSL2 Ubuntu 24.04.");
      const parsed = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}");
      expect(parsed.outcome).toContain("WSL distro install command failed with exit code 87");
      expect(parsed.statusPathExists).toBe(false);
      expect(parsed.logPathExists).toBe(false);
    },
  );

  itPowerShell(
    "verifies WSL startup even when Docker Desktop install is disabled",
    `
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
`,
    (result) => {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const parsed = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}");
      expect(parsed.nativeCalls).toContainEqual(["wsl.exe", "-d Ubuntu-24.04 -- echo WSL_OK"]);
      expect(parsed.statusMessages).toContain("Verified WSL distro 'Ubuntu-24.04' starts.");
      expect(parsed.statusMessages).toContain("Ubuntu-24.04 is ready.");
    },
  );

  itPowerShell(
    "fails an already registered distro that cannot start",
    `
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
`,
    (result) => {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const parsed = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}");
      expect(parsed.nativeCalls).toContainEqual(["wsl.exe", "-d Ubuntu-24.04 -- echo WSL_OK"]);
      expect(parsed.outcome).toContain(
        "WSL distro 'Ubuntu-24.04' is registered but could not start",
      );
      expect(parsed.statusMessages).not.toContain("Ubuntu-24.04 is ready.");
    },
  );

  itPowerShell(
    "prints the issue 3974 guidance when the deferred Ubuntu launch fails",
    `
$ErrorActionPreference = 'Stop'
. ${JSON.stringify(BOOTSTRAP_WINDOWS)}

function Resolve-WslExe { return 'wsl.exe' }
function Start-Process { throw 'launch failed' }
function Write-Status { param([string]$Message, [string]$Level = 'INFO') Write-Host $Message }

$script:InstallDistroAtHandoff = $true
try {
  Open-UbuntuForInstaller
  Write-Host 'UNEXPECTED_SUCCESS'
  throw 'UNEXPECTED_SUCCESS'
} catch {
  Write-Host "CAUGHT: $($_.Exception.Message)"
}
`,
    (result) => {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("NemoClaw on Windows ARM requires WSL2 Ubuntu 24.04.");
      expect(result.stdout).toContain("Please run: wsl --install -d Ubuntu-24.04");
      expect(result.stdout).toContain("Then re-run this installer.");
      expect(result.stdout).toContain("CAUGHT: launch failed");
    },
  );

  itPowerShell(
    "opens the final Ubuntu handoff as one plain PowerShell-hosted WSL launch",
    `
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
`,
    (result) => {
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
    },
  );

  itPowerShell(
    "repairs Docker Desktop WSL integration settings for the target distro",
    `
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
`,
    (result) => {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const parsed = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}");
      expect(parsed.wslEngineEnabled).toBe(true);
      expect(parsed.enableIntegrationWithDefaultWslDistro).toBe(false);
      expect(parsed.integratedWslDistros).toContain("Debian");
      expect(parsed.integratedWslDistros).toContain("Ubuntu-24.04");
      expect(parsed.backupCount).toBe(1);
    },
  );

  itPowerShell(
    "creates Docker Desktop WSL integration settings when the settings file is missing",
    `
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
`,
    (result) => {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const parsed = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}");
      expect(parsed.settingsExists).toBe(true);
      expect(parsed.wslEngineEnabled).toBe(true);
      expect(parsed.enableIntegrationWithDefaultWslDistro).toBe(false);
      expect(parsed.integratedWslDistros).toContain("Ubuntu-24.04");
      expect(parsed.backupCount).toBe(0);
    },
  );
});
