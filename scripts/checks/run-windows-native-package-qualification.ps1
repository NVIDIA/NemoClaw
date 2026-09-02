# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

<#
.SYNOPSIS
    Qualify the downloadable ARM64 MSI and Burn setup executable on Windows.

.DESCRIPTION
    Exercises native setup, MSI repair and reinstall, Windows Installer
    uninstall, bundle cleanup, Add/Remove Programs registration, machine PATH,
    native payload execution, and prohibited-process evidence.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ProductVersion,
    [Parameter(Mandatory)][string]$MsiPath,
    [Parameter(Mandatory)][string]$SetupPath,
    [Parameter(Mandatory)][string]$PackageManifestPath,
    [Parameter(Mandatory)][string]$ArtifactDirectory,
    [switch]$InteractiveProof
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:OperationTimeoutMilliseconds = 300000
$script:ProcessAuditSettleMilliseconds = 3000
$script:MsiDisplayName = 'NemoClaw Native Windows Candidate'
$script:BundleDisplayName = 'NemoClaw Native Windows Candidate Setup'

function Fail-PackageQualification {
    param([Parameter(Mandatory)][string]$Message)
    throw "Windows native package qualification failed: $Message"
}

function Assert-Arm64PortableExecutable {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Label
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        Fail-PackageQualification "$Label is missing."
    }
    $stream = [IO.File]::OpenRead($Path)
    $reader = [IO.BinaryReader]::new($stream)
    try {
        if ($reader.ReadUInt16() -ne 0x5A4D) {
            Fail-PackageQualification "$Label is not a Windows PE executable."
        }
        $stream.Position = 0x3C
        $peOffset = $reader.ReadInt32()
        if ($peOffset -lt 0x40 -or $peOffset -gt ($stream.Length - 6)) {
            Fail-PackageQualification "$Label has an invalid PE header offset."
        }
        $stream.Position = $peOffset
        if ($reader.ReadUInt32() -ne 0x00004550 -or $reader.ReadUInt16() -ne 0xAA64) {
            Fail-PackageQualification "$Label is not an ARM64 Windows executable."
        }
    } finally {
        $reader.Dispose()
        $stream.Dispose()
    }
}

function ConvertTo-NativeArgument {
    param([Parameter(Mandatory)][string]$Value)

    if ($Value -notmatch '[\s"]') {
        return $Value
    }
    return '"' + $Value.Replace('"', '\"') + '"'
}

function Invoke-BoundedProcess {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [Parameter(Mandatory)][string[]]$Arguments,
        [Parameter(Mandatory)][string]$Label,
        [Parameter(Mandatory)][int[]]$AllowedExitCodes,
        [switch]$SuppressProofOutput
    )

    $argumentList = @($Arguments | ForEach-Object { ConvertTo-NativeArgument -Value $_ })
    if (-not $SuppressProofOutput) {
        Write-Host "PS> $Label :: $(Split-Path -Leaf $FilePath) $($argumentList -join ' ')"
    }
    $process = Start-Process -FilePath $FilePath -ArgumentList $argumentList -PassThru -ErrorAction Stop
    try {
        if (-not $process.WaitForExit($script:OperationTimeoutMilliseconds)) {
            $process.Kill()
            $process.WaitForExit()
            Fail-PackageQualification "$Label exceeded its timeout."
        }
        $exitCode = $process.ExitCode
    } finally {
        $process.Dispose()
    }
    if ($AllowedExitCodes -cnotcontains $exitCode) {
        Fail-PackageQualification "$Label failed with exit code $exitCode."
    }
    if (-not $SuppressProofOutput) {
        Write-Host "[PASS] $Label exit=$exitCode"
    }
    return $exitCode
}

