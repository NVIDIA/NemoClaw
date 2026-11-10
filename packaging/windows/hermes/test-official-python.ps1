# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# These controls load only the actual result validator. They do not provision
# packages or claim Windows runtime/ConPTY execution.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'prepare-official-python.ps1'
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'The actual Python phase helper did not parse.' }
$definitions = @($ast.FindAll({ param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Assert-PythonPhaseResult'
}, $true))
if ($definitions.Count -ne 1) { throw 'The actual phase result validator was not found exactly once.' }
. ([scriptblock]::Create($definitions[0].Extent.Text))
$fixture = @'
{"schemaVersion":1,"status":"python-provisioned","installedTier":"hash-verified (uv.lock)","upstream":{"commit":"2237be355906fbe6065ce1815711eee52b2d646e"},"completeRuntime":false,"installedAcceptance":false,"python":{"conpty":{"schemaVersion":1,"classification":"ci-built-pywinpty-conpty-smoke","status":"pass","backend":"ConPTY","pywinptyVersion":"2.0.15","pythonVersion":"3.11.16","nativeModuleMachine":"0xaa64","nativeModuleSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","exitCode":0,"constructorSucceeded":true,"spawnSucceeded":true,"outputContainsSentinel":true,"childExitObserved":true,"cleanupPassed":true},"cryptographyVersion":"50.0.0","opensslVersion":"OpenSSL 3.5.8 25 Aug 2026","imports":["hermes_cli.main","tools.terminal_tool","tools.file_tools","tools.web_tools","fastapi","uvicorn","winpty"],"packages":[{"name":"hermes-agent","version":"0.21.1"},{"name":"pywinpty","version":"2.0.15"}]}}
'@
$complete = $fixture | ConvertFrom-Json
$complete | Add-Member -NotePropertyName selectedExtras -NotePropertyValue @('all','messaging')
$messagingImports = @('telegram.ext','telegram.request','discord.ext.commands','slack_bolt.async_app',
    'slack_bolt.adapter.socket_mode.async_handler','slack_sdk.web.async_client','nacl.bindings','brotlicffi','qrcode','tornado.web')
$complete.python.imports += $messagingImports
$messagingPackages = @{
    'python-telegram-bot' = '22.8'; 'discord.py' = '2.7.1'; 'slack-bolt' = '1.30.0'; 'slack-sdk' = '3.43.0'
    'aiohttp' = '3.14.3'; 'brotlicffi' = '1.2.0.2'; 'PyNaCl' = '1.6.2'; 'qrcode' = '7.4.2'; 'tornado' = '6.5.7'
}
foreach ($name in $messagingPackages.Keys) {
    $complete.python.packages += [pscustomobject]@{name=$name; version=$messagingPackages[$name]}
}
$fixture = $complete | ConvertTo-Json -Depth 12
Assert-PythonPhaseResult -Result ($fixture | ConvertFrom-Json)
$duplicate = $fixture | ConvertFrom-Json
$duplicate.python.packages += [pscustomobject]@{ name = 'hermes-agent'; version = '0.21.1' }
Assert-PythonPhaseResult -Result $duplicate
$controls = @(
    @{ Name = 'missing compiled ConPTY backend'; Mutate = { param($value) $value.python.conpty.constructorSucceeded = $false } },
    @{ Name = 'ConPTY child not exited'; Mutate = { param($value) $value.python.conpty.childExitObserved = $false } },
    @{ Name = 'foreign ConPTY extension'; Mutate = { param($value) $value.python.conpty.nativeModuleMachine = '0x8664' } },
    @{ Name = 'coercible ConPTY status'; Mutate = { param($value) $value.python.conpty.spawnSucceeded = 'true' } },
    @{ Name = 'mixed Hermes metadata versions'; Mutate = { param($value) $value.python.packages += [pscustomobject]@{ name = 'hermes-agent'; version = '0.21.0' } } },
    @{ Name = 'foreign OpenSSL'; Mutate = { param($value) $value.python.opensslVersion = 'OpenSSL 4.0.2' } },
    @{ Name = 'substituted cryptography'; Mutate = { param($value) $value.python.cryptographyVersion = '49.0.0' } },
    @{ Name = 'fallback tier'; Mutate = { param($value) $value.installedTier = 'core only (no extras)' } },
    @{ Name = 'failure status'; Mutate = { param($value) $value.status = 'failed' } },
    @{ Name = 'wrong source'; Mutate = { param($value) $value.upstream.commit = ('0' * 40) } },
    @{ Name = 'missing actual winpty import'; Mutate = { param($value) $value.python.imports = @('hermes_cli.main') } },
    @{ Name = 'substituted pywinpty'; Mutate = { param($value) $value.python.packages[1].version = '3.0.0' } },
    @{ Name = 'premature complete-runtime claim'; Mutate = { param($value) $value.completeRuntime = $true } },
    @{ Name = 'premature installed acceptance'; Mutate = { param($value) $value.installedAcceptance = $true } },
    @{ Name = 'coercible status flag'; Mutate = { param($value) $value.completeRuntime = 0 } }
    @{ Name = 'missing messaging selection'; Mutate = { param($value) $value.selectedExtras = @('all') } },
    @{ Name = 'unexpected extra'; Mutate = { param($value) $value.selectedExtras += 'unknown' } }
)
foreach ($control in $controls) {
    $value = $fixture | ConvertFrom-Json
    & $control.Mutate $value
    $rejected = $false
    try { Assert-PythonPhaseResult -Result $value } catch { $rejected = $true }
    if (-not $rejected) { throw "The actual result gate accepted $($control.Name)." }
}
$additional = 0
foreach ($name in $messagingImports) {
    $value = $fixture | ConvertFrom-Json
    $value.python.imports = @($value.python.imports | Where-Object { $_ -cne $name })
    $rejected = $false
    try { Assert-PythonPhaseResult -Result $value } catch { $rejected = $true }
    if (-not $rejected) { throw "The result gate accepted a missing $name import." }
    $additional++
}
foreach ($name in $messagingPackages.Keys) {
    foreach ($mutation in @('missing','wrong-version','duplicate')) {
        $value = $fixture | ConvertFrom-Json
        switch ($mutation) {
            'missing' { $value.python.packages = @($value.python.packages | Where-Object { $_.name -cne $name }) }
            'wrong-version' { ($value.python.packages | Where-Object { $_.name -ceq $name }).version = '0.0.0' }
            'duplicate' { $value.python.packages += [pscustomobject]@{name=$name; version=$messagingPackages[$name]} }
        }
        $rejected = $false
        try { Assert-PythonPhaseResult -Result $value } catch { $rejected = $true }
        if (-not $rejected) { throw "The result gate accepted $mutation for $name." }
        $additional++
    }
}

