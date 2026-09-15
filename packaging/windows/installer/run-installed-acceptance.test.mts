// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

for (const shell of ["powershell.exe", "pwsh.exe"])
  test(
    `${shell} treats absent diagnostics as optional and preserves failures`,
    {
      skip: process.platform !== "win32",
    },
    () => {
      const source = path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "run-installed-acceptance.ps1",
      );
      const script = String.raw`
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($env:NEMOCLAW_ACCEPTANCE_SOURCE, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Acceptance source does not parse.' }
$owner = @($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.TryStatementAst] -and $null -ne $_.Finally })
if ($owner.Count -ne 1) { throw 'Expected one acceptance cleanup owner.' }
$root = 'Registry::HKEY_CURRENT_USER\Software\NemoClawAcceptanceTest-' + [guid]::NewGuid().ToString('N')
$productionPath = 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\NVIDIA\NemoClaw\InstallDiagnostics'
$body = $owner[0].Finally.Statements[0].Extent.Text
if (-not $body.Contains($productionPath)) { throw 'The diagnostic owner changed.' }
$collect = [scriptblock]::Create($body.Replace($productionPath, $root))
$results = [Collections.Generic.List[string]]::new()
function Check([string]$Name, [string]$Expected, [string]$Prior, [bool]$Denied = $false) {
  $timings = @{ nativeRuntimeFailure = $null }
  $primary = $null
  if ($Prior) { try { throw $Prior } catch { $primary = $_ } }
  if ($Denied) {
    function Get-ItemProperty { throw [UnauthorizedAccessException]::new('denied-test') }
    function Get-ItemPropertyValue { throw [UnauthorizedAccessException]::new('denied-test') }
  }
  . $collect
  $actual = if ($null -eq $primary) { '' } else { $primary.Exception.Message }
  $expectedError = if ($Prior) { $Prior } elseif ($Denied) { 'denied-test' } else { '' }
  if ($actual -cne $expectedError) { throw ('Unexpected primary failure: ' + $Name + ': ' + $actual) }
  $diagnostic = if ($null -eq $timings.nativeRuntimeFailure) { '' } else { $timings.nativeRuntimeFailure.retainedPrimary }
  if ($diagnostic -cne $Expected) { throw ('Unexpected diagnostic: ' + $Name) }
  $results.Add($Name)
}
try {
  Check 'missing key' '' ''
  New-Item -Path $root | Out-Null
  Check 'missing value' '' ''
  Check 'missing value preserves earlier failure' '' 'original-test'
  New-ItemProperty -LiteralPath $root -Name RuntimeMaintenancePrimary -Value 'retained-test' -PropertyType String | Out-Null
  Check 'retained value' 'retained-test' ''
  Check 'retained value preserves earlier failure' 'retained-test' 'original-test'
  Check 'access error remains failure' '' '' $true
  Check 'access error preserves earlier failure' '' 'original-test' $true
} finally {
  if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
  if (Test-Path -LiteralPath $root) { throw 'Owned registry fixture remains.' }
}
ConvertTo-Json -InputObject @($results) -Compress
`;
      const result = spawnSync(
        shell,
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        {
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(([name]) =>
                /^(SystemRoot|WINDIR|PATH|PATHEXT|TEMP|TMP)$/iu.test(name),
              ),
            ),
            NEMOCLAW_ACCEPTANCE_SOURCE: source,
          },
          encoding: "utf8",
          windowsHide: true,
          timeout: 30_000,
        },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const lastLine = result.stdout.trim().split(/\r?\n/u).at(-1)!;
      assert.equal(JSON.parse(lastLine).length, 7);
    },
  );
