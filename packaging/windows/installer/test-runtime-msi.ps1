# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$SourceRoot,
    [Parameter(Mandatory)][string]$ArtifactDirectory,
    [Parameter(Mandatory)][string]$NodePath,
    [Parameter(Mandatory)][string]$NodeLicensePath,
    [Parameter(Mandatory)][string]$PythonPath,
    [Parameter(Mandatory)][string]$WixPath,
    [Parameter(Mandatory)][string]$SourceRevision
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -cne 'Windows_NT' -or ($env:PROCESSOR_ARCHITECTURE -cne 'ARM64' -and $env:PROCESSOR_ARCHITEW6432 -cne 'ARM64') -or $env:GITHUB_ACTIONS -cne 'true') {
    throw 'The connected MSI fixtures require an ephemeral GitHub Windows ARM64 runner.'
}
$installation = Join-Path $env:ProgramFiles 'NVIDIA\NemoClaw'
if ((Test-Path -LiteralPath $installation) -or (Test-Path -LiteralPath $ArtifactDirectory) -or
    $SourceRevision -cnotmatch '^[a-f0-9]{40}$') {
    throw 'The MSI fixtures require a fresh installation root, fresh evidence, and exact source revision.'
}
foreach ($value in @($SourceRoot,$ArtifactDirectory,$NodePath,$NodeLicensePath,$PythonPath,$WixPath)) {
    if ($value -match '["\r\n]') { throw 'A fixture input path cannot be represented safely.' }
}
[IO.Directory]::CreateDirectory($ArtifactDirectory) | Out-Null
$script:activeMsi = $null
$script:msiAttempted = $false
$lease = $null
$fixtures = @()
$primary = $null
$cleanupFailures = [Collections.Generic.List[string]]::new()
$results = [Collections.Generic.List[object]]::new()
$receipt = [ordered]@{ schemaVersion = 1; classification = 'connected-msi-boundary-fixtures';
    sourceRevision = $SourceRevision; completeRuntime = $false; installedAcceptance = $false;
    status = 'failed'; results = $results; cleanupFailures = $cleanupFailures }

function Invoke-FixtureMsi {
    param([string]$Action,[string]$Msi,[string]$Label)
    if ($null -ne $script:activeMsi) { throw 'A prior Windows Installer operation is still running.' }
    $log = Join-Path $ArtifactDirectory ($Label + '.msi.log')
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = Join-Path $env:SystemRoot 'System32\msiexec.exe'
    $start.Arguments = $Action + ' "' + $Msi + '" /qn /norestart /l*v "' + $log + '"'
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $process = [Diagnostics.Process]::Start($start)
    if ($null -eq $process) { throw 'Windows Installer did not start.' }
    $script:activeMsi = $process
    $script:msiAttempted = $true
    $watch = [Diagnostics.Stopwatch]::StartNew()
    try {
        while (-not $process.WaitForExit(1000)) {
            if ($watch.ElapsedMilliseconds -ge 180000) {
                throw 'The fixture MSI exceeded its bound; it will not be killed or overlapped by cleanup.'
            }
            if ([int]$watch.Elapsed.TotalSeconds % 10 -eq 0) { Write-Host "[MSI fixture] $Label is still running." }
        }
        return [pscustomobject]@{ label = $Label; exitCode = $process.ExitCode;
            elapsedMilliseconds = $watch.ElapsedMilliseconds; log = $log }
    } finally {
        if ($process.HasExited) { $process.Dispose(); $script:activeMsi = $null }
    }
}

