// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const WINDOWS_POWERSHELL_ENVIRONMENT =
  /^(APPDATA|COMSPEC|HOMEDRIVE|HOMEPATH|LOCALAPPDATA|OS|PATH|PATHEXT|PROCESSOR_ARCHITECTURE|PROCESSOR_ARCHITEW6432|SystemRoot|TEMP|TMP|USERPROFILE|WINDIR)$/iu;

function powershellEnvironment(extra: NodeJS.ProcessEnv = {}) {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) => WINDOWS_POWERSHELL_ENVIRONMENT.test(name)),
    ),
    ...extra,
  };
}

test(
  "Burn fixture accepts MXC capability details but rejects ambiguous preparation decisions",
  { skip: process.platform !== "win32" },
  () => {
    const script = String.raw`
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($env:BURN_SOURCE, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Burn fixture source does not parse.' }
$owner = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Read-DiagnosticPreparationTier' }, $true)
if ($null -eq $owner) { throw 'Preparation decision owner missing.' }
. ([scriptblock]::Create($owner.Extent.Text))
foreach ($tier in @('base-container','appcontainer-dacl')) {
    $augment = $tier -ceq 'appcontainer-dacl'
    foreach ($extended in @($false,$true)) {
        $record = @{tier=$tier;needsDaclAugmentation=$augment}
        if ($extended) { $record.warnings=@();$record.probes=@{baseContainerApiPresent=(-not $augment);uiCapabilities=@{canBlockClipboardRead=$true}} }
        if ((Read-DiagnosticPreparationTier ($record|ConvertTo-Json -Depth 5)) -cne $tier) { throw 'Valid MXC capabilities rejected.' }
    }
}
$invalid = @(
    '{broken', '{}', '[]', (' ' * 8193),
    ('{"tier":"base-container","needsDaclAugmentation":false,"probes":' + ('[' * 9) + '0' + (']' * 9) + '}'),
    '{"tier":"base-container","needsDaclAugmentation":true}',
    '{"tier":"appcontainer-dacl","needsDaclAugmentation":false}',
    '{"tier":"base-container","needsDaclAugmentation":"false"}',
    '{"tier":"base-container","needsDaclAugmentation":null}',
    '{"tier":"base-container","needsDaclAugmentation":0}',
    '{"tier":"BASE-CONTAINER","needsDaclAugmentation":false}',
    '{"tier":"unknown","needsDaclAugmentation":false}',
    '{"tier":"base-container","tier":"appcontainer-dacl","needsDaclAugmentation":true}',
    '{"tier":"base-container","needsDaclAugmentation":true,"needsDaclAugmentation":false}',
    '{"tier":"base-container","needsDaclAugmentation":false,"warnings":[],"warnings":[]}'
)
foreach ($text in $invalid) {
    $rejected=$false
    try { $null=Read-DiagnosticPreparationTier $text } catch { $rejected=$true }
    if (-not $rejected) { throw 'Ambiguous or invalid MXC capabilities accepted.' }
}
Write-Output 'PREPARATION_SCHEMA_19_PASS'
`;
    const result = spawnSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: powershellEnvironment({
        BURN_SOURCE: fileURLToPath(new URL("test-burn-diagnostics.ps1", import.meta.url)),
      }),
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /PREPARATION_SCHEMA_19_PASS/u);
  },
);

