// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeAll, describe, expect, it } from "vitest";

import { testTimeout, testTimeoutOptions } from "../helpers/timeouts";
import {
  BOOTSTRAP_WINDOWS,
  POWERSHELL_BATCH_EXEC_TIMEOUT_MS,
  POWERSHELL_PROCESS_EXEC_TIMEOUT_MS,
  type PowerShellBatchCase,
  type PowerShellHarnessResult,
  requirePowerShellBatchResult,
  resolvePowerShell,
  runPowerShellBatch,
} from "../support/bootstrap-windows-test-helpers";

const POWERSHELL_TEST_TIMEOUT = testTimeoutOptions(
  Math.max(30_000, POWERSHELL_PROCESS_EXEC_TIMEOUT_MS + 5_000),
);
const POWERSHELL = resolvePowerShell();
const POWERSHELL_BATCH_CASES: PowerShellBatchCase[] = [];
let powerShellBatchResults: ReadonlyMap<string, PowerShellHarnessResult> = new Map();
const POWERSHELL_BATCH_TEST_TIMEOUT_MS = testTimeout(
  Math.max(65_000, POWERSHELL_BATCH_EXEC_TIMEOUT_MS + 5_000),
);
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

describe("Windows bootstrap Docker executable trust", () => {
  beforeAll(
    POWERSHELL
      ? () => {
          powerShellBatchResults = runPowerShellBatch(POWERSHELL, POWERSHELL_BATCH_CASES);
        }
      : () => undefined,
    POWERSHELL_BATCH_TEST_TIMEOUT_MS,
  );

  itPowerShell(
    "does not treat an untrusted Docker candidate as installed (#9114)",
    `
$ErrorActionPreference = 'Stop'
$env:LOCALAPPDATA = 'C:\\Users\\tester\\AppData\\Local'
. ${JSON.stringify(BOOTSTRAP_WINDOWS)}

$script:messages = @()
function Test-Path { param([string]$LiteralPath) return $true }
function Test-DockerDesktopExecutableTrusted { param([string]$Path) return $false }
function Write-Status { param([string]$Message, [string]$Level = 'INFO') $script:messages += "$Level|$Message" }

$trustedPath = Resolve-DockerDesktopPath -Component 'Desktop' -RequireTrusted
Write-DockerDesktopNotice

[pscustomobject]@{
    trustedPath = $trustedPath
    messages = $script:messages
} | ConvertTo-Json -Compress
`,
    (result) => {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const parsed = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}");
      expect(parsed.trustedPath).toBeNull();
      expect(
        (parsed.messages as string[]).some(
          (message) => message.startsWith("WARN|") && message.includes("was not detected"),
        ),
      ).toBe(true);
    },
  );

  itPowerShell(
    "refuses to launch a trusted per-user Docker Desktop executable with an elevated token (#9114)",
    `
$ErrorActionPreference = 'Stop'
$env:LOCALAPPDATA = 'C:\\Users\\tester\\AppData\\Local'
. ${JSON.stringify(BOOTSTRAP_WINDOWS)}

$userExe = 'C:\\Users\\tester\\AppData\\Local\\Programs\\DockerDesktop\\Docker Desktop.exe'
$script:messages = @()
$script:startCalls = @()

function Resolve-DockerDesktopPath { param([string]$Component, [switch]$RequireTrusted) return $userExe }
function Test-DockerDesktopExecutableTrusted { param([string]$Path) return $true }
function Test-IsAdministrator { return $true }
function Start-Process { param([string]$FilePath) $script:startCalls += $FilePath; return [pscustomobject]@{} }
function Write-Status { param([string]$Message, [string]$Level = 'INFO') $script:messages += "$Level|$Message" }

Start-DockerDesktop

[pscustomobject]@{
    messages = $script:messages
    startCalls = $script:startCalls
} | ConvertTo-Json -Compress
`,
    (result) => {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const parsed = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}");
      expect(parsed.startCalls).toEqual([]);
      expect(
        (parsed.messages as string[]).some(
          (message) => message.startsWith("ERROR|") && message.includes("current user"),
        ),
      ).toBe(true);
    },
  );

  itPowerShell(
    "launches a trusted per-user Docker Desktop executable without an elevated token (#9114)",
    `
$ErrorActionPreference = 'Stop'
$env:LOCALAPPDATA = 'C:\\Users\\tester\\AppData\\Local'
. ${JSON.stringify(BOOTSTRAP_WINDOWS)}

$userExe = 'C:\\Users\\tester\\AppData\\Local\\Programs\\DockerDesktop\\Docker Desktop.exe'
$userCli = 'C:\\Users\\tester\\AppData\\Local\\Programs\\DockerDesktop\\resources\\bin\\docker.exe'
$script:events = @()

function Resolve-DockerDesktopPath { param([string]$Component, [switch]$RequireTrusted) if ($Component -eq 'Desktop') { return $userExe } return $userCli }
function Test-DockerDesktopExecutableTrusted { param([string]$Path) return $true }
function Test-IsAdministrator { return $false }
function Test-DockerDesktopRunning { return $false }
function Wait-DockerDesktopEngine { param([int]$TimeoutSeconds) $script:events += 'wait-ready'; return $true }
function Minimize-DockerDesktopWindow { $script:events += 'minimize' }
function Set-InstallerWindowForeground { $script:events += 'foreground' }
function Start-Process { param([string]$FilePath) $script:events += "start-$FilePath"; return [pscustomobject]@{} }
function Write-Status { param([string]$Message, [string]$Level = 'INFO') }

$requiresUserProcess = Test-DockerDesktopUserOperationRequired
Start-DockerDesktop

[pscustomobject]@{
    requiresUserProcess = $requiresUserProcess
    events = $script:events
} | ConvertTo-Json -Compress
`,
    (result) => {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const parsed = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}");
      expect(parsed.requiresUserProcess).toBe(true);
      expect(parsed.events).toEqual([
        "start-C:\\Users\\tester\\AppData\\Local\\Programs\\DockerDesktop\\Docker Desktop.exe",
        "wait-ready",
        "minimize",
        "foreground",
      ]);
    },
  );

  itPowerShell(
    "skips an untrusted machine-wide candidate when a trusted per-user executable exists (#9114)",
    `
$ErrorActionPreference = 'Stop'
$env:LOCALAPPDATA = 'C:\\Users\\tester\\AppData\\Local'
. ${JSON.stringify(BOOTSTRAP_WINDOWS)}

$desktopCandidates = @(Get-DockerDesktopCandidatePath -Component 'Desktop')
$machineExe = $desktopCandidates[0]
$userExe = $desktopCandidates[1]
$script:startCalls = @()

function Test-Path { param([string]$LiteralPath) return $desktopCandidates -contains $LiteralPath }
function Test-DockerDesktopExecutableTrusted { param([string]$Path) return $Path -eq $userExe }
function Test-IsAdministrator { return $false }
function Test-DockerDesktopRunning { return $false }
function Wait-DockerDesktopEngine { param([int]$TimeoutSeconds) return $true }
function Minimize-DockerDesktopWindow {}
function Set-InstallerWindowForeground {}
function Start-Process { param([string]$FilePath) $script:startCalls += $FilePath; return [pscustomobject]@{} }
function Write-Status { param([string]$Message, [string]$Level = 'INFO') }

Start-DockerDesktop

[pscustomobject]@{
    machineExe = $machineExe
    userExe = $userExe
    startCalls = $script:startCalls
} | ConvertTo-Json -Compress
`,
    (result) => {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const parsed = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}");
      expect(parsed.startCalls).toEqual([parsed.userExe]);
      expect(parsed.startCalls).not.toContain(parsed.machineExe);
    },
  );
});
