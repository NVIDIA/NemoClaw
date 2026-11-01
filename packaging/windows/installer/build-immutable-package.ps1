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
    [string]$UnqualifiedPackageDirectory = '',
    [string]$RuntimeImage = '',
    [string]$RuntimeImageReceipt = ''
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -cne 'Windows_NT' -or $env:GITHUB_ACTIONS -cne 'true' -or
    $SourceRevision -cnotmatch '^[a-f0-9]{40}$' -or $ProductVersion -cnotmatch '^\d+\.\d+\.\d+$') {
    throw 'The finished runtime package requires explicit disposable Windows CI inputs.'
}
if ($UnqualifiedPackageDirectory -and (-not $ReviewedAvailability -or $RuntimeImage -or $RuntimeImageReceipt)) {
    throw 'Reviewed recomposition requires an availability decision and the original single-agent package without replacement image inputs.'
}
if (Test-Path -LiteralPath $OutputDirectory) { throw 'The immutable package output must be fresh.' }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
if ($UnqualifiedPackageDirectory) {
    $originalDirectory = [IO.Path]::GetFullPath($UnqualifiedPackageDirectory).TrimEnd([IO.Path]::DirectorySeparatorChar)
    if ($OutputDirectory.Equals($originalDirectory, [StringComparison]::OrdinalIgnoreCase) -or
        $OutputDirectory.StartsWith($originalDirectory + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Reviewed recomposition must not write inside the original package.'
    }
}
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

function Get-PackagedMxcProbeSha256 {
    param([string]$HostPayload, [string]$Payload, [string]$ExpectedSource, [string]$RunId, [string]$RunAttempt)
    $receiptPath = Join-Path $HostPayload 'runtime-payload-receipt.json'
    $receiptFile = Get-Item -LiteralPath $receiptPath -Force
    if ($receiptFile -isnot [IO.FileInfo] -or $receiptFile.Length -gt 65536 -or
        ($receiptFile.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'The MXC host receipt is not a bounded ordinary file.'
    }
    $hostReceipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
    $build = $hostReceipt.mxcBuild
    if ($ExpectedSource -cnotmatch '^[a-f0-9]{40}$' -or $RunId -cnotmatch '^[1-9][0-9]*$' -or $RunAttempt -cnotmatch '^[1-9][0-9]*$' -or
        $hostReceipt.schemaVersion -ne 1 -or $hostReceipt.classification -cne 'finished-native-host-components' -or
        $hostReceipt.sourceRevision -cne $ExpectedSource -or $build.schemaVersion -ne 1 -or
        $build.classification -cne 'ci-built-mxc-host-binaries' -or $build.requestedSourceRevision -cne $ExpectedSource -or
        $build.sourceUnchanged -isnot [bool] -or $build.sourceUnchanged -ne $true -or
        $build.currentPackageQualification -isnot [bool] -or $build.currentPackageQualification -ne $false -or
        $build.workflowRunId -cne $RunId -or $build.workflowRunAttempt -cne $RunAttempt -or
        $build.mxcRevision -cnotmatch '^[a-f0-9]{40}$' -or $build.mxcRevision -cne $hostReceipt.mxcSourceRevision -or
        $build.rustTarget -cne 'aarch64-pc-windows-msvc') {
        throw 'The packaged MXC probe requires its admitted same-source, same-run ARM64 receipt.'
    }
    $built = @($build.files | Where-Object file -CEQ 'wxc-exec.exe')
    $staged = @($hostReceipt.files | Where-Object file -CEQ 'mxc/wxc-exec.exe')
    if ($built.Count -ne 1 -or $staged.Count -ne 1 -or
        $built[0].sha256 -cnotmatch '^[a-f0-9]{64}$' -or $built[0].bytes -le 0 -or
        $staged[0].sha256 -cne $built[0].sha256 -or $staged[0].bytes -ne $built[0].bytes) {
        throw 'The packaged MXC probe has no unique matching build and staging identity.'
    }
    $probe = Get-Item -LiteralPath (Join-Path $Payload 'mxc\wxc-exec.exe') -Force
    if ($probe -isnot [IO.FileInfo] -or ($probe.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        $probe.Length -ne $built[0].bytes -or
        (Get-FileHash -LiteralPath $probe.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -cne $built[0].sha256) {
        throw 'The packaged MXC probe differs from its admitted build.'
    }
    return [string]$built[0].sha256
}

function Get-RecompositionBuild {
    param([string]$Package, [string]$ExpectedSource, $ExpectedRuntime)
    $buildPath = Join-Path $Package 'immutable-package-build.json'
    $build = Get-Content -LiteralPath $buildPath -Raw | ConvertFrom-Json
    if ($build.schemaVersion -ne 1 -or $build.classification -cne 'finished-native-runtime-package-build' -or
        $build.sourceRevision -cne $ExpectedSource -or $build.status -cne 'candidate-built-for-installed-qualification' -or
        $build.installedAcceptance -isnot [bool] -or $build.installedAcceptance -or
        $build.activationAllowed -isnot [bool] -or $build.activationAllowed) {
        throw 'Reviewed recomposition requires the exact original candidate build receipt.'
    }
    foreach ($field in @('runtimeId', 'manifestSha256', 'sourceRevision', 'nodeSha256', 'nodeVersion')) {
        if ($build.runtime.$field -cne $ExpectedRuntime.$field) {
            throw 'Reviewed recomposition cannot change the built runtime tuple.'
        }
    }
    $capabilitiesPath = Join-Path $Package 'build\launcher-capabilities.json'
    if ((Get-FileHash -LiteralPath $capabilitiesPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $build.launcherCapabilitiesSha256) {
        throw 'The original launcher capability observation changed.'
    }
    $capabilities = Get-Content -LiteralPath $capabilitiesPath -Raw | ConvertFrom-Json
    foreach ($artifact in @(
        @{ path='build\compiled-native\NemoClaw.exe'; sha256=$capabilities.launcherSha256 },
        @{ path='build\compiled-native\NemoClawRuntimeTransaction.exe'; sha256=$build.transactionHelperSha256 }
    )) {
        $file = Get-Item -LiteralPath (Join-Path $Package $artifact.path) -Force
        if ($file -isnot [IO.FileInfo] -or $file.Length -le 0 -or
            ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
            $artifact.sha256 -cnotmatch '^[a-f0-9]{64}$' -or
            (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -cne $artifact.sha256) {
            throw 'An original compiled native artifact changed before recomposition.'
        }
    }
    return $build
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
        '--host-payload-root', $HostPayloadRoot,
        '--output', $systemDriveGatePath) 'system-drive-proof-verification'
    $systemDriveGate = Get-Content -LiteralPath $systemDriveGatePath -Raw | ConvertFrom-Json
    $systemDriveSha = [string]$systemDriveGate.helperSha256
    $receipt['systemDrivePreparation'] = $systemDriveGate
    $assembly = Get-Content -LiteralPath (Join-Path $RuntimeAssemblyRoot 'assembly.json') -Raw | ConvertFrom-Json
    if ($assembly.runtime.sourceRevision -cne $SourceRevision -or $assembly.buildCompleteForSelectedAgents -ne $true) {
        throw 'The selected runtime assembly differs from the package source.'
    }
    $priorBuild = $null
    if ($UnqualifiedPackageDirectory) {
        $priorBuild = Get-RecompositionBuild $UnqualifiedPackageDirectory $SourceRevision $assembly.runtime
        $receipt['reviewedRecomposition'] = @{
            originalBuildSha256 = (Get-FileHash -LiteralPath (Join-Path $UnqualifiedPackageDirectory 'immutable-package-build.json') -Algorithm SHA256).Hash.ToLowerInvariant()
            decisionSha256 = (Get-FileHash -LiteralPath $ReviewedAvailability -Algorithm SHA256).Hash.ToLowerInvariant()
            runtimeRebuilt = $false
            nativeArtifactsRebuilt = $false
            finalInstalledAcceptanceRequired = $true
        }
    }
    $sharedNodeVersion = (& (Join-Path $HostPayloadRoot 'bin\node.exe') --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $sharedNodeVersion -cne ('v' + [string]$assembly.runtime.nodeVersion)) {
        throw 'The actual shared Node version differs from the sealed runtime identity.'
    }
    # Absolute generated Python metadata is bound to the fixed target on this
    # Windows builder. A package for another Program Files path must be finalized
    # separately; source paths are never rewritten at an agent launch.
    $installedRoot = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)) 'NVIDIA\NemoClaw'
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
    if (-not $UnqualifiedPackageDirectory) {
        Invoke-BuildTool 'rustup' @('run', '1.95.0-aarch64-pc-windows-msvc', 'cargo', 'rustc', '--locked', '--release',
        '--target', 'aarch64-pc-windows-msvc', '--features', 'immutable-runtime', '--manifest-path',
        (Join-Path $windows 'launcher\Cargo.toml'), '--target-dir', $launcherTarget, '--', '-C', 'target-feature=+crt-static') 'launcher-build'
        $launcherBuilt = Join-Path $launcherTarget 'aarch64-pc-windows-msvc\release\NemoClaw.exe'
    } else {
        $launcherBuilt = Join-Path $UnqualifiedPackageDirectory 'build\compiled-native\NemoClaw.exe'
    }
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
        if (-not $UnqualifiedPackageDirectory) {
            Invoke-BuildTool 'rustup' @('run', '1.95.0-aarch64-pc-windows-msvc', 'cargo', 'rustc', '--locked', '--release',
            '--target', 'aarch64-pc-windows-msvc', '--manifest-path', (Join-Path $owner 'Cargo.toml'),
            '--target-dir', $helperTarget, '--', '-C', 'target-feature=+crt-static') 'transaction-build'
        }
    } finally {
        if ($null -eq $previousImageId) { Remove-Item Env:NEMOCLAW_RUNTIME_IMAGE_ID -ErrorAction SilentlyContinue }
        else { $env:NEMOCLAW_RUNTIME_IMAGE_ID = $previousImageId }
        if ($null -eq $previousImageSha) { Remove-Item Env:NEMOCLAW_RUNTIME_IMAGE_SHA256 -ErrorAction SilentlyContinue }
        else { $env:NEMOCLAW_RUNTIME_IMAGE_SHA256 = $previousImageSha }
    }
    $helperBuilt = Join-Path $helperTarget 'aarch64-pc-windows-msvc\release\NemoClawRuntimeTransaction.exe'
    if ($UnqualifiedPackageDirectory) {
        $helperBuilt = Join-Path $UnqualifiedPackageDirectory 'build\compiled-native\NemoClawRuntimeTransaction.exe'
    }
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
    if ($UnqualifiedPackageDirectory) {
        $compose = @($composer, 'recompose-reviewed', '--payload', (Join-Path $UnqualifiedPackageDirectory 'build\payload'),
            '--assembly', (Join-Path $RuntimeAssemblyRoot 'assembly.json'), '--reviewed-availability', $ReviewedAvailability, '--output', $payload)
    } else {
        $compose = @($composer, 'compose', '--host', $HostPayloadRoot, '--assembled', $RuntimeAssemblyRoot,
            '--launcher', $launcher, '--capabilities', $capabilityPath, '--output', $payload)
        if ($ReviewedAvailability) { $compose += @('--reviewed-availability', $ReviewedAvailability) }
    }
    if ([bool]$RuntimeImage -ne [bool]$RuntimeImageReceipt) { throw 'The runtime image and receipt must be supplied together.' }
    if ($RuntimeImage) { $compose += @('--runtime-image', $RuntimeImage, '--runtime-image-receipt', $RuntimeImageReceipt) }
    Invoke-BuildTool $PythonPath $compose 'compose'
    # The same-run transfer retains this compiled launcher outside the install
    # root. Bind its source and packaged bytes; this does not authorize inspection.
    $launcherEvidencePath = Join-Path $OutputDirectory 'launcher-build-inputs.json'
    Invoke-BuildTool $PythonPath @((Join-Path $owner 'launcher-build-evidence.py'),
        '--source-root', $SourceRoot, '--package-root', $OutputDirectory,
        '--source-revision', $SourceRevision, '--run-id', $env:GITHUB_RUN_ID,
        '--run-attempt', $env:GITHUB_RUN_ATTEMPT, '--output', $launcherEvidencePath) 'launcher-build-inputs'
    $receipt['launcherBuildInputs'] = @{
        file = 'launcher-build-inputs.json'; bytes = (Get-Item -LiteralPath $launcherEvidencePath).Length;
        sha256 = (Get-FileHash -LiteralPath $launcherEvidencePath -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    if ($RuntimeImage) {
        Remove-Item -LiteralPath (Join-Path $RuntimeAssemblyRoot 'runtimes') -Recurse -Force
    }
    $receipt.phase = 'native-ui-build'
    $project = Join-Path $windows 'bootstrapper\NemoClaw.Bootstrapper.csproj'
    $publish = Join-Path $work 'bootstrapper'
    $availability = Join-Path $payload 'runtime-package-availability.json'
    $mxcProbeSha = Get-PackagedMxcProbeSha256 $HostPayloadRoot $payload $SourceRevision $env:GITHUB_RUN_ID $env:GITHUB_RUN_ATTEMPT
    $properties = @('-p:PublishReadyToRun=true', "-p:ProductVersion=$ProductVersion", '-p:ImmutableRuntimePackage=true', "-p:ImmutableRuntimeAvailabilityFile=$availability", "-p:MxcProbeSha256=$mxcProbeSha")
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
    # Reviewed recomposition retains the original image without a new image input.
    $packageInputs = Get-Content -LiteralPath (Join-Path $payload 'immutable-package-inputs.json') -Raw | ConvertFrom-Json
    $imageDelivery = $packageInputs.deliveryContract -ceq 'finished-native-image-v1'
    $cabinetFailure = $null
    $cabinetMapped = $false
    $runtimeMapped = $false
    $cabinetCleanupErrors = [Collections.Generic.List[object]]::new()
    try {
        & $subst $cabinetDrive $payload
        $cabinetMapped = $LASTEXITCODE -eq 0
        if (-not $cabinetMapped -or -not (Test-Path -LiteralPath (Join-Path $cabinetRoot 'immutable-package-inputs.json') -PathType Leaf)) {
            throw 'The short CI cabinet source drive could not be bound to the verified payload.'
        }
        if (-not $imageDelivery) {
            $runtimePayload = Join-Path $payload (Join-Path 'runtimes' ([string]$assembly.runtime.runtimeId))
            & $subst $runtimeDrive $runtimePayload
            $runtimeMapped = $LASTEXITCODE -eq 0
            if (-not $runtimeMapped -or -not (Test-Path -LiteralPath (Join-Path $runtimeCabinetRoot 'runtime.manifest') -PathType Leaf)) {
                throw 'The short CI runtime cabinet drive could not be bound to the verified runtime.'
            }
        }
        $author = @($composer, 'author', '--payload', $payload, '--cabinet-source', $cabinetRoot,
            '--output', $payloadAuthoring, '--transaction-helper', $helper, '--transaction-output', $transactions)
        if (-not $imageDelivery) { $author += @('--cabinet-runtime-source', $runtimeCabinetRoot) }
        Invoke-BuildTool $PythonPath $author 'package-authoring'
        Invoke-BuildTool $WixPath @('build', '-arch', 'arm64', '-d', "ProductVersion=$ProductVersion", '-d', "SourceRoot=$SourceRoot",
            '-d', 'NativeRuntimeMsiPrototype=false', '-d', 'ImmutableRuntimePackage=true', '-d', "NativeRuntimeMsiAuthoring=$transactions",
            (Join-Path $windows 'Product.wxs'), $payloadAuthoring, '-pdbtype', 'none', '-wx', '-out', $msi) 'msi-build'
    } catch { $cabinetFailure = $_ }
    finally {
        foreach ($mapping in @(
            @{ owned=$runtimeMapped; drive=$runtimeDrive; error='The short CI runtime cabinet drive could not be released.' },
            @{ owned=$cabinetMapped; drive=$cabinetDrive; error='The short CI cabinet source drive could not be released.' }
        )) {
            if ($mapping.owned) {
                try {
                    & $subst $mapping.drive /D
                    if ($LASTEXITCODE -ne 0) { throw [InvalidOperationException]::new($mapping.error) }
                } catch {
                    $cabinetCleanupErrors.Add(@{ drive=$mapping.drive; error=$mapping.error })
                    if ($null -eq $cabinetFailure) { $cabinetFailure = [InvalidOperationException]::new($mapping.error) }
                }
            }
        }
        $receipt['cabinetCleanupErrors'] = @($cabinetCleanupErrors.ToArray())
    }
    if ($null -ne $cabinetFailure) { throw $cabinetFailure }
    # Same existing ICE60 exception as NemoClaw.wixproj; all other ICEs run.
    Invoke-BuildTool $WixPath @('msi', 'validate', '-sice', 'ICE60', '-wx', $msi) 'msi-validation'
    & (Join-Path $owner 'audit-runtime-msi.ps1') -MsiPath $msi -HelperSha256 $helperSha -ReceiptPath (Join-Path $OutputDirectory 'compiled-msi.json') -RequireInstallationRootRemoval -RequireRuntimeRestore:$imageDelivery
    if ($imageDelivery -and (Get-FileHash -LiteralPath (Join-Path $payload 'bin\NemoClawRuntimeRestore.exe') -Algorithm SHA256).Hash.ToLowerInvariant() -cne $helperSha) {
        throw 'The packaged startup service differs from the pinned transaction helper.'
    }
    $receipt['compiledMsi'] = Get-CompiledMsiCounts $msi
    # RemoveExistingProducts supplies this exact compiled identity to the old
    # MSI. The enclosing Burn transaction must use the same journal owner.
    $productRows = @([NativeRuntimeMsiAudit]::Rows($msi, 'SELECT `Value` FROM `Property` WHERE `Property` = ''ProductCode''', 1))
    if ($productRows.Count -ne 1 -or $productRows[0][0] -cnotmatch '^\{[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}\}$') {
        throw 'The compiled MSI must have one valid transaction owner ProductCode.'
    }
    $runtimeProductCode = [string]$productRows[0][0]
    $receipt['runtimeProductCode'] = $runtimeProductCode
    $payloadFiles = @(Get-ChildItem -LiteralPath $payload -Recurse -File)
    $receipt['payload'] = @{ fileCount = $payloadFiles.Count; bytes = [long](($payloadFiles | Measure-Object -Property Length -Sum).Sum) }
    $receipt.phase = 'native-burn-build'
    if ((Get-PackagedMxcProbeSha256 $HostPayloadRoot $payload $SourceRevision $env:GITHUB_RUN_ID $env:GITHUB_RUN_ATTEMPT) -cne $mxcProbeSha) {
        throw 'The admitted MXC probe identity changed after Setup compilation.'
    }
    $receipt['mxcProbeSha256'] = $mxcProbeSha
    # Consume the same executed binary; the package builder never rebuilds it.
    if ((Get-FileHash -LiteralPath $SystemDrivePrepPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $systemDriveSha) {
        throw 'The proven system-drive helper changed before Burn composition.'
    }
    if ($UnqualifiedPackageDirectory) {
        $unchangedBuild = Get-RecompositionBuild $UnqualifiedPackageDirectory $SourceRevision $assembly.runtime
        if ($helperSha -cne $priorBuild.transactionHelperSha256 -or
            $unchangedBuild.transactionHelperSha256 -cne $priorBuild.transactionHelperSha256 -or
            (Get-FileHash -LiteralPath (Join-Path $UnqualifiedPackageDirectory 'immutable-package-build.json') -Algorithm SHA256).Hash.ToLowerInvariant() -cne $receipt.reviewedRecomposition.originalBuildSha256 -or
            (Get-FileHash -LiteralPath $ReviewedAvailability -Algorithm SHA256).Hash.ToLowerInvariant() -cne $receipt.reviewedRecomposition.decisionSha256) {
            throw 'A reviewed recomposition input changed before final Burn composition.'
        }
    }
    $setup = Join-Path $OutputDirectory "NemoClawSetup-$ProductVersion-windows-arm64.exe"
    $runtimeTuple = @($assembly.runtime.runtimeId, $assembly.runtime.manifestSha256, $assembly.runtime.sourceRevision,
        $assembly.runtime.nodeSha256, $assembly.runtime.nodeVersion) -join ' '
    Invoke-BuildTool $WixPath @('build', '-arch', 'arm64', '-d', "ProductVersion=$ProductVersion", '-d', "SourceRoot=$SourceRoot",
        '-d', "MsiPath=$msi", '-d', "WxcHostPrepPath=$(Join-Path $payload 'mxc\wxc-host-prep.exe')", '-d', "WxcExecPath=$(Join-Path $payload 'mxc\wxc-exec.exe')",
        '-d', 'SystemDriveMetadataPreparation=true', '-d', "SystemDrivePrepPath=$SystemDrivePrepPath", '-d', "SystemDrivePrepSha256=$systemDriveSha",
        '-d', "RuntimeImageFinalization=$($imageDelivery.ToString().ToLowerInvariant())", '-d', "RuntimeFinalizerPath=$helper",
        '-d', "RuntimeFinalizerSha256=$helperSha", '-d', "RuntimeTuple=$runtimeTuple", '-d', "RuntimeId=$($assembly.runtime.runtimeId)",
        '-d', "RuntimeProductCode=$runtimeProductCode",
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
