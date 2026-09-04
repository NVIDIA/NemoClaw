// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { testTimeout, testTimeoutOptions } from "../../helpers/timeouts";
import {
  POWERSHELL_BATCH_EXEC_TIMEOUT_MS,
  type PowerShellBatchCase,
  type PowerShellHarnessResult,
  requirePowerShellBatchResult,
  resolvePowerShell,
  runPowerShellBatch,
} from "../../support/bootstrap-windows-test-helpers";

const WSL_CI_HELPER = path.join(import.meta.dirname, "../../..", "tools", "wsl", "ci-helper.ps1");
const POWERSHELL = resolvePowerShell();
const CASES: PowerShellBatchCase[] = [];
let results: ReadonlyMap<string, PowerShellHarnessResult> = new Map();
const CASE_TIMEOUT = testTimeoutOptions(30_000);
const BATCH_TIMEOUT = testTimeout(Math.max(65_000, POWERSHELL_BATCH_EXEC_TIMEOUT_MS + 5_000));

function itPowerShell(
  name: string,
  script: string,
  assertions: (result: PowerShellHarnessResult) => void,
): void {
  CASES.push({ id: name, script });
  (POWERSHELL ? it : it.skip)(name, CASE_TIMEOUT, () =>
    assertions(requirePowerShellBatchResult(results, name)),
  );
}