function Get-FixtureSnapshot {
    $records = [Collections.Generic.List[string]]::new()
    $records.Add('D|/|' + (Get-Acl -LiteralPath $installation).Sddl)
    foreach ($item in @(Get-ChildItem -LiteralPath $installation -Recurse -Force | Sort-Object FullName)) {
        if ($item.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) { throw 'The installed fixture contains a redirected entry.' }
        $relative = $item.FullName.Substring($installation.Length).Replace('\','/')
        $acl = (Get-Acl -LiteralPath $item.FullName).Sddl
        if ($item.PSIsContainer) { $records.Add('D|' + $relative + '|' + $acl) }
        else { $records.Add('F|' + $relative + '|' + (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash + '|' + $acl) }
    }
    return $records.ToArray() -join "`n"
}

function Assert-FixtureCurrent {
    param([object]$Fixture)
    $file = Join-Path $installation 'runtime-current'
    $actual = [IO.File]::ReadAllBytes($file)
    $expected = [IO.File]::ReadAllBytes((Join-Path (Split-Path -Parent $Fixture.authoring) 'runtime.ready'))
    if ([Convert]::ToBase64String($actual) -cne [Convert]::ToBase64String($expected) -or
        (Test-Path -LiteralPath (Join-Path $installation 'runtime-maintenance')) -or
        (Test-Path -LiteralPath (Join-Path $installation 'runtime-retired'))) {
        throw 'The installed fixture did not publish the exact selected tuple after successful maintenance.'
    }
}

function Start-FixtureLease {
    param([string]$Helper)
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $Helper; $start.Arguments = '--runtime-session openclaw'
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true; $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($start)
    if ($null -eq $process) { throw 'The owned lease helper did not start.' }
    try {
        $line = $process.StandardOutput.ReadLineAsync()
        if (-not $line.Wait(15000)) { throw 'The actual package lease did not report readiness.' }
        $ready = $line.GetAwaiter().GetResult() | ConvertFrom-Json
        if ($ready.kind -cne 'native-runtime-session' -or $ready.leaseHeld -ne $true -or $process.HasExited) {
            throw 'The actual native helper did not retain its package lease.'
        }
        return [pscustomobject]@{ process = $process; readiness = $ready }
    } catch {
        $leaseError = $_
        try {
            $process.StandardInput.Close()
            if (-not $process.WaitForExit(5000)) { $process.Kill(); [void]$process.WaitForExit(5000) }
        } catch { Write-Warning ('Lease startup cleanup failed: ' + $_.Exception.Message) }
        finally { $process.Dispose() }
        throw $leaseError
    }
}

function Stop-FixtureLease {
    param([object]$OwnedLease)
    if ($null -eq $OwnedLease) { return }
    $process = $OwnedLease.process
    try {
        if (-not $process.HasExited) {
            $bytes = [Text.Encoding]::UTF8.GetBytes("release`n")
            $process.StandardInput.BaseStream.Write($bytes,0,$bytes.Length)
            $process.StandardInput.BaseStream.Flush(); $process.StandardInput.Close()
        }
        if (-not $process.WaitForExit(10000)) {
            $process.Kill(); [void]$process.WaitForExit(5000)
            throw 'The owned lease helper did not close after release.'
        }
        if ($process.ExitCode -ne 0) { throw 'The owned lease helper rejected its release.' }
    } finally { $process.Dispose() }
}

try {
    $nodeVersion = (& $NodePath -p 'process.versions.node' | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -cnotmatch '^\d+\.\d+\.\d+$') { throw 'The actual Node input did not report a version.' }
    $nodeArchitecture = (& $NodePath -p 'process.arch' | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $nodeArchitecture -cne 'arm64') { throw 'The fixture requires actual native ARM64 Node.' }
    $receipt.node = [pscustomobject]@{ path = $NodePath; version = $nodeVersion; architecture = $nodeArchitecture;
        sha256 = (Get-FileHash -LiteralPath $NodePath -Algorithm SHA256).Hash.ToLowerInvariant() }
    $owner = Join-Path $SourceRoot 'packaging\windows\installer'
    $target = Join-Path $ArtifactDirectory 'cargo-target'
    try {
        $ErrorActionPreference = 'Continue'
        & rustup run 1.95.0-aarch64-pc-windows-msvc cargo rustc --locked --release `
            --target aarch64-pc-windows-msvc --features msi-boundary-fixture `
            --manifest-path (Join-Path $owner 'Cargo.toml') --target-dir $target -- -C target-feature=+crt-static `
            2>&1 | Tee-Object -FilePath (Join-Path $ArtifactDirectory 'helper-build.log') | Out-Host
        $buildExit = $LASTEXITCODE
    } finally { $ErrorActionPreference = 'Stop' }
    if ($buildExit -ne 0) { throw 'The actual native MSI fixture helper did not build.' }
    $helper = Join-Path $target 'aarch64-pc-windows-msvc\release\NemoClawRuntimeTransaction.exe'
    $identity = (& $helper --fixture-identify | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $identity -cne 'NEMOCLAW_MSI_FIXTURE_COMMIT_FAILURE_V1') { throw 'The fault-control helper variant was not selected.' }
    $receipt.helperSha256 = (Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash.ToLowerInvariant()
    $fixtureDirectory = Join-Path $ArtifactDirectory 'fixtures'
    & $PythonPath (Join-Path $owner 'build_msi_fixtures.py') --output $fixtureDirectory --node $NodePath --node-license $NodeLicensePath `
        --node-version $nodeVersion --helper $helper --source-revision $SourceRevision
    if ($LASTEXITCODE -ne 0) { throw 'The controlled MSI fixture source could not be prepared.' }
    $prepared = Get-Content -LiteralPath (Join-Path $fixtureDirectory 'fixtures.json') -Raw | ConvertFrom-Json
    $fixtures = @($prepared.fixtures)
    if ($fixtures.Count -ne 4 -or $prepared.helperSha256 -cne $receipt.helperSha256) { throw 'The fixture source identity changed.' }
    foreach ($fixture in $fixtures) {
        & $WixPath build -arch arm64 -d "ProductVersion=$($fixture.version)" -d "SourceRoot=$SourceRoot" `
            -d NativeRuntimeMsiPrototype=true -d "NativeRuntimeMsiAuthoring=$($fixture.authoring)" `
            (Join-Path $SourceRoot 'packaging\windows\Product.wxs') $fixture.payloadAuthoring -pdbtype none -out $fixture.msi
        if ($LASTEXITCODE -ne 0) { throw 'The actual MSI transaction fixture did not compile.' }
        & (Join-Path $owner 'audit-runtime-msi.ps1') -MsiPath $fixture.msi -HelperSha256 $receipt.helperSha256 `
            -ReceiptPath (Join-Path $ArtifactDirectory ($fixture.label + '.compiled-msi.json'))
    }
    $first = $fixtures[0]; $upgrade = $fixtures[1]
    $installed = Invoke-FixtureMsi '/i' $first.msi 'first-install'; $results.Add($installed)
    if ($installed.exitCode -ne 0) { throw 'The first MSI fixture did not install successfully.' }
    Assert-FixtureCurrent $first
    $snapshot = Get-FixtureSnapshot
    $lease = Start-FixtureLease $helper
    $receipt.heldLease = $lease.readiness
    foreach ($case in @(
        @{ Action = '/fa'; Msi = $first.msi; Label = 'busy-direct-repair' },
        @{ Action = '/x'; Msi = $first.msi; Label = 'busy-direct-uninstall' },
        @{ Action = '/i'; Msi = $upgrade.msi; Label = 'busy-major-upgrade' }
    )) {
        $result = Invoke-FixtureMsi $case.Action $case.Msi $case.Label; $results.Add($result)
        if ($result.exitCode -ne 1603 -or (Get-FixtureSnapshot) -cne $snapshot) {
            throw 'Active-reader maintenance did not refuse before changing the installed tree or ACLs.'
        }
        Assert-FixtureCurrent $first
    }
    Stop-FixtureLease $lease; $lease = $null
    $repair = Invoke-FixtureMsi '/fa' $first.msi 'released-direct-repair'; $results.Add($repair)
    if ($repair.exitCode -ne 0 -or (Get-FixtureSnapshot) -cne $snapshot) { throw 'Repair after lease release did not preserve the exact runtime.' }
    foreach ($fixture in @($fixtures[2],$fixtures[3])) {
        $failed = Invoke-FixtureMsi '/i' $fixture.msi $fixture.label; $results.Add($failed)
        if ($failed.exitCode -ne 1603 -or (Get-FixtureSnapshot) -cne $snapshot) {
            throw 'Actual MSI rollback did not restore the prior files and descriptor after the controlled failure.'
        }
        if ($fixture.label -ceq 'commit-failure' -and
            (Get-Content -LiteralPath $failed.log -Raw) -notmatch 'NativeRuntimeCommitInstall returned actual error code 47') {
            throw 'The intended commit failure before admission was not observed.'
        }
        Assert-FixtureCurrent $first
        $probeLease = Start-FixtureLease $helper; Stop-FixtureLease $probeLease
    }
    $upgraded = Invoke-FixtureMsi '/i' $upgrade.msi 'released-major-upgrade'; $results.Add($upgraded)
    if ($upgraded.exitCode -ne 0) { throw 'Upgrade after lease release did not complete.' }
    Assert-FixtureCurrent $upgrade
    $removed = Invoke-FixtureMsi '/x' $upgrade.msi 'released-direct-uninstall'; $results.Add($removed)
    if ($removed.exitCode -ne 0) { throw 'The final direct MSI uninstall failed.' }
    $remaining = @()
    if (Test-Path -LiteralPath $installation -ErrorAction Stop) {
        $remaining = @(Get-ChildItem -LiteralPath $installation -Recurse -File -Force -ErrorAction Stop)
    }
    if ($remaining.Count -ne 0) { throw 'Direct uninstall left installed fixture files.' }
    $receipt.emptyInstallationDirectoryRemains = Test-Path -LiteralPath $installation
    $receipt.status = 'pass'
} catch { $primary = $_; $receipt.error = $_.Exception.Message }
finally {
    try { if ($null -ne $lease) { Stop-FixtureLease $lease; $lease = $null } }
    catch { $cleanupFailures.Add('The owned lease helper could not be released: ' + $_.Exception.Message) }
    if ($null -ne $script:activeMsi) {
        $cleanupFailures.Add('A Windows Installer operation remains active; no overlapping uninstall was attempted.')
    } elseif ($script:msiAttempted) {
        foreach ($fixture in $fixtures) {
            if (-not (Test-Path -LiteralPath $fixture.msi)) { continue }
            try {
                $productCode = [NativeRuntimeMsiAudit]::ProductCode($fixture.msi)
                $state = [NativeRuntimeMsiAudit]::ProductState($productCode)
                if ($state -eq 5) {
                    $cleanup = Invoke-FixtureMsi '/x' $fixture.msi ('cleanup-' + $fixture.label)
                    if ($cleanup.exitCode -ne 0) { $cleanupFailures.Add('Fixture uninstall failed: ' + $fixture.label) }
                }
            } catch { $cleanupFailures.Add($_.Exception.Message) }
        }
    }
    if ($cleanupFailures.Count -gt 0) { $receipt.status = 'failed' }
    try {
        [IO.File]::WriteAllText((Join-Path $ArtifactDirectory 'msi-boundary.json'), (($receipt | ConvertTo-Json -Depth 12) + "`n"), [Text.UTF8Encoding]::new($false))
    } catch { if ($null -eq $primary) { $primary = $_ } else { Write-Warning ('Fixture receipt failed: ' + $_.Exception.Message) } }
}
if ($null -ne $primary) { throw $primary }
if ($cleanupFailures.Count -gt 0) { throw 'The MSI fixture cleanup did not complete.' }
Write-Host 'Connected MSI fixture controls passed; full product activation and cancellation/termination limits remain separate.'