function Invoke-NativeVersionProbe {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Label
    )

    Assert-Arm64PortableExecutable -Path $Path -Label $Label
    Write-Host "PS> $Label :: $(Split-Path -Leaf $Path) --version"
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $Path
    $startInfo.Arguments = '--version'
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) {
            Fail-PackageQualification "$Label could not start its native version probe."
        }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(30000)) {
            $process.Kill()
            $process.WaitForExit()
            Fail-PackageQualification "$Label exceeded its version-probe timeout."
        }
        $process.WaitForExit()
        $exitCode = $process.ExitCode
        $stdout = $stdoutTask.GetAwaiter().GetResult()
        $stderr = $stderrTask.GetAwaiter().GetResult()
        $output = (@($stdout.Trim(), $stderr.Trim()) | Where-Object {
            -not [string]::IsNullOrWhiteSpace($_)
        }) -join [Environment]::NewLine
    } finally {
        $process.Dispose()
    }
    if ($exitCode -ne 0 -or [string]::IsNullOrWhiteSpace($output) -or $output.Length -gt 4096) {
        Fail-PackageQualification "$Label did not complete a bounded native version probe."
    }
    Write-Host "OUTPUT> $($output -replace '[\r\n]+', ' | ')"
    Write-Host "[PASS] $Label exit=$exitCode"
    return [pscustomobject]@{
        file = Split-Path -Leaf $Path
        exitCode = $exitCode
        output = $output
        sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}

function Invoke-NodeCliVersionProbe {
    param(
        [Parameter(Mandatory)][string]$NodePath,
        [Parameter(Mandatory)][string]$EntryPath,
        [Parameter(Mandatory)][string]$ExpectedVersion,
        [Parameter(Mandatory)][string]$Label
    )

    Assert-Arm64PortableExecutable -Path $NodePath -Label 'Installed node.exe'
    if (-not (Test-Path -LiteralPath $EntryPath -PathType Leaf)) {
        Fail-PackageQualification "$Label entrypoint is missing."
    }
    Write-Host "PS> $Label :: node.exe $(Split-Path -Leaf $EntryPath) --version"
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $NodePath
    $startInfo.Arguments = (@($EntryPath, '--version') | ForEach-Object {
        ConvertTo-NativeArgument -Value $_
    }) -join ' '
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) {
            Fail-PackageQualification "$Label could not start."
        }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(30000)) {
            $process.Kill()
            $process.WaitForExit()
            Fail-PackageQualification "$Label exceeded its version-probe timeout."
        }
        $process.WaitForExit()
        $exitCode = $process.ExitCode
        $output = (@($stdoutTask.GetAwaiter().GetResult().Trim(), $stderrTask.GetAwaiter().GetResult().Trim()) | Where-Object {
            -not [string]::IsNullOrWhiteSpace($_)
        }) -join [Environment]::NewLine
    } finally {
        $process.Dispose()
    }
    if ($exitCode -ne 0 -or $output -notmatch [regex]::Escape($ExpectedVersion) -or $output.Length -gt 4096) {
        Fail-PackageQualification "$Label did not report expected version $ExpectedVersion."
    }
    Write-Host "OUTPUT> $($output -replace '[\r\n]+', ' | ')"
    Write-Host "[PASS] $Label exit=$exitCode"
    return [pscustomobject]@{
        file = $EntryPath.Substring($installRoot.Length + 1)
        exitCode = $exitCode
        output = $output
        sha256 = (Get-FileHash -LiteralPath $EntryPath -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}

function Get-ArpEntries {
    param([Parameter(Mandatory)][string]$DisplayName)

    $baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
        [Microsoft.Win32.RegistryHive]::LocalMachine,
        [Microsoft.Win32.RegistryView]::Registry64
    )
    try {
        $uninstall = $baseKey.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall')
        if ($null -eq $uninstall) {
            return @()
        }
        try {
            $entries = @()
            foreach ($subkeyName in $uninstall.GetSubKeyNames()) {
                $subkey = $uninstall.OpenSubKey($subkeyName)
                if ($null -eq $subkey) {
                    continue
                }
                try {
                    if ([string]$subkey.GetValue('DisplayName') -ceq $DisplayName) {
                        $entries += [pscustomobject]@{
                            key = $subkeyName
                            displayName = $DisplayName
                            displayVersion = [string]$subkey.GetValue('DisplayVersion')
                            uninstallString = [string]$subkey.GetValue('UninstallString')
                        }
                    }
                } finally {
                    $subkey.Dispose()
                }
            }
            return @($entries)
        } finally {
            $uninstall.Dispose()
        }
    } finally {
        $baseKey.Dispose()
    }
}