test(
  "tester reset preserves primary failure and retains recovery for incomplete cleanup",
  {
    skip: process.platform !== "win32",
  },
  () => {
    const script = String.raw`
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($env:RESET_SOURCE, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Reset source does not parse.' }
$function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Invoke-NativeTesterResetQualification' }, $true)
$statements = @($function.Body.EndBlock.Statements)
$owner = @($statements | Where-Object { $_ -is [Management.Automation.Language.TryStatementAst] })[0]
$index = [array]::IndexOf($statements, $owner)
if ($statements[$index+1] -isnot [Management.Automation.Language.IfStatementAst] -or
    $statements[$index+2] -isnot [Management.Automation.Language.IfStatementAst]) { throw 'Reset outcome handling changed.' }
$body = 'try { if ($mainFailure) { throw "primary-fixture-failure" } } ' +
  ($owner.CatchClauses.Extent.Text -join ' ') + ' finally ' + $owner.Finally.Extent.Text +
  $statements[$index+1].Extent.Text + $statements[$index+2].Extent.Text
$execute = [scriptblock]::Create($body)
function Fail-PackageQualification($message) { throw $message }
function Invoke-NativeCredentialHelper {
  param($LauncherPath, $Arguments)
  $calls.Add($Arguments[0])
  switch ($Arguments[0]) {
    '--credential-read' {
      if ($testCase -ceq 'read-throws') { throw 'synthetic-sensitive-diagnostic' }
      return @{ exitCode = 0; stdout = $(if ($testCase -ceq 'identity-drift') { 'other-key' } else { $canary }) }
    }
    '--credential-delete' { return @{ exitCode = $(if ($testCase -cin @('key-fails','both-fail')) { 1 } else { 0 }) } }
    '--state-remove' { return @{ exitCode = $(if ($testCase -cin @('state-fails','both-fail')) { 1 } else { 0 }) } }
    default { throw 'Unexpected cleanup operation.' }
  }
}
$root = Join-Path ([IO.Path]::GetTempPath()) ('reset-cleanup-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root) | Out-Null
try {
  foreach ($mainFailure in @($false,$true)) {
    foreach ($testCase in @('pass','key-fails','state-fails','both-fail','read-throws','identity-drift','live','wait-throws')) {
      $helper = Join-Path $root 'helper.exe'; [IO.File]::WriteAllText($helper, 'inert-test-data')
      $helperHash = (Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash.ToLowerInvariant()
      $primary = $null; $cleanupErrors = [Collections.Generic.List[string]]::new()
      $calls = [Collections.Generic.List[string]]::new(); $ownsKey = $true; $ownsState = $true
      $binding = 'fixture-binding'; $canary = 'synthetic-private-key'; $window = $null
      $script:disposed = 0; $script:waits = 0; $script:OperationTimeoutMilliseconds = 1
      $process = [pscustomobject]@{ HasExited = $false }
      $process | Add-Member ScriptMethod WaitForExit {
        param($timeout)
        $script:waits++
        if ($testCase -ceq 'wait-throws') { throw 'query-failed' }
        return $testCase -cne 'live'
      }
      $process | Add-Member ScriptMethod Dispose { $script:disposed++ }
      $caught = $null
      try { . $execute -WarningAction SilentlyContinue } catch { $caught = $_ }
      $failedCleanup = $testCase -cne 'pass'
      if (($null -ne $caught) -ne ($mainFailure -or $failedCleanup)) { throw ('Wrong outcome: ' + $testCase) }
      if ($mainFailure -and $caught.Exception.Message -cne 'primary-fixture-failure') { throw 'Primary error replaced.' }
      if ($mainFailure -and $failedCleanup -and -not $caught.Exception.Data.Contains('NemoClawCleanupErrors')) { throw 'Secondary errors lost.' }
      if ($script:disposed -ne 1 -or $script:waits -ne 1) { throw 'Process was not observed and disposed.' }
      if ($testCase -cin @('live','wait-throws')) {
        if ($calls.Count -ne 0) { throw 'Cleanup overlapped a live or unconfirmed installer.' }
      } elseif ($calls -notcontains '--state-remove') { throw 'State cleanup was skipped after key failure.' }
      if ($testCase -cin @('identity-drift','read-throws') -and $calls -contains '--credential-delete') { throw 'Unowned key deleted.' }
      if ((Test-Path -LiteralPath $helper) -ne $failedCleanup) { throw 'Wrong recovery helper retention.' }
      if (($cleanupErrors -join ' ').Contains('synthetic-')) { throw 'Sensitive diagnostic leaked.' }
    }
  }
  Write-Output 'RESET_CLEANUP_16_PASS'
} finally { [IO.Directory]::Delete($root, $true) }
`;
    const result = spawnSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: powershellEnvironment({
        RESET_SOURCE: fileURLToPath(
          new URL(
            "../../../scripts/checks/qualify-windows-native-tester-reset.ps1",
            import.meta.url,
          ),
        ),
      }),
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /RESET_CLEANUP_16_PASS/u);
  },
);

