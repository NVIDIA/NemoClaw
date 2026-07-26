// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { execTimeout } from "../helpers/timeouts";

export const BOOTSTRAP_WINDOWS = path.join(
  import.meta.dirname,
  "..",
  "..",
  "scripts",
  "bootstrap-windows.ps1",
);
export const POWERSHELL_PROCESS_EXEC_TIMEOUT_MS = execTimeout(20_000);
export const POWERSHELL_BATCH_EXEC_TIMEOUT_MS = execTimeout(60_000);

const BATCH_RESULT_PREFIX = "NEMOCLAW_POWERSHELL_BATCH_RESULT=";
const POWERSHELL_BATCH_RUNNER = String.raw`
param(
    [Parameter(Mandatory = $true)]
    [string]$ManifestPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$resultPrefix = 'NEMOCLAW_POWERSHELL_BATCH_RESULT='

function Get-ProcessEnvironmentSnapshot {
    $snapshot = @{}
    foreach ($entry in [Environment]::GetEnvironmentVariables('Process').GetEnumerator()) {
        $snapshot[[string]$entry.Key] = [string]$entry.Value
    }
    return $snapshot
}

function Restore-ProcessEnvironment {
    param([Parameter(Mandatory = $true)] [hashtable]$Snapshot)

    $current = [Environment]::GetEnvironmentVariables('Process')
    foreach ($name in @($current.Keys)) {
        if (-not $Snapshot.ContainsKey([string]$name)) {
            [Environment]::SetEnvironmentVariable([string]$name, $null, 'Process')
        }
    }
    foreach ($entry in $Snapshot.GetEnumerator()) {
        [Environment]::SetEnvironmentVariable(
            [string]$entry.Key,
            [string]$entry.Value,
            'Process'
        )
    }
}

function Convert-CaseOutput {
    param([AllowEmptyCollection()] [object[]]$Items)

    $lines = @(
        foreach ($item in @($Items)) {
            if ($item -is [System.Management.Automation.InformationRecord]) {
                [string]$item.MessageData
            } elseif ($item -is [System.Management.Automation.WarningRecord]) {
                [string]$item.Message
            } elseif ($item -is [System.Management.Automation.VerboseRecord]) {
                [string]$item.Message
            } elseif ($item -is [System.Management.Automation.DebugRecord]) {
                [string]$item.Message
            } else {
                [string]$item
            }
        }
    )
    return ($lines -join [Environment]::NewLine)
}

$manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$records = @(
    foreach ($case in @($manifest.cases)) {
        $environmentSnapshot = Get-ProcessEnvironmentSnapshot
        $locationSnapshot = Get-Location
        $lastExitCodeVariable = Get-Variable -Name LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue
        $stopwatch = [Diagnostics.Stopwatch]::StartNew()
        $status = 0
        $stdout = ''
        $stderr = ''

        try {
            $global:LASTEXITCODE = 0
            $caseScript = [ScriptBlock]::Create([string]$case.script)
            $mergedOutput = @(
                New-Module -ScriptBlock $caseScript -ReturnResult -Function @() 2>&1 3>&1 4>&1 5>&1 6>&1
            )
            $output = @(
                $mergedOutput | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }
            )
            $errors = @(
                $mergedOutput | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] }
            )
            $stdout = Convert-CaseOutput -Items $output
            $stderr = Convert-CaseOutput -Items $errors
        } catch {
            $status = 1
            $stderr = [string]$_
        } finally {
            $stopwatch.Stop()
            Restore-ProcessEnvironment -Snapshot $environmentSnapshot
            Set-Location -LiteralPath $locationSnapshot.Path
            if ($null -eq $lastExitCodeVariable) {
                Remove-Variable -Name LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue
            } else {
                Set-Variable -Name LASTEXITCODE -Scope Global -Value $lastExitCodeVariable.Value
            }
        }

        [pscustomobject]@{
            id = [string]$case.id
            status = $status
            stdout = $stdout
            stderr = $stderr
            durationMs = $stopwatch.Elapsed.TotalMilliseconds
        }
    }
)

$json = [pscustomobject]@{
    version = 1
    cases = $records
} | ConvertTo-Json -Depth 5 -Compress
$payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
[Console]::Out.WriteLine($resultPrefix + $payload)
`;

