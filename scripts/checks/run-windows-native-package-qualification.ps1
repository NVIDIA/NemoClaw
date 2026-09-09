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
$script:NativeSetupEndpoint = 'http://127.0.0.1:17071/v1'
$script:NativeSetupModel = 'native-preview-qualification'
$script:OwnedNativeConfigurations = @{}

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
        [int]$TimeoutMilliseconds = $script:OperationTimeoutMilliseconds,
        [switch]$SuppressProofOutput
    )

    $argumentList = @($Arguments | ForEach-Object { ConvertTo-NativeArgument -Value $_ })
    if (-not $SuppressProofOutput) {
        Write-Host "PS> $Label :: $(Split-Path -Leaf $FilePath) $($argumentList -join ' ')"
    }
    $process = Start-Process -FilePath $FilePath -ArgumentList $argumentList -PassThru -ErrorAction Stop
    try {
        if (-not $process.WaitForExit($TimeoutMilliseconds)) {
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

function Invoke-NativeCredentialHelper {
    param(
        [Parameter(Mandatory)][string]$LauncherPath,
        [Parameter(Mandatory)][string[]]$Arguments,
        [AllowEmptyString()][string]$StandardInput = ''
    )
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $LauncherPath
    $startInfo.Arguments = ($Arguments | ForEach-Object {
        ConvertTo-NativeArgument -Value $_
    }) -join ' '
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $utf8WithoutBom = [Text.UTF8Encoding]::new($false)
    $parentInputEncoding = [Console]::InputEncoding
    $useConsoleInputEncoding = $null -eq $startInfo.PSObject.Properties['StandardInputEncoding']
    if (-not $useConsoleInputEncoding) { $startInfo.StandardInputEncoding = $utf8WithoutBom }
    if ($Arguments -contains '--configure-native' -and ($Arguments -contains '--prepare' -or $Arguments -contains '--prepare-service')) {
        $encodingMode = if ($useConsoleInputEncoding) { 'scoped-console' } else { 'process-property' }
        $preamble = [BitConverter]::ToString($parentInputEncoding.GetPreamble())
        if ($preamble.Length -eq 0) { $preamble = 'none' }
        Write-Host "[CREDENTIAL HELPER] stdin=$encodingMode; parent codepage=$($parentInputEncoding.CodePage); parent preamble=$preamble; selected=UTF-8/no-BOM"
    }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        # Framework constructs and flushes its writer inside Start, so choosing
        # UTF-8 without a preamble must happen before Start, not on BaseStream later.
        try {
            if ($useConsoleInputEncoding) { [Console]::InputEncoding = $utf8WithoutBom }
            $started = $process.Start()
        } finally {
            if ($useConsoleInputEncoding) { [Console]::InputEncoding = $parentInputEncoding }
        }
        if (-not $started) {
            Fail-PackageQualification 'The native Windows credential helper could not start.'
        }
        if (-not [string]::IsNullOrEmpty($StandardInput)) {
            $process.StandardInput.Write($StandardInput)
        }
        $process.StandardInput.Close()
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(30000)) {
            $process.Kill()
            $process.WaitForExit()
            Fail-PackageQualification 'The native Windows credential helper exceeded its timeout.'
        }
        $process.WaitForExit()
        return [pscustomobject]@{
            exitCode = $process.ExitCode
            stdout = $stdoutTask.GetAwaiter().GetResult()
            stderr = $stderrTask.GetAwaiter().GetResult()
        }
    } finally {
        $process.Dispose()
    }
}

function Get-NativeCredentialPrepareDiagnostic {
    param([Parameter(Mandatory)]$Result)
    $stdout = [string]$Result.stdout
    $stderr = [string]$Result.stderr
    $stdoutStatus = if ($stdout.Length -eq 0) { 'empty' } elseif ($stdout -cmatch '^[a-f0-9]{64}$') { 'binding' } else { 'invalid' }
    $sample = $stderr.Substring(0, [Math]::Min($stderr.Length, 4096))
    # Classify a bounded stderr prefix instead of printing helper data, which may
    # contain submitted values. Never emit the key-bearing stdout stream.
    $stderrStatus = if ($stderr.Length -eq 0) { 'empty' } elseif ($sample.Contains([string][char]0xFEFF)) {
        'JSON-BOM'
    } elseif ($sample -match 'JSON|Unexpected token|Unexpected end') {
        'JSON-parse-error'
    } elseif ($sample -match 'EACCES|EPERM|access.denied|permission') {
        'access-denied'
    } else { 'redacted' }
    return "exit=$($Result.exitCode); stdout=$stdoutStatus/$($stdout.Length) chars; stderr=$stderrStatus/$($stderr.Length) chars"
}

