# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Finished native application CI package path; customer machines only install built files.
# This builds a candidate for installed tests; it cannot approve its own runtime.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$SourceRoot,
    [Parameter(Mandatory)][string]$SourceRevision,
    [Parameter(Mandatory)][string]$ProductVersion,
    [Parameter(Mandatory)][string]$HostPayloadRoot,
    [Parameter(Mandatory)][string]$RuntimeAssemblyRoot,
    [Parameter(Mandatory)][string]$OutputDirectory,
    [Parameter(Mandatory)][string]$PythonPath,
    [Parameter(Mandatory)][string]$DotNetPath,
    [Parameter(Mandatory)][string]$WixPath,
    [Parameter(Mandatory)][string]$SystemDrivePrepPath,
    [Parameter(Mandatory)][string]$SystemDriveBuildReceipt,
    [Parameter(Mandatory)][string]$SystemDriveProofDirectory,
    [string]$ReviewedAvailability = '',
    [string]$RuntimeImage = '',
    [string]$RuntimeImageReceipt = ''
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -cne 'Windows_NT' -or $env:GITHUB_ACTIONS -cne 'true' -or
    $SourceRevision -cnotmatch '^[a-f0-9]{40}$' -or $ProductVersion -cnotmatch '^\d+\.\d+\.\d+$') {
    throw 'The finished runtime package requires explicit disposable Windows CI inputs.'
}
if (Test-Path -LiteralPath $OutputDirectory) { throw 'The immutable package output must be fresh.' }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null
$work = Join-Path $OutputDirectory 'build'
[IO.Directory]::CreateDirectory($work) | Out-Null
$owner = Join-Path $SourceRoot 'packaging\windows\installer'
$windows = Join-Path $SourceRoot 'packaging\windows'
$receipt = [ordered]@{
    schemaVersion = 1; classification = 'finished-native-runtime-package-build'; sourceRevision = $SourceRevision;
    status = 'failed'; installedAcceptance = $false; activationAllowed = $false; phase = 'input-validation'
}
$primary = $null

function Invoke-BuildTool {
    param([string]$Executable, [string[]]$Arguments, [string]$Label)
    $log = Join-Path $work ($Label + '.log')
    $previous = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & $Executable @Arguments 2>&1 | Tee-Object -FilePath $log | Out-Host
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previous }
    if ($code -ne 0) { throw "The owned $Label command failed with exit code $code; its output is retained." }
}

# Read only the two compiled tables; do not enumerate/hash customer runtime bytes.
function Get-CompiledMsiCounts([string]$Path) {
    $installer = $null; $database = $null
    $result = [ordered]@{ fileCount = 0; componentCount = 0; fileBytes = [long]0 }
    try {
        $installer = New-Object -ComObject WindowsInstaller.Installer
        $database = $installer.OpenDatabase($Path, 0)
        foreach ($table in @('File', 'Component')) {
            $view = $null; $record = $null; $count = 0
            try {
                $query = if ($table -ceq 'File') { 'SELECT `FileSize` FROM `File`' } else { 'SELECT `Component` FROM `Component`' }
                $view = $database.OpenView($query); $null = $view.Execute()
                while ($null -ne ($record = $view.Fetch())) {
                    try {
                        $count++
                        if ($count -gt 1000000) { throw 'The compiled MSI measurement exceeds its row bound.' }
                        if ($table -ceq 'File') { $result.fileBytes += [long]$record.IntegerData(1) }
                    } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($record); $record = $null }
                }
                if ($table -ceq 'File') { $result.fileCount = $count } else { $result.componentCount = $count }
            } finally {
                if ($null -ne $record) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($record) }
                if ($null -ne $view) { try { $null = $view.Close() } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($view) } }
            }
        }
        return $result
    } finally {
        if ($null -ne $database) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($database) }
        if ($null -ne $installer) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($installer) }
    }
}