function Test-MachinePathContains {
    param([Parameter(Mandatory)][string]$ExpectedPath)

    $expected = [IO.Path]::GetFullPath($ExpectedPath).TrimEnd('\')
    $machinePath = [Environment]::GetEnvironmentVariable('PATH', 'Machine')
    return @($machinePath.Split(';') | Where-Object {
        -not [string]::IsNullOrWhiteSpace($_) -and
        [IO.Path]::GetFullPath($_).TrimEnd('\') -ieq $expected
    }).Count -eq 1
}

function Assert-InstalledTree {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$Phase,
        [Parameter(Mandatory)][string[]]$ExpectedFiles
    )

    $expectedFiles = @($ExpectedFiles | Sort-Object)
    $expectedDirectories = @($expectedFiles | ForEach-Object {
        $parent = [IO.Path]::GetDirectoryName($_)
        while (-not [string]::IsNullOrEmpty($parent)) {
            $parent
            $parent = [IO.Path]::GetDirectoryName($parent)
        }
    } | Sort-Object -Unique)
    $observed = @(Get-ChildItem -LiteralPath $Root -Recurse -Force)
    foreach ($item in $observed) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            Fail-PackageQualification "$Phase installed tree contains a reparse point."
        }
    }
    $observedFiles = @($observed | Where-Object { -not $_.PSIsContainer } | ForEach-Object {
        $_.FullName.Substring($Root.Length + 1)
    } | Sort-Object)
    $observedDirectories = @($observed | Where-Object { $_.PSIsContainer } | ForEach-Object {
        $_.FullName.Substring($Root.Length + 1)
    } | Sort-Object)
    if (@(Compare-Object $expectedFiles $observedFiles).Count -ne 0 -or
        @(Compare-Object $expectedDirectories $observedDirectories).Count -ne 0) {
        Fail-PackageQualification "$Phase installed tree contains an unexpected or missing path."
    }
}

function Get-ProhibitedProcessSnapshot {
    param([Parameter(Mandatory)][string]$Phase)

    $prohibited = @('bash', 'docker', 'dockerd', 'wsl')
    $processes = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
        $name = $_.ProcessName.ToLowerInvariant()
        $prohibited -ccontains $name -or $name.StartsWith('com.docker') -or $name.StartsWith('ubuntu')
    } | ForEach-Object {
        [pscustomobject]@{ processId = $_.Id; processName = $_.ProcessName }
    } | Sort-Object processId)
    return [pscustomobject]@{ phase = $Phase; processes = $processes }
}

function Start-ProhibitedProcessAudit {
    $sourceIdentifier = 'NemoClawNativePackage-' + [guid]::NewGuid().ToString('N')
    Register-WmiEvent -Class Win32_ProcessStartTrace -SourceIdentifier $sourceIdentifier | Out-Null
    return $sourceIdentifier
}