export type PowerShellHarnessResult = {
  stdout: string;
  stderr: string;
  status: number;
  durationMs?: number;
};

export type PowerShellBatchCase = {
  id: string;
  script: string;
};

type PowerShellBatchPayload = {
  version: number;
  cases: Array<{
    id: string;
    status: number;
    stdout?: string | null;
    stderr?: string | null;
    durationMs?: number;
  }>;
};

function powerShellEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TEMP: process.env.TEMP ?? process.env.TMPDIR ?? os.tmpdir(),
    TMP: process.env.TMP ?? process.env.TMPDIR ?? os.tmpdir(),
    NEMOCLAW_BOOTSTRAP_WINDOWS_SOURCE_ONLY: "1",
    SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
  };
}

export function resolvePowerShell(): string | null {
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

export function runPowerShellProcess(powerShell: string, script: string): PowerShellHarnessResult {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bootstrap-windows-"));
  const harness = path.join(tmp, "harness.ps1");
  try {
    fs.writeFileSync(harness, script);
    const result = spawnSync(
      powerShell,
      ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", harness],
      {
        encoding: "utf8",
        timeout: POWERSHELL_PROCESS_EXEC_TIMEOUT_MS,
        env: powerShellEnvironment(),
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

function decodeBatchPayload(result: PowerShellHarnessResult): PowerShellBatchPayload {
  const marker = result.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith(BATCH_RESULT_PREFIX))
    .at(-1);
  if (!marker) {
    throw new Error(
      `PowerShell batch emitted no result marker (status ${result.status}).\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  const encoded = marker.slice(BATCH_RESULT_PREFIX.length);
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as PowerShellBatchPayload;
}

function validateBatchPayload(
  payload: PowerShellBatchPayload,
  cases: readonly PowerShellBatchCase[],
): void {
  if (payload.version !== 1) {
    throw new Error(`Unsupported PowerShell batch result version: ${payload.version}`);
  }
  const expectedIds = new Set(cases.map(({ id }) => id));
  const actualIds = new Set(payload.cases.map(({ id }) => id));
  if (expectedIds.size !== cases.length) {
    throw new Error("PowerShell batch case IDs must be unique");
  }
  if (actualIds.size !== payload.cases.length) {
    throw new Error("PowerShell batch result IDs must be unique");
  }
  const missing = [...expectedIds].filter((id) => !actualIds.has(id));
  const unexpected = [...actualIds].filter((id) => !expectedIds.has(id));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `PowerShell batch result mismatch (missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"})`,
    );
  }
}

export function runPowerShellBatch(
  powerShell: string,
  cases: readonly PowerShellBatchCase[],
): Map<string, PowerShellHarnessResult> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bootstrap-windows-batch-"));
  const runner = path.join(tmp, "batch-runner.ps1");
  const manifest = path.join(tmp, "cases.json");
  try {
    fs.writeFileSync(runner, POWERSHELL_BATCH_RUNNER);
    fs.writeFileSync(manifest, JSON.stringify({ cases }));
    const processResult = spawnSync(
      powerShell,
      [
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        runner,
        "-ManifestPath",
        manifest,
      ],
      {
        encoding: "utf8",
        timeout: POWERSHELL_BATCH_EXEC_TIMEOUT_MS,
        env: powerShellEnvironment(),
      },
    );
    const result = {
      stdout: processResult.stdout,
      stderr: processResult.stderr,
      status: processResult.status ?? 1,
    };
    if (result.status !== 0 || result.stderr.trim() !== "") {
      throw new Error(
        `PowerShell batch failed (status ${result.status}).\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
    }
    const payload = decodeBatchPayload(result);
    validateBatchPayload(payload, cases);
    return new Map(
      payload.cases.map((entry) => [
        entry.id,
        {
          status: entry.status,
          stdout: String(entry.stdout ?? ""),
          stderr: String(entry.stderr ?? ""),
          durationMs: entry.durationMs,
        },
      ]),
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function requirePowerShellBatchResult(
  results: ReadonlyMap<string, PowerShellHarnessResult>,
  id: string,
): PowerShellHarnessResult {
  const result = results.get(id);
  if (!result) throw new Error(`PowerShell batch returned no result for: ${id}`);
  return result;
}