try {
    $sourceHead = (& git -C $SourceRoot rev-parse HEAD | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $sourceHead -cne $SourceRevision) { throw 'The package source differs from the declared controller.' }
    & git -C $SourceRoot diff --quiet HEAD
    if ($LASTEXITCODE -ne 0) { throw 'The package requires the exact committed source bytes.' }
    $untracked = @(& git -C $SourceRoot ls-files --others --exclude-standard -- packaging/windows)
    if ($LASTEXITCODE -ne 0 -or @($untracked | Where-Object { $_ -notmatch '/(?:bin|obj|\.local)/' }).Count -ne 0) {
        throw 'Uncommitted Windows source inputs cannot enter the package.'
    }
    $systemDriveGatePath = Join-Path $OutputDirectory 'system-drive-build-gate.json'
    Invoke-BuildTool $PythonPath @((Join-Path $owner 'verify-system-drive-proof.py'),
        '--helper', $SystemDrivePrepPath, '--build-receipt', $SystemDriveBuildReceipt,
        '--proof-directory', $SystemDriveProofDirectory, '--source-root', $SourceRoot,
        '--source-revision', $SourceRevision, '--node-path', (Join-Path $HostPayloadRoot 'bin\node.exe'),
        '--output', $systemDriveGatePath) 'system-drive-proof-verification'
    $systemDriveGate = Get-Content -LiteralPath $systemDriveGatePath -Raw | ConvertFrom-Json
    $systemDriveSha = [string]$systemDriveGate.helperSha256
    $receipt['systemDrivePreparation'] = $systemDriveGate
    $assembly = Get-Content -LiteralPath (Join-Path $RuntimeAssemblyRoot 'assembly.json') -Raw | ConvertFrom-Json
    if ($assembly.runtime.sourceRevision -cne $SourceRevision -or $assembly.buildCompleteForSelectedAgents -ne $true) {
        throw 'The selected runtime assembly differs from the package source.'
    }
    $sharedNodeVersion = (& (Join-Path $HostPayloadRoot 'bin\node.exe') --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $sharedNodeVersion -cne ('v' + [string]$assembly.runtime.nodeVersion)) {
        throw 'The actual shared Node version differs from the sealed runtime identity.'
    }
    # Absolute generated Python metadata is bound to the fixed target on this
    # Windows builder. A package for another Program Files path must be finalized
    # separately; source paths are never rewritten at an agent launch.
    $installedRoot = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)) 'NVIDIA\NemoClaw RTX Spark Preview'
    if ($assembly.installTargetEqualityRequired -and
        -not [string]::Equals([string]$assembly.pythonMetadataInstallRoot, $installedRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Generated interpreter metadata differs from this fixed installation target.'
    }
    $dotnetVersion = (& $DotNetPath --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $dotnetVersion -cne '8.0.419') { throw 'The package requires the pinned .NET SDK.' }
    $wixVersion = (& $WixPath --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $wixVersion -cnotmatch '^5\.0\.2(?:\+.*)?$') { throw 'The package requires pinned WiX 5.0.2.' }
    $receipt.phase = 'native-guardian-build'
    $launcherTarget = Join-Path $work 'launcher-target'
    $nativeArtifacts = Join-Path $work 'compiled-native'
    [IO.Directory]::CreateDirectory($nativeArtifacts) | Out-Null
    $materializer = Join-Path $owner 'materialize-compiled-executable.py'
    Invoke-BuildTool 'rustup' @('run', '1.95.0-aarch64-pc-windows-msvc', 'cargo', 'rustc', '--locked', '--release',
        '--target', 'aarch64-pc-windows-msvc', '--features', 'immutable-runtime', '--manifest-path',
        (Join-Path $windows 'launcher\Cargo.toml'), '--target-dir', $launcherTarget, '--', '-C', 'target-feature=+crt-static') 'launcher-build'
    $launcherBuilt = Join-Path $launcherTarget 'aarch64-pc-windows-msvc\release\NemoClaw.exe'
    $launcher = Join-Path $nativeArtifacts 'NemoClaw.exe'
    $launcherCopyReceipt = Join-Path $OutputDirectory 'compiled-launcher.json'
    Invoke-BuildTool $PythonPath @($materializer, '--source', $launcherBuilt, '--output', $launcher,
        '--receipt', $launcherCopyReceipt) 'launcher-materialization'
    $capabilityText = (& $launcher --runtime-capabilities | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $capabilityText.Length -gt 4096) { throw 'The actual launcher capability query failed.' }
    $capabilities = $capabilityText | ConvertFrom-Json
    if ($capabilities.immutableRuntime -ne $true -or $capabilities.guardianEnabled -ne $true) {
        throw 'The compiled launcher did not enable the package guardian.'
    }
    $capabilityPath = Join-Path $work 'launcher-capabilities.json'
    [IO.File]::WriteAllText($capabilityPath, (@{schemaVersion=1;launcherSha256=(Get-FileHash -LiteralPath $launcher -Algorithm SHA256).Hash.ToLowerInvariant();capabilities=$capabilities}|ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
    $helperTarget = Join-Path $work 'transaction-target'
    $previousImageId = $env:NEMOCLAW_RUNTIME_IMAGE_ID
    $previousImageSha = $env:NEMOCLAW_RUNTIME_IMAGE_SHA256
    try {
        if ($RuntimeImage) {
            $imageReceipt = Get-Content -LiteralPath $RuntimeImageReceipt -Raw | ConvertFrom-Json
            if ($imageReceipt.runtimeId -cne $assembly.runtime.runtimeId -or $imageReceipt.image.sha256 -cnotmatch '^[a-f0-9]{64}$') {
                throw 'The finished runtime image identity is invalid before native helper compilation.'
            }
            $env:NEMOCLAW_RUNTIME_IMAGE_ID = [string]$imageReceipt.runtimeId
            $env:NEMOCLAW_RUNTIME_IMAGE_SHA256 = [string]$imageReceipt.image.sha256
        } else {
            Remove-Item Env:NEMOCLAW_RUNTIME_IMAGE_ID -ErrorAction SilentlyContinue
            Remove-Item Env:NEMOCLAW_RUNTIME_IMAGE_SHA256 -ErrorAction SilentlyContinue
        }
        Invoke-BuildTool 'rustup' @('run', '1.95.0-aarch64-pc-windows-msvc', 'cargo', 'rustc', '--locked', '--release',
            '--target', 'aarch64-pc-windows-msvc', '--manifest-path', (Join-Path $owner 'Cargo.toml'),
            '--target-dir', $helperTarget, '--', '-C', 'target-feature=+crt-static') 'transaction-build'
    } finally {
        if ($null -eq $previousImageId) { Remove-Item Env:NEMOCLAW_RUNTIME_IMAGE_ID -ErrorAction SilentlyContinue }
        else { $env:NEMOCLAW_RUNTIME_IMAGE_ID = $previousImageId }
        if ($null -eq $previousImageSha) { Remove-Item Env:NEMOCLAW_RUNTIME_IMAGE_SHA256 -ErrorAction SilentlyContinue }
        else { $env:NEMOCLAW_RUNTIME_IMAGE_SHA256 = $previousImageSha }
    }
    $helperBuilt = Join-Path $helperTarget 'aarch64-pc-windows-msvc\release\NemoClawRuntimeTransaction.exe'
    $helper = Join-Path $nativeArtifacts 'NemoClawRuntimeTransaction.exe'
    $helperCopyReceipt = Join-Path $OutputDirectory 'compiled-transaction-helper.json'
    Invoke-BuildTool $PythonPath @($materializer, '--source', $helperBuilt, '--output', $helper,
        '--receipt', $helperCopyReceipt) 'transaction-helper-materialization'
    $receipt['compiledArtifacts'] = @($launcherCopyReceipt, $helperCopyReceipt) | ForEach-Object {
        @{ file = [IO.Path]::GetFileName($_); sha256 = (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant() }
    }
    $helperSha = (Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash.ToLowerInvariant()
    $receipt.phase = 'selected-package-composition'
    $payload = Join-Path $work 'payload'
    $composer = Join-Path $owner 'package_runtime.py'
    $compose = @($composer, 'compose', '--host', $HostPayloadRoot, '--assembled', $RuntimeAssemblyRoot,
        '--launcher', $launcher, '--capabilities', $capabilityPath, '--output', $payload)
    if ($ReviewedAvailability) { $compose += @('--reviewed-availability', $ReviewedAvailability) }
    if ([bool]$RuntimeImage -ne [bool]$RuntimeImageReceipt) { throw 'The runtime image and receipt must be supplied together.' }
    if ($RuntimeImage) { $compose += @('--runtime-image', $RuntimeImage, '--runtime-image-receipt', $RuntimeImageReceipt) }
    Invoke-BuildTool $PythonPath $compose 'compose'
    if ($RuntimeImage) {
        Remove-Item -LiteralPath (Join-Path $RuntimeAssemblyRoot 'runtimes') -Recurse -Force
    }
    $receipt.phase = 'native-ui-build'
    $project = Join-Path $windows 'bootstrapper\NemoClaw.Bootstrapper.csproj'
    $publish = Join-Path $work 'bootstrapper'
    $availability = Join-Path $payload 'runtime-package-availability.json'
    $properties = @('-p:PublishReadyToRun=true', "-p:ProductVersion=$ProductVersion", '-p:ImmutableRuntimePackage=true', "-p:ImmutableRuntimeAvailabilityFile=$availability")
    Invoke-BuildTool $DotNetPath (@('restore', $project, '--runtime', 'win-arm64') + $properties) 'bootstrapper-restore'
    Invoke-BuildTool $DotNetPath (@('publish', $project, '-c', 'Release', '--runtime', 'win-arm64', '--self-contained', 'true',
        '--no-restore', '--disable-build-servers', '--output', $publish) + $properties) 'bootstrapper-publish'
    $bootstrapperAuthoring = Join-Path $work 'BootstrapperPayloads.wxs'
    Invoke-BuildTool $PythonPath @($composer, 'bootstrapper', '--published', $publish, '--payload', $payload, '--output', $bootstrapperAuthoring) 'bootstrapper-inventory'
    $receipt.phase = 'native-msi-build'
    $payloadAuthoring = Join-Path $work 'Payload.wxs'
    $transactions = Join-Path $work 'RuntimeTransactions.wxi'
    $msi = Join-Path $OutputDirectory "NemoClaw-$ProductVersion-windows-arm64.msi"
    $cabinetDrive = 'P:'
    $cabinetRoot = $cabinetDrive + '\'
    $runtimeDrive = 'R:'
    $runtimeCabinetRoot = $runtimeDrive + '\'
    $subst = Join-Path $env:SystemRoot 'System32\subst.exe'
    if ((Test-Path -LiteralPath $cabinetRoot) -or (Test-Path -LiteralPath $runtimeCabinetRoot)) {
        throw 'A fixed CI cabinet source drive is already in use.'
    }
    & $subst $cabinetDrive $payload
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $cabinetRoot 'immutable-package-inputs.json') -PathType Leaf)) {
        throw 'The short CI cabinet source drive could not be bound to the verified payload.'
    }
    $imageDelivery = [bool]$RuntimeImage
    if (-not $imageDelivery) {
        $runtimePayload = Join-Path $payload (Join-Path 'runtimes' ([string]$assembly.runtime.runtimeId))
        & $subst $runtimeDrive $runtimePayload
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $runtimeCabinetRoot 'runtime.manifest') -PathType Leaf)) {
            & $subst $runtimeDrive /D
            & $subst $cabinetDrive /D
            throw 'The short CI runtime cabinet drive could not be bound to the verified runtime.'
        }
    }
    $cabinetFailure = $null
    try {
        $author = @($composer, 'author', '--payload', $payload, '--cabinet-source', $cabinetRoot,
            '--output', $payloadAuthoring, '--transaction-helper', $helper, '--transaction-output', $transactions)
        if (-not $imageDelivery) { $author += @('--cabinet-runtime-source', $runtimeCabinetRoot) }
        Invoke-BuildTool $PythonPath $author 'package-authoring'
        Invoke-BuildTool $WixPath @('build', '-arch', 'arm64', '-d', "ProductVersion=$ProductVersion", '-d', "SourceRoot=$SourceRoot",
            '-d', 'NativeRuntimeMsiPrototype=false', '-d', 'ImmutableRuntimePackage=true', '-d', "NativeRuntimeMsiAuthoring=$transactions",
            (Join-Path $windows 'Product.wxs'), $payloadAuthoring, '-pdbtype', 'none', '-wx', '-out', $msi) 'msi-build'
    } catch { $cabinetFailure = $_ }
    finally {
        if (-not $imageDelivery) {
            & $subst $runtimeDrive /D
            if ($LASTEXITCODE -ne 0 -and $null -eq $cabinetFailure) {
                $cabinetFailure = [InvalidOperationException]::new('The short CI runtime cabinet drive could not be released.')
            }
        }
        & $subst $cabinetDrive /D
        if ($LASTEXITCODE -ne 0 -and $null -eq $cabinetFailure) {
            $cabinetFailure = [InvalidOperationException]::new('The short CI cabinet source drive could not be released.')
        }
    }
    if ($null -ne $cabinetFailure) { throw $cabinetFailure }
    # Same existing ICE60 exception as NemoClaw.wixproj; all other ICEs run.
    Invoke-BuildTool $WixPath @('msi', 'validate', '-sice', 'ICE60', '-wx', $msi) 'msi-validation'
    & (Join-Path $owner 'audit-runtime-msi.ps1') -MsiPath $msi -HelperSha256 $helperSha -ReceiptPath (Join-Path $OutputDirectory 'compiled-msi.json') -RequireInstallationRootRemoval
    $receipt['compiledMsi'] = Get-CompiledMsiCounts $msi
    $payloadFiles = @(Get-ChildItem -LiteralPath $payload -Recurse -File)
    $receipt['payload'] = @{ fileCount = $payloadFiles.Count; bytes = [long](($payloadFiles | Measure-Object -Property Length -Sum).Sum) }
    $receipt.phase = 'native-burn-build'
    # Consume the same executed binary; the package builder never rebuilds it.
    if ((Get-FileHash -LiteralPath $SystemDrivePrepPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $systemDriveSha) {
        throw 'The proven system-drive helper changed before Burn composition.'
    }
    $setup = Join-Path $OutputDirectory "NemoClawSetup-$ProductVersion-windows-arm64.exe"
    $runtimeTuple = @($assembly.runtime.runtimeId, $assembly.runtime.manifestSha256, $assembly.runtime.sourceRevision,
        $assembly.runtime.nodeSha256, $assembly.runtime.nodeVersion) -join ' '
    Invoke-BuildTool $WixPath @('build', '-arch', 'arm64', '-d', "ProductVersion=$ProductVersion", '-d', "SourceRoot=$SourceRoot",
        '-d', "MsiPath=$msi", '-d', "WxcHostPrepPath=$(Join-Path $payload 'mxc\wxc-host-prep.exe')", '-d', "WxcExecPath=$(Join-Path $payload 'mxc\wxc-exec.exe')",
        '-d', 'SystemDriveMetadataPreparation=true', '-d', "SystemDrivePrepPath=$SystemDrivePrepPath", '-d', "SystemDrivePrepSha256=$systemDriveSha",
        '-d', 'RuntimeUpgradePreparation=true',
        '-d', "RuntimeImageFinalization=$($imageDelivery.ToString().ToLowerInvariant())", '-d', "RuntimeFinalizerPath=$helper",
        '-d', "RuntimeFinalizerSha256=$helperSha", '-d', "RuntimeTuple=$runtimeTuple", '-d', "RuntimeId=$($assembly.runtime.runtimeId)",
        '-d', "BootstrapperPath=$(Join-Path $publish 'NemoClaw.Bootstrapper.exe')", '-d', "BootstrapperRoot=$publish",
        (Join-Path $windows 'Bundle.wxs'), $bootstrapperAuthoring, '-pdbtype', 'none', '-wx', '-sw1161', '-out', $setup) 'burn-build'
    $receipt['runtime'] = $assembly.runtime
    $receipt['files'] = @($msi, $setup) | ForEach-Object { @{file=[IO.Path]::GetFileName($_);bytes=(Get-Item -LiteralPath $_).Length;sha256=(Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant()} }
    $receipt['launcherCapabilitiesSha256'] = (Get-FileHash -LiteralPath $capabilityPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $receipt['transactionHelperSha256'] = $helperSha
    & git -C $SourceRoot diff --quiet HEAD
    if ($LASTEXITCODE -ne 0) { throw 'The committed package source changed during the build.' }
    $receipt.status = 'candidate-built-for-installed-qualification'
} catch { $primary = $_; $receipt['error'] = $_.Exception.Message }
finally {
    try { [IO.File]::WriteAllText((Join-Path $OutputDirectory 'immutable-package-build.json'), ($receipt|ConvertTo-Json -Depth 8)+"`n", [Text.UTF8Encoding]::new($false)) }
    catch { if ($null -eq $primary) { $primary = $_ } else { Write-Warning 'The failed package receipt also could not be saved.' } }
}
if ($null -ne $primary) { throw $primary }