function Stop-ProhibitedProcessAudit {
    param(
        [Parameter(Mandatory)][string]$SourceIdentifier,
        [Parameter(Mandatory)][int]$RootProcessId
    )

    Start-Sleep -Milliseconds $script:ProcessAuditSettleMilliseconds
    $records = @()
    foreach ($auditEvent in @(Get-Event -SourceIdentifier $SourceIdentifier -ErrorAction SilentlyContinue)) {
        $processEvent = $auditEvent.SourceEventArgs.NewEvent
        $records += [pscustomobject]@{
            processId = [int]$processEvent.ProcessID
            parentProcessId = [int]$processEvent.ParentProcessID
            processName = [string]$processEvent.ProcessName
        }
        Remove-Event -EventIdentifier $auditEvent.EventIdentifier
    }
    Unregister-Event -SourceIdentifier $SourceIdentifier -ErrorAction SilentlyContinue

    $tracked = @{}
    $tracked[[string]$RootProcessId] = $true
    $descendantStarts = @()
    foreach ($record in $records) {
        if ($tracked.ContainsKey([string]$record.parentProcessId)) {
            $descendantStarts += $record
            $tracked[[string]$record.processId] = $true
        }
    }
    $prohibitedStarts = @($records | Where-Object {
        $name = $_.processName.ToLowerInvariant()
        $name -in @('bash.exe', 'docker.exe', 'dockerd.exe', 'wsl.exe') -or
        $name.StartsWith('com.docker') -or $name.StartsWith('ubuntu')
    })
    $packageDescendantProhibitedStarts = @($descendantStarts | Where-Object {
        $name = $_.processName.ToLowerInvariant()
        $name -in @('bash.exe', 'docker.exe', 'dockerd.exe', 'wsl.exe') -or
        $name.StartsWith('com.docker') -or $name.StartsWith('ubuntu')
    })
    return [pscustomobject]@{
        allStarts = $records
        descendantStarts = $descendantStarts
        prohibitedStarts = $prohibitedStarts
        packageDescendantProhibitedStarts = $packageDescendantProhibitedStarts
    }
}

if ($ProductVersion -cnotmatch '^[0-9]{1,3}\.[0-9]{1,5}\.[0-9]{1,5}$') {
    Fail-PackageQualification 'ProductVersion is invalid.'
}
if ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() -cne 'Arm64') {
    Fail-PackageQualification 'Package qualification requires native Windows ARM64.'
}
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Fail-PackageQualification 'Package qualification requires an elevated Windows runner.'
}

$msi = [IO.Path]::GetFullPath($MsiPath)
$setup = [IO.Path]::GetFullPath($SetupPath)
$manifestPath = [IO.Path]::GetFullPath($PackageManifestPath)
$artifactRoot = [IO.Path]::GetFullPath($ArtifactDirectory).TrimEnd('\')
$expectedMsiName = "NemoClaw-$ProductVersion-windows-arm64.msi"
$expectedSetupName = "NemoClawSetup-$ProductVersion-windows-arm64.exe"
if ((Split-Path -Leaf $msi) -cne $expectedMsiName -or
    (Split-Path -Leaf $setup) -cne $expectedSetupName) {
    Fail-PackageQualification 'Package filenames do not match the product version and ARM64 contract.'
}
foreach ($packagePath in @($msi, $setup, $manifestPath)) {
    if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) {
        Fail-PackageQualification "Package input is missing: $(Split-Path -Leaf $packagePath)"
    }
}
Assert-Arm64PortableExecutable -Path $setup -Label $expectedSetupName
if (Test-Path -LiteralPath $artifactRoot) {
    Fail-PackageQualification 'ArtifactDirectory must not already exist.'
}
[IO.Directory]::CreateDirectory($artifactRoot) | Out-Null

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.productVersion -cne $ProductVersion -or $manifest.architecture -cne 'arm64' -or
    $manifest.wixToolset -cne '5.0.2') {
    Fail-PackageQualification 'Package manifest identity is invalid.'
}
$payloadHashes = @{}
$expectedPayloadFiles = @()
foreach ($entry in @($manifest.payload)) {
    $relativePath = [string]$entry.relativePath
    if ($relativePath -notmatch '^[^:\x00-\x1f]+$' -or [IO.Path]::IsPathRooted($relativePath) -or
        $relativePath.Split('\') -contains '..' -or $payloadHashes.ContainsKey($relativePath)) {
        Fail-PackageQualification 'Package manifest contains an invalid payload path.'
    }
    $payloadHashes[$relativePath] = [string]$entry.sha256
    $expectedPayloadFiles += $relativePath
}
foreach ($requiredPayload in @(
    'bin\openshell.exe',
    'bin\openshell-gateway.exe',
    'bin\node.exe',
    'bin\nemoclaw.cmd',
    'nemoclaw\app\bin\nemoclaw.js',
    'openclaw\node_modules\openclaw\openclaw.mjs',
    'mxc\wxc-exec.exe',
    'mxc\wxc-host-prep.exe',
    'config\mxc-gateway.toml',
    'qualification\run-installed-native-turn.mts'
)) {
    if (-not $payloadHashes.ContainsKey($requiredPayload) -or
        $payloadHashes[$requiredPayload] -cnotmatch '^[a-f0-9]{64}$') {
        Fail-PackageQualification "Package manifest is missing $requiredPayload authority."
    }
}

$installRoot = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)) 'NVIDIA\NemoClaw'
$installBin = Join-Path $installRoot 'bin'
$openshellPath = Join-Path $installBin 'openshell.exe'
$gatewayPath = Join-Path $installBin 'openshell-gateway.exe'
$nodePath = Join-Path $installBin 'node.exe'
$nemoclawEntryPath = Join-Path $installRoot 'nemoclaw\app\bin\nemoclaw.js'
$openClawEntryPath = Join-Path $installRoot 'openclaw\node_modules\openclaw\openclaw.mjs'
$wxcExecPath = Join-Path $installRoot 'mxc\wxc-exec.exe'
$nemoclawLauncherPath = Join-Path $installBin 'nemoclaw.cmd'
$bundleInstallLog = Join-Path $artifactRoot 'bundle-install.log'
$msiRepairLog = Join-Path $artifactRoot 'msi-repair.log'
$msiReinstallLog = Join-Path $artifactRoot 'msi-reinstall.log'
$msiUninstallLog = Join-Path $artifactRoot 'msi-uninstall.log'
$bundleUninstallLog = Join-Path $artifactRoot 'bundle-uninstall.log'
$preExecution = Get-ProhibitedProcessSnapshot -Phase 'pre-execution'
$processAudit = Start-ProhibitedProcessAudit
$processAuditStopped = $false