$stageSource = Join-Path $PSScriptRoot 'complete-official-python.ps1'
$stageAst = [Management.Automation.Language.Parser]::ParseFile($stageSource, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'The actual dependency worker did not parse.' }
$stage = @($stageAst.FindAll({ param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-PythonMessagingStage'
}, $true))
if ($stage.Count -ne 1) { throw 'The locked messaging stage was not found exactly once.' }
. ([scriptblock]::Create($stage[0].Extent.Text))
function Invoke-NativeWithRelaxedErrorAction { param([scriptblock]$Command) & $Command }
function Invoke-UvFixture {
    $script:observedArguments = @($args)
    $script:observedEnvironment = $env:UV_PROJECT_ENVIRONMENT
    $global:LASTEXITCODE = $script:fixtureExitCode
    if ($script:fixtureThrows) { throw 'owned fixture failed' }
}
$previousProject = $env:UV_PROJECT_ENVIRONMENT
try {
    foreach ($mode in @('success','nonzero','throw')) {
        $env:UV_PROJECT_ENVIRONMENT = 'retained-environment'
        $script:fixtureExitCode = if ($mode -eq 'nonzero') { 1 } else { 0 }
        $script:fixtureThrows = $mode -eq 'throw'
        $failed = $false
        try { Invoke-PythonMessagingStage -UvPath 'Invoke-UvFixture' -SourceRoot '/fixture/source' -PythonPath '/fixture/python' }
        catch { $failed = $true }
        if ($failed -ne ($mode -ne 'success')) { throw "Messaging sync outcome differs for $mode." }
        $expected = @('sync','--project','/fixture/source','--python','/fixture/python','--extra','all','--extra','messaging','--locked')
        if (($script:observedArguments -join '|') -cne ($expected -join '|')) { throw 'The messaging stage changed its locked command.' }
        if ($script:observedEnvironment -cne (Join-Path '/fixture/source' 'venv') -or $env:UV_PROJECT_ENVIRONMENT -cne 'retained-environment') {
            throw 'The messaging stage failed canonical venv selection or restoration.'
        }
        $additional++
    }
} finally { $env:UV_PROJECT_ENVIRONMENT = $previousProject }
Write-Host "Official Python result contract: $($controls.Count + $additional + 2) controls passed; no runtime execution claimed."