function Invoke-NativeCredentialManagerRoundTrip {
    param([Parameter(Mandatory)][string]$LauncherPath)

    $secret = "NemoClawNativeCredential-$([guid]::NewGuid().ToString('N'))"
    $invokeHelper = {
        param([Parameter(Mandatory)][string[]]$Arguments, [AllowEmptyString()][string]$StandardInput = '')
        Invoke-NativeCredentialHelper -LauncherPath $LauncherPath -Arguments $Arguments -StandardInput $StandardInput
    }

    $write = & $invokeHelper -Arguments @('--credential-write', 'local') -StandardInput $secret
    if ($write.exitCode -ne 0 -or -not [string]::IsNullOrEmpty($write.stdout) -or
        -not [string]::IsNullOrEmpty($write.stderr)) {
        Fail-PackageQualification 'The native Windows credential helper did not store a test credential.'
    }
    try {
        $read = & $invokeHelper -Arguments @('--credential-read', 'local')
        if ($read.exitCode -ne 0 -or $read.stdout -cne $secret -or
            -not [string]::IsNullOrEmpty($read.stderr)) {
            Fail-PackageQualification 'Windows Credential Manager did not return the exact test credential.'
        }
    } finally {
        $delete = & $invokeHelper -Arguments @('--credential-delete', 'local')
        if ($delete.exitCode -ne 0) {
            Fail-PackageQualification 'The native Windows credential helper did not delete its test credential.'
        }
    }
    $absent = & $invokeHelper -Arguments @('--credential-read', 'local')
    if ($absent.exitCode -eq 0 -or -not [string]::IsNullOrEmpty($absent.stdout)) {
        Fail-PackageQualification 'The native Windows credential helper left its test credential behind.'
    }
    Write-Host '[PASS] Native launcher stored, read, and removed a secret through Windows Credential Manager'
    return [pscustomobject]@{
        backend = 'Windows Credential Manager generic credential'
        provider = 'local'
        exactRoundTrip = $true
        removedAfterProbe = $true
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
                eventTime = [uint64]$processEvent.TIME_CREATED
                eventIdentifier = $auditEvent.EventIdentifier
                kind = $source.kind
                parentProcessId = $parentProcessId
                processId = [int]$processEvent.ProcessID
                processName = [string]$processEvent.ProcessName
                trackedParentProcessName = ''
                timeGenerated = $auditEvent.TimeGenerated
            }
            Remove-Event -EventIdentifier $auditEvent.EventIdentifier
        }
        Unregister-Event -SourceIdentifier $source.identifier -ErrorAction SilentlyContinue
    }

    $tracked = @{}
    $tracked[[string]$RootProcessId] = [pscustomobject]@{
        processName = '<qualification-root>'
    }
    $descendantStarts = @()
    foreach ($record in @($records | Sort-Object eventTime, eventIdentifier)) {
        if ($record.kind -ceq 'stop') {
            [void]$tracked.Remove([string]$record.processId)
        } else {
            # A numeric PID can be reused during the long all-agent replay.
            # A new start always begins a new process generation, even when a
            # delayed or missing stop event left the prior generation tracked.
            [void]$tracked.Remove([string]$record.processId)
            if ($tracked.ContainsKey([string]$record.parentProcessId)) {
                $record.trackedParentProcessName = [string]$tracked[[string]$record.parentProcessId].processName
                $descendantStarts += $record
                $tracked[[string]$record.processId] = $record
            }
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

function Invoke-InteractiveHermesQualification {
    $evidence = Join-Path $artifactRoot 'interactive-hermes'
    if (Test-Path -LiteralPath $evidence) { Fail-PackageQualification 'Interactive Hermes evidence already exists.' }
    [IO.Directory]::CreateDirectory($evidence) | Out-Null
    $inputMarker = 'NEMOCLAW_INTERACTIVE_INPUT_' + [guid]::NewGuid().ToString('N').Substring(0, 16)
    $outputMarker = 'NEMOCLAW_INTERACTIVE_OUTPUT_' + [guid]::NewGuid().ToString('N').Substring(0, 16)
    $providerScript = Join-Path $PSScriptRoot 'run-windows-native-interactive-provider.mts'
    $controllerScript = Join-Path $PSScriptRoot 'control-windows-native-hermes-console.ps1'
    foreach ($script in @($providerScript, $controllerScript)) {
        if (-not (Test-Path -LiteralPath $script -PathType Leaf)) { Fail-PackageQualification 'Interactive Hermes qualification tooling is missing.' }
    }
    $provider = $null
    $application = $null
    $controller = $null
    try {
        $providerArgs = @('--experimental-strip-types', '--no-warnings', $providerScript, '--port', '17071', '--input-marker', $inputMarker, '--output-marker', $outputMarker, '--artifact-directory', $evidence)
        $provider = Start-Process -FilePath $nodePath -ArgumentList @($providerArgs | ForEach-Object { ConvertTo-NativeArgument $_ }) `
            -RedirectStandardOutput (Join-Path $evidence 'provider-stdout.log') -RedirectStandardError (Join-Path $evidence 'provider-stderr.log') -PassThru
        $null = $provider.Handle
        $clock = [Diagnostics.Stopwatch]::StartNew()
        while (-not (Test-Path -LiteralPath (Join-Path $evidence 'provider.json')) -and $clock.ElapsedMilliseconds -lt 30000 -and -not $provider.HasExited) {
            Start-Sleep -Milliseconds 100
        }
        if (-not (Test-Path -LiteralPath (Join-Path $evidence 'provider.json'))) { Fail-PackageQualification 'The interactive test provider did not start.' }
        $arguments = @('--console', '--wait', '--configured', '--agent', 'hermes', '--console-qualification', '--artifact-directory', $evidence)
        Write-Host 'PS> Open the actual configured Hermes interactive console'
        if ($InteractiveProof) {
            [IO.File]::WriteAllText((Join-Path $artifactRoot 'video-interactive-hermes-start.json'), ('{"phase":"start","recordedAtUtc":"' + [DateTime]::UtcNow.ToString('O') + '"}'), [Text.UTF8Encoding]::new($false))
        }
        $application = Start-Process -FilePath $nemoclawUiLauncherPath -ArgumentList @($arguments | ForEach-Object { ConvertTo-NativeArgument $_ }) -PassThru
        $null = $application.Handle
        $startPath = Join-Path $evidence 'interactive-session-start.json'
        $clock.Restart()
        while (-not (Test-Path -LiteralPath $startPath) -and $clock.ElapsedMilliseconds -lt $script:OperationTimeoutMilliseconds -and -not $application.HasExited) {
            Start-Sleep -Milliseconds 200
        }
        if (-not (Test-Path -LiteralPath $startPath)) { Fail-PackageQualification 'The configured Hermes session did not start.' }
        $session = Get-Content -LiteralPath $startPath -Raw | ConvertFrom-Json
        if ($session.schemaVersion -ne 1 -or $session.agent -cne 'hermes' -or [int]$session.nodeProcessId -le 0) {
            Fail-PackageQualification 'The interactive Hermes session identity is invalid.'
        }
        $startInfo = [Diagnostics.ProcessStartInfo]::new()
        $startInfo.FileName = Join-Path $PSHOME 'powershell.exe'
        $controlArgs = @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $controllerScript,
            '-NativeNodeProcessId', [string]$session.nodeProcessId, '-ArtifactDirectory', $evidence, '-InputMarker', $inputMarker, '-OutputMarker', $outputMarker)
        $startInfo.Arguments = (@($controlArgs | ForEach-Object { ConvertTo-NativeArgument $_ })) -join ' '
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $controller = [Diagnostics.Process]::new()
        $controller.StartInfo = $startInfo
        if (-not $controller.Start() -or -not $controller.WaitForExit(270000) -or $controller.ExitCode -ne 0) {
            Fail-PackageQualification 'The real Hermes prompt, input, resize, or provider-response check failed.'
        }
        if (-not $application.WaitForExit(120000) -or $application.ExitCode -ne 0) {
            Fail-PackageQualification 'The configured Hermes session did not exit cleanly after its exit command.'
        }
        $documents = @{}
        foreach ($name in @('provider.json', 'console-control.json', 'contained-console.json', 'agent-exit.json', 'interactive-session-end.json')) {
            $file = Join-Path $evidence $name
            if (-not (Test-Path -LiteralPath $file -PathType Leaf) -or (Get-Item -LiteralPath $file).Length -gt 65536) {
                Fail-PackageQualification "Interactive Hermes evidence is missing or too large: $name"
            }
            $documents[$name] = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
        }
        $providerReceipt = $documents['provider.json']
        $control = $documents['console-control.json']
        $contained = $documents['contained-console.json']
        $exit = $documents['agent-exit.json']
        $end = $documents['interactive-session-end.json']
        if ($providerReceipt.inputMarker -cne $inputMarker -or $providerReceipt.outputMarker -cne $outputMarker -or
            $providerReceipt.inputObserved -ne $true -or $providerReceipt.responseSent -ne $true -or
            $control.visiblePrompt -ne $true -or $control.typedMessage -ne $true -or
            $control.visibleProviderResponse -ne $true -or $control.resizeApplied -ne $true -or
            $control.exitCommandEntered -ne $true -or $control.inputMarker -cne $inputMarker -or $control.outputMarker -cne $outputMarker -or
            [int]$contained.processId -le 0 -or [int]$contained.before.columns -le 0 -or [int]$contained.before.rows -le 0 -or
            $contained.after.columns -ne $control.afterColumns -or $contained.after.rows -ne $control.afterRows -or
            $exit.agent -cne 'hermes' -or $exit.exitCode -ne 0 -or
            $end.agent -cne 'hermes' -or $end.sandboxDeleted -ne $true -or $end.gatewayStopped -ne $true -or
            $end.ephemeralRootsRemoved -ne $true -or $end.persistentStateRetained -ne $true) {
            Fail-PackageQualification 'The installed configured Hermes interactive acceptance evidence is incomplete.'
        }
        foreach ($snapshot in @($contained.before, $contained.after)) {
            foreach ($stream in @('stdin', 'stdout', 'stderr')) {
                if ($null -eq $snapshot.modes.$stream) { Fail-PackageQualification 'The contained Win32 console probe did not verify every standard handle.' }
            }
        }
        $screenshots = @()
        foreach ($name in @('hermes-prompt.png', 'hermes-resized.png', 'hermes-response.png')) {
            $image = Join-Path $evidence $name
            if (-not (Test-Path -LiteralPath $image -PathType Leaf) -or (Get-Item -LiteralPath $image).Length -lt 4096) {
                Fail-PackageQualification 'The real interactive Hermes window was not captured.'
            }
            $screenshots += [pscustomobject]@{ file = $name; sha256 = (Get-FileHash -LiteralPath $image -Algorithm SHA256).Hash.ToLowerInvariant() }
        }
        Write-Host '[PASS] Configured Hermes displayed its real prompt, accepted typed input, resized, showed a provider response, and cleaned up'
        if ($InteractiveProof) {
            [IO.File]::WriteAllText((Join-Path $artifactRoot 'video-interactive-hermes-end.json'), ('{"phase":"end","recordedAtUtc":"' + [DateTime]::UtcNow.ToString('O') + '"}'), [Text.UTF8Encoding]::new($false))
        }
        return [pscustomobject]@{
            classification = 'installed-configured-hermes-interactive-console'
            verdict = 'pass'
            hostConsole = $true
            agentOneShotMode = $false
            console = $control
            containedWin32Console = $contained
            provider = $providerReceipt
            cleanup = $end
            screenshots = $screenshots
            tooling = [pscustomobject]@{
                providerSha256 = (Get-FileHash -LiteralPath $providerScript -Algorithm SHA256).Hash.ToLowerInvariant()
                controllerSha256 = (Get-FileHash -LiteralPath $controllerScript -Algorithm SHA256).Hash.ToLowerInvariant()
            }
        }
    } finally {
        if ($controller) {
            if (-not $controller.HasExited) { $controller.Kill(); [void]$controller.WaitForExit(10000) }
            $controller.Dispose()
        }
        if ($application) {
            if (-not $application.HasExited) {
                & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $application.Id /T /F | Out-Null
                [void]$application.WaitForExit(10000)
            }
            $application.Dispose()
        }
        if ($provider) {
            if (-not $provider.HasExited) { $provider.Kill(); [void]$provider.WaitForExit(10000) }
            $provider.Dispose()
        }
    }
}

function Stop-NativeHermesDashboardSession {
    param([Parameter(Mandatory)][int]$NodeProcessId, [Parameter(Mandatory)][string]$EvidenceDirectory)
    $desktop = [Windows.Automation.AutomationElement]::RootElement
    $condition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, 'NemoClaw Hermes session')
    $windows = $desktop.FindAll([Windows.Automation.TreeScope]::Children, $condition)
    if ($windows.Count -ne 1) { Fail-PackageQualification 'The real Hermes native session control is missing or ambiguous.' }
    $window = $windows[0]
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($window.Current.ProcessId)" -ErrorAction Stop
    if ($window.Current.FrameworkId -cne 'WPF' -or $process.Name -cne 'NemoClaw.Bootstrapper.exe' -or [int]$process.ParentProcessId -ne $NodeProcessId) {
        Fail-PackageQualification 'The Hermes native Stop control is not owned by this installed dashboard session.'
    }
    $stop = Wait-NativeSetupElement -Root $window -AutomationId 'NativeWebSessionStop'
    $window.SetFocus()
    [NemoClawNativeSetupCapture]::Save([IntPtr]$window.Current.NativeWindowHandle, (Join-Path $EvidenceDirectory 'hermes-dashboard-native-stop.png'))
    $identity = [pscustomobject]@{ automationId = 'NativeWebSessionStop'; framework = 'WPF'; windowTitle = $window.Current.Name; processId = $window.Current.ProcessId; parentNodeProcessId = $NodeProcessId; invoked = $true }
    Invoke-NativeSetupButton -Element $stop
    return $identity
}

function Invoke-HermesDashboardQualification {
    $evidence = Join-Path $artifactRoot 'hermes-dashboard'
    if (Test-Path -LiteralPath $evidence) { Fail-PackageQualification 'Hermes dashboard evidence already exists.' }
    [IO.Directory]::CreateDirectory($evidence) | Out-Null
    $inputMarker = 'NEMOCLAW_INTERACTIVE_INPUT_' + [guid]::NewGuid().ToString('N').Substring(0, 16)
    $outputMarker = 'NEMOCLAW_INTERACTIVE_OUTPUT_' + [guid]::NewGuid().ToString('N').Substring(0, 16)
    $providerScript = Join-Path $PSScriptRoot 'run-windows-native-interactive-provider.mts'
    $controllerScript = Join-Path $PSScriptRoot 'control-windows-native-hermes-dashboard.mts'
    foreach ($script in @($providerScript, $controllerScript)) {
        if (-not (Test-Path -LiteralPath $script -PathType Leaf)) { Fail-PackageQualification 'Hermes dashboard proof tooling is missing.' }
    }
    $provider = $null; $application = $null; $session = $null; $stopInvoked = $false
    try {
        $providerArgs = @('--experimental-strip-types', '--no-warnings', $providerScript, '--port', '17071', '--turns', '3', '--input-marker', $inputMarker, '--output-marker', $outputMarker, '--artifact-directory', $evidence)
        $provider = Start-Process -FilePath $nodePath -ArgumentList @($providerArgs | ForEach-Object { ConvertTo-NativeArgument $_ }) `
            -RedirectStandardOutput (Join-Path $evidence 'provider-stdout.log') -RedirectStandardError (Join-Path $evidence 'provider-stderr.log') -PassThru
        $null = $provider.Handle
        $clock = [Diagnostics.Stopwatch]::StartNew()
        while (-not (Test-Path -LiteralPath (Join-Path $evidence 'provider.json')) -and $clock.ElapsedMilliseconds -lt 30000 -and -not $provider.HasExited) { Start-Sleep -Milliseconds 100 }
        if (-not (Test-Path -LiteralPath (Join-Path $evidence 'provider.json'))) { Fail-PackageQualification 'The dashboard test provider did not start.' }
        $arguments = @('--wait', '--configured', '--web-ui', '--agent', 'hermes', '--dashboard-qualification', '--artifact-directory', $evidence)
        Write-Host 'PS> Open the installed configured Hermes dashboard and its actual interactive terminal'
        if ($InteractiveProof) {
            [IO.File]::WriteAllText((Join-Path $artifactRoot 'video-hermes-dashboard-start.json'), ('{"phase":"start","recordedAtUtc":"' + [DateTime]::UtcNow.ToString('O') + '"}'), [Text.UTF8Encoding]::new($false))
        }
        $application = Start-Process -FilePath $nemoclawUiLauncherPath -ArgumentList @($arguments | ForEach-Object { ConvertTo-NativeArgument $_ }) -PassThru
        $null = $application.Handle
        $startPath = Join-Path $evidence 'dashboard-ready.json'
        $clock.Restart()
        while (-not (Test-Path -LiteralPath $startPath) -and $clock.ElapsedMilliseconds -lt $script:OperationTimeoutMilliseconds -and -not $application.HasExited) { Start-Sleep -Milliseconds 200 }
        if (-not (Test-Path -LiteralPath $startPath) -or (Get-Item -LiteralPath $startPath).Length -gt 16384) { Fail-PackageQualification 'The installed Hermes dashboard did not become ready.' }
        $session = Get-Content -LiteralPath $startPath -Raw | ConvertFrom-Json
        if ($session.schemaVersion -ne 1 -or $session.agent -cne 'hermes' -or [int]$session.nodeProcessId -le 0) { Fail-PackageQualification 'The Hermes dashboard session identity is invalid.' }
        $driverArgs = @('--experimental-strip-types', '--no-warnings', $controllerScript, '--install-root', $installRoot, '--artifact-directory', $evidence, '--input-marker', $inputMarker, '--output-marker', $outputMarker)
        Invoke-BoundedProcess -FilePath $nodePath -Arguments $driverArgs -Label 'Real Hermes dashboard three-turn proof' -AllowedExitCodes @(0) | Out-Null
        $nativeStop = Stop-NativeHermesDashboardSession -NodeProcessId ([int]$session.nodeProcessId) -EvidenceDirectory $evidence
        $stopInvoked = $true
        if (-not $application.WaitForExit(120000) -or $application.ExitCode -ne 0) { Fail-PackageQualification 'Native Stop did not cleanly stop the installed Hermes dashboard.' }
        $documents = @{}
        foreach ($name in @('provider.json', 'dashboard-control.json', 'dashboard-end.json')) {
            $file = Join-Path $evidence $name
            if (-not (Test-Path -LiteralPath $file -PathType Leaf) -or (Get-Item -LiteralPath $file).Length -gt 65536) { Fail-PackageQualification "Hermes dashboard evidence is missing or oversized: $name" }
            $documents[$name] = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
        }
        $providerReceipt = $documents['provider.json']; $control = $documents['dashboard-control.json']; $end = $documents['dashboard-end.json']
        if ($control.classification -cne 'installed-hermes-dashboard-real-spa-pty' -or $control.actualShippedSpa -ne $true -or $control.realXtermInput -ne $true -or
            $control.nodeProcessId -ne $session.nodeProcessId -or $control.browser -cne 'Microsoft Edge' -or $control.transport.overflow -ne $false -or
            @($control.turns).Count -ne 3 -or @($providerReceipt.turns).Count -ne 3 -or $providerReceipt.inputMarker -cne $inputMarker -or $providerReceipt.outputMarker -cne $outputMarker -or
            $end.schemaVersion -ne 1 -or $end.agent -cne 'hermes' -or $end.sandboxDeleted -ne $true -or $end.gatewayStopped -ne $true -or $end.ephemeralRootsRemoved -ne $true -or $end.stateRetained -ne $true -or $end.leaseReleased -ne $true) {
            Fail-PackageQualification 'Hermes dashboard did not prove its actual SPA, PTY, or owned cleanup.'
        }
        for ($index = 0; $index -lt 3; $index++) {
            $turn = $control.turns[$index]; $providerTurn = $providerReceipt.turns[$index]; $number = $index + 1
            if ($turn.index -ne $number -or $turn.inputMarker -cne "$($inputMarker)_$number" -or $turn.outputMarker -cne "$($outputMarker)_$number" -or
                $turn.typedThroughRealTerminal -ne $true -or $turn.providerOutputObserved -ne $true -or $providerTurn.inputMarker -cne $turn.inputMarker -or $providerTurn.outputMarker -cne $turn.outputMarker -or
                $providerTurn.inputObserved -ne $true -or $providerTurn.responseSent -ne $true) { Fail-PackageQualification 'An actual Hermes dashboard turn lacks matching typed-input and provider-response evidence.' }
        }
        if (@($control.screenshots).Count -ne 4) { Fail-PackageQualification 'Hermes dashboard did not retain its prompt and three real response frames.' }
        foreach ($frame in $control.screenshots) {
            if ($frame.file -cnotmatch '^hermes-dashboard-(prompt|turn-[1-3])\.png$') { Fail-PackageQualification 'Hermes dashboard frame identity is invalid.' }
            $file = Join-Path $evidence $frame.file
            if (-not (Test-Path -LiteralPath $file -PathType Leaf) -or (Get-Item -LiteralPath $file).Length -lt 4096 -or
                (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $frame.sha256) { Fail-PackageQualification 'Hermes dashboard frame digest does not match the real captured image.' }
        }
        $stopFrame = Join-Path $evidence 'hermes-dashboard-native-stop.png'
        if ($InteractiveProof) {
            [IO.File]::WriteAllText((Join-Path $artifactRoot 'video-hermes-dashboard-end.json'), ('{"phase":"end","recordedAtUtc":"' + [DateTime]::UtcNow.ToString('O') + '"}'), [Text.UTF8Encoding]::new($false))
        }
        Write-Host '[PASS] Real Hermes dashboard accepted three typed turns, displayed three provider responses, and native Stop released its sandbox and state lease'
        return [pscustomobject]@{
            classification = 'installed-configured-hermes-dashboard'; verdict = 'pass'; agentOneShotMode = $false
            control = $control; provider = $providerReceipt; cleanup = $end; nativeStop = $nativeStop
            nativeStopScreenshot = [pscustomobject]@{ file = 'hermes-dashboard-native-stop.png'; sha256 = (Get-FileHash -LiteralPath $stopFrame -Algorithm SHA256).Hash.ToLowerInvariant() }
            tooling = [pscustomobject]@{ providerSha256 = (Get-FileHash -LiteralPath $providerScript -Algorithm SHA256).Hash.ToLowerInvariant(); controllerSha256 = (Get-FileHash -LiteralPath $controllerScript -Algorithm SHA256).Hash.ToLowerInvariant() }
        }
    } finally {
        if ($application) {
            if (-not $application.HasExited -and $session -and -not $stopInvoked) {
                try { Stop-NativeHermesDashboardSession -NodeProcessId ([int]$session.nodeProcessId) -EvidenceDirectory $evidence | Out-Null; [void]$application.WaitForExit(120000) } catch { }
            }
            if (-not $application.HasExited) { & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $application.Id /T /F | Out-Null; [void]$application.WaitForExit(10000) }
            $application.Dispose()
        }
        if ($provider) { if (-not $provider.HasExited) { $provider.Kill(); [void]$provider.WaitForExit(10000) }; $provider.Dispose() }
    }
}

function Invoke-InstalledQualificationEntry {
    param(
        [Parameter(Mandatory)][ValidateSet('run-installed-native-web-ui.mts', 'run-installed-native-pi.mts', 'run-installed-native-nemocua.mts')][string]$Entry,
        [Parameter(Mandatory)][string[]]$Arguments,
        [Parameter(Mandatory)][string]$Label
    )
    $entryPath = Join-Path $installRoot "qualification\$Entry"
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $nodePath
    $startInfo.Arguments = (@('--experimental-strip-types', '--no-warnings', $entryPath) + $Arguments | ForEach-Object {
        ConvertTo-NativeArgument -Value $_
    }) -join ' '
    $startInfo.UseShellExecute = $false
    $startInfo.WorkingDirectory = $installRoot
    $startInfo.EnvironmentVariables['NEMOCLAW_NATIVE_INSTALL_ROOT'] = $installRoot
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        Write-Host "PS> $Label :: installed native Node entry $Entry"
        if (-not $process.Start()) { Fail-PackageQualification "$Label did not start." }
        if (-not $process.WaitForExit($script:OperationTimeoutMilliseconds)) {
            $process.Kill()
            [void]$process.WaitForExit(10000)
            Fail-PackageQualification "$Label exceeded its timeout."
        }
        if ($process.ExitCode -ne 0) { Fail-PackageQualification "$Label failed with exit code $($process.ExitCode)." }
    } finally {
        $process.Dispose()
    }
}

function Initialize-NativeSetupAutomation {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    Add-Type -AssemblyName System.Drawing
    if ('NemoClawNativeSetupCapture' -as [type]) { return }
    Add-Type -ReferencedAssemblies @([Drawing.Bitmap].Assembly.Location) -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.InteropServices;
public static class NemoClawNativeSetupCapture {
    [StructLayout(LayoutKind.Sequential)] private struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
    public static void Save(IntPtr window, string path) {
        Rect rect;
        if (!GetWindowRect(window, out rect)) throw new InvalidOperationException("Native setup window is unavailable.");
        int width = rect.Right - rect.Left, height = rect.Bottom - rect.Top;
        if (width < 320 || height < 240 || width > 8192 || height > 8192) throw new InvalidOperationException("Native setup window dimensions are invalid.");
        using (var bitmap = new Bitmap(width, height)) {
            using (var graphics = Graphics.FromImage(bitmap)) {
                IntPtr dc = graphics.GetHdc();
                try { if (!PrintWindow(window, dc, 2)) throw new InvalidOperationException("Native setup PrintWindow capture failed."); }
                finally { graphics.ReleaseHdc(dc); }
            }
            var colors = new List<int>();
            for (int x = 0; x < width && colors.Count < 8; x += Math.Max(1, width / 50))
                for (int y = 0; y < height && colors.Count < 8; y += Math.Max(1, height / 50)) {
                    int color = bitmap.GetPixel(x, y).ToArgb();
                    if (!colors.Contains(color)) colors.Add(color);
                }
            if (colors.Count < 8) throw new InvalidOperationException("Native setup capture has no rendered control content.");
            bitmap.Save(path, System.Drawing.Imaging.ImageFormat.Png);
        }
    }
}
'@
}

function Wait-NativeSetupElement {
    param(
        [Parameter(Mandatory)]$Root,
        [Parameter(Mandatory)][string]$AutomationId,
        [int]$TimeoutMilliseconds = 30000
    )
    $condition = [Windows.Automation.PropertyCondition]::new(
        [Windows.Automation.AutomationElement]::AutomationIdProperty, $AutomationId
    )
    $clock = [Diagnostics.Stopwatch]::StartNew()
    do {
        $element = $Root.FindFirst([Windows.Automation.TreeScope]::Descendants, $condition)
        if ($element -and -not $element.Current.IsOffscreen -and $element.Current.IsEnabled) { return $element }
        if ($element -and $element.Current.IsEnabled) {
            try { $element.SetFocus() } catch [InvalidOperationException] { }
        }
        foreach ($failureId in @('ConfigurationError', 'FailureDetail', 'MaintenanceError')) {
            $failureCondition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::AutomationIdProperty, $failureId)
            $failure = $Root.FindFirst([Windows.Automation.TreeScope]::Descendants, $failureCondition)
            if ($failure -and -not $failure.Current.IsOffscreen -and -not [string]::IsNullOrWhiteSpace($failure.Current.Name)) {
                Fail-PackageQualification 'The native setup window reported a configuration or installation failure.'
            }
        }
        Start-Sleep -Milliseconds 200
    } while ($clock.ElapsedMilliseconds -lt $TimeoutMilliseconds)
    Fail-PackageQualification "Native setup did not expose the enabled $AutomationId control."
}

function Invoke-NativeSetupButton {
    param([Parameter(Mandatory)]$Element)
    ([Windows.Automation.InvokePattern]$Element.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)).Invoke()
}

