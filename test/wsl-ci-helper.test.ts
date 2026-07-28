// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { testTimeout, testTimeoutOptions } from "./helpers/timeouts";
import {
  POWERSHELL_BATCH_EXEC_TIMEOUT_MS,
  type PowerShellBatchCase,
  type PowerShellHarnessResult,
  requirePowerShellBatchResult,
  resolvePowerShell,
  runPowerShellBatch,
} from "./support/bootstrap-windows-test-helpers";

const WSL_CI_HELPER = path.join(import.meta.dirname, "..", "tools", "wsl", "ci-helper.ps1");
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
Get-WslCheckoutSyncScript -Checkout "/mnt/d/agent work/repo's" -Workdir "/tmp/nemoclaw work/run's" -Owner nemoclaw-ci
`,
    (result) => {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("if [ ! -d '/mnt/d/agent work/repo'\"'\"'s/.git' ]; then");
      expect(result.stdout).toContain("rsync -a --no-owner --no-group --delete");
      expect(result.stdout).toContain(
        "git config --global --add safe.directory '/tmp/nemoclaw work/run'\"'\"'s'",
      );
      expect(result.stdout).toContain("git -C '/tmp/nemoclaw work/run'\"'\"'s' reset --hard HEAD");
      expect(result.stdout).toContain("git -C '/tmp/nemoclaw work/run'\"'\"'s' clean -ffdx");
      expect(result.stdout).toContain(
        "chown -R 'nemoclaw-ci:nemoclaw-ci' '/tmp/nemoclaw work/run'\"'\"'s'",
      );
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
} finally {
  [pscustomobject]@{ removed = @($script:removed) } | ConvertTo-Json -Compress
}
`,
    (result) => {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("WSL script exited with code 23");
      const parsed = JSON.parse(result.stdout.trim()) as { removed: string[] };
      expect(parsed.removed).toHaveLength(1);
      expect(parsed.removed[0].replaceAll("\\", "/")).toMatch(/\/nemoclaw-wsl-step\.sh$/u);
    },
  );
});
