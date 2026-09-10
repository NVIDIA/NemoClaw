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
if ($null -eq [Diagnostics.ProcessStartInfo].GetProperty('StandardInputEncoding')) { throw 'The MSI fixtures require PowerShell Core with explicit stdin encoding support.' }
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
    status = 'failed'; results = $results; cleanupFailures = $cleanupFailures;
    snapshots = [ordered]@{}; snapshotDiffsFromFirstInstall = [ordered]@{} }

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

function Add-FixtureSnapshotEvidence {
    param([string]$Label, [string]$Value)
    if (-not $Label) { return }
    $receipt.snapshots[$Label] = $Value
    if ($receipt.snapshots.Contains('first-install')) {
        $receipt.snapshotDiffsFromFirstInstall[$Label] = @(Compare-Object -CaseSensitive `
            -ReferenceObject ([string[]]($receipt.snapshots['first-install'] -split "`n")) `
            -DifferenceObject ([string[]]($Value -split "`n")) | ForEach-Object {
                [pscustomobject]@{ side = $_.SideIndicator; row = $_.InputObject }
            })
    }
}

function Compare-RecreatedFixtureFiles {
    param([Parameter(Mandatory)][string]$Before, [Parameter(Mandatory)][string]$After)
    $previous = @($Before -split "`n"); $current = @($After -split "`n")
    if ($previous.Count -ne $current.Count) { throw 'Repair changed the exact fixture inventory.' }
    $changes = [Collections.Generic.List[object]]::new()
    for ($index = 0; $index -lt $previous.Count; $index++) {
        if ($previous[$index] -ceq $current[$index]) { continue }
        $left = @($previous[$index] -split '\|', 4); $right = @($current[$index] -split '\|', 4)
        # Only MSI-owned recreated files may lose the AI control metadata. The
        # selector, directories, owner/group, protection, ACE order/flags/masks,
        # path and content hash must stay byte-for-byte equal. No ACL is edited.
        # SE_DACL_AUTO_INHERITED describes propagation support; regular files
        # have no children. This exception is never used for busy or rollback.
        if ($left.Count -ne 4 -or $right.Count -ne 4 -or $left[0] -cne 'F' -or
            $left[1] -cnotmatch '^/(?:bin/node\.exe|runtimes/[a-f0-9]{64}/(?:NODE-LICENSE\.txt|payload\.txt|runtime\.manifest|runtime\.ready))$' -or
            $left[0] -cne $right[0] -or $left[1] -cne $right[1] -or $left[2] -cne $right[2]) {
            throw 'Repair changed a protected fixture identity or security descriptor.'
        }
        $metadata = [regex]::Match($left[3], '\A(?<prefix>[^()]*D:)AI(?<body>\(.*)\z')
        if (-not $metadata.Success -or ($metadata.Groups['prefix'].Value + $metadata.Groups['body'].Value) -cne $right[3]) {
            throw 'Repair changed file access, ownership, protection or inheritance flags.'
        }
        $changes.Add([pscustomobject]@{ path = $left[1]; control = 'SE_DACL_AUTO_INHERITED'; before = 'set'; after = 'clear' })
    }
    return $changes.ToArray()
}

