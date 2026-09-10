# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

param([string]$SourcePath = '', [string]$RecordedReceipt = '')
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $SourcePath) { $SourcePath = Join-Path $PSScriptRoot 'test-runtime-msi.ps1' }
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($SourcePath, [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) { throw 'The actual MSI control does not parse.' }
$functions = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Compare-RolledBackFixtureLeaf' }, $true))
if ($functions.Count -ne 1) { throw 'The actual rollback comparator is unavailable.' }
. ([scriptblock]::Create($functions[0].Extent.Text))
$id = 'a' * 64; $hash = 'b' * 64
$leafPath = '/runtimes/' + $id + '/empty'
$acl = 'O:SYG:SYD:AI(A;ID;FA;;;SY)(A;OICIIOID;GA;;;SY)(A;ID;FA;;;BA)(A;ID;0x1200a9;;;BU)'
$root = 'D|/|' + $acl
$parent = 'D|/runtimes/' + $id + '|' + $acl
$leaf = 'D|' + $leafPath + '|' + $acl
$leafAfter = $leaf.Replace('D:AI(', 'D:(')
$payload = 'F|/runtimes/' + $id + '/payload.txt|' + $hash + '|' + $acl
$selector = 'F|/runtime-current|' + $hash + '|' + $acl
$before = @($root, $selector, $parent, $leaf, $payload) -join "`n"
$after = @($root, $selector, $parent, $leafAfter, $payload) -join "`n"
$passed = [Collections.Generic.List[string]]::new()
function Require-Rejected {
    param([string]$Name, [string]$Previous, [string]$Changed, [string]$RuntimeId = $id)
    $rejected = $false
    try { Compare-RolledBackFixtureLeaf -Before $Previous -After $Changed -RuntimeId $RuntimeId | Out-Null }
    catch { $rejected = $true }
    if (-not $rejected) { throw ('The rollback comparator accepted: ' + $Name) }
    $passed.Add($Name)
}
if (@(Compare-RolledBackFixtureLeaf $before $before $id).Count -ne 0) { throw 'Unchanged metadata produced a delta.' }
$passed.Add('unchanged empty leaf')
$delta = @(Compare-RolledBackFixtureLeaf $before $after $id)
if ($delta.Count -ne 1 -or $delta[0].path -cne $leafPath -or $delta[0].control -cne 'SE_DACL_AUTO_INHERITED' -or
    $delta[0].before -cne 'set' -or $delta[0].after -cne 'clear' -or -not $delta[0].emptyBefore -or -not $delta[0].emptyAfter) {
    throw 'The exact empty-leaf metadata change was not recorded.'
}
$passed.Add('one-way empty leaf AI clear')
if (@(Compare-RolledBackFixtureLeaf $after $after $id).Count -ne 0) { throw 'The raw post-rollback baseline was not preserved.' }
$passed.Add('raw post-rollback baseline')
$cases = @(
    @{ Name='reverse AI transition'; Before=$after; After=$before },
    @{ Name='owner'; Before=$before; After=$after.Replace($leafAfter, $leafAfter.Replace('O:SY', 'O:BA')) },
    @{ Name='group'; Before=$before; After=$after.Replace($leafAfter, $leafAfter.Replace('G:SY', 'G:BA')) },
    @{ Name='rights'; Before=$before; After=$after.Replace($leafAfter, $leafAfter.Replace('0x1200a9;;;BU', 'FA;;;BU')) },
    @{ Name='inherited flag'; Before=$before; After=$after.Replace($leafAfter, $leafAfter.Replace('(A;ID;FA;;;SY)', '(A;;FA;;;SY)')) },
    @{ Name='inherit-only flag'; Before=$before; After=$after.Replace($leafAfter, $leafAfter.Replace('OICIIOID', 'OICIID')) },
    @{ Name='protection'; Before=$before; After=$after.Replace($leafAfter, $leafAfter.Replace('D:(', 'D:P(')) },
    @{ Name='ACE order'; Before=$before; After=$after.Replace($leafAfter, $leafAfter.Replace('(A;ID;FA;;;SY)(A;OICIIOID;GA;;;SY)', '(A;OICIIOID;GA;;;SY)(A;ID;FA;;;SY)')) },
    @{ Name='ACE addition'; Before=$before; After=$after.Replace($leafAfter, ($leafAfter + '(A;;FA;;;WD)')) },
    @{ Name='parent metadata'; Before=$before; After=$after.Replace($parent, $parent.Replace('D:AI(', 'D:(')) },
    @{ Name='selector metadata'; Before=$before; After=$after.Replace($selector, $selector.Replace('D:AI(', 'D:(')) },
    @{ Name='file metadata'; Before=$before; After=$after.Replace($payload, $payload.Replace('D:AI(', 'D:(')) },
    @{ Name='file hash'; Before=$before; After=$after.Replace($hash, ('c' * 64)) },
    @{ Name='missing leaf'; Before=$before; After=$after.Replace(($leafAfter + "`n"), '') },
    @{ Name='both missing leaf'; Before=$before.Replace(($leaf + "`n"), ''); After=$after.Replace(($leafAfter + "`n"), '') },
    @{ Name='extra path'; Before=$before; After=($after + "`nD|/extra|" + $acl) },
    @{ Name='changed leaf path'; Before=$before; After=$after.Replace($leafPath, ($leafPath + '-other')) },
    @{ Name='path case'; Before=$before; After=$after.Replace($leafPath, $leafPath.ToUpperInvariant()) },
    @{ Name='non-directory leaf'; Before=$before.Replace($leaf, ('F|' + $leafPath + '|' + $hash + '|' + $acl)); After=$after.Replace($leafAfter, ('F|' + $leafPath + '|' + $hash + '|' + $acl.Replace('D:AI(', 'D:('))) },
    @{ Name='duplicate leaf'; Before=($before + "`n" + $leaf); After=($after + "`n" + $leafAfter) },
    @{ Name='existing child'; Before=($before + "`nF|" + $leafPath + '/child|' + $hash + '|' + $acl); After=($after + "`nF|" + $leafPath + '/child|' + $hash + '|' + $acl) },
    @{ Name='child path case'; Before=($before + "`nD|" + $leafPath.ToUpperInvariant() + '/CHILD|' + $acl); After=($after + "`nD|" + $leafPath.ToUpperInvariant() + '/CHILD|' + $acl) },
    @{ Name='added child'; Before=$before; After=($after + "`nD|" + $leafPath + '/child|' + $acl) },
    @{ Name='removed child'; Before=($before + "`nD|" + $leafPath + '/child|' + $acl); After=$after }
)
foreach ($case in $cases) { Require-Rejected $case.Name $case.Before $case.After }
Require-Rejected 'wrong runtime ID' $before $after ('c' * 64)
Require-Rejected 'invalid runtime ID' $before $after '../empty'
if ($RecordedReceipt) {
    $recorded = Get-Content -LiteralPath $RecordedReceipt -Raw | ConvertFrom-Json
    if ($recorded.sourceRevision -cne '16ed8a5b1b83d24c3d7abcba7835e692c8ee2fe8') { throw 'The supplied Windows receipt has a different source.' }
    $actualBefore = $recorded.snapshots.'released-direct-repair'
    $actualAfter = $recorded.snapshots.'deferred-failure'
    if ($actualBefore -ceq $actualAfter) { throw 'The retained Windows strict negative control no longer differs.' }
    $actual = @(Compare-RolledBackFixtureLeaf $actualBefore $actualAfter $recorded.heldLease.runtimeId)
    if ($actual.Count -ne 1 -or $actual[0].path -cne ('/runtimes/' + $recorded.heldLease.runtimeId + '/empty')) {
        throw 'The actual Windows rollback did not have exactly the known leaf transition.'
    }
    $passed.Add('actual 16ed Windows snapshots with original strict negative')
}
[pscustomobject]@{ schemaVersion=1; passed=$passed.Count; failed=0; controls=$passed.ToArray();
    nativeAclMutation=$false; windowsMsiRerun=$false } | ConvertTo-Json -Depth 3 -Compress