function Save-NativeSetupFrame {
    param([Parameter(Mandatory)]$Window, [Parameter(Mandatory)][string]$Name)
    # Capture only real WPF window pixels; no replacement or rendered mock screen.
    $Window.SetFocus()
    Start-Sleep -Milliseconds 400
    $path = Join-Path $nativeSetupArtifacts $Name
    [NemoClawNativeSetupCapture]::Save([IntPtr]$Window.Current.NativeWindowHandle, $path)
    return [pscustomobject]@{
        file = $Name
        sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
        bytes = (Get-Item -LiteralPath $path).Length
    }
}

function Invoke-NativeSetupSelection {
    param(
        [Parameter(Mandatory)][string]$Agent,
        [Parameter(Mandatory)][string]$ChoiceId,
        [switch]$Maintenance,
        [switch]$Standalone,
        [switch]$ReplaceOwned,
        [ValidateSet('local', 'compatible')][string]$Inference = 'local',
        [string]$Endpoint = $script:NativeSetupEndpoint,
        [AllowEmptyString()][string]$CredentialCanary = '',
        [hashtable]$ServiceCanaries = @{},
        [string]$EvidenceName = ''
    )
    if (-not $EvidenceName) { $EvidenceName = $Agent }
    if ($EvidenceName -cnotmatch '^[a-z0-9-]+$') { Fail-PackageQualification 'Native setup evidence name is invalid.' }
    $configPath = Join-Path $nativeConfigurationRoot "$Agent\native-windows.json"
    if (Test-Path -LiteralPath $configPath) {
        if (-not $ReplaceOwned -or -not $script:OwnedNativeConfigurations.ContainsKey($configPath) -or
            (Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $script:OwnedNativeConfigurations[$configPath]) {
            Fail-PackageQualification 'Native setup qualification requires absent or unchanged owned per-agent configuration.'
        }
    } elseif ($ReplaceOwned) {
        Fail-PackageQualification 'The owned native setup configuration is missing.'
    }
    if ((Test-Path -LiteralPath $nativeActiveAgentPath) -and
        (-not $script:OwnedNativeConfigurations.ContainsKey($nativeActiveAgentPath) -or
         (Get-FileHash -LiteralPath $nativeActiveAgentPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $script:OwnedNativeConfigurations[$nativeActiveAgentPath])) {
        Fail-PackageQualification 'Native setup qualification cannot replace a pre-existing or changed remembered agent.'
    }
    $nameCondition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, 'NemoClaw Setup')
    $desktop = [Windows.Automation.AutomationElement]::RootElement
    if ($desktop.FindAll([Windows.Automation.TreeScope]::Children, $nameCondition).Count -ne 0) {
        Fail-PackageQualification 'A NemoClaw Setup window already exists before the owned UI transaction.'
    }
    $setupLog = if ($Maintenance) { Join-Path $artifactRoot "bundle-configure-$Agent.log" } else { $bundleInstallLog }
    if ($EvidenceName -cne $Agent) { $setupLog = Join-Path $artifactRoot "bundle-$EvidenceName.log" }
    $arguments = if ($Standalone) { @('--wait', '--onboard', '--agent', $Agent) } else { @('/install', '/norestart', '/log', $setupLog) }
    $arguments = $arguments | ForEach-Object { ConvertTo-NativeArgument -Value $_ }
    $application = if ($Standalone) { $nemoclawUiLauncherPath } else { $setup }
    $process = Start-Process -FilePath $application -ArgumentList $arguments -PassThru -ErrorAction Stop
    $null = $process.Handle
    $window = $null
    $snapshots = @()
    try {
        $clock = [Diagnostics.Stopwatch]::StartNew()
        do {
            $windows = $desktop.FindAll([Windows.Automation.TreeScope]::Children, $nameCondition)
            if ($windows.Count -eq 1) { $window = $windows[0]; break }
            if ($process.HasExited -or $windows.Count -gt 1) { break }
            Start-Sleep -Milliseconds 200
        } while ($clock.ElapsedMilliseconds -lt 60000)
        if (-not $window -or $window.Current.FrameworkId -cne 'WPF') {
            Fail-PackageQualification 'The bundle did not open one native WPF setup window.'
        }
        $windowProcessId = $window.Current.ProcessId
        $windowHandle = $window.Current.NativeWindowHandle
        if ($Maintenance) {
            Invoke-NativeSetupButton -Element (Wait-NativeSetupElement -Root $window -AutomationId 'ConfigureInstalledAgent')
        } else {
            Wait-NativeSetupElement -Root $window -AutomationId 'ConfigureInference' | Out-Null
        }
        $observedChoices = @()
        foreach ($choice in $nativeAgentChoices) {
            $condition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::AutomationIdProperty, $choice.automationId)
            $element = $window.FindFirst([Windows.Automation.TreeScope]::Descendants, $condition)
            if (-not $element -or -not $element.Current.IsEnabled -or $element.Current.ControlType -ne [Windows.Automation.ControlType]::RadioButton) {
                Fail-PackageQualification "Native setup is missing the enabled $($choice.agent) radio-button choice."
            }
            if ($choice.agent -in @('pi', 'nemocua') -and $element.Current.Name -notmatch 'experimental') {
                Fail-PackageQualification "Native setup did not identify $($choice.agent) as experimental."
            }
            $observedChoices += $choice.agent
        }
        $choiceCondition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::AutomationIdProperty, $ChoiceId)
        $selected = $window.FindFirst([Windows.Automation.TreeScope]::Descendants, $choiceCondition)
        $selected.SetFocus()
        $selection = [Windows.Automation.SelectionItemPattern]$selected.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern)
        if ($Standalone -and -not $selection.Current.IsSelected) {
            Fail-PackageQualification 'The installed native launcher did not preserve its requested initial agent.'
        }
        $selection.Select()
        if (-not $selection.Current.IsSelected) { Fail-PackageQualification 'The native agent selection was not applied.' }
        $snapshots += Save-NativeSetupFrame -Window $window -Name "$EvidenceName-choose.png"
        Invoke-NativeSetupButton -Element (Wait-NativeSetupElement -Root $window -AutomationId 'ConfigureInference')
        $provider = Wait-NativeSetupElement -Root $window -AutomationId 'InferenceProvider'
        $expanded = [Windows.Automation.ExpandCollapsePattern]$provider.GetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern)
        $expanded.Expand()
        $listCondition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::ListItem)
        $providerClock = [Diagnostics.Stopwatch]::StartNew()
        do {
            $providers = $provider.FindAll([Windows.Automation.TreeScope]::Descendants, $listCondition)
            if ($providers.Count -in @(4, 5)) { break }
            Start-Sleep -Milliseconds 100
        } while ($providerClock.ElapsedMilliseconds -lt 5000)
        if ($providers.Count -notin @(4, 5)) { Fail-PackageQualification 'The native inference provider list is incomplete.' }
        $providerIndex = if ($Inference -ceq 'compatible') { 2 } else { 3 }
        ([Windows.Automation.SelectionItemPattern]$providers[$providerIndex].GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern)).Select()
        $expanded.Collapse()
        foreach ($field in @(
            [pscustomobject]@{ id = 'InferenceEndpoint'; value = $Endpoint },
            [pscustomobject]@{ id = 'InferenceModel'; value = $script:NativeSetupModel }
        )) {
            $inputElement = Wait-NativeSetupElement -Root $window -AutomationId $field.id
            ([Windows.Automation.ValuePattern]$inputElement.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)).SetValue($field.value)
        }
        $password = Wait-NativeSetupElement -Root $window -AutomationId 'InferenceApiKey'
        if (-not $password.Current.IsPassword) { Fail-PackageQualification 'The native API key control does not conceal its value.' }
        ([Windows.Automation.ValuePattern]$password.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)).SetValue($CredentialCanary)
        $expectedOptions = Get-NativeCanaryOptions -Services $ServiceCanaries
        if ($ServiceCanaries.Count -gt 0) {
            $optionsElement = Wait-NativeSetupElement -Root $window -AutomationId 'DownstreamOptions'
            ([Windows.Automation.ExpandCollapsePattern]$optionsElement.GetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern)).Expand()
            if ($expectedOptions.Contains('search')) {
                $searchToggle = Wait-NativeSetupElement -Root $window -AutomationId 'EnableSearch'
                ([Windows.Automation.TogglePattern]$searchToggle.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern)).Toggle()
                $search = Wait-NativeSetupElement -Root $window -AutomationId 'SearchProvider'
                $searchExpand = [Windows.Automation.ExpandCollapsePattern]$search.GetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern)
                $searchExpand.Expand()
                $searchItems = $search.FindAll([Windows.Automation.TreeScope]::Descendants, $listCondition)
                $expectedSearchNames = if ($Agent -ceq 'openclaw') { @('Brave Search', 'Tavily') } else { @('Tavily') }
                if (@(Compare-Object $expectedSearchNames @($searchItems | ForEach-Object { $_.Current.Name })).Count -ne 0) {
                    Fail-PackageQualification 'Native search choices do not match the actual selected agent capabilities.'
                }
                $searchName = if ($expectedOptions.search.provider -ceq 'brave') { 'Brave Search' } else { 'Tavily' }
                $searchItem = @($searchItems | Where-Object { $_.Current.Name -ceq $searchName })
                ([Windows.Automation.SelectionItemPattern]$searchItem[0].GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern)).Select()
                $searchExpand.Collapse()
            }
            foreach ($channel in @('telegram', 'discord', 'slack')) {
                if (-not $expectedOptions.Contains('messaging') -or -not $expectedOptions.messaging.Contains($channel)) { continue }
                $channelId = 'Enable' + [Globalization.CultureInfo]::InvariantCulture.TextInfo.ToTitleCase($channel)
                $channelElement = Wait-NativeSetupElement -Root $window -AutomationId $channelId
                ([Windows.Automation.TogglePattern]$channelElement.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern)).Toggle()
            }
            $keyControls = @{ brave = 'SearchApiKey'; tavily = 'SearchApiKey'; telegram = 'TelegramBotToken'; discord = 'DiscordBotToken'; 'slack-bot' = 'SlackBotToken'; 'slack-app' = 'SlackAppToken' }
            foreach ($service in $ServiceCanaries.Keys) {
                $keyElement = Wait-NativeSetupElement -Root $window -AutomationId $keyControls[$service]
                if (-not $keyElement.Current.IsPassword) { Fail-PackageQualification 'An integration key control exposed its value.' }
                ([Windows.Automation.ValuePattern]$keyElement.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)).SetValue($ServiceCanaries[$service])
            }
            $snapshots += Save-NativeSetupFrame -Window $window -Name "$EvidenceName-services.png"
        }
        $license = Wait-NativeSetupElement -Root $window -AutomationId 'LicenseCheck'
        $toggle = [Windows.Automation.TogglePattern]$license.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern)
        if ($toggle.Current.ToggleState -ne [Windows.Automation.ToggleState]::On) { $toggle.Toggle() }
        $snapshots += Save-NativeSetupFrame -Window $window -Name "$EvidenceName-inference.png"
        Invoke-NativeSetupButton -Element (Wait-NativeSetupElement -Root $window -AutomationId 'InstallNemoClaw')
        if (-not $Maintenance -and -not $Standalone) {
            Wait-NativeSetupElement -Root $window -AutomationId 'ProgressBar' | Out-Null
            $snapshots += Save-NativeSetupFrame -Window $window -Name "$EvidenceName-progress.png"
        }
        Wait-NativeSetupElement -Root $window -AutomationId 'LaunchConfiguredAgent' -TimeoutMilliseconds 2700000 | Out-Null
        if (-not (Test-Path -LiteralPath $configPath -PathType Leaf) -or (Get-Item -LiteralPath $configPath).Length -gt 16384) {
            Fail-PackageQualification 'Native setup did not publish one bounded per-agent configuration.'
        }
        $configurationSha256 = (Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash.ToLowerInvariant()
        $script:OwnedNativeConfigurations[$configPath] = $configurationSha256
        $configurationText = Get-Content -LiteralPath $configPath -Raw
        if ($CredentialCanary -and $configurationText.Contains($CredentialCanary)) {
            Fail-PackageQualification 'Native setup persisted the credential canary in JSON.'
        }
        foreach ($canary in $ServiceCanaries.Values) {
            if ($configurationText.Contains($canary)) { Fail-PackageQualification 'Native setup persisted an integration key canary in JSON.' }
        }
        $config = $configurationText | ConvertFrom-Json
        $expectedEndpoint = ([Uri]$Endpoint).AbsoluteUri.TrimEnd('/')
        $configFields = @($config.PSObject.Properties.Name | Sort-Object)
        $expectedFields = @('schemaVersion', 'classification', 'profile', 'agent', 'inference', 'endpoint', 'model', 'credentialStored', 'options') | Sort-Object
        if (@(Compare-Object $expectedFields $configFields).Count -ne 0 -or
            $config.schemaVersion -ne 1 -or $config.classification -cne 'nemoclaw-native-windows-agent-configuration' -or $config.profile -cne 'personal' -or
            $config.agent -cne $Agent -or $config.inference -cne $Inference -or
            $config.endpoint -cne $expectedEndpoint -or $config.model -cne $script:NativeSetupModel -or
            $config.credentialStored -ne [bool]$CredentialCanary -or
            ($config.options | ConvertTo-Json -Depth 8 -Compress) -cne ($expectedOptions | ConvertTo-Json -Depth 8 -Compress)) {
            Fail-PackageQualification 'Native setup configuration does not match the selected nonsecret UI values.'
        }
        if (-not (Test-Path -LiteralPath $nativeActiveAgentPath -PathType Leaf) -or
            [IO.File]::ReadAllText($nativeActiveAgentPath) -cne ($Agent + "`n")) {
            Fail-PackageQualification 'Native setup did not remember the configured agent.'
        }
        $script:OwnedNativeConfigurations[$nativeActiveAgentPath] = (Get-FileHash -LiteralPath $nativeActiveAgentPath -Algorithm SHA256).Hash.ToLowerInvariant()
        $snapshots += Save-NativeSetupFrame -Window $window -Name "$EvidenceName-finish.png"
        Invoke-NativeSetupButton -Element (Wait-NativeSetupElement -Root $window -AutomationId 'CloseButton')
        if (-not $process.WaitForExit(30000) -or $process.ExitCode -notin @(0, 3010)) {
            Fail-PackageQualification 'Native setup did not complete successfully after its Done action.'
        }
        Write-Host "[PASS] Native WPF onboarding selected $Agent and saved its nonsecret configuration"
        return [pscustomobject]@{
            agent = $Agent
            entryMode = if ($Standalone) { 'installed-native-ui' } elseif ($Maintenance) { 'bundle-maintenance' } else { 'bundle-install' }
            automationId = $ChoiceId
            framework = 'WPF'
            windowTitle = 'NemoClaw Setup'
            windowProcessId = $windowProcessId
            windowHandle = $windowHandle
            selectionConfirmed = $true
            demonstratedAgentChoices = $observedChoices
            inference = $Inference
            endpoint = $config.endpoint
            model = $config.model
            credentialStored = [bool]$CredentialCanary
            credentialJsonAbsent = $true
            rememberedAgentMatches = $true
            configuredServices = @($ServiceCanaries.Keys | Sort-Object)
            serviceCanariesAbsentFromJson = $true
            configurationSha256 = $configurationSha256
            finishedWithoutLaunch = $true
            screenshots = $snapshots
        }
    } finally {
        if (-not $process.HasExited) {
            # Ask the owned window to cancel and allow MSI rollback before fallback termination.
            if ($window) {
                try { ([Windows.Automation.WindowPattern]$window.GetCurrentPattern([Windows.Automation.WindowPattern]::Pattern)).Close() } catch { }
            }
            $cleanupClock = [Diagnostics.Stopwatch]::StartNew()
            while (-not $process.WaitForExit(500) -and $cleanupClock.ElapsedMilliseconds -lt $script:OperationTimeoutMilliseconds) {
                if ($window) {
                    try {
                        foreach ($finishedId in @('CloseButton', 'FailureDetail', 'ConfigurationError')) {
                            $finishedCondition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::AutomationIdProperty, $finishedId)
                            $finished = $window.FindFirst([Windows.Automation.TreeScope]::Descendants, $finishedCondition)
                            if ($finished -and -not $finished.Current.IsOffscreen) {
                                ([Windows.Automation.WindowPattern]$window.GetCurrentPattern([Windows.Automation.WindowPattern]::Pattern)).Close()
                                break
                            }
                        }
                    } catch [Windows.Automation.ElementNotAvailableException] { }
                }
            }
            if (-not $process.HasExited) {
                $process.Kill()
                [void]$process.WaitForExit(10000)
            }
        }
        $process.Dispose()
    }
}