function Compare-RolledBackFixtureLeaf {
    param([Parameter(Mandatory)][string]$Before, [Parameter(Mandatory)][string]$After,
        [Parameter(Mandatory)][string]$RuntimeId)
    if ($RuntimeId -cnotmatch '^[a-f0-9]{64}$') { throw 'Rollback requires the exact prior fixture runtime identity.' }
    $leaf = '/runtimes/' + $RuntimeId + '/empty'
    $previous = @($Before -split "`n"); $current = @($After -split "`n")
    if ($previous.Count -ne $current.Count) { throw 'Rollback changed the exact fixture inventory.' }
    $paths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $changes = [Collections.Generic.List[object]]::new()
    $foundLeaf = $false
    for ($index = 0; $index -lt $previous.Count; $index++) {
        $left = @($previous[$index] -split '\|'); $right = @($current[$index] -split '\|')
        if ($left.Count -lt 3 -or $right.Count -ne $left.Count -or $left[0] -cne $right[0] -or
            $left[1] -cne $right[1] -or -not $paths.Add($left[1])) {
            throw 'Rollback changed a fixture path, kind or inventory identity.'
        }
        # The exact fixture leaf must have no descendants in either complete
        # snapshot. Every corresponding path is checked above, case-sensitively.
        if ($left[1].StartsWith($leaf + '/', [StringComparison]::OrdinalIgnoreCase) -or
            $right[1].StartsWith($leaf + '/', [StringComparison]::OrdinalIgnoreCase)) {
            throw 'The rollback metadata exception requires an empty fixture leaf.'
        }
        if ($left[1] -cne $leaf) {
            if ($previous[$index] -cne $current[$index]) { throw 'Rollback changed a protected fixture entry.' }
            continue
        }
        if ($left.Count -ne 3 -or $left[0] -cne 'D') { throw 'The known rollback leaf is not a directory.' }
        $foundLeaf = $true
        if ($previous[$index] -ceq $current[$index]) { continue }
        # MSI FolderCreate may clear AI when reconstructing this owned empty
        # directory. Preserve every other SDDL byte: owner/group, protection,
        # ACE order, flags and masks. No production ACL is changed or normalized.
        $metadata = [regex]::Match($left[2], '\A(?<prefix>[^()]*D:)AI(?<body>\(.*)\z')
        if (-not $metadata.Success -or ($metadata.Groups['prefix'].Value + $metadata.Groups['body'].Value) -cne $right[2]) {
            throw 'Rollback changed leaf access, ownership, protection or inheritance flags.'
        }
        $changes.Add([pscustomobject]@{ path = $leaf; control = 'SE_DACL_AUTO_INHERITED';
            before = 'set'; after = 'clear'; emptyBefore = $true; emptyAfter = $true })
    }
    if (-not $foundLeaf) { throw 'The known rollback fixture leaf is missing.' }
    return $changes.ToArray()
}

