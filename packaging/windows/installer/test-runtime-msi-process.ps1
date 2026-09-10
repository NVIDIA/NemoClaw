# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$SourceRoot,
    [Parameter(Mandatory)][string]$ArtifactDirectory
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $ArtifactDirectory) { throw 'Lease process controls require fresh evidence.' }
[IO.Directory]::CreateDirectory($ArtifactDirectory) | Out-Null
$owner = Join-Path $SourceRoot 'packaging/windows/installer/test-runtime-msi.ps1'
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($owner,[ref]$tokens,[ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw 'The actual MSI process functions did not parse.' }
foreach ($name in @('Start-FixtureLease','Add-FixtureLeaseObservation','Stop-FixtureLease')) {
    $definitions = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name },$true))
    if ($definitions.Count -ne 1) { throw 'An actual lease process function is missing or ambiguous.' }
    . ([ScriptBlock]::Create($definitions[0].Extent.Text))
}
$child = Join-Path $ArtifactDirectory 'lease-protocol-child.ps1'
[IO.File]::WriteAllText($child,@'
param([string]$Mode)
[Console]::Out.WriteLine('{"kind":"native-runtime-session","leaseHeld":true}')
[Console]::Out.Flush()
if ($Mode -eq 'early-exit') {
    Start-Sleep -Milliseconds 1000
    [Console]::Error.Write('holder-ended-before-release')
    exit 23
}
$stream = [Console]::OpenStandardInput()
$bytes = [Collections.Generic.List[byte]]::new()
while ($bytes.Count -lt 9) {
    $value = $stream.ReadByte()
    if ($value -lt 0) { break }
    $bytes.Add([byte]$value)
}
[Console]::Error.Write([Convert]::ToBase64String($bytes.ToArray()))
if ([Convert]::ToBase64String($bytes.ToArray()) -cne 'cmVsZWFzZQo=') { exit 24 }
exit 0
'@,[Text.UTF8Encoding]::new($false))
$runner = (Get-Process -Id $PID).Path
$held = $null; $primary = $null
$results = [Collections.Generic.List[object]]::new()
try {
    $held = Start-FixtureLease $runner ('-NoProfile -NonInteractive -File "' + $child + '" -Mode normal')
    if ($held.process.WaitForExit(100)) { throw 'The real child did not wait for the release channel.' }
    $normalEvidence = $held.evidence
    Stop-FixtureLease $held; $held = $null
    if ($normalEvidence.exitCode -ne 0 -or $normalEvidence.stderr -cne 'cmVsZWFzZQo=' -or
        $normalEvidence.releaseRequested -ne $true -or $normalEvidence.stderrComplete -ne $true) {
        throw 'The actual release writer did not deliver exactly eight UTF-8 bytes and EOF.'
    }
    $results.Add([pscustomobject]@{ case = 'exact-release-framing'; process = $normalEvidence })
    $held = Start-FixtureLease $runner ('-NoProfile -NonInteractive -File "' + $child + '" -Mode early-exit')
    if (-not $held.process.WaitForExit(5000)) { throw 'The controlled earlier failure did not exit.' }
    $failedEvidence = $held.evidence
    $failed = $false
    try { Stop-FixtureLease $held } catch { $failed = $_.Exception.Message -ceq 'The owned lease helper rejected its release.' }
    $held = $null
    if (-not $failed -or $failedEvidence.exitCode -ne 23 -or
        $failedEvidence.stderr -cne 'holder-ended-before-release' -or $failedEvidence.releaseRequested -ne $false) {
        throw 'The actual process controller hid an earlier child exit or its stderr.'
    }
    $results.Add([pscustomobject]@{ case = 'prior-exit-preserved'; process = $failedEvidence })
} catch { $primary = $_ }
finally {
    try { if ($null -ne $held) { Stop-FixtureLease $held } }
    catch { if ($null -eq $primary) { $primary = $_ } else { Write-Warning ('Lease test cleanup failed: ' + $_.Exception.Message) } }
    $receipt = [ordered]@{ schemaVersion = 1; classification = 'msi-lease-process-controls';
        helperSourceSha256 = (Get-FileHash -LiteralPath $owner -Algorithm SHA256).Hash.ToLowerInvariant();
        powershellVersion = $PSVersionTable.PSVersion.ToString(); nativeLeaseOrMsiExecution = $false;
        passed = $results.Count; results = $results; error = $null }
    if ($null -ne $primary) { $receipt.error = $primary.Exception.Message }
    try { [IO.File]::WriteAllText((Join-Path $ArtifactDirectory 'lease-process-controls.json'),(($receipt | ConvertTo-Json -Depth 10) + "`n"),[Text.UTF8Encoding]::new($false)) }
    catch { if ($null -eq $primary) { $primary = $_ } else { Write-Warning ('Lease test receipt failed: ' + $_.Exception.Message) } }
}
if ($null -ne $primary) { throw $primary }
Write-Host 'Two actual MSI lease process controls passed; no native lease or MSI execution is claimed.'