function Get-NativeCanaryOptions {
    param([Parameter(Mandatory)][hashtable]$Services)
    $options = [ordered]@{}
    foreach ($search in @('brave', 'tavily')) {
        if ($Services.ContainsKey($search)) { $options.search = [ordered]@{ provider = $search; credentialStored = $true } }
    }
    $channels = [ordered]@{}
    foreach ($channel in @('telegram', 'discord', 'slack')) {
        if ($Services.ContainsKey($channel) -or ($channel -ceq 'slack' -and $Services.ContainsKey('slack-bot'))) {
            $value = [ordered]@{ credentialStored = $true; allowedUsers = @() }
            if ($channel -ceq 'slack') { $value.appCredentialStored = $true }
            $channels[$channel] = $value
        }
    }
    if ($channels.Count -gt 0) { $options.messaging = $channels }
    return $options
}

function Invoke-NativeCredentialBindingControl {
    $nonce = [guid]::NewGuid().ToString('N')
    $cases = @(
        [pscustomobject]@{ agent = 'openclaw'; choice = 'AgentOpenClaw'; endpoint = "https://LOCALHOST:443/nemoclaw-$nonce-a/v1/"; canary = "NemoClawCredentialA-$nonce"; binding = $null; owned = $false; evidence = 'credential-a'; services = @{ brave = "BraveCanary-$nonce"; telegram = "TelegramCanary-$nonce"; discord = "DiscordCanary-$nonce"; 'slack-bot' = "xoxb-Canary-$nonce"; 'slack-app' = "xapp-Canary-$nonce" }; serviceBindings = @{} }
        [pscustomobject]@{ agent = 'hermes'; choice = 'AgentHermes'; endpoint = "https://localhost/nemoclaw-$nonce-b/v1"; canary = "NemoClawCredentialB-$nonce"; binding = $null; owned = $false; evidence = 'credential-b'; services = @{ tavily = "TavilyCanary-$nonce" }; serviceBindings = @{} }
    )
    $snapshots = @()
    foreach ($file in @($nativeActiveAgentPath) + @($cases | ForEach-Object { Join-Path $nativeConfigurationRoot "$($_.agent)\native-windows.json" })) {
        if (-not $script:OwnedNativeConfigurations.ContainsKey($file) -or
            (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $script:OwnedNativeConfigurations[$file]) {
            Fail-PackageQualification 'Credential binding control requires unchanged owned configuration files.'
        }
        $snapshots += [pscustomobject]@{ path = $file; bytes = [IO.File]::ReadAllBytes($file); hash = $script:OwnedNativeConfigurations[$file] }
    }
    $selections = @()
    $result = $null
    $primaryFailure = $null
    $cleanupFailures = [Collections.Generic.List[string]]::new()
    try {
        foreach ($case in $cases) {
            Write-Host "[CREDENTIAL CONTROL] Prepare inference binding: $($case.agent)"
            $metadata = [pscustomobject]@{
                schemaVersion = 1
                classification = 'nemoclaw-native-windows-agent-configuration'
                profile = 'personal'
                agent = $case.agent
                inference = 'compatible'
                endpoint = $case.endpoint
                model = $script:NativeSetupModel
                credentialStored = $true
                options = Get-NativeCanaryOptions -Services $case.services
            }
            $prepared = Invoke-NativeCredentialHelper -LauncherPath $nemoclawUiLauncherPath `
                -Arguments @('--configure-native', '--prepare') -StandardInput ($metadata | ConvertTo-Json -Depth 8 -Compress)
            if ($prepared.exitCode -ne 0 -or $prepared.stdout -cnotmatch '^[a-f0-9]{64}$') {
                Fail-PackageQualification ('Native setup did not prepare a bounded credential binding. ' + (Get-NativeCredentialPrepareDiagnostic -Result $prepared))
            }
            $case.binding = $prepared.stdout
            foreach ($snapshot in $snapshots) {
                if ((Get-FileHash -LiteralPath $snapshot.path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $snapshot.hash) {
                    Fail-PackageQualification 'Preparing a credential binding changed configuration or the remembered agent.'
                }
            }
            Write-Host "[CREDENTIAL CONTROL] Check absent inference key: $($case.agent)"
            $absent = Invoke-NativeCredentialHelper -LauncherPath $nemoclawUiLauncherPath `
                -Arguments @('--credential-read', 'compatible', '--binding', $case.binding)
            if ($absent.exitCode -eq 0 -or $absent.stdout.Length -ne 0) {
                Fail-PackageQualification 'Credential binding control requires absent canary targets.'
            }
            $case.owned = $true
            foreach ($service in $case.services.Keys) {
                Write-Host "[CREDENTIAL CONTROL] Prepare service binding: $($case.agent)/$service"
                $servicePrepared = Invoke-NativeCredentialHelper -LauncherPath $nemoclawUiLauncherPath `
                    -Arguments @('--configure-native', '--prepare-service', $service) -StandardInput ($metadata | ConvertTo-Json -Depth 8 -Compress)
                if ($servicePrepared.exitCode -ne 0 -or $servicePrepared.stdout -cnotmatch '^[a-f0-9]{64}$' -or $servicePrepared.stdout -ceq $case.binding) {
                    Fail-PackageQualification ('A service credential binding was invalid or aliased inference. ' + (Get-NativeCredentialPrepareDiagnostic -Result $servicePrepared))
                }
                Write-Host "[CREDENTIAL CONTROL] Check absent service key: $($case.agent)/$service"
                $serviceAbsent = Invoke-NativeCredentialHelper -LauncherPath $nemoclawUiLauncherPath `
                    -Arguments @('--credential-read', $service, '--binding', $servicePrepared.stdout)
                if ($serviceAbsent.exitCode -eq 0 -or $serviceAbsent.stdout.Length -ne 0) {
                    Fail-PackageQualification 'Service canary control requires an absent per-agent service credential.'
                }
                $case.serviceBindings[$service] = $servicePrepared.stdout
            }
        }
        if ($cases[0].binding -ceq $cases[1].binding) { Fail-PackageQualification 'Different endpoints shared a credential binding.' }
        foreach ($case in $cases) {
            Write-Host "[CREDENTIAL CONTROL] Configure native canary selection: $($case.agent)"
            $selections += Invoke-NativeSetupSelection -Agent $case.agent -ChoiceId $case.choice `
                -Standalone -ReplaceOwned -Inference compatible -Endpoint $case.endpoint `
                -CredentialCanary $case.canary -ServiceCanaries $case.services -EvidenceName $case.evidence
        }
        Write-Host '[CREDENTIAL CONTROL] Verify stored bindings'
        foreach ($case in $cases) {
            $read = Invoke-NativeCredentialHelper -LauncherPath $nemoclawUiLauncherPath `
                -Arguments @('--credential-read', 'compatible', '--binding', $case.binding)
            if ($read.exitCode -ne 0 -or $read.stdout -cne $case.canary) {
                Fail-PackageQualification 'The native setup canary did not remain bound to its own agent and endpoint.'
            }
            foreach ($service in $case.services.Keys) {
                $serviceRead = Invoke-NativeCredentialHelper -LauncherPath $nemoclawUiLauncherPath `
                    -Arguments @('--credential-read', $service, '--binding', $case.serviceBindings[$service])
                if ($serviceRead.exitCode -ne 0 -or $serviceRead.stdout -cne $case.services[$service]) {
                    Fail-PackageQualification 'Native setup did not store a selected service key in its own Windows credential binding.'
                }
            }
        }
        Write-Host '[CREDENTIAL CONTROL] Verify agent isolation and scoped deletion'
        $wrongAgentMetadata = [pscustomobject]@{
            schemaVersion = 1; classification = 'nemoclaw-native-windows-agent-configuration'; profile = 'personal'
            agent = $cases[1].agent; inference = 'compatible'; endpoint = $cases[0].endpoint
            model = $script:NativeSetupModel; credentialStored = $true; options = @{}
        }
        $wrongAgent = Invoke-NativeCredentialHelper -LauncherPath $nemoclawUiLauncherPath `
            -Arguments @('--configure-native', '--prepare') -StandardInput ($wrongAgentMetadata | ConvertTo-Json -Compress)
        if ($wrongAgent.exitCode -ne 0 -or $wrongAgent.stdout -cnotmatch '^[a-f0-9]{64}$' -or $wrongAgent.stdout -ceq $cases[0].binding) {
            Fail-PackageQualification ('Changing the agent did not change the credential binding. ' + (Get-NativeCredentialPrepareDiagnostic -Result $wrongAgent))
        }
        $wrongRead = Invoke-NativeCredentialHelper -LauncherPath $nemoclawUiLauncherPath `
            -Arguments @('--credential-read', 'compatible', '--binding', $wrongAgent.stdout)
        if ($wrongRead.exitCode -eq 0 -or $wrongRead.stdout.Length -ne 0) {
            Fail-PackageQualification 'A different agent could read the first endpoint canary.'
        }
        $deleted = Invoke-NativeCredentialHelper -LauncherPath $nemoclawUiLauncherPath `
            -Arguments @('--credential-delete', 'compatible', '--binding', $cases[0].binding)
        $firstAbsent = Invoke-NativeCredentialHelper -LauncherPath $nemoclawUiLauncherPath `
            -Arguments @('--credential-read', 'compatible', '--binding', $cases[0].binding)
        $secondRetained = Invoke-NativeCredentialHelper -LauncherPath $nemoclawUiLauncherPath `
            -Arguments @('--credential-read', 'compatible', '--binding', $cases[1].binding)
        if ($deleted.exitCode -ne 0 -or $firstAbsent.exitCode -eq 0 -or $firstAbsent.stdout.Length -ne 0 -or
            $secondRetained.exitCode -ne 0 -or $secondRetained.stdout -cne $cases[1].canary) {
            Fail-PackageQualification 'Deleting one credential binding changed another endpoint credential.'
        }
        $result = [pscustomobject]@{
            classification = 'native-setup-credential-binding-canary'
            endpointIsolation = $true; agentIsolation = $true; scopedDelete = $true
            prepareHadNoWrites = $true; configurationCanariesAbsent = $true
            nativeOptionalServices = [pscustomobject]@{
                services = @('brave', 'tavily', 'telegram', 'discord', 'slack-bot', 'slack-app')
                credentialRoundTrips = 6; agentCapabilityChoicesMatched = $true
                metadataOnly = $true; emptyAllowedUsersPreserved = $true
                externalServiceRequestsSent = $false; credentialCanariesAbsentFromJson = $true
            }
            rememberedAgentMatches = $true; selections = $selections
        }
    } catch {
        $primaryFailure = $_
    } finally {
        Write-Host '[CREDENTIAL CONTROL] Restore owned keys and settings'
        foreach ($case in $cases) {
            foreach ($service in $case.serviceBindings.Keys) {
                try {
                    $serviceDeleted = Invoke-NativeCredentialHelper -LauncherPath $nemoclawUiLauncherPath `
                        -Arguments @('--credential-delete', $service, '--binding', $case.serviceBindings[$service])
                    $serviceAbsent = Invoke-NativeCredentialHelper -LauncherPath $nemoclawUiLauncherPath `
                        -Arguments @('--credential-read', $service, '--binding', $case.serviceBindings[$service])
                    if ($serviceDeleted.exitCode -ne 0 -or $serviceAbsent.exitCode -eq 0 -or $serviceAbsent.stdout.Length -ne 0) { $cleanupFailures.Add("key:$($case.agent)/$service") }
                } catch { $cleanupFailures.Add("key:$($case.agent)/$service") }
            }
            if (-not $case.owned) { continue }
            try {
                $deleted = Invoke-NativeCredentialHelper -LauncherPath $nemoclawUiLauncherPath `
                    -Arguments @('--credential-delete', 'compatible', '--binding', $case.binding)
                $absent = Invoke-NativeCredentialHelper -LauncherPath $nemoclawUiLauncherPath `
                    -Arguments @('--credential-read', 'compatible', '--binding', $case.binding)
                if ($deleted.exitCode -ne 0 -or $absent.exitCode -eq 0 -or $absent.stdout.Length -ne 0) { $cleanupFailures.Add("key:$($case.agent)/inference") }
            } catch { $cleanupFailures.Add("key:$($case.agent)/inference") }
        }
        foreach ($snapshot in $snapshots) {
            $snapshotLabel = if ($snapshot.path -ceq $nativeActiveAgentPath) { 'remembered-agent' } else { Split-Path -Leaf (Split-Path -Parent $snapshot.path) }
            $temporary = $snapshot.path + '.restore-' + [guid]::NewGuid().ToString('N')
            try {
                if ((Get-FileHash -LiteralPath $snapshot.path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $script:OwnedNativeConfigurations[$snapshot.path]) {
                    throw 'The owned configuration changed during credential control.'
                }
                [IO.File]::WriteAllBytes($temporary, $snapshot.bytes)
                [IO.File]::Replace($temporary, $snapshot.path, [System.Management.Automation.Language.NullString]::Value)
                $script:OwnedNativeConfigurations[$snapshot.path] = $snapshot.hash
            } catch { $cleanupFailures.Add("restore:$snapshotLabel") }
            finally {
                try { if (Test-Path -LiteralPath $temporary -PathType Leaf) { [IO.File]::Delete($temporary) } }
                catch { $cleanupFailures.Add("temporary:$snapshotLabel") }
            }
        }
    }
    if ($cleanupFailures.Count -gt 0) {
        $cleanupMessage = 'Credential binding control could not restore owned state: ' + ($cleanupFailures -join ', ') + '.'
        if ($primaryFailure) { Write-Warning -Message $cleanupMessage -WarningAction Continue }
        else { Fail-PackageQualification $cleanupMessage }
    }
    if ($primaryFailure) { throw $primaryFailure }
    $result | Add-Member -NotePropertyName ownedStateRestored -NotePropertyValue $true
    Write-Host '[PASS] Native WPF setup kept two canary keys separate by agent and endpoint; scoped deletion and owned cleanup passed'
    return $result
}

function Remove-OwnedNativeConfigurations {
    foreach ($entry in @($script:OwnedNativeConfigurations.GetEnumerator())) {
        if (Test-Path -LiteralPath $entry.Key -PathType Leaf) {
            if ((Get-FileHash -LiteralPath $entry.Key -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entry.Value) {
                Fail-PackageQualification 'Qualification configuration changed before owned cleanup.'
            }
            [IO.File]::Delete($entry.Key)
        }
    }
}

function Export-BootstrapperStartupDiagnostics {
    param([Parameter(Mandatory)][DateTime]$StartedAt)

    foreach ($startupLog in @(Get-ChildItem `
        -LiteralPath ([IO.Path]::GetTempPath()) `
        -Filter 'NemoClaw.Bootstrapper.*.startup.log' `
        -File `
        -ErrorAction SilentlyContinue)) {
        Copy-Item -LiteralPath $startupLog.FullName -Destination $artifactRoot -Force
        Remove-Item -LiteralPath $startupLog.FullName -Force -ErrorAction SilentlyContinue
    }

    $events = @(Get-WinEvent `
        -FilterHashtable @{ LogName = 'Application'; StartTime = $StartedAt; Level = @(1, 2, 3) } `
        -ErrorAction SilentlyContinue | Where-Object {
        $_.ProviderName -in @('.NET Runtime', 'Application Error', 'SideBySide', 'Windows Error Reporting')
    } | Select-Object TimeCreated, ProviderName, Id, LevelDisplayName, Message)
    if ($events.Count -gt 0) {
        [IO.File]::WriteAllText(
            (Join-Path $artifactRoot 'bootstrapper-application-events.json'),
            (($events | ConvertTo-Json -Depth 4) + [Environment]::NewLine),
            [Text.UTF8Encoding]::new($false)
        )
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
    'native-ui\NemoClaw.Bootstrapper.exe',
    'native-ui\mbanative.dll',
    'native-ui\PenImc_cor3.dll',
    'native-ui\PresentationNative_cor3.dll',
    'native-ui\vcruntime140_cor3.dll',
    'native-ui\wpfgfx_cor3.dll',
    'bin\nemoclaw.cmd',
    'nemoclaw\app\bin\nemoclaw.js',
    'openclaw\node_modules\openclaw\openclaw.mjs',
    'pi\node_modules\@earendil-works\pi-coding-agent\dist\cli.js',
    'python\python.exe',
    'hermes\site-packages\hermes_cli\main.py',
    'hermes\site-packages\concurrent_log_handler\__init__.py',
    'deepagents\site-packages\deepagents_code\main.py',
    'deepagents\site-packages\colorama\__init__.py',
    'deepagents\site-packages\jsonschema_rs\jsonschema_rs.pyd',
    'deepagents\site-packages\quickjs_rs\__init__.py',
    'deepagents\site-packages\quickjs_rs\_guest.wasm',
    'deepagents\site-packages\quickjs_rs\_transform.wasm',
    'deepagents\site-packages\sitecustomize.py',
    'deepagents\site-packages\tiktoken\_tiktoken.cp313-win_arm64.pyd',
    'nemocua\run_with_harness.py',
    'onboarding\index.html',
    'onboarding\styles.css',
    'onboarding\app.ts',
    'mxc\wxc-exec.exe',
    'mxc\wxc-host-prep.exe',
    'config\mxc-gateway.toml',
    'qualification\native-security.mts',
    'qualification\run-installed-native-turn.mts',
    'qualification\run-installed-native-web-ui.mts',
    'qualification\run-installed-native-console-agent.mts',
    'qualification\run-installed-native-pi.mts',
    'qualification\run-installed-native-nemocua.mts',
    'agent-support.json',
    'LANGGRAPH-PYTHON313-COMPATIBILITY.patch',
    'LANGGRAPH-INMEMORY-NO-GRPC.patch',
    'LANGCHAIN-QUICKJS-NO-BSDIFF.patch',
    'DEEPAGENTS-WINDOWS-DACL.patch',
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
$qualificationStartedAt = [DateTime]::Now
$nativeSetupAudit = $null
$nativeSetupAuditStopped = $false
$nativeSetupArtifacts = Join-Path $artifactRoot 'native-setup'
[IO.Directory]::CreateDirectory($nativeSetupArtifacts) | Out-Null
$nativeConfigurationRoot = Join-Path $env:LOCALAPPDATA 'NVIDIA\NemoClaw\agents'
$nativeActiveAgentPath = Join-Path $env:LOCALAPPDATA 'NVIDIA\NemoClaw\active-agent.txt'
$nativeAgentChoices = @(
    [pscustomobject]@{ agent = 'openclaw'; automationId = 'AgentOpenClaw' },
    [pscustomobject]@{ agent = 'hermes'; automationId = 'AgentHermes' },
    [pscustomobject]@{ agent = 'langchain-deepagents-code'; automationId = 'AgentDeepAgents' },
    [pscustomobject]@{ agent = 'pi'; automationId = 'AgentPi' },
    [pscustomobject]@{ agent = 'nemocua'; automationId = 'AgentNemoCUA' }
)
$nativeSelections = @()
$desktopLinkEvidence = @()
$desktopLinkCheck = Join-Path $PSScriptRoot 'check-windows-native-desktop-links.ps1'


Write-Host "HOST> NemoClaw native Windows ARM64 package qualification"
Write-Host "HOST> os=$([Environment]::OSVersion.Version) architecture=$([Runtime.InteropServices.RuntimeInformation]::OSArchitecture) product=$ProductVersion"

try {
    Initialize-NativeSetupAutomation
    $nativeSetupAudit = Start-ProhibitedProcessAudit
    foreach ($choice in $nativeAgentChoices) {
        $standalone = $choice.agent -ceq 'nemocua'
        $nativeSelections += Invoke-NativeSetupSelection -Agent $choice.agent -ChoiceId $choice.automationId -Maintenance:($nativeSelections.Count -ne 0 -and -not $standalone) -Standalone:$standalone
    }
    $credentialBindingEvidence = Invoke-NativeCredentialBindingControl
    $desktopReceipt = Join-Path $artifactRoot 'desktop-links-configured.json'
    & $desktopLinkCheck -InstallRoot $installRoot -ReceiptPath $desktopReceipt -Expected Present
    $desktopLinkEvidence += ([IO.File]::ReadAllText($desktopReceipt) | ConvertFrom-Json)
    $nativeAuditResult = Stop-ProhibitedProcessAudit -Audit $nativeSetupAudit -RootProcessId $PID
    $nativeSetupAuditStopped = $true
    $browserStarts = @($nativeAuditResult.descendantStarts | Where-Object {
        $_.processName.ToLowerInvariant() -in @('msedge.exe', 'msedgewebview2.exe', 'chrome.exe', 'chromium.exe', 'firefox.exe', 'iexplore.exe')
    })
    $automaticAgentStarts = @($nativeAuditResult.descendantStarts | Where-Object {
        $_.processName.ToLowerInvariant() -in @('openshell.exe', 'openshell-gateway.exe', 'wxc-exec.exe', 'python.exe')
    })
    if ($browserStarts.Count -ne 0 -or $automaticAgentStarts.Count -ne 0) {
        Fail-PackageQualification 'Native setup or onboarding started a browser, WebView, or agent runtime.'
    }
    foreach ($selection in $nativeSelections) {
        if (@($nativeAuditResult.descendantStarts | Where-Object {
            $_.processId -eq $selection.windowProcessId -and $_.processName -ieq 'NemoClaw.Bootstrapper.exe'
        }).Count -lt 1) {
            Fail-PackageQualification 'The process audit did not bind a native WPF selection to an owned bootstrapper process.'
        }
    }
    $nativeSetupReceipt = [pscustomobject]@{
        framework = 'WPF'
        windowTitle = 'NemoClaw Setup'
        selections = $nativeSelections
        browserDescendantStarts = $browserStarts
        automaticAgentStarts = $automaticAgentStarts
        noAutomaticAgentLaunch = $true
        setupAndOnboardingBrowserFree = $true
        processStarts = $nativeAuditResult.descendantStarts
    }
    [IO.File]::WriteAllText((Join-Path $nativeSetupArtifacts 'native-setup.json'), ($nativeSetupReceipt | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
    Write-Host '[PASS] Five native WPF agent configurations completed with zero browser or WebView descendants'

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
    $credentialManagerEvidence = Invoke-NativeCredentialManagerRoundTrip -LauncherPath $nemoclawUiLauncherPath
    $nativeTurnArtifacts = Join-Path $artifactRoot 'native-turn'
    $nativeTurnExitCode = Invoke-BoundedProcess `
        -FilePath $nemoclawUiLauncherPath `
        -Arguments @('--native-turn', '--wait', '--qualification', '--artifact-directory', $nativeTurnArtifacts) `
        -Label 'Installed NemoClaw native MXC agent turn' `
        -AllowedExitCodes @(0)
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
    Write-Host "AGENT> $($nativeTurnReceipt.exactReply)"
    Write-Host '[PASS] Installed nemoclaw command created an MXC sandbox and completed an exact CHAT_OK turn'
    $interactiveHermesReceipt = Invoke-InteractiveHermesQualification
    $hermesDashboardReceipt = Invoke-HermesDashboardQualification
    $webUiArtifacts = Join-Path $artifactRoot 'web-ui'
    Write-Host 'PS> Launch installed NemoClaw OpenClaw web UI and complete three agent turns'
    Write-InteractiveVideoMarker -Agent 'openclaw' -Phase 'start'
    Invoke-InstalledQualificationEntry `
        -Entry 'run-installed-native-web-ui.mts' `
        -Arguments @('--qualification', '--skip-onboarding', '--artifact-directory', $webUiArtifacts) `
        -Label 'Installed OpenClaw Control UI after native setup'
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
    if ($webUiReceipt.verdict -cne 'pass' -or
        $webUiReceipt.backend -cne 'process_container' -or
        $webUiReceipt.browser -cne 'Microsoft Edge' -or
        $webUiReceipt.openClawEntrypointSha256 -cne $payloadHashes['openclaw\node_modules\openclaw\openclaw.mjs'] -or
        $webUiReceipt.nodeSha256 -cne $payloadHashes['bin\node.exe'] -or
        $webUiReceipt.openShellSha256 -cne $payloadHashes['bin\openshell.exe'] -or
        $webUiReceipt.openShellGatewaySha256 -cne $payloadHashes['bin\openshell-gateway.exe'] -or
        $webUiReceipt.deterministicLocalModel -ne $true -or
        $webUiReceipt.onboardingSkipped -ne $true -or
        $null -ne $webUiReceipt.onboardingSelection -or
        [int]$webUiReceipt.turnCount -ne 3 -or
        @($webUiReceipt.turns).Count -ne 3 -or
        $webUiReceipt.sandboxDeleted -ne $true -or
        $webUiReceipt.sandboxRegistryAbsent -ne $true -or
        $webUiReceipt.gatewayStopped -ne $true -or
        $webUiReceipt.qualificationRootsRemoved -ne $true) {
        Fail-PackageQualification 'Installed NemoClaw web UI receipt is incomplete.'
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
    Write-Host '[PASS] Native WPF onboarding selected OpenClaw and completed three exact Control UI agent turns'
    Write-InteractiveVideoMarker -Agent 'openclaw' -Phase 'end'
    $piArtifacts = Join-Path $artifactRoot 'pi'
    Write-Host 'PS> Run the installed Pi runtime after native WPF selection'
    Write-InteractiveVideoMarker -Agent 'pi' -Phase 'start'
    Invoke-InstalledQualificationEntry `
        -Entry 'run-installed-native-pi.mts' `
        -Arguments @('--qualification', '--agent', 'pi', '--artifact-directory', $piArtifacts) `
        -Label 'Installed native Windows Pi runtime qualification'
    $piReceipts = @(Get-ChildItem -LiteralPath $piArtifacts -Filter 'native-windows-pi-*.json' -File -ErrorAction SilentlyContinue)
    if ($piReceipts.Count -ne 1) {
        Fail-PackageQualification 'Installed Pi runtime did not publish exactly one receipt.'
    }
    $piReceipt = Get-Content -LiteralPath $piReceipts[0].FullName -Raw | ConvertFrom-Json
    $piSelection = @($nativeSelections | Where-Object { $_.agent -ceq 'pi' })
    if ($piSelection.Count -ne 1) { Fail-PackageQualification 'Native Pi selection evidence is missing.' }
    $piLaunchReceipt = [pscustomobject]@{
        classification = 'native-wpf-selection-and-runtime-qualification'
        selectedAgent = 'pi'
        nativeSetupSelection = $piSelection[0]
        runtimeReceipt = $piReceipt
    }
    if ($piReceipt.verdict -cne 'pass' -or
        $piLaunchReceipt.selectedAgent -cne 'pi' -or
        $piLaunchReceipt.nativeSetupSelection.agent -cne 'pi' -or
        $piReceipt.piVersion -cne '0.84.1' -or
        $piReceipt.backend -cne 'process_container' -or
        $piReceipt.interface -cne 'Pi terminal one-shot mode' -or
        $piReceipt.runtimeEntrypointSha256 -cne $payloadHashes['pi\node_modules\@earendil-works\pi-coding-agent\dist\cli.js'] -or
        $piReceipt.runtimeHostSha256 -cne $payloadHashes['bin\node.exe'] -or
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
    Write-Host 'PS> Run the installed Hermes runtime after native WPF selection'
    Write-InteractiveVideoMarker -Agent 'hermes' -Phase 'start'
    Invoke-InstalledQualificationEntry `
        -Entry 'run-installed-native-pi.mts' `
        -Arguments @('--qualification', '--agent', 'hermes', '--artifact-directory', $hermesArtifacts) `
        -Label 'Installed native Windows Hermes runtime qualification'
    $hermesReceipts = @(Get-ChildItem -LiteralPath $hermesArtifacts -Filter 'native-windows-hermes-*.json' -File -ErrorAction SilentlyContinue)
    if ($hermesReceipts.Count -ne 1) {
        Fail-PackageQualification 'Installed Hermes runtime did not publish exactly one receipt.'
    }
    $hermesReceipt = Get-Content -LiteralPath $hermesReceipts[0].FullName -Raw | ConvertFrom-Json
    $hermesSelection = @($nativeSelections | Where-Object { $_.agent -ceq 'hermes' })
    if ($hermesSelection.Count -ne 1) { Fail-PackageQualification 'Native Hermes selection evidence is missing.' }
    $hermesLaunchReceipt = [pscustomobject]@{
        classification = 'native-wpf-selection-and-runtime-qualification'
        selectedAgent = 'hermes'
        nativeSetupSelection = $hermesSelection[0]
        runtimeReceipt = $hermesReceipt
    }
    if ($hermesReceipt.verdict -cne 'pass' -or
        $hermesLaunchReceipt.selectedAgent -cne 'hermes' -or
        $hermesLaunchReceipt.nativeSetupSelection.agent -cne 'hermes' -or
        $hermesReceipt.hermesVersion -cne '0.19.0' -or
        $hermesReceipt.backend -cne 'process_container' -or
        $hermesReceipt.interface -cne 'Hermes terminal one-shot mode' -or
        $hermesReceipt.runtimeEntrypointSha256 -cne $payloadHashes['hermes\site-packages\hermes_cli\main.py'] -or
        $hermesReceipt.runtimeHostSha256 -cne $payloadHashes['python\python.exe'] -or
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
    Write-Host 'PS> Run the installed Deep Agents Code runtime after native WPF selection'
    Write-InteractiveVideoMarker -Agent 'langchain-deepagents-code' -Phase 'start'
    Invoke-InstalledQualificationEntry `
        -Entry 'run-installed-native-pi.mts' `
        -Arguments @('--qualification', '--agent', 'langchain-deepagents-code', '--artifact-directory', $deepAgentsArtifacts) `
        -Label 'Installed native Windows Deep Agents Code runtime qualification'
    $deepAgentsReceipts = @(Get-ChildItem -LiteralPath $deepAgentsArtifacts -Filter 'native-windows-langchain-deepagents-code-*.json' -File -ErrorAction SilentlyContinue)
    if ($deepAgentsReceipts.Count -ne 1) {
        Fail-PackageQualification 'Installed Deep Agents Code runtime did not publish exactly one receipt.'
    }
    $deepAgentsReceipt = Get-Content -LiteralPath $deepAgentsReceipts[0].FullName -Raw | ConvertFrom-Json
    $deepAgentsSelection = @($nativeSelections | Where-Object { $_.agent -ceq 'langchain-deepagents-code' })
    if ($deepAgentsSelection.Count -ne 1) { Fail-PackageQualification 'Native Deep Agents Code selection evidence is missing.' }
    $deepAgentsLaunchReceipt = [pscustomobject]@{
        classification = 'native-wpf-selection-and-runtime-qualification'
        selectedAgent = 'langchain-deepagents-code'
        nativeSetupSelection = $deepAgentsSelection[0]
        runtimeReceipt = $deepAgentsReceipt
    }
    if ($deepAgentsReceipt.verdict -cne 'pass' -or
        $deepAgentsLaunchReceipt.selectedAgent -cne 'langchain-deepagents-code' -or
        $deepAgentsLaunchReceipt.nativeSetupSelection.agent -cne 'langchain-deepagents-code' -or
        $deepAgentsReceipt.deepAgentsCodeVersion -cne '0.1.55' -or
        $deepAgentsReceipt.backend -cne 'process_container' -or
        $deepAgentsReceipt.interface -cne 'Deep Agents Code terminal one-shot mode' -or
        $deepAgentsReceipt.runtimeEntrypointSha256 -cne $payloadHashes['deepagents\site-packages\deepagents_code\main.py'] -or
        $deepAgentsReceipt.runtimeHostSha256 -cne $payloadHashes['python\python.exe'] -or
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
    Write-Host 'PS> Run the installed NemoCUA browser task after native WPF selection'
    Write-InteractiveVideoMarker -Agent 'nemocua' -Phase 'start'
    Invoke-InstalledQualificationEntry `
        -Entry 'run-installed-native-nemocua.mts' `
        -Arguments @('--qualification', '--agent', 'nemocua', '--artifact-directory', $nemoCuaArtifacts) `
        -Label 'Installed native Windows NemoCUA runtime qualification'
    $nemoCuaReceipts = @(Get-ChildItem -LiteralPath $nemoCuaArtifacts -Filter 'native-windows-nemocua-*.json' -File -ErrorAction SilentlyContinue)
    if ($nemoCuaReceipts.Count -ne 1) {
        Fail-PackageQualification 'Installed NemoCUA runtime did not publish exactly one receipt.'
    }
    $nemoCuaReceipt = Get-Content -LiteralPath $nemoCuaReceipts[0].FullName -Raw | ConvertFrom-Json
    $nemoCuaSelection = @($nativeSelections | Where-Object { $_.agent -ceq 'nemocua' })
    if ($nemoCuaSelection.Count -ne 1) { Fail-PackageQualification 'Native NemoCUA selection evidence is missing.' }
    $nemoCuaLaunchReceipt = [pscustomobject]@{
        classification = 'native-wpf-selection-and-runtime-qualification'
        selectedAgent = 'nemocua'
        nativeSetupSelection = $nemoCuaSelection[0]
        runtimeReceipt = $nemoCuaReceipt
    }
    if ($nemoCuaReceipt.verdict -cne 'pass' -or
        $nemoCuaLaunchReceipt.selectedAgent -cne 'nemocua' -or
        $nemoCuaLaunchReceipt.nativeSetupSelection.agent -cne 'nemocua' -or
        $nemoCuaReceipt.nemocuaVersion -cne '0.1.0-windows-experimental' -or
        $nemoCuaReceipt.backend -cne 'process_container' -or
        $nemoCuaReceipt.interface -cne 'NemoCUA visible browser task' -or
        $nemoCuaReceipt.browser -cne 'Microsoft Edge' -or
        $nemoCuaReceipt.runtimeEntrypointSha256 -cne $payloadHashes['nemocua\run_with_harness.py'] -or
        $nemoCuaReceipt.pythonSha256 -cne $payloadHashes['python\python.exe'] -or
        $nemoCuaReceipt.openShellSha256 -cne $payloadHashes['bin\openshell.exe'] -or
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
            -AllowedExitCodes @(0, 3010) `
            -TimeoutMilliseconds 2700000 | Out-Null
        if ((Get-FileHash -LiteralPath $openshellPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $payloadHashes['bin\openshell.exe']) {
            Fail-PackageQualification 'MSI repair did not restore the corrupted OpenShell CLI.'
        }
        Assert-InstalledTree -Root $installRoot -Phase 'MSI repair' -ExpectedFiles $expectedPayloadFiles
        $repairRestoredDigest = $true
        Write-Host '[PASS] MSI repair restored the deliberately corrupted openshell.exe digest'
        $desktopReceipt = Join-Path $artifactRoot 'desktop-links-repaired.json'
        & $desktopLinkCheck -InstallRoot $installRoot -ReceiptPath $desktopReceipt -Expected Present
        $desktopLinkEvidence += ([IO.File]::ReadAllText($desktopReceipt) | ConvertFrom-Json)

        Invoke-BoundedProcess `
            -FilePath (Join-Path $env:SystemRoot 'System32\msiexec.exe') `
            -Arguments @('/i', $msi, 'REINSTALL=ALL', 'REINSTALLMODE=vomus', '/qn', '/norestart', '/l*v', $msiReinstallLog) `
            -Label 'MSI reinstall' `
            -AllowedExitCodes @(0, 3010) `
            -TimeoutMilliseconds 2700000 | Out-Null
        if (@(Get-ArpEntries -DisplayName $script:MsiDisplayName).Count -ne 1) {
            Fail-PackageQualification 'MSI reinstall did not preserve one product registration.'
        }
        Assert-InstalledTree -Root $installRoot -Phase 'MSI reinstall' -ExpectedFiles $expectedPayloadFiles
        $reinstallPreservedRegistration = $true
        Write-Host '[PASS] MSI reinstall preserved exactly one product registration'
        $desktopReceipt = Join-Path $artifactRoot 'desktop-links-reinstalled.json'
        & $desktopLinkCheck -InstallRoot $installRoot -ReceiptPath $desktopReceipt -Expected Present
        $desktopLinkEvidence += ([IO.File]::ReadAllText($desktopReceipt) | ConvertFrom-Json)
    }

    . (Join-Path $PSScriptRoot 'qualify-windows-native-tester-reset.ps1')
    $testerResetEvidence = Invoke-NativeTesterResetQualification

    Invoke-BoundedProcess `
        -FilePath (Join-Path $env:SystemRoot 'System32\msiexec.exe') `
        -Arguments @('/x', $msi, '/qn', '/norestart', '/l*v', $msiUninstallLog) `
        -Label 'MSI uninstall' `
        -AllowedExitCodes @(0, 3010) `
        -TimeoutMilliseconds 2700000 | Out-Null
    Invoke-BoundedProcess `
        -FilePath $setup `
        -Arguments @('/uninstall', '/quiet', '/norestart', '/log', $bundleUninstallLog) `
        -Label 'Burn bundle registration cleanup' `
        -AllowedExitCodes @(0, 3010) `
        -TimeoutMilliseconds 2700000 | Out-Null

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
    $desktopReceipt = Join-Path $artifactRoot 'desktop-links-uninstalled.json'
    & $desktopLinkCheck -InstallRoot $installRoot -ReceiptPath $desktopReceipt -Expected Absent
    $desktopLinkEvidence += ([IO.File]::ReadAllText($desktopReceipt) | ConvertFrom-Json)
    foreach ($entry in @($script:OwnedNativeConfigurations.GetEnumerator())) {
        if (-not (Test-Path -LiteralPath $entry.Key -PathType Leaf) -or
            (Get-FileHash -LiteralPath $entry.Key -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entry.Value) {
            Fail-PackageQualification 'Windows Installer changed or removed user-owned agent configuration.'
        }
    }
    Remove-OwnedNativeConfigurations
    $nativeSetupReceipt | Add-Member -NotePropertyName configurationsPreservedOnUninstall -NotePropertyValue $true
    $nativeSetupReceipt | Add-Member -NotePropertyName qualificationConfigurationsRemoved -NotePropertyValue $true


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
            "$($_.processName)(pid=$($_.processId),parent=$($_.parentProcessId):$($_.trackedParentProcessName))"
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
        credentialManager = $credentialManagerEvidence
        credentialBinding = $credentialBindingEvidence
        desktopLinks = $desktopLinkEvidence
        testerReset = $testerResetEvidence
        nativeTurn = $nativeTurnReceipt
        nativeSetup = $nativeSetupReceipt
        webUi = $webUiReceipt
        pi = $piReceipt
        hermes = $hermesReceipt
        interactiveHermes = $interactiveHermesReceipt
        hermesDashboard = $hermesDashboardReceipt
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
    Export-BootstrapperStartupDiagnostics -StartedAt $qualificationStartedAt
    if ($nativeSetupAudit -and -not $nativeSetupAuditStopped) {
        try { Stop-ProhibitedProcessAudit -Audit $nativeSetupAudit -RootProcessId $PID | Out-Null }
        catch { Write-Warning 'Could not stop native setup process audit during cleanup.' }
    }
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
                -TimeoutMilliseconds 2700000 `
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
            -TimeoutMilliseconds 2700000 `
            -SuppressProofOutput | Out-Null
    } catch {
        Write-Warning "Bundle failure cleanup did not complete: $($_.Exception.Message)"
    }
    Remove-OwnedNativeConfigurations
}