function Get-FixtureSnapshot {
    param([string]$Label = '')
    $records = [Collections.Generic.List[string]]::new()
    $records.Add('D|/|' + (Get-Acl -LiteralPath $installation).Sddl)
    foreach ($item in @(Get-ChildItem -LiteralPath $installation -Recurse -Force | Sort-Object FullName)) {
        if ($item.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) { throw 'The installed fixture contains a redirected entry.' }
        $relative = $item.FullName.Substring($installation.Length).Replace('\','/')
        $acl = (Get-Acl -LiteralPath $item.FullName).Sddl
        if ($item.PSIsContainer) { $records.Add('D|' + $relative + '|' + $acl) }
        else { $records.Add('F|' + $relative + '|' + (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash + '|' + $acl) }
    }
    $value = $records.ToArray() -join "`n"
    Add-FixtureSnapshotEvidence -Label $Label -Value $value
    return $value
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
    param([string]$Helper,[string]$Arguments = '--runtime-session openclaw')
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $Helper; $start.Arguments = $Arguments
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true; $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    $process = $null
    try {
        if ($null -eq $start.GetType().GetProperty('StandardInputEncoding')) {
            throw 'The MSI lease fixtures require PowerShell Core with explicit stdin encoding support.'
        }
        $start.StandardInputEncoding = [Text.UTF8Encoding]::new($false)
        $process = [Diagnostics.Process]::Start($start)
        if ($null -eq $process) { throw 'The owned lease helper did not start.' }
        $stderr = $process.StandardError.ReadToEndAsync()
        $evidence = [ordered]@{ pid = $process.Id; startedUtc = $process.StartTime.ToUniversalTime().ToString('o');
            releaseRequested = $false; exitCode = $null; stderr = $null; stderrComplete = $false;
            stdinCodePage = $process.StandardInput.Encoding.CodePage;
            stdinPreambleBytes = $process.StandardInput.Encoding.GetPreamble().Length;
            observations = [Collections.Generic.List[object]]::new() }
        if ($evidence.stdinPreambleBytes -ne 0) { throw 'The owned release channel acquired an encoding preamble.' }
        $line = $process.StandardOutput.ReadLineAsync()
        if (-not $line.Wait(15000)) { throw 'The actual package lease did not report readiness.' }
        $ready = $line.GetAwaiter().GetResult() | ConvertFrom-Json
        if ($ready.kind -cne 'native-runtime-session' -or $ready.leaseHeld -ne $true -or $process.HasExited) {
            throw 'The actual native helper did not retain its package lease.'
        }
        $owned = [pscustomobject]@{ process = $process; readiness = $ready; stderr = $stderr; evidence = $evidence }
        Add-FixtureLeaseObservation $owned 'ready'
        return $owned
    } catch {
        $leaseError = $_
        if ($null -ne $process) {
            try {
                $process.StandardInput.Close()
                if (-not $process.WaitForExit(5000)) { $process.Kill(); [void]$process.WaitForExit(5000) }
            } catch { Write-Warning ('Lease startup cleanup failed: ' + $_.Exception.Message) }
            finally { $process.Dispose() }
        }
        throw $leaseError
    }
}

function Add-FixtureLeaseObservation {
    param([object]$OwnedLease,[string]$Label)
    $process = $OwnedLease.process
    $process.Refresh()
    $exited = $process.HasExited
    $exitCode = $null
    if ($exited) { $exitCode = $process.ExitCode }
    $OwnedLease.evidence.observations.Add([pscustomobject]@{ label = $Label;
        observedUtc = [DateTime]::UtcNow.ToString('o'); hasExited = $exited; exitCode = $exitCode })
}

function Stop-FixtureLease {
    param([object]$OwnedLease)
    if ($null -eq $OwnedLease) { return }
    $process = $OwnedLease.process
    $failure = $null
    try {
        Add-FixtureLeaseObservation $OwnedLease 'before-release'
        if (-not $process.HasExited) {
            $OwnedLease.evidence.releaseRequested = $true
            $bytes = [Text.Encoding]::UTF8.GetBytes("release`n")
            $process.StandardInput.BaseStream.Write($bytes,0,$bytes.Length)
            $process.StandardInput.BaseStream.Flush(); $process.StandardInput.Close()
        }
        if (-not $process.WaitForExit(10000)) {
            $process.Kill(); [void]$process.WaitForExit(5000)
            throw 'The owned lease helper did not close after release.'
        }
        if ($process.ExitCode -ne 0) { throw 'The owned lease helper rejected its release.' }
    } catch { $failure = $_ }
    finally {
        try {
            Add-FixtureLeaseObservation $OwnedLease 'closed'
            if ($process.HasExited) { $OwnedLease.evidence.exitCode = $process.ExitCode }
            if (-not $OwnedLease.stderr.Wait(5000)) { throw 'The owned lease helper stderr did not close.' }
            $text = $OwnedLease.stderr.GetAwaiter().GetResult()
            $OwnedLease.evidence.stderr = $text.Substring(0,[Math]::Min(8192,$text.Length))
            $OwnedLease.evidence.stderrComplete = $text.Length -le 8192
        } catch {
            if ($null -eq $failure) { $failure = $_ }
            else { Write-Warning ('Lease failure evidence could not be completed: ' + $_.Exception.Message) }
        } finally { $process.Dispose() }
    }
    if ($null -ne $failure) { throw $failure }
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
    & (Join-Path $PSScriptRoot 'test-runtime-msi-repair-snapshot.ps1') -SourcePath $PSCommandPath
    & (Join-Path $PSScriptRoot 'test-runtime-msi-rollback-snapshot.ps1') -SourcePath $PSCommandPath
    $first = $fixtures[0]; $upgrade = $fixtures[1]
    $installed = Invoke-FixtureMsi '/i' $first.msi 'first-install'; $results.Add($installed)
    if ($installed.exitCode -ne 0) { throw 'The first MSI fixture did not install successfully.' }
    Assert-FixtureCurrent $first
    $snapshot = Get-FixtureSnapshot -Label 'first-install'
    $lease = Start-FixtureLease $helper
    $receipt.heldLease = $lease.readiness
    $receipt.leaseProcess = $lease.evidence
    foreach ($case in @(
        @{ Action = '/fa'; Msi = $first.msi; Label = 'busy-direct-repair' },
        @{ Action = '/x'; Msi = $first.msi; Label = 'busy-direct-uninstall' },
        @{ Action = '/i'; Msi = $upgrade.msi; Label = 'busy-major-upgrade' }
    )) {
        Add-FixtureLeaseObservation $lease ($case.Label + '-before')
        if ($lease.process.HasExited) { throw 'The owned lease helper exited before busy maintenance.' }
        $result = Invoke-FixtureMsi $case.Action $case.Msi $case.Label; $results.Add($result)
        Add-FixtureLeaseObservation $lease ($case.Label + '-after')
        if ($lease.process.HasExited -or $result.exitCode -ne 1603 -or (Get-FixtureSnapshot -Label $case.Label) -cne $snapshot) {
            throw 'Active-reader maintenance did not refuse before changing the installed tree or ACLs.'
        }
        Assert-FixtureCurrent $first
    }
    if ((Get-FixtureSnapshot -Label 'before-lease-release') -cne $snapshot) { throw 'The active lease changed the exact fixture snapshot.' }
    $closingLease = $lease; $lease = $null
    Stop-FixtureLease $closingLease
    if ((Get-FixtureSnapshot -Label 'after-lease-release') -cne $snapshot) { throw 'Lease release changed the exact fixture snapshot.' }
    $repair = Invoke-FixtureMsi '/fa' $first.msi 'released-direct-repair'; $results.Add($repair)
    $repairedSnapshot = Get-FixtureSnapshot -Label 'released-direct-repair'
    if ($repair.exitCode -ne 0) { throw 'Repair after lease release failed.' }
    $receipt['recreatedFileMetadataChanges'] = @(Compare-RecreatedFixtureFiles -Before $snapshot -After $repairedSnapshot)
    # Preserve the raw post-repair baseline for subsequent transaction checks.
    $snapshot = $repairedSnapshot
    Assert-FixtureCurrent $first
    foreach ($fixture in @($fixtures[2],$fixtures[3])) {
        $failed = Invoke-FixtureMsi '/i' $fixture.msi $fixture.label; $results.Add($failed)
        $rolledBackSnapshot = Get-FixtureSnapshot -Label $fixture.label
        if ($failed.exitCode -ne 1603) { throw 'The controlled MSI failure did not return 1603.' }
        if ($fixture.label -ceq 'deferred-failure' -and
            (Get-Content -LiteralPath $failed.log -Raw) -notmatch 'FixtureDeferredFailure returned actual error code 42') {
            throw 'The intended deferred failure was not observed.'
        }
        if ($fixture.label -ceq 'commit-failure' -and
            (Get-Content -LiteralPath $failed.log -Raw) -notmatch 'NativeRuntimeCommitInstall returned actual error code 47') {
            throw 'The intended commit failure before admission was not observed.'
        }
        $receipt['rollbackLeafMetadataChanges-' + $fixture.label] = @(Compare-RolledBackFixtureLeaf `
            -Before $snapshot -After $rolledBackSnapshot -RuntimeId $first.identity.runtimeId)
        # Keep the actual post-rollback bytes as the next exact baseline.
        $snapshot = $rolledBackSnapshot
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
    try { if ($null -ne $lease) { $closingLease = $lease; $lease = $null; Stop-FixtureLease $closingLease } }
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
