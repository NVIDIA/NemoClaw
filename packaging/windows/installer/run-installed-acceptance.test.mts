// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test(
  "acceptance rejects unsupported scopes and credentials before installing",
  { skip: process.platform !== "win32" },
  () => {
    const source = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "run-installed-acceptance.ps1",
    );
    for (const [agent, scope, mode, secret, expected] of [
      ["pi", "full-acceptance", "current-build", "", "Pi supports startup-only"],
      ["pi", "startup-only", "built-0.1.3-replay", "", "Only OpenClaw"],
      ["hermes", "startup-only", "current-build", "", "Startup-only smoke supports"],
      ["openclaw", "startup-only", "built-0.1.3-replay", "", "Startup-only smoke supports"],
      [
        "pi",
        "startup-only",
        "current-build",
        "NVIDIA_API_KEY",
        "must not receive inference credentials",
      ],
      [
        "pi",
        "startup-only",
        "current-build",
        "NVIDIA_INFERENCE_API_KEY",
        "must not receive inference credentials",
      ],
      ["pi", "startup-only", "current-build", "", "requires explicit Windows CI identities"],
      [
        "openclaw",
        "full-acceptance",
        "current-build",
        "",
        "requires explicit Windows CI identities",
      ],
      ["hermes", "full-acceptance", "current-build", "", "requires explicit Windows CI identities"],
    ]) {
      const result = spawnSync(
        "pwsh.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `
      try {
        & $env:NEMOCLAW_ACCEPTANCE_SOURCE -SourceRoot . -WorkDirectory . -ProductVersion 0.1.9 -ArtifactSourceRevision invalid -Agent $env:TEST_AGENT -ValidationScope $env:TEST_SCOPE -Mode $env:TEST_MODE
        throw 'Unexpected acceptance success'
      } catch { Write-Output $_.Exception.Message; exit 0 }
    `,
        ],
        {
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(([name]) =>
                /^(SystemRoot|WINDIR|PATH|PATHEXT|TEMP|TMP|OS)$/iu.test(name),
              ),
            ),
            NEMOCLAW_ACCEPTANCE_SOURCE: source,
            TEST_AGENT: agent,
            TEST_SCOPE: scope,
            TEST_MODE: mode,
            ...(secret ? { [secret]: "synthetic-never-log-this-value" } : {}),
          },
          encoding: "utf8",
          windowsHide: true,
          timeout: 30_000,
        },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes(expected), result.stdout);
      assert.ok(!(result.stdout + result.stderr).includes("synthetic-never-log-this-value"));
    }
  },
);

test(
  "startup acceptance checks the smoke process and receipt without running live acceptance",
  { skip: process.platform !== "win32" },
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
$branch = @($owner[0].Body.Statements | Where-Object { $_ -is [Management.Automation.Language.IfStatementAst] })
$execute = [scriptblock]::Create($branch[0].Extent.Text)
$ValidationScope = 'startup-only'; $Agent = 'pi'; $SourceRoot = 'source-fixture'
$work = 'work-fixture'; $installation = 'install-fixture'; $ciNode = 'Invoke-TestSmoke'
function Invoke-TestSmoke {
  if ($args -contains '--browser-driver-root' -or $args -notcontains '--agent' -or $args -notcontains 'pi' -or
      $args -notcontains 'source-fixture\packaging\windows\installer\qualify-finished-package.mts') { throw 'Unexpected installed test route.' }
  $global:LASTEXITCODE = $testExit
}
function Get-Content {
  param($LiteralPath, [switch]$Raw)
  if ($LiteralPath -cne 'work-fixture\installed-smoke\finished-package-smoke.json') { throw 'Unexpected receipt path.' }
  return $testReceipt
}
$count = 0
foreach ($case in @('pass','exit','receipt-fail','wrong-agent','wrong-scope','full-claim','truncated','missing','string-false')) {
  $timings = @{}; $testExit = if ($case -ceq 'exit') { 1 } else { 0 }
  $receipt = @{ verdict='pass'; agent='pi'; validationScope='startup-only'; fullInstalledQualification=$false }
  switch ($case) {
    'receipt-fail' { $receipt.verdict = 'fail' }
    'wrong-agent' { $receipt.agent = 'openclaw' }
    'wrong-scope' { $receipt.validationScope = 'full-acceptance' }
    'full-claim' { $receipt.fullInstalledQualification = $true }
    'missing' { $receipt.Remove('fullInstalledQualification') }
    'string-false' { $receipt.fullInstalledQualification = 'False' }
  }
  $testReceipt = if ($case -ceq 'truncated') { '{' } else { $receipt | ConvertTo-Json -Compress }
  $failed = $false
  try { . $execute } catch { $failed = $true }
  if ($failed -ne ($case -cne 'pass')) { throw ('Unexpected startup result: ' + $case) }
  if ($timings.ContainsKey('startupSmoke') -ne ($case -ceq 'pass')) { throw 'Failed smoke acquired a success receipt.' }
  if ($case -ceq 'pass' -and $timings.startupSmoke.deterministicLocalModel -ne $true) { throw 'Missing mock-model scope.' }
  $count++
}
Write-Output $count
`;
    const result = spawnSync(
      "pwsh.exe",
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
    assert.equal(result.stdout.trim(), "9");
  },
);

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