describe("trusted WSL CI helper", () => {
  beforeAll(
    POWERSHELL
      ? () => {
          results = runPowerShellBatch(POWERSHELL, CASES);
        }
      : () => undefined,
    BATCH_TIMEOUT,
  );

  itPowerShell(
    "converts drive paths with spaces and quotes without changing their data",
    `
. ${JSON.stringify(WSL_CI_HELPER)}
[pscustomobject]@{
  path = ConvertTo-WslPath -WindowsPath "D:\\agent work\\repo's"
  literal = ConvertTo-BashLiteral -Value "D:/agent work/repo's"
} | ConvertTo-Json -Compress
`,
    (result) => {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout.trim())).toEqual({
        path: "/mnt/d/agent work/repo's",
        literal: "'D:/agent work/repo'\"'\"'s'",
      });
    },
  );

  itPowerShell(
    "keeps script paths and arguments as separate WSL command values",
    `
. ${JSON.stringify(WSL_CI_HELPER)}
New-WslScriptArguments -Distro 'Ubuntu Test' -User 'ci user' -ScriptPath '/mnt/c/runner temp/step.sh' -ScriptArguments @("argument with spaces", "quote's") |
  ConvertTo-Json -Compress
`,
    (result) => {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout.trim())).toEqual([
        "-d",
        "Ubuntu Test",
        "--user",
        "ci user",
        "--",
        "bash",
        "-l",
        "/mnt/c/runner temp/step.sh",
        "argument with spaces",
        "quote's",
      ]);
    },
  );

  itPowerShell(
    "builds the ext4 sync script with quoted paths and explicit ownership",
    `
. ${JSON.stringify(WSL_CI_HELPER)}
Get-WslCheckoutSyncScript -Checkout "/mnt/d/agent work/repo's" -Workdir "/tmp/nemoclaw-wsl-workdir/123-1" -Owner nemoclaw-ci
`,
    (result) => {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("if [ ! -d '/mnt/d/agent work/repo'\"'\"'s/.git' ]; then");
      expect(result.stdout).toContain("rsync -a --no-owner --no-group --delete");
      expect(result.stdout).toContain(
        "git config --global --add safe.directory '/tmp/nemoclaw-wsl-workdir/123-1'",
      );
      expect(result.stdout).toContain("if [ -L '/tmp/nemoclaw-wsl-workdir' ]; then");
      expect(result.stdout).toContain("git -C '/tmp/nemoclaw-wsl-workdir/123-1' reset --hard HEAD");
      expect(result.stdout).toContain("git -C '/tmp/nemoclaw-wsl-workdir/123-1' clean -ffdx");
      expect(result.stdout).toContain(
        "chown -R 'nemoclaw-ci:nemoclaw-ci' '/tmp/nemoclaw-wsl-workdir/123-1'",
      );
    },
  );

  itPowerShell(
    "accepts <positive-run-id>-<positive-run-attempt> paths under both dedicated WSL roots (#6958)",
    `
. ${JSON.stringify(WSL_CI_HELPER)}
$workdirs = @(
  '/tmp/nemoclaw-wsl-workdir/123-1',
  '/tmp/nemoclaw-wsl-vitest/123-1'
)
@(
  foreach ($workdir in $workdirs) {
    $null = Get-WslCheckoutSyncScript -Checkout '/mnt/d/agent/repo' -Workdir $workdir
    $workdir
  }
) | ConvertTo-Json -Compress
`,
    (result) => {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout.trim())).toEqual([
        "/tmp/nemoclaw-wsl-workdir/123-1",
        "/tmp/nemoclaw-wsl-vitest/123-1",
      ]);
    },
  );

  itPowerShell(
    "rejects workdirs that do not match the dedicated run path contract (#6958)",
    `
. ${JSON.stringify(WSL_CI_HELPER)}
$unsafeWorkdirs = @(
  '/',
  '/mnt/d/agent',
  '/mnt/d/agent/repo/',
  '/tmp/nemoclaw-wsl-workdir/../shared',
  '/tmp/nemoclaw-wsl-workdir/not-a-run',
  '/etc',
  '/tmp/nemoclaw-other/run',
  'relative/workdir',
  '   '
)
$messages = foreach ($workdir in $unsafeWorkdirs) {
  try {
    Get-WslCheckoutSyncScript -Checkout '/mnt/d/agent/repo' -Workdir $workdir
    'unexpected success'
  } catch {
    $_.Exception.Message
  }
}
$messages | ConvertTo-Json -Compress
`,
    (result) => {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const unsafeWorkdirs = [
        "/",
        "/mnt/d/agent",
        "/mnt/d/agent/repo/",
        "/tmp/nemoclaw-wsl-workdir/../shared",
        "/tmp/nemoclaw-wsl-workdir/not-a-run",
        "/etc",
        "/tmp/nemoclaw-other/run",
        "relative/workdir",
        "   ",
      ];
      const message =
        "WSL sync workdir must use /tmp/nemoclaw-wsl-workdir or /tmp/nemoclaw-wsl-vitest with one <positive-run-id>-<positive-run-attempt> child. It must not overlap the checkout or contain traversal";
      expect(JSON.parse(result.stdout.trim())).toEqual(
        unsafeWorkdirs.map((workdir) => `${message}: '${workdir}'.`),
      );
    },
  );

  itPowerShell(
    "rejects a checkout that contains the generated WSL workdir (#6958)",
    `
. ${JSON.stringify(WSL_CI_HELPER)}
try {
  Get-WslCheckoutSyncScript -Checkout '/tmp/nemoclaw-wsl-workdir' -Workdir '/tmp/nemoclaw-wsl-workdir/123-1'
  'unexpected success'
} catch {
  $_.Exception.Message
}
`,
    (result) => {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim()).toBe(
        "WSL sync workdir must use /tmp/nemoclaw-wsl-workdir or /tmp/nemoclaw-wsl-vitest with one <positive-run-id>-<positive-run-attempt> child. It must not overlap the checkout or contain traversal: '/tmp/nemoclaw-wsl-workdir/123-1'.",
      );
    },
  );

  itPowerShell(
    "omits the optional test-user argument instead of forwarding an empty value",
    `
. ${JSON.stringify(WSL_CI_HELPER)}
$script:calls = @()
function Invoke-WslScript {
  param(
    [string]$Distro,
    [string]$User,
    [string]$Script,
    [string[]]$ScriptArguments = @()
  )
  $script:calls += [pscustomobject]@{
    hasScriptArguments = $PSBoundParameters.ContainsKey('ScriptArguments')
    scriptArguments = @($ScriptArguments)
  }
}
Install-WslUbuntuDependencies -Distro Ubuntu -Packages @('curl')
Install-WslUbuntuDependencies -Distro Ubuntu -Packages @('curl') -TestUser nemoclaw-ci
$script:calls | ConvertTo-Json -Compress
`,
    (result) => {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout.trim())).toEqual([
        {
          hasScriptArguments: false,
          scriptArguments: [],
        },
        {
          hasScriptArguments: true,
          scriptArguments: ["nemoclaw-ci"],
        },
      ]);
    },
  );

  itPowerShell(
    "writes transferred scripts as LF-only UTF-8 without a byte-order mark",
    `
. ${JSON.stringify(WSL_CI_HELPER)}
$target = Join-Path ([IO.Path]::GetTempPath()) ('wsl-helper-' + [guid]::NewGuid() + '.sh')
try {
  Write-WslScriptFile -Path $target -Content "first\`r\`nsecond\`rthird\`n"
  $bytes = [IO.File]::ReadAllBytes($target)
  [pscustomobject]@{
    base64 = [Convert]::ToBase64String($bytes)
    hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
    hasCarriageReturn = $bytes -contains 13
  } | ConvertTo-Json -Compress
} finally {
  Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue
}
`,
    (result) => {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const parsed = JSON.parse(result.stdout.trim()) as {
        base64: string;
        hasBom: boolean;
        hasCarriageReturn: boolean;
      };
      expect(Buffer.from(parsed.base64, "base64").toString("utf8")).toBe("first\nsecond\nthird\n");
      expect(parsed.hasBom).toBe(false);
      expect(parsed.hasCarriageReturn).toBe(false);
    },
  );

  itPowerShell(
    "retries a partial distro install and unregisters it before the next attempt",
    `
. ${JSON.stringify(WSL_CI_HELPER)}
$script:calls = @()
$script:probe = 0
$script:install = 0
function Invoke-WslNative {
  param([string[]]$ArgumentList, [switch]$MergeError)
  $text = $ArgumentList -join ' '
  $script:calls += $text
  if ($text -eq '--list --verbose') { return 0 }
  if ($text -eq '-d Ubuntu -- echo ok') {
    $script:probe += 1
    return 1
  }
  if ($text -eq '--install -d Ubuntu --no-launch --web-download') {
    $script:install += 1
    return $(if ($script:install -eq 1) { 1 } else { 0 })
  }
  if ($text -eq '--unregister Ubuntu') { return 0 }
  if ($text -eq '-d Ubuntu -- bash -c echo distro initialised') { return 0 }
  if ($text -eq '--set-default Ubuntu') { return 0 }
  throw "Unexpected WSL command: $text"
}
function Start-Sleep { param([int]$Seconds) $script:calls += "sleep $Seconds" }

Ensure-WslDistro -Distro Ubuntu
$script:calls | ConvertTo-Json -Compress
`,
    (result) => {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "[]")).toEqual([
        "--list --verbose",
        "-d Ubuntu -- echo ok",
        "--install -d Ubuntu --no-launch --web-download",
        "-d Ubuntu -- echo ok",
        "--unregister Ubuntu",
        "sleep 20",
        "--install -d Ubuntu --no-launch --web-download",
        "-d Ubuntu -- bash -c echo distro initialised",
        "--set-default Ubuntu",
      ]);
    },
  );

  itPowerShell(
    "deletes the transferred script after successful execution",
    `
. ${JSON.stringify(WSL_CI_HELPER)}
$env:RUNNER_TEMP = [IO.Path]::GetTempPath()
$script:removed = @()
function Write-WslScriptFile { param([string]$Path, [string]$Content) }
function ConvertTo-WslPath { param([string]$WindowsPath) return '/mnt/c/runner temp/nemoclaw-wsl-step.sh' }
function Invoke-WslNative { param([string[]]$ArgumentList, [switch]$MergeError) return 0 }
function Remove-Item {
  param([string]$LiteralPath, [switch]$Force, [object]$ErrorAction)
  $script:removed += $LiteralPath
}
Invoke-WslScript -Distro Ubuntu -User root -Script 'exit 0'
[pscustomobject]@{ removed = @($script:removed) } | ConvertTo-Json -Compress
`,
    (result) => {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const parsed = JSON.parse(result.stdout.trim()) as { removed: string[] };
      expect(parsed.removed).toHaveLength(1);
      expect(parsed.removed[0].replaceAll("\\", "/")).toMatch(/\/nemoclaw-wsl-step\.sh$/u);
    },
  );

  itPowerShell(
    "propagates a nonzero WSL script exit code",
    `
. ${JSON.stringify(WSL_CI_HELPER)}
$env:RUNNER_TEMP = [IO.Path]::GetTempPath()
function Write-WslScriptFile { param([string]$Path, [string]$Content) }
function ConvertTo-WslPath { param([string]$WindowsPath) return '/mnt/c/runner temp/nemoclaw-wsl-step.sh' }
function Invoke-WslNative { param([string[]]$ArgumentList, [switch]$MergeError) return 23 }
Invoke-WslScript -Distro Ubuntu -User root -Script 'exit 23'
`,
    (result) => {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("WSL script exited with code 23");
    },
  );

  itPowerShell(
    "deletes the transferred script after failed execution",
    `
. ${JSON.stringify(WSL_CI_HELPER)}
$env:RUNNER_TEMP = [IO.Path]::GetTempPath()
$script:removed = @()
function Write-WslScriptFile { param([string]$Path, [string]$Content) }
function ConvertTo-WslPath { param([string]$WindowsPath) return '/mnt/c/runner temp/nemoclaw-wsl-step.sh' }
function Invoke-WslNative { param([string[]]$ArgumentList, [switch]$MergeError) return 23 }
function Remove-Item {
  param([string]$LiteralPath, [switch]$Force, [object]$ErrorAction)
  $script:removed += $LiteralPath
}
try {
  Invoke-WslScript -Distro Ubuntu -User root -Script 'exit 23'
} catch {
  $script:errorMessage = [string]$_
}
[pscustomobject]@{
  removed = @($script:removed)
  errorMessage = $script:errorMessage
} | ConvertTo-Json -Compress
`,
    (result) => {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const parsed = JSON.parse(result.stdout.trim()) as {
        removed: string[];
        errorMessage: string;
      };
      expect(parsed.errorMessage).toContain("WSL script exited with code 23");
      expect(parsed.removed).toHaveLength(1);
      expect(parsed.removed[0].replaceAll("\\", "/")).toMatch(/\/nemoclaw-wsl-step\.sh$/u);
    },
  );
});