test(
  "acceptance rejects unsupported scopes and credentials before installing",
  { skip: process.platform !== "win32" },
  () => {
    const source = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "run-installed-acceptance.ps1",
    );
    for (const [agent, scope, mode, secret, expected] of [
      ["pi", "full-acceptance", "current-build", "", "requires explicit Windows CI identities"],
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
          env: powershellEnvironment({
            NEMOCLAW_ACCEPTANCE_SOURCE: source,
            TEST_AGENT: agent,
            TEST_SCOPE: scope,
            TEST_MODE: mode,
            ...(secret ? { [secret]: "synthetic-never-log-this-value" } : {}),
          }),
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
        env: powershellEnvironment({
          NEMOCLAW_ACCEPTANCE_SOURCE: source,
        }),
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

for (const agent of ["pi", "hermes"])
  test(
    `${agent} installed acceptance runs cold and saved-configuration launches and rejects incomplete evidence`,
    { skip: process.platform !== "win32" },
    () => {
      const source = fileURLToPath(new URL("./run-installed-acceptance.ps1", import.meta.url));
      const script = String.raw`
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($env:NEMOCLAW_ACCEPTANCE_SOURCE, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Acceptance source does not parse.' }
$owner = @($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.TryStatementAst] -and $null -ne $_.Finally })
$branch = @($owner[0].Body.Statements | Where-Object { $_ -is [Management.Automation.Language.IfStatementAst] })
# Replace only the external process boundary; execute the actual case loop,
# argument routing and evidence checks without installing or contacting inference.
$execute = [scriptblock]::Create($branch[0].Extent.Text.Replace('& "$work\application\node\node.exe"', '& Invoke-TestAgent'))
$ValidationScope = 'full-acceptance'; $Agent = $env:TEST_AGENT; $SourceRoot = 'source-fixture'
$work = 'work-fixture'; $installation = 'install-fixture'
function Invoke-TestAgent {
  if ($args -notcontains "source-fixture\packaging\windows\installer\qualify-installed-$Agent.mts") { throw 'Wrong agent controller.' }
  $first = $calls.Count -eq 0
  if (($args -contains '--preserve-configuration') -ne $first -or ($args -contains '--reuse-configuration') -eq $first) { throw ('Incorrect cold/warm configuration routing: ' + ($args -join ',') + '; first=' + $first) }
  $previous = [array]::IndexOf($args, '--previous-acceptance')
  if (($previous -ge 0) -ne (-not $first)) { throw 'Incorrect cold-run receipt routing.' }
  if ($previous -ge 0 -and $args[$previous+1] -cne "work-fixture\installed-acceptance\installed-$Agent-acceptance.json") { throw 'Wrong cold-run receipt.' }
  $calls.Add(@($args))
  $global:LASTEXITCODE = if ($scenario -ceq 'process-failure') { 1 } else { 0 }
}
function Get-Content {
  param($LiteralPath, [switch]$Raw)
  $directory = if ($calls.Count -eq 1) { 'installed-acceptance' } else { 'installed-acceptance-warm' }
  if ($LiteralPath -cne "work-fixture\$directory\installed-$Agent-acceptance.json") { throw 'Wrong agent receipt.' }
  $receipt = @{ classification='installed-pi-terminal-acceptance'; verdict='pass'; cleanupErrors=@(); results=@{
    realTerminal=$true; realModelReply=$true; fileToolsQualified=$true; turns=@(@{},@{fileTools=$true}); configurationReused=($calls.Count -eq 2)
  } }
  switch ($scenario) {
    'failed-receipt' { $receipt.verdict='fail' }
    'cleanup-failure' { $receipt.cleanupErrors=@('retained process') }
    'no-terminal' { $receipt.results.realTerminal=$false }
    'no-model' { $receipt.results.realModelReply=$false }
    'one-turn' { $receipt.results.turns=@(@{}) }
    'no-tools' { $receipt.results.fileToolsQualified=$false }
    'no-tool-turn' { $receipt.results.turns[1].Remove('fileTools') }
    'string-tools' { $receipt.results.fileToolsQualified='true' }
    'wrong-controller' { $receipt.classification='startup-only' }
    'no-restart' { $receipt.results.configurationReused=$false }
  }
  return ($receipt | ConvertTo-Json -Depth 6)
}
$count=0
$scenarios=@('pass','process-failure','failed-receipt','cleanup-failure')
if ($Agent -ceq 'pi') { $scenarios+=@('no-terminal','no-model','one-turn','no-tools','no-tool-turn','string-tools','wrong-controller','no-restart') }
foreach ($scenario in $scenarios) {
  $calls=[Collections.Generic.List[object]]::new(); $timings=@{}; $failed=$false
  try { . $execute } catch { if ($scenario -ceq 'pass') { throw }; $failed=$true }
  if ($failed -ne ($scenario -cne 'pass')) { throw ('Unexpected Pi acceptance result: '+$scenario) }
  if ($scenario -ceq 'pass' -and ($calls.Count -ne 2 -or $timings.startupComparisonAvailable -ne $true)) { throw 'Incorrect launch comparison result.' }
  if ($scenario -ceq 'pass' -and $Agent -ceq 'pi' -and ($timings.networkQualification -ne $false -or $timings.piCodingToolsQualified -ne $false)) { throw 'Incorrect Pi qualification scope.' }
  if ($failed -and $timings.startupComparisonAvailable -eq $true) { throw 'A failed case claimed a startup comparison.' }
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
          env: powershellEnvironment({ NEMOCLAW_ACCEPTANCE_SOURCE: source, TEST_AGENT: agent }),
          encoding: "utf8",
          windowsHide: true,
          timeout: 30_000,
        },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(result.stdout.trim(), agent === "pi" ? "12" : "4");
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
          env: powershellEnvironment({
            NEMOCLAW_ACCEPTANCE_SOURCE: source,
          }),
          encoding: "utf8",
          windowsHide: true,
          // Windows PowerShell 5.1 takes ~29.5s for the real registry matrix on
          // the ARM64 runner and crosses 30s when migration runs in parallel.
          timeout: shell === "powershell.exe" ? 45_000 : 30_000,
        },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const lastLine = result.stdout.trim().split(/\r?\n/u).at(-1)!;
      assert.equal(JSON.parse(lastLine).length, 7);
    },
  );

test(
  "migration accepts Pi and only versions newer than its published baseline",
  { skip: process.platform !== "win32" },
  () => {
    const script = String.raw`
$ErrorActionPreference='Stop'
function Parse([string]$File) {
  $tokens=$null; $errors=$null
  $ast=[Management.Automation.Language.Parser]::ParseFile($File,[ref]$tokens,[ref]$errors)
  if ($errors.Count) { throw 'Migration controller does not parse.' }
  return $ast
}
$ast=Parse (Join-Path $env:TEST_OWNER 'run-preview-migration.ps1')
$guard=@($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.IfStatementAst] })[0]
$check=[scriptblock]::Create($ast.ParamBlock.Extent.Text + '; $parsedVersion=$null; ' + $guard.Extent.Text + '; return $NewAgent')
foreach ($agent in @('openclaw','hermes','pi')) {
  foreach ($version in @('0.1.3','0.1.4','0.1.5','0.1.10','bad','0.1.10.1')) {
    $failed=$false
    try { $result=& $check -WorkDirectory 'unused-fixture' -ProductVersion $version -NewAgent $agent } catch { $failed=$true }
    if ($failed -ne ($version -notin @('0.1.5','0.1.10'))) { throw 'Incorrect migration version admission.' }
    if (-not $failed -and $result -cne $agent) { throw 'Incorrect migrated agent.' }
  }
}
$controls=Parse (Join-Path $env:TEST_OWNER 'preview-ui-controls.ps1')
$function=@($controls.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Set-PreviewCanaryConfiguration'},$true))[0]
$parameters=($function.Parameters | ForEach-Object { $_.Extent.Text }) -join ','
$choose=[scriptblock]::Create('param('+ $parameters + ') ' + $function.Body.EndBlock.Statements[0].Extent.Text + '; return $choiceId')
foreach ($entry in @{openclaw='AgentOpenClaw';hermes='AgentHermes';pi='AgentPi'}.GetEnumerator()) {
  if ((& $choose -Window $null -Endpoint '' -Key '' -Agent $entry.Key) -cne $entry.Value) { throw 'Wrong native UI agent choice.' }
}
try { $null=& $choose -Window $null -Endpoint '' -Key '' -Agent 'unrecognized'; throw 'Unexpected agent accepted.' }
catch [System.Management.Automation.ParameterBindingException] { }
Write-Output 'pass'
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
        env: powershellEnvironment({ TEST_OWNER: fileURLToPath(new URL(".", import.meta.url)) }),
        encoding: "utf8",
        windowsHide: true,
        timeout: 30000,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout.trim(), "pass");
  },
);

test(
  "migration requires tier-specific native preparation evidence",
  { skip: process.platform !== "win32" },
  () => {
    const script = String.raw`
$ErrorActionPreference='Stop'
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:MIGRATION_SOURCE,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw 'Migration controller does not parse.' }
$function=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Assert-MigrationPreparationNoop'},$true)
if ($null -eq $function) { throw 'Migration preparation owner is missing.' }
. ([scriptblock]::Create($function.Extent.Text))
$root=Join-Path ([IO.Path]::GetTempPath()) ('migration-preparation-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root) | Out-Null
function Reject([scriptblock]$Fixture) {
  $failed=$false
  try { & $Fixture } catch { $failed=$true }
  if (-not $failed) { throw 'Invalid migration preparation evidence was accepted.' }
}
try {
  $base=Join-Path $root 'base.log'
  [IO.File]::WriteAllText($base,('prefix MXC preparation tier: base-container'+[Environment]::NewLine))
  $baseResult=Assert-MigrationPreparationNoop $base
  if ($baseResult.tier -cne 'base-container' -or $baseResult.helperSkipped -ne $true -or $baseResult.addedAces -ne 0 -or $baseResult.writeCalls -ne 0 -or $null -ne $baseResult.sidecarSha256) { throw 'BaseContainer preparation result is incomplete.' }

  $app=Join-Path $root 'app.log'; $attempt='a' * 32
  [IO.File]::WriteAllText($app,('prefix MXC preparation tier: appcontainer-dacl'+[Environment]::NewLine+'Applying execute package: MxcSystemDrivePreparation'+[Environment]::NewLine))
  $sidecar=$app + '.host-preparation-' + $attempt + '.json'
  @{classification='nemoclaw-host-preparation-diagnostic';operation='prepare-system-drive';status='succeeded';addedAces=0;writeCalls=0;elapsedMilliseconds=7;attemptId=$attempt} | ConvertTo-Json -Compress | Set-Content -LiteralPath $sidecar -NoNewline
  $appResult=Assert-MigrationPreparationNoop $app
  if ($appResult.tier -cne 'appcontainer-dacl' -or $appResult.helperSkipped -ne $false -or $appResult.addedAces -ne 0 -or $appResult.writeCalls -ne 0 -or $appResult.elapsedMilliseconds -ne 7 -or $appResult.sidecarSha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'AppContainer preparation result is incomplete.' }

  [IO.File]::WriteAllText((Join-Path $root 'bad-tier.log'),('MXC preparation tier: unsupported'+[Environment]::NewLine))
  Reject { Assert-MigrationPreparationNoop (Join-Path $root 'bad-tier.log') }
  [IO.File]::WriteAllText((Join-Path $root 'duplicate.log'),('MXC preparation tier: base-container'+[Environment]::NewLine+'MXC preparation tier: base-container'+[Environment]::NewLine))
  Reject { Assert-MigrationPreparationNoop (Join-Path $root 'duplicate.log') }
  [IO.File]::WriteAllText((Join-Path $root 'base-helper.log'),('MXC preparation tier: base-container'+[Environment]::NewLine+'Applying execute package: MxcSystemDrivePreparation'+[Environment]::NewLine))
  Reject { Assert-MigrationPreparationNoop (Join-Path $root 'base-helper.log') }
  [IO.File]::WriteAllText((Join-Path $root 'missing-sidecar.log'),('MXC preparation tier: appcontainer-dacl'+[Environment]::NewLine+'Applying execute package: MxcSystemDrivePreparation'+[Environment]::NewLine))
  Reject { Assert-MigrationPreparationNoop (Join-Path $root 'missing-sidecar.log') }
  [IO.File]::WriteAllText((Join-Path $root 'oversized.log'),('x' * 1048577))
  Reject { Assert-MigrationPreparationNoop (Join-Path $root 'oversized.log') }
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force
}
Write-Output 'pass'
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
        env: powershellEnvironment({
          MIGRATION_SOURCE: fileURLToPath(new URL("run-preview-migration.ps1", import.meta.url)),
        }),
        encoding: "utf8",
        windowsHide: true,
        timeout: 30_000,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout.trim(), "pass");
  },
);
