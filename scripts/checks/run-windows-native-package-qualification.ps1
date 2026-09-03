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

$script:OperationTimeoutMilliseconds = 1200000
$script:ProcessAuditSettleMilliseconds = 3000
$script:MsiDisplayName = 'NemoClaw Runtime'
$script:BundleDisplayName = 'NemoClaw'

function Fail-PackageQualification {
    param([Parameter(Mandatory)][string]$Message)
    throw "Windows native package qualification failed: $Message"
}

function Write-InteractiveVideoMarker {
    param(
        [Parameter(Mandatory)][ValidateSet('openclaw', 'hermes', 'langchain-deepagents-code', 'pi', 'nemocua')][string]$Agent,
        [Parameter(Mandatory)][ValidateSet('start', 'end')][string]$Phase
    )

    if (-not $InteractiveProof) {
        return
    }
    $marker = [pscustomobject]@{
        schemaVersion = 1
        agent = $Agent
        phase = $Phase
        recordedAtUtc = [DateTime]::UtcNow.ToString('O')
    }
    [IO.File]::WriteAllText(
        (Join-Path $artifactRoot "video-segment-$Agent-$Phase.json"),
        (($marker | ConvertTo-Json -Compress) + [Environment]::NewLine),
        [Text.UTF8Encoding]::new($false)
    )
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

function Invoke-PythonDistributionVersionProbe {
    param(
        [Parameter(Mandatory)][string]$PythonPath,
        [Parameter(Mandatory)][string]$SitePackages,
        [Parameter(Mandatory)][string]$Distribution,
        [Parameter(Mandatory)][string]$ExpectedVersion,
        [Parameter(Mandatory)][string]$EntryRelativePath,
        [Parameter(Mandatory)][string]$Label
    )

    Assert-Arm64PortableExecutable -Path $PythonPath -Label 'Installed python.exe'
    if (-not (Test-Path -LiteralPath $SitePackages -PathType Container)) {
        Fail-PackageQualification "$Label site-packages directory is missing."
    }
    $program = "import sys;sys.path.insert(0,sys.argv[1]);from importlib.metadata import version;print(version(sys.argv[2]))"
    Write-Host "PS> $Label :: python.exe -c importlib.metadata.version('$Distribution')"
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $PythonPath
    $startInfo.Arguments = (@('-c', $program, $SitePackages, $Distribution) | ForEach-Object {
        ConvertTo-NativeArgument -Value $_
    }) -join ' '
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.Environment['PYTHONDONTWRITEBYTECODE'] = '1'
    $startInfo.Environment['PYTHONNOUSERSITE'] = '1'
    $startInfo.Environment['PYTHONUTF8'] = '1'
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
        $stdout = $stdoutTask.GetAwaiter().GetResult().Trim()
        $stderr = $stderrTask.GetAwaiter().GetResult().Trim()
    } finally {
        $process.Dispose()
    }
    if ($exitCode -ne 0 -or $stdout -cne $ExpectedVersion -or $stderr.Length -ne 0) {
        Fail-PackageQualification "$Label did not report expected version $ExpectedVersion."
    }
    Write-Host "OUTPUT> $stdout"
    Write-Host "[PASS] $Label exit=$exitCode"
    return [pscustomobject]@{
        file = $SitePackages.Substring($installRoot.Length + 1)
        exitCode = $exitCode
        output = $stdout
        sha256 = (Get-FileHash -LiteralPath (Join-Path $SitePackages $EntryRelativePath) -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}

function Invoke-PythonScriptVersionProbe {
    param(
        [Parameter(Mandatory)][string]$PythonPath,
        [Parameter(Mandatory)][string]$ScriptPath,
        [Parameter(Mandatory)][string]$ExpectedVersion,
        [Parameter(Mandatory)][string]$Label
    )

    Assert-Arm64PortableExecutable -Path $PythonPath -Label 'Installed python.exe'
    if (-not (Test-Path -LiteralPath $ScriptPath -PathType Leaf)) {
        Fail-PackageQualification "$Label entrypoint is missing."
    }
    Write-Host "PS> $Label :: python.exe $(Split-Path -Leaf $ScriptPath) --version"
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $PythonPath
    $startInfo.Arguments = (@($ScriptPath, '--version') | ForEach-Object {
        ConvertTo-NativeArgument -Value $_
    }) -join ' '
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.Environment['PYTHONDONTWRITEBYTECODE'] = '1'
    $startInfo.Environment['PYTHONNOUSERSITE'] = '1'
    $startInfo.Environment['PYTHONUTF8'] = '1'
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
        $stdout = $stdoutTask.GetAwaiter().GetResult().Trim()
        $stderr = $stderrTask.GetAwaiter().GetResult().Trim()
    } finally {
        $process.Dispose()
    }
    if ($exitCode -ne 0 -or $stdout -cne $ExpectedVersion -or $stderr.Length -ne 0) {
        Fail-PackageQualification "$Label did not report expected version $ExpectedVersion."
    }
    Write-Host "OUTPUT> $stdout"
    Write-Host "[PASS] $Label exit=$exitCode"
    return [pscustomobject]@{
        file = $ScriptPath.Substring($installRoot.Length + 1)
        exitCode = $exitCode
        output = $stdout
        sha256 = (Get-FileHash -LiteralPath $ScriptPath -Algorithm SHA256).Hash.ToLowerInvariant()
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
    $auditId = [guid]::NewGuid().ToString('N')
    $startSourceIdentifier = "NemoClawNativePackageStart-$auditId"
    $stopSourceIdentifier = "NemoClawNativePackageStop-$auditId"
    Register-WmiEvent -Class Win32_ProcessStartTrace -SourceIdentifier $startSourceIdentifier | Out-Null
    Register-WmiEvent -Class Win32_ProcessStopTrace -SourceIdentifier $stopSourceIdentifier | Out-Null
    return [pscustomobject]@{
        startSourceIdentifier = $startSourceIdentifier
        stopSourceIdentifier = $stopSourceIdentifier
    }
}

function Stop-ProhibitedProcessAudit {
    param(
        [Parameter(Mandatory)][object]$Audit,
        [Parameter(Mandatory)][int]$RootProcessId
    )

    Start-Sleep -Milliseconds $script:ProcessAuditSettleMilliseconds
    $records = @()
    foreach ($source in @(
        [pscustomobject]@{ identifier = $Audit.startSourceIdentifier; kind = 'start' }
        [pscustomobject]@{ identifier = $Audit.stopSourceIdentifier; kind = 'stop' }
    )) {
        foreach ($auditEvent in @(Get-Event -SourceIdentifier $source.identifier -ErrorAction SilentlyContinue)) {
            $processEvent = $auditEvent.SourceEventArgs.NewEvent
            $parentProcessId = 0
            if ($source.kind -ceq 'start') {
                $parentProcessId = [int]$processEvent.ParentProcessID
            }
            $records += [pscustomobject]@{
                eventIdentifier = $auditEvent.EventIdentifier
                kind = $source.kind
                parentProcessId = $parentProcessId
                processId = [int]$processEvent.ProcessID
                processName = [string]$processEvent.ProcessName
                timeGenerated = $auditEvent.TimeGenerated
            }
            Remove-Event -EventIdentifier $auditEvent.EventIdentifier
        }
        Unregister-Event -SourceIdentifier $source.identifier -ErrorAction SilentlyContinue
    }

    $tracked = @{}
    $tracked[[string]$RootProcessId] = $true
    $descendantStarts = @()
    foreach ($record in @($records | Sort-Object timeGenerated, eventIdentifier)) {
        if ($record.kind -ceq 'stop') {
            [void]$tracked.Remove([string]$record.processId)
        } elseif ($tracked.ContainsKey([string]$record.parentProcessId)) {
            $descendantStarts += $record
            $tracked[[string]$record.processId] = $true
        }
    }
    $startRecords = @($records | Where-Object { $_.kind -ceq 'start' })
    $prohibitedStarts = @($startRecords | Where-Object {
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
        allStarts = $startRecords
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
    'bin\NemoClaw.exe',
    'bin\nemoclaw.cmd',
    'nemoclaw\app\bin\nemoclaw.js',
    'openclaw\node_modules\openclaw\openclaw.mjs',
    'pi\node_modules\@earendil-works\pi-coding-agent\dist\cli.js',
    'python\python.exe',
    'hermes\site-packages\hermes_cli\main.py',
    'deepagents\site-packages\deepagents_code\main.py',
    'nemocua\run_with_harness.py',
    'onboarding\index.html',
    'onboarding\styles.css',
    'onboarding\app.ts',
    'mxc\wxc-exec.exe',
    'mxc\wxc-host-prep.exe',
    'config\mxc-gateway.toml',
    'qualification\run-installed-native-turn.mts',
    'qualification\run-installed-native-web-ui.mts',
    'qualification\run-installed-native-pi.mts',
    'qualification\run-installed-native-nemocua.mts',
    'agent-support.json',
    'OPENSHELL-NODE-UI-COMPATIBILITY.patch'
)) {
    if (-not $payloadHashes.ContainsKey($requiredPayload) -or
        $payloadHashes[$requiredPayload] -cnotmatch '^[a-f0-9]{64}$') {
        Fail-PackageQualification "Package manifest is missing $requiredPayload authority."
    }
}
$mxcManifestFiles = @($expectedPayloadFiles | Where-Object {
    $_.StartsWith('mxc\', [StringComparison]::OrdinalIgnoreCase)
} | ForEach-Object {
    $_.Substring(4)
} | Sort-Object)
if (@(Compare-Object @('wxc-exec.exe', 'wxc-host-prep.exe') $mxcManifestFiles).Count -ne 0) {
    Fail-PackageQualification 'Package manifest contains an unused MXC backend or sidecar.'
}

$installRoot = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)) 'NVIDIA\NemoClaw'
$installBin = Join-Path $installRoot 'bin'
$openshellPath = Join-Path $installBin 'openshell.exe'
$gatewayPath = Join-Path $installBin 'openshell-gateway.exe'
$pythonPath = Join-Path $installRoot 'python\python.exe'
$hermesSitePackages = Join-Path $installRoot 'hermes\site-packages'
$deepAgentsSitePackages = Join-Path $installRoot 'deepagents\site-packages'
$nemoCuaEntryPath = Join-Path $installRoot 'nemocua\run_with_harness.py'
$piEntryPath = Join-Path $installRoot 'pi\node_modules\@earendil-works\pi-coding-agent\dist\cli.js'
$nodePath = Join-Path $installBin 'node.exe'
$nemoclawEntryPath = Join-Path $installRoot 'nemoclaw\app\bin\nemoclaw.js'
$openClawEntryPath = Join-Path $installRoot 'openclaw\node_modules\openclaw\openclaw.mjs'
$wxcExecPath = Join-Path $installRoot 'mxc\wxc-exec.exe'
$nemoclawLauncherPath = Join-Path $installBin 'nemoclaw.cmd'
$nemoclawUiLauncherPath = Join-Path $installBin 'NemoClaw.exe'
$bundleInstallLog = Join-Path $artifactRoot 'bundle-install.log'
$msiRepairLog = Join-Path $artifactRoot 'msi-repair.log'
$msiReinstallLog = Join-Path $artifactRoot 'msi-reinstall.log'
$msiUninstallLog = Join-Path $artifactRoot 'msi-uninstall.log'
$bundleUninstallLog = Join-Path $artifactRoot 'bundle-uninstall.log'
$preExecution = Get-ProhibitedProcessSnapshot -Phase 'pre-execution'
$processAudit = Start-ProhibitedProcessAudit
$processAuditStopped = $false
$repairRestoredDigest = $false
$reinstallPreservedRegistration = $false

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
        Invoke-NativeVersionProbe -Path $pythonPath -Label 'Installed python.exe'
    )
    $applicationEvidence = @(
        Invoke-NodeCliVersionProbe -NodePath $nodePath -EntryPath $nemoclawEntryPath -ExpectedVersion $ProductVersion -Label 'Installed NemoClaw CLI'
        Invoke-NodeCliVersionProbe -NodePath $nodePath -EntryPath $openClawEntryPath -ExpectedVersion '2026.7.1' -Label 'Installed OpenClaw runtime'
        Invoke-NodeCliVersionProbe -NodePath $nodePath -EntryPath $piEntryPath -ExpectedVersion '0.84.1' -Label 'Installed Pi runtime'
        Invoke-PythonDistributionVersionProbe -PythonPath $pythonPath -SitePackages $hermesSitePackages -Distribution 'hermes-agent' -ExpectedVersion '0.19.0' -EntryRelativePath 'hermes_cli\main.py' -Label 'Installed Hermes Agent runtime'
        Invoke-PythonDistributionVersionProbe -PythonPath $pythonPath -SitePackages $deepAgentsSitePackages -Distribution 'deepagents-code' -ExpectedVersion '0.1.55' -EntryRelativePath 'deepagents_code\main.py' -Label 'Installed Deep Agents Code runtime'
        Invoke-PythonScriptVersionProbe -PythonPath $pythonPath -ScriptPath $nemoCuaEntryPath -ExpectedVersion '0.1.0-windows-experimental' -Label 'Installed NemoCUA runtime'
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
        $nativeTurnReceipt.openClawExecutionMode -cne 'embedded-worker' -or
        $nativeTurnReceipt.createWatcherStopped -ne $true -or
        $nativeTurnReceipt.workloadStopped -ne $true -or
        $nativeTurnReceipt.gatewayStopped -ne $true -or
        $nativeTurnReceipt.sandboxDeleted -ne $true -or
        $nativeTurnReceipt.sandboxRegistryAbsent -ne $true -or
        $nativeTurnReceipt.qualificationRootsRemoved -ne $true -or
        $nativeTurnReceipt.artifactStagedAtDriveRoot -ne $true) {
        Fail-PackageQualification 'Installed NemoClaw native turn receipt is incomplete.'
    }
    Write-Host '[PASS] Installed nemoclaw command created an MXC sandbox and completed an exact CHAT_OK turn'
    $webUiArtifacts = Join-Path $artifactRoot 'web-ui'
    Write-Host 'PS> Launch installed NemoClaw OpenClaw web UI and complete three agent turns'
    Write-InteractiveVideoMarker -Agent 'openclaw' -Phase 'start'
    Invoke-BoundedProcess `
        -FilePath $nemoclawUiLauncherPath `
        -Arguments @('--wait', '--qualification', '--artifact-directory', $webUiArtifacts) `
        -Label 'Installed NemoClaw graphical onboarding and OpenClaw web UI' `
        -AllowedExitCodes @(0) | Out-Null
    $webUiReceipts = @(Get-ChildItem `
        -LiteralPath $webUiArtifacts `
        -Filter 'native-windows-web-ui-*.json' `
        -File `
        -ErrorAction SilentlyContinue)
    if ($webUiReceipts.Count -ne 1) {
        Fail-PackageQualification 'Installed NemoClaw web UI did not publish exactly one receipt.'
    }
    $webUiReceipt = Get-Content -LiteralPath $webUiReceipts[0].FullName -Raw | ConvertFrom-Json
    $expectedWebUiReplies = @(
        'NATIVE_WINDOWS_TURN_1_OK',
        'NATIVE_WINDOWS_TURN_2_OK',
        'NATIVE_WINDOWS_TURN_3_OK'
    )
    $expectedAgentChoices = @('openclaw', 'hermes', 'langchain-deepagents-code', 'pi', 'nemocua')
    $expectedDisabledAgentChoices = @()
    if ($webUiReceipt.verdict -cne 'pass' -or
        $webUiReceipt.backend -cne 'process_container' -or
        $webUiReceipt.browser -cne 'Microsoft Edge' -or
        $webUiReceipt.deterministicLocalModel -ne $true -or
        $webUiReceipt.onboardingSelection.agent -cne 'openclaw' -or
        $webUiReceipt.onboardingSelection.inference -cne 'nvidia' -or
        @($webUiReceipt.demonstratedAgentChoices).Count -ne $expectedAgentChoices.Count -or
        @($webUiReceipt.disabledAgentChoices).Count -ne $expectedDisabledAgentChoices.Count -or
        [int]$webUiReceipt.turnCount -ne 3 -or
        @($webUiReceipt.turns).Count -ne 3 -or
        $webUiReceipt.sandboxDeleted -ne $true -or
        $webUiReceipt.sandboxRegistryAbsent -ne $true -or
        $webUiReceipt.gatewayStopped -ne $true -or
        $webUiReceipt.qualificationRootsRemoved -ne $true) {
        Fail-PackageQualification 'Installed NemoClaw web UI receipt is incomplete.'
    }
    for ($index = 0; $index -lt $expectedAgentChoices.Count; $index++) {
        if ($webUiReceipt.demonstratedAgentChoices[$index] -cne $expectedAgentChoices[$index]) {
            Fail-PackageQualification "Installed NemoClaw onboarding did not visibly demonstrate agent choice $($index + 1)."
        }
    }
    for ($index = 0; $index -lt $expectedDisabledAgentChoices.Count; $index++) {
        if ($webUiReceipt.disabledAgentChoices[$index].agent -cne $expectedDisabledAgentChoices[$index] -or
            [string]::IsNullOrWhiteSpace([string]$webUiReceipt.disabledAgentChoices[$index].blocker)) {
            Fail-PackageQualification "Installed NemoClaw onboarding did not disable and explain unavailable agent choice $($index + 1)."
        }
    }
    for ($index = 0; $index -lt $expectedWebUiReplies.Count; $index++) {
        if ($webUiReceipt.turns[$index].expected -cne $expectedWebUiReplies[$index] -or
            $webUiReceipt.turns[$index].visible -ne $true) {
            Fail-PackageQualification "Installed NemoClaw web UI turn $($index + 1) is not exact."
        }
    }
    if (@(Get-ChildItem -LiteralPath $webUiArtifacts -Filter 'web-ui-turn-*.png' -File).Count -ne 3) {
        Fail-PackageQualification 'Installed NemoClaw web UI did not capture three turn screenshots.'
    }
    if (@(Get-ChildItem -LiteralPath $webUiArtifacts -Filter 'onboarding-*.png' -File).Count -ne 4) {
        Fail-PackageQualification 'Installed NemoClaw did not capture all four graphical onboarding steps.'
    }
    Write-Host '[PASS] Graphical onboarding selected OpenClaw and completed three exact Control UI agent turns'
    Write-InteractiveVideoMarker -Agent 'openclaw' -Phase 'end'
    $piArtifacts = Join-Path $artifactRoot 'pi'
    Write-Host 'PS> Launch NemoClaw, select Pi graphically, and complete three native MXC agent turns'
    Write-InteractiveVideoMarker -Agent 'pi' -Phase 'start'
    Invoke-BoundedProcess `
        -FilePath $nemoclawUiLauncherPath `
        -Arguments @('--wait', '--qualification', '--agent', 'pi', '--artifact-directory', $piArtifacts) `
        -Label 'Installed graphical native Windows Pi qualification' `
        -AllowedExitCodes @(0) | Out-Null
    $piLaunchReceipts = @(Get-ChildItem -LiteralPath $piArtifacts -Filter 'native-windows-agent-launch-pi.json' -File -ErrorAction SilentlyContinue)
    if ($piLaunchReceipts.Count -ne 1) {
        Fail-PackageQualification 'Installed Pi graphical launch did not publish exactly one receipt.'
    }
    $piLaunchReceipt = Get-Content -LiteralPath $piLaunchReceipts[0].FullName -Raw | ConvertFrom-Json
    $piReceipt = $piLaunchReceipt.runtimeReceipt
    if ($piReceipt.verdict -cne 'pass' -or
        $piLaunchReceipt.selectedAgent -cne 'pi' -or
        $piLaunchReceipt.onboardingSelection.agent -cne 'pi' -or
        (@($piLaunchReceipt.demonstratedAgentChoices) -join ',') -cne 'openclaw,hermes,langchain-deepagents-code,pi,nemocua' -or
        $piReceipt.piVersion -cne '0.84.1' -or
        $piReceipt.backend -cne 'process_container' -or
        $piReceipt.interface -cne 'Pi terminal one-shot mode' -or
        [int]$piReceipt.turnCount -ne 3 -or
        @($piReceipt.turns).Count -ne 3 -or
        $piReceipt.createWatcherStopped -ne $true -or
        $piReceipt.sandboxDeleted -ne $true -or
        $piReceipt.sandboxRegistryAbsent -ne $true -or
        $piReceipt.gatewayStopped -ne $true -or
        $piReceipt.qualificationRootsRemoved -ne $true) {
        Fail-PackageQualification 'Installed Pi qualification receipt is incomplete.'
    }
    Write-Host '[PASS] Installed Pi completed three real terminal agent turns inside native MXC'
    Write-InteractiveVideoMarker -Agent 'pi' -Phase 'end'
    $hermesArtifacts = Join-Path $artifactRoot 'hermes'
    Write-Host 'PS> Launch NemoClaw, select Hermes Agent graphically, and complete three native MXC agent turns'
    Write-InteractiveVideoMarker -Agent 'hermes' -Phase 'start'
    Invoke-BoundedProcess `
        -FilePath $nemoclawUiLauncherPath `
        -Arguments @('--wait', '--qualification', '--agent', 'hermes', '--artifact-directory', $hermesArtifacts) `
        -Label 'Installed graphical native Windows Hermes qualification' `
        -AllowedExitCodes @(0) | Out-Null
    $hermesLaunchReceipts = @(Get-ChildItem -LiteralPath $hermesArtifacts -Filter 'native-windows-agent-launch-hermes.json' -File -ErrorAction SilentlyContinue)
    if ($hermesLaunchReceipts.Count -ne 1) {
        Fail-PackageQualification 'Installed Hermes graphical launch did not publish exactly one receipt.'
    }
    $hermesLaunchReceipt = Get-Content -LiteralPath $hermesLaunchReceipts[0].FullName -Raw | ConvertFrom-Json
    $hermesReceipt = $hermesLaunchReceipt.runtimeReceipt
    if ($hermesReceipt.verdict -cne 'pass' -or
        $hermesLaunchReceipt.selectedAgent -cne 'hermes' -or
        $hermesLaunchReceipt.onboardingSelection.agent -cne 'hermes' -or
        (@($hermesLaunchReceipt.demonstratedAgentChoices) -join ',') -cne 'openclaw,hermes,langchain-deepagents-code,pi,nemocua' -or
        $hermesReceipt.hermesVersion -cne '0.19.0' -or
        $hermesReceipt.backend -cne 'process_container' -or
        $hermesReceipt.interface -cne 'Hermes terminal one-shot mode' -or
        [int]$hermesReceipt.turnCount -ne 3 -or
        @($hermesReceipt.turns).Count -ne 3 -or
        $hermesReceipt.createWatcherStopped -ne $true -or
        $hermesReceipt.sandboxDeleted -ne $true -or
        $hermesReceipt.sandboxRegistryAbsent -ne $true -or
        $hermesReceipt.gatewayStopped -ne $true -or
        $hermesReceipt.qualificationRootsRemoved -ne $true) {
        Fail-PackageQualification 'Installed Hermes qualification receipt is incomplete.'
    }
    Write-Host '[PASS] Installed Hermes completed three real terminal agent turns inside native MXC'
    Write-InteractiveVideoMarker -Agent 'hermes' -Phase 'end'
    $deepAgentsArtifacts = Join-Path $artifactRoot 'deepagents'
    Write-Host 'PS> Launch NemoClaw, select Deep Agents Code graphically, and complete three native MXC agent turns'
    Write-InteractiveVideoMarker -Agent 'langchain-deepagents-code' -Phase 'start'
    Invoke-BoundedProcess `
        -FilePath $nemoclawUiLauncherPath `
        -Arguments @('--wait', '--qualification', '--agent', 'langchain-deepagents-code', '--artifact-directory', $deepAgentsArtifacts) `
        -Label 'Installed graphical native Windows Deep Agents Code qualification' `
        -AllowedExitCodes @(0) | Out-Null
    $deepAgentsLaunchReceipts = @(Get-ChildItem -LiteralPath $deepAgentsArtifacts -Filter 'native-windows-agent-launch-langchain-deepagents-code.json' -File -ErrorAction SilentlyContinue)
    if ($deepAgentsLaunchReceipts.Count -ne 1) {
        Fail-PackageQualification 'Installed Deep Agents Code graphical launch did not publish exactly one receipt.'
    }
    $deepAgentsLaunchReceipt = Get-Content -LiteralPath $deepAgentsLaunchReceipts[0].FullName -Raw | ConvertFrom-Json
    $deepAgentsReceipt = $deepAgentsLaunchReceipt.runtimeReceipt
    if ($deepAgentsReceipt.verdict -cne 'pass' -or
        $deepAgentsLaunchReceipt.selectedAgent -cne 'langchain-deepagents-code' -or
        $deepAgentsLaunchReceipt.onboardingSelection.agent -cne 'langchain-deepagents-code' -or
        (@($deepAgentsLaunchReceipt.demonstratedAgentChoices) -join ',') -cne 'openclaw,hermes,langchain-deepagents-code,pi,nemocua' -or
        $deepAgentsReceipt.deepAgentsCodeVersion -cne '0.1.55' -or
        $deepAgentsReceipt.backend -cne 'process_container' -or
        $deepAgentsReceipt.interface -cne 'Deep Agents Code terminal one-shot mode' -or
        [int]$deepAgentsReceipt.turnCount -ne 3 -or
        @($deepAgentsReceipt.turns).Count -ne 3 -or
        $deepAgentsReceipt.createWatcherStopped -ne $true -or
        $deepAgentsReceipt.sandboxDeleted -ne $true -or
        $deepAgentsReceipt.sandboxRegistryAbsent -ne $true -or
        $deepAgentsReceipt.gatewayStopped -ne $true -or
        $deepAgentsReceipt.qualificationRootsRemoved -ne $true) {
        Fail-PackageQualification 'Installed Deep Agents Code qualification receipt is incomplete.'
    }
    Write-Host '[PASS] Installed Deep Agents Code completed three real terminal agent turns inside native MXC'
    Write-InteractiveVideoMarker -Agent 'langchain-deepagents-code' -Phase 'end'
    $nemoCuaArtifacts = Join-Path $artifactRoot 'nemocua'
    Write-Host 'PS> Launch NemoClaw, select NemoCUA graphically, and complete three model-driven native MXC browser turns'
    Write-InteractiveVideoMarker -Agent 'nemocua' -Phase 'start'
    Invoke-BoundedProcess `
        -FilePath $nemoclawUiLauncherPath `
        -Arguments @('--wait', '--qualification', '--agent', 'nemocua', '--artifact-directory', $nemoCuaArtifacts) `
        -Label 'Installed graphical native Windows NemoCUA qualification' `
        -AllowedExitCodes @(0) | Out-Null
    $nemoCuaLaunchReceipts = @(Get-ChildItem -LiteralPath $nemoCuaArtifacts -Filter 'native-windows-agent-launch-nemocua.json' -File -ErrorAction SilentlyContinue)
    if ($nemoCuaLaunchReceipts.Count -ne 1) {
        Fail-PackageQualification 'Installed NemoCUA graphical launch did not publish exactly one receipt.'
    }
    $nemoCuaLaunchReceipt = Get-Content -LiteralPath $nemoCuaLaunchReceipts[0].FullName -Raw | ConvertFrom-Json
    $nemoCuaReceipt = $nemoCuaLaunchReceipt.runtimeReceipt
    if ($nemoCuaReceipt.verdict -cne 'pass' -or
        $nemoCuaLaunchReceipt.selectedAgent -cne 'nemocua' -or
        $nemoCuaLaunchReceipt.onboardingSelection.agent -cne 'nemocua' -or
        (@($nemoCuaLaunchReceipt.demonstratedAgentChoices) -join ',') -cne 'openclaw,hermes,langchain-deepagents-code,pi,nemocua' -or
        $nemoCuaReceipt.nemocuaVersion -cne '0.1.0-windows-experimental' -or
        $nemoCuaReceipt.backend -cne 'process_container' -or
        $nemoCuaReceipt.interface -cne 'NemoCUA visible browser task' -or
        $nemoCuaReceipt.browser -cne 'Microsoft Edge' -or
        [int]$nemoCuaReceipt.turnCount -ne 3 -or
        @($nemoCuaReceipt.turns).Count -ne 3 -or
        $nemoCuaReceipt.visiblePostcondition.inputValue -cne 'NEMOCUA_NATIVE_WINDOWS' -or
        $nemoCuaReceipt.visiblePostcondition.completed -ne $true -or
        $nemoCuaReceipt.createWatcherStopped -ne $true -or
        $nemoCuaReceipt.sandboxDeleted -ne $true -or
        $nemoCuaReceipt.sandboxRegistryAbsent -ne $true -or
        $nemoCuaReceipt.gatewayStopped -ne $true -or
        $nemoCuaReceipt.qualificationRootsRemoved -ne $true) {
        Fail-PackageQualification 'Installed NemoCUA qualification receipt is incomplete.'
    }
    Write-Host '[PASS] Installed NemoCUA completed three real model-driven browser actions inside native MXC'
    Write-InteractiveVideoMarker -Agent 'nemocua' -Phase 'end'
    if ($InteractiveProof) {
        Start-Sleep -Seconds 3
    }
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

    if ($InteractiveProof) {
        Write-Host '[INFO] Repair and reinstall are already proven by the bound initial qualification receipt'
    } else {
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
        $repairRestoredDigest = $true
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
        $reinstallPreservedRegistration = $true
        Write-Host '[PASS] MSI reinstall preserved exactly one product registration'
    }

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

    $auditResult = Stop-ProhibitedProcessAudit -Audit $processAudit -RootProcessId $PID
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
            "$($_.processName)(pid=$($_.processId),parent=$($_.parentProcessId))"
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

    $requiredLogs = @($bundleInstallLog, $msiUninstallLog, $bundleUninstallLog)
    if (-not $InteractiveProof) {
        $requiredLogs += @($msiRepairLog, $msiReinstallLog)
    }
    foreach ($logPath in $requiredLogs) {
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
        webUi = $webUiReceipt
        pi = $piReceipt
        hermes = $hermesReceipt
        deepAgentsCode = $deepAgentsReceipt
        nemoCua = $nemoCuaReceipt
        agentLaunches = [pscustomobject]@{
            pi = $piLaunchReceipt
            hermes = $hermesLaunchReceipt
            deepAgentsCode = $deepAgentsLaunchReceipt
            nemoCua = $nemoCuaLaunchReceipt
        }
        msiRegistration = $msiArp
        bundleRegistration = $bundleArp
        repairRestoredDigest = $repairRestoredDigest
        reinstallPreservedRegistration = $reinstallPreservedRegistration
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
            Stop-ProhibitedProcessAudit -Audit $processAudit -RootProcessId $PID | Out-Null
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
