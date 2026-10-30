# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

param([string]$SourcePath = (Join-Path $PSScriptRoot 'test-runtime-msi.ps1'), [string]$RecordedSnapshots = '')
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($SourcePath, [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) { throw 'The actual MSI control does not parse.' }
$functions = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Compare-RecreatedFixtureFiles' }, $true))
if ($functions.Count -ne 1) { throw 'The actual repair comparator is unavailable.' }
. ([scriptblock]::Create($functions[0].Extent.Text))
$id = 'a' * 64; $hash = 'b' * 64
$acl = 'O:SYG:SYD:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;0x1200a9;;;BU)(A;ID;0x1200a9;;;AC)'
$directory = 'D|/|' + $acl
$node = 'F|/bin/node.exe|' + $hash + '|' + $acl
$payload = 'F|/runtimes/' + $id + '/payload.txt|' + $hash + '|' + $acl
$selector = 'F|/runtime-current|' + $hash + '|' + $acl
$before = @($directory, $node, $payload, $selector) -join "`n"
$after = @($directory, $node.Replace('D:AI(', 'D:('), $payload.Replace('D:AI(', 'D:('), $selector) -join "`n"
$script:passed = 0
function Require-Rejected {
    param([string]$Changed)
    $rejected = $false
    try { Compare-RecreatedFixtureFiles -Before $before -After $Changed | Out-Null } catch { $rejected = $true }
    if (-not $rejected) { throw 'The comparator accepted an unauthorized snapshot change.' }
    $script:passed++
}
if (@(Compare-RecreatedFixtureFiles $before $before).Count -ne 0) { throw 'Unchanged metadata produced a delta.' }; $script:passed++
if (@(Compare-RecreatedFixtureFiles $before $after).Count -ne 2) { throw 'The exact recreated-file AI transition was rejected.' }; $script:passed++
$nodeAfter = $node.Replace('D:AI(', 'D:(')
Require-Rejected ($after.Replace($nodeAfter, $nodeAfter.Replace($hash, ('c' * 64))))
Require-Rejected ($after.Replace($nodeAfter, $nodeAfter.Replace('O:SY', 'O:BA')))
Require-Rejected ($after.Replace($nodeAfter, $nodeAfter.Replace('G:SY', 'G:BA')))
Require-Rejected ($after.Replace($nodeAfter, $nodeAfter.Replace('0x1200a9;;;BU', 'FA;;;BU')))
Require-Rejected ($after.Replace($nodeAfter, $nodeAfter.Replace('(A;ID;FA;;;SY)', '(A;;FA;;;SY)')))
Require-Rejected ($after.Replace($nodeAfter, $nodeAfter.Replace('(A;ID;FA;;;SY)(A;ID;FA;;;BA)', '(A;ID;FA;;;BA)(A;ID;FA;;;SY)')))
Require-Rejected ($after.Replace($nodeAfter, $nodeAfter.Replace('D:(', 'D:P(')))
Require-Rejected ($after.Replace($directory, $directory.Replace('D:AI(', 'D:(')))
Require-Rejected ($after.Replace($selector, $selector.Replace('D:AI(', 'D:(')))
Require-Rejected ($after + "`n" + $payload)
if ($RecordedSnapshots) {
    $recorded = Get-Content -LiteralPath $RecordedSnapshots -Raw | ConvertFrom-Json
    if (@(Compare-RecreatedFixtureFiles $recorded.'first-install' $recorded.'released-direct-repair').Count -ne 5) { throw 'The actual Windows five-file metadata transition differs.' }
    $script:passed++
}
[pscustomobject]@{ schemaVersion = 1; passed = $script:passed; failed = 0; nativeAclMutation = $false; windowsMsiRerun = $false } | ConvertTo-Json -Compress
