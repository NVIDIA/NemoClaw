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
{"schemaVersion":1,"status":"python-provisioned","installedTier":"hash-verified (uv.lock)","upstream":{"commit":"2237be355906fbe6065ce1815711eee52b2d646e"},"completeRuntime":false,"installedAcceptance":false,"python":{"cryptographyVersion":"50.0.0","opensslVersion":"OpenSSL 3.5.8 25 Aug 2026","imports":["hermes_cli.main","tools.terminal_tool","tools.file_tools","tools.web_tools","fastapi","uvicorn","winpty"],"packages":[{"name":"hermes-agent","version":"0.21.1"},{"name":"pywinpty","version":"2.0.15"}]}}
'@
Assert-PythonPhaseResult -Result ($fixture | ConvertFrom-Json)
$duplicate = $fixture | ConvertFrom-Json
$duplicate.python.packages += [pscustomobject]@{ name = 'hermes-agent'; version = '0.21.1' }
Assert-PythonPhaseResult -Result $duplicate
$controls = @(
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
)
foreach ($control in $controls) {
    $value = $fixture | ConvertFrom-Json
    & $control.Mutate $value
    $rejected = $false
    try { Assert-PythonPhaseResult -Result $value } catch { $rejected = $true }
    if (-not $rejected) { throw "The actual result gate accepted $($control.Name)." }
}
Write-Host 'Official Python result contract: 13 controls passed; no runtime execution claimed.'