Write-Host "HOST> NemoClaw native Windows ARM64 package qualification"
Write-Host "HOST> os=$([Environment]::OSVersion.Version) architecture=$([Runtime.InteropServices.RuntimeInformation]::OSArchitecture) product=$ProductVersion"

try {
    $bundleInstallArguments = if ($InteractiveProof) {
        @('/install', '/passive', '/norestart', '/log', $bundleInstallLog)
    } else {
        @('/install', '/quiet', '/norestart', '/log', $bundleInstallLog)
    }
    Invoke-BoundedProcess `
        -FilePath $setup `
        -Arguments $bundleInstallArguments `
        -Label 'Burn bundle install' `
        -AllowedExitCodes @(0, 3010) | Out-Null

    if (-not (Test-Path -LiteralPath $openshellPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $gatewayPath -PathType Leaf)) {
        Fail-PackageQualification 'Bundle installation did not publish both payload executables.'
    }
    Assert-InstalledTree -Root $installRoot -Phase 'Initial bundle install' -ExpectedFiles $expectedPayloadFiles
    if ((Get-FileHash -LiteralPath $openshellPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $payloadHashes['bin\openshell.exe'] -or
        (Get-FileHash -LiteralPath $gatewayPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $payloadHashes['bin\openshell-gateway.exe'] -or
        (Get-FileHash -LiteralPath $nodePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $payloadHashes['bin\node.exe'] -or
        (Get-FileHash -LiteralPath $wxcExecPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $payloadHashes['mxc\wxc-exec.exe']) {
        Fail-PackageQualification 'Installed payload digests do not match the package manifest.'
    }
    Write-Host "[PASS] Setup installed the exact MSI-owned NemoClaw runtime tree ($($expectedPayloadFiles.Count) files)"
    $nativeEvidence = @(
        Invoke-NativeVersionProbe -Path $openshellPath -Label 'Installed openshell.exe'
        Invoke-NativeVersionProbe -Path $gatewayPath -Label 'Installed openshell-gateway.exe'
        Invoke-NativeVersionProbe -Path $nodePath -Label 'Installed node.exe'
    )
    $applicationEvidence = @(
        Invoke-NodeCliVersionProbe -NodePath $nodePath -EntryPath $nemoclawEntryPath -ExpectedVersion $ProductVersion -Label 'Installed NemoClaw CLI'
        Invoke-NodeCliVersionProbe -NodePath $nodePath -EntryPath $openClawEntryPath -ExpectedVersion '2026.7.1' -Label 'Installed OpenClaw runtime'
    )
    $nativeTurnArtifacts = Join-Path $artifactRoot 'native-turn'
    Write-Host "PS> Installed NemoClaw native MXC agent turn :: nemoclaw debug --native-windows-turn"
    & $nemoclawLauncherPath debug --native-windows-turn --artifact-directory $nativeTurnArtifacts
    $nativeTurnExitCode = $LASTEXITCODE
    if ($nativeTurnExitCode -ne 0) {
        Fail-PackageQualification "Installed NemoClaw native MXC agent turn failed with exit code $nativeTurnExitCode."
    }
    Write-Host "[PASS] Installed NemoClaw native MXC agent turn exit=$nativeTurnExitCode"
    $nativeTurnReceipts = @(Get-ChildItem -LiteralPath $nativeTurnArtifacts -Filter 'native-windows-turn-*.json' -File)
    if ($nativeTurnReceipts.Count -ne 1) {
        Fail-PackageQualification 'Installed NemoClaw native turn did not publish exactly one receipt.'
    }
    $nativeTurnReceipt = Get-Content -LiteralPath $nativeTurnReceipts[0].FullName -Raw | ConvertFrom-Json
    if ($nativeTurnReceipt.verdict -cne 'pass' -or $nativeTurnReceipt.exactReply -cne 'CHAT_OK' -or
        $nativeTurnReceipt.sandboxDeleted -ne $true) {
        Fail-PackageQualification 'Installed NemoClaw native turn receipt is incomplete.'
    }
    Write-Host '[PASS] Installed nemoclaw command created an MXC sandbox and completed an exact CHAT_OK turn'
    $msiArp = @(Get-ArpEntries -DisplayName $script:MsiDisplayName)
    $bundleArp = @(Get-ArpEntries -DisplayName $script:BundleDisplayName)
    if ($msiArp.Count -ne 1 -or $msiArp[0].displayVersion -cne $ProductVersion) {
        Fail-PackageQualification 'MSI Add/Remove Programs registration is missing or ambiguous.'
    }
    if ($bundleArp.Count -ne 1) {
        Fail-PackageQualification 'Bundle Add/Remove Programs registration is missing or ambiguous.'
    }
    if (-not (Test-MachinePathContains -ExpectedPath $installBin)) {
        Fail-PackageQualification 'Machine PATH does not contain the installed bin directory exactly once.'
    }
    Write-Host "[PASS] Add/Remove Programs registered MSI=$($msiArp[0].displayVersion) bundle=$($bundleArp[0].displayVersion)"
    Write-Host '[PASS] Machine PATH contains the installed bin directory exactly once'

    [IO.File]::AppendAllText($openshellPath, 'msi-repair-drift', [Text.UTF8Encoding]::new($false))
    Invoke-BoundedProcess `
        -FilePath (Join-Path $env:SystemRoot 'System32\msiexec.exe') `
        -Arguments @('/fa', $msi, '/qn', '/norestart', '/l*v', $msiRepairLog) `
        -Label 'MSI repair' `
        -AllowedExitCodes @(0, 3010) | Out-Null
    if ((Get-FileHash -LiteralPath $openshellPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $payloadHashes['bin\openshell.exe']) {
        Fail-PackageQualification 'MSI repair did not restore the corrupted OpenShell CLI.'
    }
    Assert-InstalledTree -Root $installRoot -Phase 'MSI repair' -ExpectedFiles $expectedPayloadFiles
    Write-Host '[PASS] MSI repair restored the deliberately corrupted openshell.exe digest'

    Invoke-BoundedProcess `
        -FilePath (Join-Path $env:SystemRoot 'System32\msiexec.exe') `
        -Arguments @('/i', $msi, 'REINSTALL=ALL', 'REINSTALLMODE=vomus', '/qn', '/norestart', '/l*v', $msiReinstallLog) `
        -Label 'MSI reinstall' `
        -AllowedExitCodes @(0, 3010) | Out-Null
    if (@(Get-ArpEntries -DisplayName $script:MsiDisplayName).Count -ne 1) {
        Fail-PackageQualification 'MSI reinstall did not preserve one product registration.'
    }
    Assert-InstalledTree -Root $installRoot -Phase 'MSI reinstall' -ExpectedFiles $expectedPayloadFiles
    Write-Host '[PASS] MSI reinstall preserved exactly one product registration'

    Invoke-BoundedProcess `
        -FilePath (Join-Path $env:SystemRoot 'System32\msiexec.exe') `
        -Arguments @('/x', $msi, '/qn', '/norestart', '/l*v', $msiUninstallLog) `
        -Label 'MSI uninstall' `
        -AllowedExitCodes @(0, 3010) | Out-Null
    Invoke-BoundedProcess `
        -FilePath $setup `
        -Arguments @('/uninstall', '/quiet', '/norestart', '/log', $bundleUninstallLog) `
        -Label 'Burn bundle registration cleanup' `
        -AllowedExitCodes @(0, 3010) | Out-Null

    if (Test-Path -LiteralPath $installRoot) {
        Fail-PackageQualification 'Windows Installer uninstall did not remove the product directory.'
    }
    if (@(Get-ArpEntries -DisplayName $script:MsiDisplayName).Count -ne 0 -or
        @(Get-ArpEntries -DisplayName $script:BundleDisplayName).Count -ne 0) {
        Fail-PackageQualification 'Add/Remove Programs registration remains after uninstall.'
    }
    if (Test-MachinePathContains -ExpectedPath $installBin) {
        Fail-PackageQualification 'Machine PATH still contains the removed bin directory.'
    }
    Write-Host '[PASS] Windows Installer uninstall removed files, registrations, and PATH'

    $auditResult = Stop-ProhibitedProcessAudit -SourceIdentifier $processAudit -RootProcessId $PID
    $processAuditStopped = $true
    $setupProcessName = (Split-Path -Leaf $setup).ToLowerInvariant()
    if (@($auditResult.descendantStarts | Where-Object {
        $_.processName.ToLowerInvariant() -ceq $setupProcessName
    }).Count -lt 1) {
        Fail-PackageQualification 'The process audit did not observe the setup executable as a package descendant.'
    }
    $prohibitedStarts = @($auditResult.prohibitedStarts)
    $packageDescendantProhibitedStarts = @($auditResult.packageDescendantProhibitedStarts)
    if ($packageDescendantProhibitedStarts.Count -ne 0) {
        $names = @($packageDescendantProhibitedStarts | ForEach-Object {
            $_.processName
        } | Sort-Object -Unique) -join ', '
        Fail-PackageQualification "Package operations started a prohibited descendant process: $names"
    }
    $postExecution = Get-ProhibitedProcessSnapshot -Phase 'post-execution'
    $baselineIds = @($preExecution.processes | ForEach-Object { $_.processId })
    $newProhibitedProcesses = @($postExecution.processes | Where-Object {
        $baselineIds -notcontains $_.processId
    })
    $packageDescendantProhibitedIds = @($packageDescendantProhibitedStarts | ForEach-Object {
        $_.processId
    })
    $newPackageDescendantProhibitedProcesses = @($newProhibitedProcesses | Where-Object {
        $packageDescendantProhibitedIds -contains $_.processId
    })
    if ($newPackageDescendantProhibitedProcesses.Count -ne 0) {
        Fail-PackageQualification 'A new prohibited package descendant remains after qualification.'
    }
    Write-Host "[PASS] Zero prohibited package descendants; runner-wide prohibited starts recorded=$($prohibitedStarts.Count)"

    foreach ($logPath in @($bundleInstallLog, $msiRepairLog, $msiReinstallLog, $msiUninstallLog, $bundleUninstallLog)) {
        if (-not (Test-Path -LiteralPath $logPath -PathType Leaf) -or (Get-Item -LiteralPath $logPath).Length -eq 0) {
            Fail-PackageQualification "Installer log is missing: $(Split-Path -Leaf $logPath)"
        }
    }

    $receipt = [pscustomobject]@{
        schemaVersion = 1
        classification = 'native-windows-candidate-preview'
        productVersion = $ProductVersion
        architecture = 'arm64'
        installRoot = $installRoot
        msi = [pscustomobject]@{
            file = $expectedMsiName
            sha256 = (Get-FileHash -LiteralPath $msi -Algorithm SHA256).Hash.ToLowerInvariant()
            authenticodeStatus = (Get-AuthenticodeSignature -LiteralPath $msi).Status.ToString()
        }
        setup = [pscustomobject]@{
            file = $expectedSetupName
            sha256 = (Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash.ToLowerInvariant()
            authenticodeStatus = (Get-AuthenticodeSignature -LiteralPath $setup).Status.ToString()
        }
        nativeExecutions = $nativeEvidence
        applicationExecutions = $applicationEvidence
        nativeTurn = $nativeTurnReceipt
        msiRegistration = $msiArp
        bundleRegistration = $bundleArp
        repairRestoredDigest = $true
        reinstallPreservedRegistration = $true
        finalAbsence = $true
        machinePathRemoved = $true
        prohibitedProcessStarts = $prohibitedStarts
        packageDescendantStarts = $auditResult.descendantStarts
        packageDescendantProhibitedStarts = $packageDescendantProhibitedStarts
        newProhibitedProcesses = $newProhibitedProcesses
        newPackageDescendantProhibitedProcesses = $newPackageDescendantProhibitedProcesses
        preExecution = $preExecution
        postExecution = $postExecution
    }
    [IO.File]::WriteAllText(
        (Join-Path $artifactRoot 'package-qualification.json'),
        (($receipt | ConvertTo-Json -Depth 12) + [Environment]::NewLine),
        [Text.UTF8Encoding]::new($false)
    )
    Write-Host '[PASS] NATIVE WINDOWS PACKAGE QUALIFICATION COMPLETE'
    Write-Host "Windows native package qualification receipts: $artifactRoot"
} finally {
    if (-not $processAuditStopped) {
        try {
            Stop-ProhibitedProcessAudit -SourceIdentifier $processAudit -RootProcessId $PID | Out-Null
        } catch {
            Write-Warning "Could not stop prohibited-process audit during cleanup: $($_.Exception.Message)"
        }
    }
    if (Test-Path -LiteralPath $installRoot) {
        try {
            Invoke-BoundedProcess `
                -FilePath (Join-Path $env:SystemRoot 'System32\msiexec.exe') `
                -Arguments @('/x', $msi, '/qn', '/norestart') `
                -Label 'Failure cleanup MSI uninstall' `
                -AllowedExitCodes @(0, 1605, 3010) `
                -SuppressProofOutput | Out-Null
        } catch {
            Write-Warning "MSI failure cleanup did not complete: $($_.Exception.Message)"
        }
    }
    try {
        Invoke-BoundedProcess `
            -FilePath $setup `
            -Arguments @('/uninstall', '/quiet', '/norestart') `
            -Label 'Failure cleanup bundle uninstall' `
            -AllowedExitCodes @(0, 1605, 3010) `
            -SuppressProofOutput | Out-Null
    } catch {
        Write-Warning "Bundle failure cleanup did not complete: $($_.Exception.Message)"
    }
}
