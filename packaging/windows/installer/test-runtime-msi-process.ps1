# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$SourceRoot,
    [Parameter(Mandatory)][string]$ArtifactDirectory,
    [Parameter(Mandatory)][string]$NodePath
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
$child = Join-Path $ArtifactDirectory 'lease-protocol-child.mjs'
[IO.File]::WriteAllText($child,@'
const mode = process.argv[2];
if (mode === "early-exit") {
  setTimeout(() => process.stderr.write("holder-ended-before-release", () => process.exit(23)), 1000);
} else {
  let bytes = Buffer.alloc(0);
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    process.stderr.write(bytes.toString("base64"), () => process.exit(bytes.equals(Buffer.from("release\n")) ? 0 : 24));
  };
  process.stdin.on("data", chunk => {
    bytes = Buffer.concat([bytes, chunk.subarray(0, 9 - bytes.length)]);
    if (bytes.length === 9) finish();
  });
  process.stdin.on("end", finish);
}
process.stdout.write('{"kind":"native-runtime-session","leaseHeld":true}\n');
'@,[Text.UTF8Encoding]::new($false))
$held = $null; $primary = $null
$results = [Collections.Generic.List[object]]::new()
$passed = 0
$frameworkPreamble = $null
try {
    $memory = [IO.MemoryStream]::new()
    $writer = [IO.StreamWriter]::new($memory,[Text.UTF8Encoding]::new($true),4096,$true)
    try {
        $writer.AutoFlush = $true
        $prefixBytes = $memory.Length
        $frame = [Text.Encoding]::UTF8.GetBytes("release`n")
        $writer.BaseStream.Write($frame,0,$frame.Length); $writer.Flush()
        $frameworkPreamble = [pscustomobject]@{ beforeReleaseBytes = $prefixBytes; frameBase64 = [Convert]::ToBase64String($memory.ToArray()) }
        if ($prefixBytes -ne 3 -or $frameworkPreamble.frameBase64 -cne '77u/cmVsZWFzZQo=') { throw 'The Framework-style writer preamble control did not reproduce the incompatible wire bytes.' }
    } finally { $writer.Dispose(); $memory.Dispose() }
    $priorEncoding = [Console]::InputEncoding
    $held = Start-FixtureLease $NodePath ('"' + $child + '" normal')
    if ([Console]::InputEncoding.CodePage -ne $priorEncoding.CodePage -or
        [Convert]::ToBase64String([Console]::InputEncoding.GetPreamble()) -cne [Convert]::ToBase64String($priorEncoding.GetPreamble())) { throw 'Lease creation did not restore the caller input encoding.' }
    if ($held.process.WaitForExit(100)) { throw 'The real child did not wait for the release channel.' }
    $normalEvidence = $held.evidence
    $normalCase = [pscustomobject]@{ case = 'exact-release-framing'; passed = $false; process = $normalEvidence }
    $results.Add($normalCase)
    $closing = $held; $held = $null
    Stop-FixtureLease $closing
    if ($normalEvidence.exitCode -ne 0 -or $normalEvidence.stderr -cne 'cmVsZWFzZQo=' -or
        $normalEvidence.releaseRequested -ne $true -or $normalEvidence.stderrComplete -ne $true -or $normalEvidence.stdinPreambleBytes -ne 0) {
        throw 'The actual release writer did not deliver exactly eight UTF-8 bytes and EOF.'
    }
    $normalCase.passed = $true; $passed++
    $held = Start-FixtureLease $NodePath ('"' + $child + '" early-exit')
    if (-not $held.process.WaitForExit(5000)) { throw 'The controlled earlier failure did not exit.' }
    $failedEvidence = $held.evidence
    $failedCase = [pscustomobject]@{ case = 'prior-exit-preserved'; passed = $false; process = $failedEvidence }
    $results.Add($failedCase)
    $failed = $false
    $closing = $held; $held = $null
    try { Stop-FixtureLease $closing } catch { $failed = $_.Exception.Message -ceq 'The owned lease helper rejected its release.' }
    $held = $null
    if (-not $failed -or $failedEvidence.exitCode -ne 23 -or
        $failedEvidence.stderr -cne 'holder-ended-before-release' -or $failedEvidence.releaseRequested -ne $false) {
        throw 'The actual process controller hid an earlier child exit or its stderr.'
    }
    $failedCase.passed = $true; $passed++
    $startFailed = $false
    try { Start-FixtureLease (Join-Path $ArtifactDirectory 'absent-helper.exe') | Out-Null }
    catch { $startFailed = $true }
    if (-not $startFailed -or [Console]::InputEncoding.CodePage -ne $priorEncoding.CodePage -or
        [Convert]::ToBase64String([Console]::InputEncoding.GetPreamble()) -cne [Convert]::ToBase64String($priorEncoding.GetPreamble())) {
        throw 'Failed helper creation did not restore the caller input encoding.'
    }
} catch { $primary = $_ }
finally {
    try { if ($null -ne $held) { $closing = $held; $held = $null; Stop-FixtureLease $closing } }
    catch { if ($null -eq $primary) { $primary = $_ } else { Write-Warning ('Lease test cleanup failed: ' + $_.Exception.Message) } }
    $receipt = [ordered]@{ schemaVersion = 1; classification = 'msi-lease-process-controls';
        helperSourceSha256 = (Get-FileHash -LiteralPath $owner -Algorithm SHA256).Hash.ToLowerInvariant();
        powershellVersion = $PSVersionTable.PSVersion.ToString(); nativeLeaseOrMsiExecution = $false;
        frameworkStyleWriter = $frameworkPreamble;
        childNodeSha256 = (Get-FileHash -LiteralPath $NodePath -Algorithm SHA256).Hash.ToLowerInvariant();
        passed = $passed; results = $results; error = $null }
    if ($null -ne $primary) { $receipt.error = $primary.Exception.Message }
    try { [IO.File]::WriteAllText((Join-Path $ArtifactDirectory 'lease-process-controls.json'),(($receipt | ConvertTo-Json -Depth 10) + "`n"),[Text.UTF8Encoding]::new($false)) }
    catch { if ($null -eq $primary) { $primary = $_ } else { Write-Warning ('Lease test receipt failed: ' + $_.Exception.Message) } }
}
if ($null -ne $primary) { throw $primary }
Write-Host 'Two actual MSI lease process controls passed; no native lease or MSI execution is claimed.'
