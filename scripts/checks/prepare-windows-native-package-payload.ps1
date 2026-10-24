# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

<#
.SYNOPSIS
    Assemble the complete native ARM64 NemoClaw installer payload.

.DESCRIPTION
    Builds the exact candidate NemoClaw CLI, installs its locked production
    dependencies, installs the locked OpenClaw runtime, and stages pinned Node,
    OpenShell, and Microsoft MXC binaries. The resulting directory is a build
    input for WiX; this script is never invoked by the installed product.
    HermesPtyControlOnly instead restores the pinned Hermes/pywinpty pair and
    exercises its native console bridge before the long native builds.
#>

[CmdletBinding(DefaultParameterSetName = 'Payload')]
param(
    [Parameter(Mandatory)][string]$CandidateCheckout,
    [Parameter(Mandatory, ParameterSetName = 'Payload')][string]$OpenShellPayloadRoot,
    [Parameter(Mandatory)][string]$OutputDirectory,
    [Parameter(Mandatory, ParameterSetName = 'HermesPtyControl')][switch]$HermesPtyControlOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

$script:NodeVersion = '22.22.3'
$script:NodeArchive = "node-v$($script:NodeVersion)-win-arm64.zip"
$script:NodeArchiveSha256 = '00be129a09e8872cd52d3bb8bba12412c5733d2224123a482a2dca4a6fbf2586'
$script:PythonVersion = '3.13.13'
$script:PythonEmbedArchive = "python-$($script:PythonVersion)-embed-arm64.zip"
$script:PythonEmbedArchiveSha256 = '1230310118a6330cd6385cfc04de48bc77c7d18c240fd5fa23d054e50b1ebb85'
$script:HermesVersion = '0.19.0'
$script:HermesWheelSha256 = 'bd0bac012aee38a60894781f4597dc29ee7bedb3448540249921f10d3bef327f'
$script:HermesWheelUri = "https://files.pythonhosted.org/packages/e5/30/c85be8290e9565dc3c7a9720e93f3e59e09b1b163487be4946c3aa848f80/hermes_agent-$($script:HermesVersion)-py3-none-any.whl"
$script:RuamelYamlWheelSha256 = '9c8ba9eb3e793efdf924b60d521820869d5bf0cb9c6f1b82d82de8295e290b9d'
$script:RustVersion = '1.95.0'
$script:MxcSdkVersion = '0.8.0'
$script:MxcSdkArchiveSha256 = '06bb2399d7e98ab1907acf851e12a4e44748dd467b79d3e53c2f2fbf569da14e'
$script:OpenShellRevision = 'bcd517bbe08cc80860c9be57699390cd32e8445f'

function Fail-PayloadPreparation {
    param([Parameter(Mandatory)][string]$Message)
    throw "Windows native payload preparation failed: $Message"
}

function Read-RequiredPayloadInventory {
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw 'The canonical Windows payload inventory is missing.'
    }
    $document = [Xml.XmlDocument]::new()
    $document.XmlResolver = $null
    $document.Load($Path)
    $entries = @($document.SelectNodes('/Project/ItemGroup/NemoClawRequiredPayload'))
    if ($entries.Count -eq 0) { throw 'The canonical Windows payload inventory is empty.' }
    $seen = @{}
    $result = @()
    foreach ($entry in $entries) {
        $relative = $entry.GetAttribute('Include')
        $phase = $entry.GetAttribute('Phase')
        if ($relative -cnotmatch '^[A-Za-z0-9@._-]+(?:\\[A-Za-z0-9@._-]+)*$' -or
            @($relative.Split('\') | Where-Object { $_ -in @('.', '..') }).Count -ne 0 -or
            $phase -cnotin @('Prepared', 'Package') -or $seen.ContainsKey($relative) -or
            @($entry.Attributes | Where-Object { $_.Name -cnotin @('Include', 'Phase') }).Count -ne 0) {
            throw 'The canonical Windows payload inventory contains an invalid or duplicate entry.'
        }
        $seen[$relative] = $true
        $result += [pscustomobject]@{ Include = $relative; Phase = $phase }
    }
    if (@($result | Where-Object Phase -CEQ 'Prepared').Count -eq 0 -or
        @($result | Where-Object Phase -CEQ 'Package').Count -eq 0) {
        throw 'The canonical Windows payload inventory must define both build phases.'
    }
    return $result
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [Parameter(Mandatory)][string[]]$Arguments,
        [Parameter(Mandatory)][string]$Label,
        [string]$WorkingDirectory
    )

    $prior = Get-Location
    try {
        if ($WorkingDirectory) { Set-Location -LiteralPath $WorkingDirectory }
        & $FilePath @Arguments
        if ($LASTEXITCODE -ne 0) {
            Fail-PayloadPreparation "$Label exited with status $LASTEXITCODE."
        }
    } finally {
        Set-Location -LiteralPath $prior
    }
}

function Assert-Sha256 {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Expected,
        [Parameter(Mandatory)][string]$Label
    )

    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -cne $Expected) {
        Fail-PayloadPreparation "$Label digest mismatch."
    }
}

function Assert-Arm64PortableExecutable {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Label
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        Fail-PayloadPreparation "$Label is missing."
    }
    $stream = [IO.File]::OpenRead($Path)
    $reader = [IO.BinaryReader]::new($stream)
    try {
        if ($reader.ReadUInt16() -ne 0x5A4D) { Fail-PayloadPreparation "$Label is not a PE file." }
        $stream.Position = 0x3C
        $peOffset = $reader.ReadInt32()
        if ($peOffset -lt 0x40 -or $peOffset -gt ($stream.Length - 6)) {
            Fail-PayloadPreparation "$Label has an invalid PE header."
        }
        $stream.Position = $peOffset
        if ($reader.ReadUInt32() -ne 0x00004550 -or $reader.ReadUInt16() -ne 0xAA64) {
            Fail-PayloadPreparation "$Label is not native Windows ARM64."
        }
    } finally {
        $reader.Dispose()
        $stream.Dispose()
    }
}

function Get-PinnedNativePythonBuilder {
    $builder = (Get-Command python.exe -ErrorAction Stop).Source
    $reportedVersion = (& $builder --version).Trim()
    if ($LASTEXITCODE -ne 0 -or $reportedVersion -cne "Python $($script:PythonVersion)") {
        Fail-PayloadPreparation "Python $($script:PythonVersion) is required to build the native agent payloads."
    }
    Assert-Arm64PortableExecutable -Path $builder -Label 'Python agent payload builder'
    return $builder
}

function Read-HermesPtyRequirement {
    param([Parameter(Mandatory)][string]$LockPath)

    $lock = [IO.File]::ReadAllText($LockPath)
    $entries = [regex]::Matches($lock, '(?m)^pywinpty==[^\r\n]+(?:\r?\n[ \t]+--hash=[^\r\n]+)*')
    if ($entries.Count -ne 1 -or $entries[0].Value -cnotmatch
        '\Apywinpty==[0-9]+(?:\.[0-9]+){2}[ \t]+\\\r?\n(?:[ \t]+--hash=sha256:[0-9a-f]{64}[ \t]+\\\r?\n)*[ \t]+--hash=sha256:[0-9a-f]{64}[ \t]*\z') {
        Fail-PayloadPreparation 'The Hermes lock must contain one complete hash-pinned pywinpty requirement.'
    }
    return $entries[0].Value + [Environment]::NewLine
}

function Invoke-CapturedHermesPtyPreflight {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [Parameter(Mandatory)][string[]]$Arguments,
        [Parameter(Mandatory)][string]$LogPath
    )

    # Windows PowerShell transcripts can omit native stderr. Drain both pipes
    # directly, retaining bounded diagnostics without changing the native result.
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $FilePath
    $start.Arguments = ($Arguments | ForEach-Object {
        '"' + [regex]::Replace([regex]::Replace($_, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
    }) -join ' '
    $start.UseShellExecute = $false
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    $log = [IO.File]::Open($LogPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    $started = $false
    $retained = 0
    $truncated = $false
    $encoding = [Text.UTF8Encoding]::new($false)
    $notice = $encoding.GetBytes("`n[native console output truncated at 64 KiB]`n")
    $limit = 64 * 1024 - $notice.Length
    try {
        $started = $process.Start()
        if (-not $started) { Fail-PayloadPreparation 'The native Hermes ConPTY preflight could not start.' }
        $readers = @($process.StandardOutput, $process.StandardError) | ForEach-Object {
            $buffer = [char[]]::new(2048)
            [pscustomobject]@{ Stream = $_; Buffer = $buffer; Read = $_.ReadAsync($buffer, 0, $buffer.Length) }
        }
        while (@($readers | Where-Object { $null -ne $_.Read }).Count -ne 0) {
            foreach ($reader in $readers) {
                if ($null -eq $reader.Read -or -not $reader.Read.IsCompleted) { continue }
                $count = $reader.Read.GetAwaiter().GetResult()
                if ($count -eq 0) { $reader.Read = $null; continue }
                $bytes = $encoding.GetBytes([string]::new($reader.Buffer, 0, $count))
                $keep = [Math]::Min($bytes.Length, $limit - $retained)
                if ($keep -gt 0) {
                    $log.Write($bytes, 0, $keep)
                    $log.Flush()
                    Write-Host -NoNewline $encoding.GetString($bytes, 0, $keep)
                    $retained += $keep
                }
                if ($keep -lt $bytes.Length) { $truncated = $true }
                $reader.Read = $reader.Stream.ReadAsync($reader.Buffer, 0, $reader.Buffer.Length)
            }
            if (@($readers | Where-Object { $null -ne $_.Read }).Count -ne 0) { Start-Sleep -Milliseconds 20 }
        }
        $process.WaitForExit()
        $exitCode = $process.ExitCode
        if ($truncated) {
            $log.Write($notice, 0, $notice.Length)
            Write-Host -NoNewline $encoding.GetString($notice)
        }
    } finally {
        try {
            if ($started -and -not $process.HasExited) {
                $process.Kill()
                $process.WaitForExit(5000) | Out-Null
            }
        } finally {
            $log.Dispose()
            $process.Dispose()
        }
    }
    if ($exitCode -ne 0) { Fail-PayloadPreparation "Native Hermes ConPTY preflight exited with status $exitCode." }
}

function Invoke-HermesPtyControl {
    param(
        [Parameter(Mandatory)][string]$Candidate,
        [Parameter(Mandatory)][string]$Output
    )

    $work = Join-Path $env:RUNNER_TEMP ('nemoclaw-hermes-pty-' + [guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($Output) | Out-Null
    $transcribing = $false
    try {
        Start-Transcript -Path (Join-Path $Output 'control.log') | Out-Null
        $transcribing = $true
        $builder = Get-PinnedNativePythonBuilder
        $site = Join-Path $work 'site-packages'
        [IO.Directory]::CreateDirectory($site) | Out-Null
        $lockPath = Join-Path $Candidate 'packaging\windows\python\hermes-windows-arm64.lock'
        $requirement = Read-HermesPtyRequirement -LockPath $lockPath
        $requirementPath = Join-Path $Output 'pywinpty-requirement.txt'
        [IO.File]::WriteAllText($requirementPath, $requirement, [Text.ASCIIEncoding]::new())
        [IO.File]::WriteAllText(
            (Join-Path $Output 'control-inputs.json'),
            (([pscustomobject]@{
                schemaVersion = 1
                classification = 'early-native-hermes-pty-control'
                pythonVersion = $script:PythonVersion
                hermesVersion = $script:HermesVersion
                hermesWheelSha256 = $script:HermesWheelSha256
                hermesLockSha256 = (Get-FileHash -LiteralPath $lockPath -Algorithm SHA256).Hash.ToLowerInvariant()
            } | ConvertTo-Json) + [Environment]::NewLine),
            [Text.UTF8Encoding]::new($false)
        )
        Invoke-Checked -FilePath $builder -Arguments @(
            '-I', '-m', 'pip', 'install', '--disable-pip-version-check',
            '--no-deps', '--require-hashes', '--only-binary=:all:', '--no-compile',
            '--timeout', '30', '--retries', '0', '--target', $site,
            '--requirement', $requirementPath,
            '--report', (Join-Path $Output 'pywinpty-restore.json')
        ) -Label 'Early Hermes native ARM64 PTY dependency restore'
        $wheel = Join-Path $work "hermes_agent-$($script:HermesVersion)-py3-none-any.whl"
        Invoke-WebRequest -UseBasicParsing -Uri $script:HermesWheelUri -OutFile $wheel -TimeoutSec 120
        Assert-Sha256 -Path $wheel -Expected $script:HermesWheelSha256 -Label 'Hermes Agent wheel'
        Invoke-Checked -FilePath $builder -Arguments @(
            '-I', '-m', 'pip', 'install', '--disable-pip-version-check',
            '--no-deps', '--no-index', '--no-compile', '--target', $site, $wheel
        ) -Label 'Early Hermes pinned runtime restore'
        Write-Host 'Running the authentic Hermes Windows ConPTY input/output/resize control.'
        Invoke-CapturedHermesPtyPreflight -FilePath $builder -Arguments @(
            '-I', (Join-Path $Candidate 'packaging\windows\python\native-hermes-preflight.py'),
            $site, '--pty-only', '--receipt', (Join-Path $Output 'console-bridge.json')
        ) -LogPath (Join-Path $Output 'native-console.log')
        if (-not (Test-Path -LiteralPath (Join-Path $Output 'console-bridge.json') -PathType Leaf)) {
            Fail-PayloadPreparation 'The early Hermes ConPTY control did not produce its receipt.'
        }
    } catch {
        $_ | Out-String | Out-File -LiteralPath (Join-Path $Output 'control-failure.txt') -Encoding utf8
        throw
    } finally {
        try {
            if ($transcribing) { Stop-Transcript | Out-Null }
        } finally {
            if (Test-Path -LiteralPath $work) { [IO.Directory]::Delete($work, $true) }
        }
    }
}

$candidate = [IO.Path]::GetFullPath($CandidateCheckout).TrimEnd('\')
$output = [IO.Path]::GetFullPath($OutputDirectory).TrimEnd('\')
if ($HermesPtyControlOnly) {
    if (-not (Test-Path -LiteralPath $candidate -PathType Container)) {
        Fail-PayloadPreparation "Required input directory is missing: $candidate"
    }
    if (Test-Path -LiteralPath $output) { Fail-PayloadPreparation 'OutputDirectory must not already exist.' }
    Invoke-HermesPtyControl -Candidate $candidate -Output $output
    return
}
$openShellPayload = [IO.Path]::GetFullPath($OpenShellPayloadRoot).TrimEnd('\')
foreach ($directory in @($candidate, $openShellPayload)) {
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
        Fail-PayloadPreparation "Required input directory is missing: $directory"
    }
}
if (Test-Path -LiteralPath $output) {
    Fail-PayloadPreparation 'OutputDirectory must not already exist.'
}

$node = (Get-Command node.exe -ErrorAction Stop).Source
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$npx = (Get-Command npx.cmd -ErrorAction Stop).Source
$tar = (Get-Command tar.exe -ErrorAction Stop).Source
$git = (Get-Command git.exe -ErrorAction Stop).Source
$rustup = (Get-Command rustup.exe -ErrorAction Stop).Source
$pythonBuilder = Get-PinnedNativePythonBuilder
$reportedNodeVersion = (& $node --version).Trim()
if ($LASTEXITCODE -ne 0 -or $reportedNodeVersion -cne "v$($script:NodeVersion)") {
    Fail-PayloadPreparation "Node.js $($script:NodeVersion) is required to build the payload."
}
$reportedRustVersion = (& $rustup run $script:RustVersion rustc --version).Trim()
if ($LASTEXITCODE -ne 0 -or -not $reportedRustVersion.StartsWith("rustc $($script:RustVersion) ", [StringComparison]::Ordinal)) {
    Fail-PayloadPreparation "Rust $($script:RustVersion) is required to build the native launcher."
}
$workRoot = Join-Path $env:RUNNER_TEMP ('nemoclaw-native-payload-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($workRoot) | Out-Null
[IO.Directory]::CreateDirectory($output) | Out-Null
$candidateVersionPath = Join-Path $candidate '.version'
$candidateRevisionPath = Join-Path $candidate '.source-revision'
$createdCandidateIdentityFiles = $false
$candidatePackageJsonPath = Join-Path $candidate 'package.json'
$candidatePackageJsonBytes = [IO.File]::ReadAllBytes($candidatePackageJsonPath)
$candidatePackageJsonTemporarilyModified = $false

try {
    Invoke-Checked -FilePath $npm -Arguments @('ci', '--ignore-scripts', '--no-audit', '--no-fund') -Label 'NemoClaw dependency restore' -WorkingDirectory $candidate
    Invoke-Checked -FilePath $npm -Arguments @('run', 'clean:cli') -Label 'NemoClaw CLI clean' -WorkingDirectory $candidate
    Invoke-Checked -FilePath $npm -Arguments @('run', 'build:policy-boundary') -Label 'NemoClaw policy boundary build' -WorkingDirectory $candidate
    Invoke-Checked -FilePath $npm -Arguments @('run', 'build:runner-boundary') -Label 'NemoClaw runner boundary build' -WorkingDirectory $candidate
    Invoke-Checked -FilePath $npx -Arguments @('--no-install', 'tsc', '-p', 'tsconfig.src.json') -Label 'NemoClaw CLI TypeScript build' -WorkingDirectory $candidate
    Invoke-Checked -FilePath $node -Arguments @('--experimental-strip-types', '--no-warnings', 'scripts/lib/package-blueprint-runner-runtime.mts') -Label 'NemoClaw blueprint runtime packaging' -WorkingDirectory $candidate
    Invoke-Checked -FilePath $node -Arguments @('dist/lib/core/generate-build-identity.js') -Label 'NemoClaw build identity generation' -WorkingDirectory $candidate
    Invoke-Checked -FilePath $node -Arguments @('dist/lib/inference/serving/generate-catalog.js') -Label 'NemoClaw catalog generation' -WorkingDirectory $candidate
    Invoke-Checked -FilePath $node -Arguments @('dist/lib/cli/generate-oclif-metadata-manifest.js') -Label 'NemoClaw command metadata generation' -WorkingDirectory $candidate

    if ((Test-Path -LiteralPath $candidateVersionPath) -or (Test-Path -LiteralPath $candidateRevisionPath)) {
        Fail-PayloadPreparation 'Candidate release identity files must not be pre-existing build residue.'
    }
    $candidateVersion = [string](Get-Content -LiteralPath (Join-Path $candidate 'package.json') -Raw | ConvertFrom-Json).version
    $candidateRevision = (& git -C $candidate rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $candidateRevision -cnotmatch '^[a-f0-9]{40}$') {
        Fail-PayloadPreparation 'Candidate Git revision could not be resolved.'
    }
    [IO.File]::WriteAllText($candidateVersionPath, "$candidateVersion`n", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($candidateRevisionPath, "$candidateRevision`n", [Text.UTF8Encoding]::new($false))
    $createdCandidateIdentityFiles = $true

    $packManifest = Get-Content -LiteralPath $candidatePackageJsonPath -Raw | ConvertFrom-Json
    if ($null -eq $packManifest.scripts -or [string]::IsNullOrWhiteSpace([string]$packManifest.scripts.prepare)) {
        Fail-PayloadPreparation 'Candidate package does not expose the expected prepare lifecycle.'
    }
    $packManifest.scripts.PSObject.Properties.Remove('prepare')
    [IO.File]::WriteAllText(
        $candidatePackageJsonPath,
        (($packManifest | ConvertTo-Json -Depth 100) + [Environment]::NewLine),
        [Text.UTF8Encoding]::new($false)
    )
    $candidatePackageJsonTemporarilyModified = $true
    $packOutput = & $npm pack --json --pack-destination $workRoot $candidate | Out-String
    if ($LASTEXITCODE -ne 0) { Fail-PayloadPreparation 'NemoClaw npm package creation failed.' }
    [IO.File]::WriteAllBytes($candidatePackageJsonPath, $candidatePackageJsonBytes)
    $candidatePackageJsonTemporarilyModified = $false
    $packReceipt = @($packOutput | ConvertFrom-Json)
    if ($packReceipt.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$packReceipt[0].filename)) {
        Fail-PayloadPreparation 'NemoClaw npm pack output was invalid.'
    }
    $nemoclawArchive = Join-Path $workRoot ([string]$packReceipt[0].filename)
    Remove-Item -LiteralPath $candidateVersionPath, $candidateRevisionPath -Force
    $createdCandidateIdentityFiles = $false

    $nemoclawProduction = Join-Path $workRoot 'nemoclaw-production'
    [IO.Directory]::CreateDirectory($nemoclawProduction) | Out-Null
    Copy-Item -LiteralPath (Join-Path $candidate 'package.json') -Destination $nemoclawProduction
    Copy-Item -LiteralPath (Join-Path $candidate 'package-lock.json') -Destination $nemoclawProduction
    Invoke-Checked -FilePath $npm -Arguments @('ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund') -Label 'NemoClaw production dependency restore' -WorkingDirectory $nemoclawProduction
    $nemoclawExtract = Join-Path $workRoot 'nemoclaw-package'
    [IO.Directory]::CreateDirectory($nemoclawExtract) | Out-Null
    Invoke-Checked -FilePath $tar -Arguments @('-xzf', $nemoclawArchive, '-C', $nemoclawExtract) -Label 'NemoClaw package extraction'
    $nemoclawRoot = Join-Path $output 'nemoclaw'
    [IO.Directory]::CreateDirectory($nemoclawRoot) | Out-Null
    Copy-Item -LiteralPath (Join-Path $nemoclawExtract 'package') -Destination (Join-Path $nemoclawRoot 'app') -Recurse
    [IO.File]::WriteAllBytes((Join-Path $nemoclawRoot 'app\package.json'), $candidatePackageJsonBytes)
    Copy-Item -LiteralPath (Join-Path $nemoclawProduction 'node_modules') -Destination (Join-Path $nemoclawRoot 'node_modules') -Recurse

    $openClawRoot = Join-Path $output 'openclaw'
    [IO.Directory]::CreateDirectory($openClawRoot) | Out-Null
    Copy-Item -LiteralPath (Join-Path $candidate 'agents\openclaw\openclaw-runtime\package.json') -Destination $openClawRoot
    Copy-Item -LiteralPath (Join-Path $candidate 'agents\openclaw\openclaw-runtime\package-lock.json') -Destination $openClawRoot
    Invoke-Checked -FilePath $npm -Arguments @('ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund') -Label 'OpenClaw production runtime restore' -WorkingDirectory $openClawRoot

    $braveArchive = Join-Path $workRoot 'brave-plugin-2026.7.1.tgz'
    Invoke-WebRequest -UseBasicParsing -Uri 'https://registry.npmjs.org/@openclaw/brave-plugin/-/brave-plugin-2026.7.1.tgz' -OutFile $braveArchive
    Assert-Sha256 -Path $braveArchive -Expected 'f5198ea18ea0adebc376c669b8e5e1100781f07ec2d9e24e86c90cb82acb039c' -Label 'Reviewed OpenClaw Brave provider'
    $braveRoot = Join-Path $openClawRoot 'extensions\brave'
    [IO.Directory]::CreateDirectory($braveRoot) | Out-Null
    Invoke-Checked -FilePath $tar -Arguments @('-xzf', $braveArchive, '--strip-components=1', '-C', $braveRoot) -Label 'Reviewed Brave provider extraction'

    $pythonArchivePath = Join-Path $workRoot $script:PythonEmbedArchive
    Invoke-WebRequest -UseBasicParsing -Uri "https://www.python.org/ftp/python/$($script:PythonVersion)/$($script:PythonEmbedArchive)" -OutFile $pythonArchivePath
    Assert-Sha256 -Path $pythonArchivePath -Expected $script:PythonEmbedArchiveSha256 -Label 'Python ARM64 embeddable archive'
    $pythonRoot = Join-Path $output 'python'
    Expand-Archive -LiteralPath $pythonArchivePath -DestinationPath $pythonRoot
    Assert-Arm64PortableExecutable -Path (Join-Path $pythonRoot 'python.exe') -Label 'Packaged Python runtime'
    [IO.File]::WriteAllText(
        (Join-Path $pythonRoot 'python313._pth'),
        "python313.zip`r`n.`r`nimport site`r`n",
        [Text.ASCIIEncoding]::new()
    )

    $hermesRoot = Join-Path $output 'hermes'
    $hermesSitePackages = Join-Path $hermesRoot 'site-packages'
    [IO.Directory]::CreateDirectory($hermesSitePackages) | Out-Null
    Copy-Item -LiteralPath (Join-Path $candidate 'packaging\windows\CONPTY-LICENSE.txt') -Destination (Join-Path $hermesRoot 'CONPTY-LICENSE.txt')
    $hermesLock = Join-Path $candidate 'packaging\windows\python\hermes-windows-arm64.lock'
    Invoke-Checked `
        -FilePath $pythonBuilder `
        -Arguments @(
            '-m', 'pip', 'install',
            '--disable-pip-version-check',
            '--require-hashes',
            '--only-binary=:all:',
            '--no-compile',
            '--target', $hermesSitePackages,
            '--requirement', $hermesLock
        ) `
        -Label 'Hermes native ARM64 dependency restore'
    $hermesWheel = Join-Path $workRoot "hermes_agent-$($script:HermesVersion)-py3-none-any.whl"
    Invoke-WebRequest -UseBasicParsing -Uri $script:HermesWheelUri -OutFile $hermesWheel
    Assert-Sha256 -Path $hermesWheel -Expected $script:HermesWheelSha256 -Label 'Hermes Agent wheel'
    $ruamelWheel = Join-Path $workRoot 'ruamel_yaml-0.18.17-py3-none-any.whl'
    Invoke-WebRequest -UseBasicParsing -Uri 'https://files.pythonhosted.org/packages/af/fe/b6045c782f1fd1ae317d2a6ca1884857ce5c20f59befe6ab25a8603c43a7/ruamel_yaml-0.18.17-py3-none-any.whl' -OutFile $ruamelWheel
    Assert-Sha256 -Path $ruamelWheel -Expected $script:RuamelYamlWheelSha256 -Label 'ruamel.yaml wheel'
    Invoke-Checked `
        -FilePath $pythonBuilder `
        -Arguments @(
            '-m', 'pip', 'install',
            '--disable-pip-version-check',
            '--no-deps',
            '--no-index',
            '--no-compile',
            '--target', $hermesSitePackages,
            $ruamelWheel,
            $hermesWheel
        ) `
        -Label 'Hermes Agent runtime restore'

    # discord.py bundles optional x86/x64 Opus binaries even without [voice].
    # Native text messaging keeps the authentic SDK, excluding those two unused
    # voice-only files before the package-wide ARM64 executable inspection.
    foreach ($voiceFile in @('discord\bin\libopus-0.x64.dll', 'discord\bin\libopus-0.x86.dll')) {
        Remove-Item -LiteralPath (Join-Path $hermesSitePackages $voiceFile) -Force
    }
    Invoke-Checked `
        -FilePath (Join-Path $pythonRoot 'python.exe') `
        -Arguments @('-I', (Join-Path $candidate 'packaging\windows\python\native-hermes-preflight.py'), $hermesSitePackages) `
        -Label 'Hermes native ARM64 messaging and ConPTY preflight'

    $nodeArchivePath = Join-Path $workRoot $script:NodeArchive
    Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$($script:NodeVersion)/$($script:NodeArchive)" -OutFile $nodeArchivePath
    Assert-Sha256 -Path $nodeArchivePath -Expected $script:NodeArchiveSha256 -Label 'Node.js ARM64 archive'
    $nodeExtract = Join-Path $workRoot 'node'
    Expand-Archive -LiteralPath $nodeArchivePath -DestinationPath $nodeExtract
    $nodeDistributionRoot = Join-Path $nodeExtract "node-v$($script:NodeVersion)-win-arm64"

    $binRoot = Join-Path $output 'bin'
    [IO.Directory]::CreateDirectory($binRoot) | Out-Null
    $launcherTarget = Join-Path $workRoot 'launcher-target'
    Invoke-Checked `
        -FilePath $rustup `
        -Arguments @(
            'run', $script:RustVersion, 'cargo',
            'build',
            '--locked',
            '--release',
            '--target', 'aarch64-pc-windows-msvc',
            '--manifest-path', (Join-Path $candidate 'packaging\windows\launcher\Cargo.toml'),
            '--target-dir', $launcherTarget
        ) `
        -Label 'NemoClaw native Windows launcher build'
    Invoke-Checked `
        -FilePath $rustup `
        -Arguments @(
            'run', $script:RustVersion, 'cargo', 'test', '--locked',
            '--target', 'aarch64-pc-windows-msvc',
            '--manifest-path', (Join-Path $candidate 'packaging\windows\launcher\Cargo.toml'),
            '--target-dir', $launcherTarget
        ) `
        -Label 'Native Windows state ownership and credential boundary tests'
    Copy-Item `
        -LiteralPath (Join-Path $launcherTarget 'aarch64-pc-windows-msvc\release\NemoClaw.exe') `
        -Destination (Join-Path $binRoot 'NemoClaw.exe')
    Copy-Item -LiteralPath (Join-Path $nodeDistributionRoot 'node.exe') -Destination (Join-Path $binRoot 'node.exe')
    Copy-Item -LiteralPath (Join-Path $nodeDistributionRoot 'LICENSE') -Destination (Join-Path $output 'NODE-LICENSE.txt')
    Copy-Item -LiteralPath (Join-Path $openShellPayload 'openshell.exe') -Destination (Join-Path $binRoot 'openshell.exe')
    Copy-Item -LiteralPath (Join-Path $openShellPayload 'openshell-gateway.exe') -Destination (Join-Path $binRoot 'openshell-gateway.exe')

    $mxcArchivePath = Join-Path $workRoot "mxc-sdk-$($script:MxcSdkVersion).tgz"
    Invoke-WebRequest -UseBasicParsing -Uri "https://registry.npmjs.org/@microsoft/mxc-sdk/-/mxc-sdk-$($script:MxcSdkVersion).tgz" -OutFile $mxcArchivePath
    Assert-Sha256 -Path $mxcArchivePath -Expected $script:MxcSdkArchiveSha256 -Label 'Microsoft MXC SDK archive'
    $mxcExtract = Join-Path $workRoot 'mxc-sdk'
    [IO.Directory]::CreateDirectory($mxcExtract) | Out-Null
    Invoke-Checked -FilePath $tar -Arguments @('-xzf', $mxcArchivePath, '-C', $mxcExtract) -Label 'Microsoft MXC SDK extraction'
    $mxcRoot = Join-Path $output 'mxc'
    [IO.Directory]::CreateDirectory($mxcRoot) | Out-Null
    $mxcDistributionRoot = Join-Path $mxcExtract 'package\bin\arm64'
    foreach ($mxcFile in @('wxc-exec.exe', 'wxc-host-prep.exe')) {
        $mxcSource = Join-Path $mxcDistributionRoot $mxcFile
        if (-not (Test-Path -LiteralPath $mxcSource -PathType Leaf)) {
            Fail-PayloadPreparation "Pinned Microsoft MXC archive is missing $mxcFile."
        }
        Copy-Item -LiteralPath $mxcSource -Destination (Join-Path $mxcRoot $mxcFile)
    }
    Copy-Item -LiteralPath (Join-Path $candidate 'packaging\windows\MXC-LICENSE.txt') -Destination (Join-Path $output 'MXC-LICENSE.txt')

    $launcher = "@echo off`r`n`"%~dp0node.exe`" `"%~dp0..\nemoclaw\app\bin\nemoclaw.js`" %*`r`n"
    [IO.File]::WriteAllText((Join-Path $binRoot 'nemoclaw.cmd'), $launcher, [Text.ASCIIEncoding]::new())
    $openClawLauncher = "@echo off`r`n`"%~dp0node.exe`" `"%~dp0..\openclaw\node_modules\openclaw\openclaw.mjs`" %*`r`n"
    [IO.File]::WriteAllText((Join-Path $binRoot 'openclaw.cmd'), $openClawLauncher, [Text.ASCIIEncoding]::new())

    Copy-Item `
        -LiteralPath (Join-Path $candidate 'packaging\windows\onboarding') `
        -Destination (Join-Path $output 'onboarding') `
        -Recurse

    $configRoot = Join-Path $output 'config'
    [IO.Directory]::CreateDirectory($configRoot) | Out-Null
    $gatewayConfig = @"
[openshell.drivers.mxc]
wxc_exec_path = "C:\\Program Files\\NVIDIA\\NemoClaw\\mxc\\wxc-exec.exe"
backend = "process_container"
default_configuration_id = "composable"
# AppContainer compatibility baseline: the pinned ARM64 Node/agent paths have not
# qualified restricted/LPAC mode. Personal adds internetClient/outbound-open per
# sandbox; it grants no Windows user-profile filesystem access. Retirement needs
# negative filesystem/network evidence: https://github.com/NVIDIA/NemoClaw/issues/8178
pc_least_privilege = false
pc_capabilities = ["privateNetworkClientServer"]
debug = false
"@
    [IO.File]::WriteAllText((Join-Path $configRoot 'mxc-gateway.toml'), $gatewayConfig, [Text.UTF8Encoding]::new($false))
    $qualificationRoot = Join-Path $output 'qualification'
    [IO.Directory]::CreateDirectory($qualificationRoot) | Out-Null
    Copy-Item -LiteralPath (Join-Path $candidate 'packaging\windows\runtime\native-security.mts') -Destination $qualificationRoot
    Copy-Item -LiteralPath (Join-Path $candidate 'packaging\windows\runtime\native-state.mts') -Destination $qualificationRoot
    Copy-Item -LiteralPath (Join-Path $candidate 'packaging\windows\runtime\native-ui-file-owner.mts') -Destination $qualificationRoot
    Copy-Item -LiteralPath (Join-Path $candidate 'packaging\windows\runtime\native-hermes-dashboard.mts') -Destination $qualificationRoot
    Copy-Item -LiteralPath (Join-Path $candidate 'packaging\windows\runtime\run-installed-native-hermes-ui.mts') -Destination $qualificationRoot
    Copy-Item -LiteralPath (Join-Path $candidate 'packaging\windows\runtime\native-remove-data.mts') -Destination $qualificationRoot
    Copy-Item -LiteralPath (Join-Path $candidate 'packaging\windows\runtime\native-web-session.mts') -Destination $qualificationRoot
    Copy-Item -LiteralPath (Join-Path $candidate 'packaging\windows\runtime\native-session-diagnostics.mts') -Destination $qualificationRoot
    Copy-Item -LiteralPath (Join-Path $candidate 'packaging\windows\runtime\native-ui-tunnel.mts') -Destination $qualificationRoot
    Copy-Item -LiteralPath (Join-Path $candidate 'packaging\windows\assets\desktop-icons') -Destination (Join-Path $output 'desktop-icons') -Recurse
    Copy-Item -LiteralPath (Join-Path $candidate 'packaging\windows\runtime\native-options.mts') -Destination $qualificationRoot
    Copy-Item -LiteralPath (Join-Path $candidate 'packaging\windows\runtime\native-inference-broker.mts') -Destination $qualificationRoot
    foreach ($brokerFile in @('native-broker-relay.mts', 'native-broker-tunnel.mts', 'native-broker-relay-protocol.mts')) {
        Copy-Item -LiteralPath (Join-Path $candidate "packaging\windows\runtime\$brokerFile") -Destination $qualificationRoot
    }
    Copy-Item -LiteralPath (Join-Path $candidate 'packaging\windows\runtime\native-ui-relay.mts') -Destination $qualificationRoot
    Copy-Item -LiteralPath (Join-Path $candidate 'packaging\windows\runtime\native-ui-lifecycle.mts') -Destination $qualificationRoot
    Copy-Item -LiteralPath (Join-Path $candidate 'packaging\windows\runtime\native-console-attachment.mts') -Destination $qualificationRoot
    foreach ($inferenceFile in @('native-inference.mts', 'native-inference-cli.mts', 'native-inference-host.mts', 'native-inference-install.mts', 'native-inference-download.mts', 'native-inference-manifest.mts', 'native-inference-manifest.json', 'native-inference-guard.mts', 'native-inference-unpack.py', 'native-configured-inference.mts')) {
        Copy-Item -LiteralPath (Join-Path $candidate "packaging\windows\runtime\$inferenceFile") -Destination $qualificationRoot
    }
    Copy-Item -LiteralPath (Join-Path $candidate 'packaging\windows\runtime\run-installed-native-turn.mts') -Destination $qualificationRoot
    Copy-Item -LiteralPath (Join-Path $candidate 'packaging\windows\runtime\run-installed-native-web-ui.mts') -Destination $qualificationRoot
    Copy-Item -LiteralPath (Join-Path $candidate 'packaging\windows\runtime\run-installed-native-console-agent.mts') -Destination $qualificationRoot
    Copy-Item -LiteralPath (Join-Path $candidate 'packaging\windows\runtime\run-installed-native-hermes-turn.mts') -Destination $qualificationRoot
    Copy-Item -LiteralPath (Join-Path $candidate 'LICENSE') -Destination (Join-Path $output 'LICENSE.txt')
    Copy-Item -LiteralPath (Join-Path $candidate 'packaging\windows\NATIVE-PREVIEW.txt') -Destination (Join-Path $output 'NATIVE-PREVIEW.txt')
    Copy-Item -LiteralPath (Join-Path $candidate 'packaging\windows\agent-support.json') -Destination (Join-Path $output 'agent-support.json')
    Copy-Item -LiteralPath (Join-Path $candidate 'packaging\windows\openshell-2721-node-ui.patch') -Destination (Join-Path $output 'OPENSHELL-NODE-UI-COMPATIBILITY.patch')

    foreach ($portableExecutable in @(
        'bin\node.exe',
        'bin\NemoClaw.exe',
        'bin\openshell.exe',
        'bin\openshell-gateway.exe',
        'mxc\wxc-exec.exe',
        'mxc\wxc-host-prep.exe'
    )) {
        Assert-Arm64PortableExecutable -Path (Join-Path $output $portableExecutable) -Label $portableExecutable
    }
    $requiredInventory = @(Read-RequiredPayloadInventory -Path (Join-Path $candidate 'packaging\windows\RequiredPayload.props'))
    foreach ($entry in @($requiredInventory | Where-Object Phase -CEQ 'Prepared')) {
        $required = $entry.Include
        if (-not (Test-Path -LiteralPath (Join-Path $output $required) -PathType Leaf)) {
            Fail-PayloadPreparation "Prepared payload is incomplete: $required"
        }
    }

    $receipt = [pscustomobject]@{
        schemaVersion = 1
        classification = 'nemoclaw-native-windows-arm64-runtime-payload'
        nemoclaw = [pscustomobject]@{ version = $candidateVersion; revision = $candidateRevision }
        node = [pscustomobject]@{ version = $script:NodeVersion; archiveSha256 = $script:NodeArchiveSha256 }
        launcher = [pscustomobject]@{
            rustVersion = $script:RustVersion
            sha256 = (Get-FileHash -LiteralPath (Join-Path $output 'bin\NemoClaw.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
            credentialBackend = 'Windows Credential Manager generic credentials'
            configurationRoot = '%LOCALAPPDATA%\NVIDIA\NemoClaw\agents'
        }
        agentAdapters = @(
            [pscustomobject]@{ agent = 'openclaw'; interface = 'OpenClaw Control UI'; status = 'candidate' },
            [pscustomobject]@{ agent = 'hermes'; interface = 'Hermes native terminal'; status = 'candidate' }
        )
        openClaw = [pscustomobject]@{ version = '2026.7.1' }
        python = [pscustomobject]@{
            version = $script:PythonVersion
            archiveSha256 = $script:PythonEmbedArchiveSha256
        }
        hermes = [pscustomobject]@{
            version = $script:HermesVersion
            wheelSha256 = $script:HermesWheelSha256
            dependencyLockSha256 = (Get-FileHash -LiteralPath $hermesLock -Algorithm SHA256).Hash.ToLowerInvariant()
            omittedUnqualifiedNativeExtensions = @('cryptography==46.0.7')
        }
        agentSupportSha256 = (Get-FileHash -LiteralPath (Join-Path $output 'agent-support.json') -Algorithm SHA256).Hash.ToLowerInvariant()
        openShell = [pscustomobject]@{ pullRequest = 'NVIDIA/OpenShell#2721'; revision = $script:OpenShellRevision }
        openShellCompatibilityPatchSha256 = (Get-FileHash -LiteralPath (Join-Path $output 'OPENSHELL-NODE-UI-COMPATIBILITY.patch') -Algorithm SHA256).Hash.ToLowerInvariant()
        mxc = [pscustomobject]@{
            npmPackage = '@microsoft/mxc-sdk'
            version = $script:MxcSdkVersion
            archiveSha256 = $script:MxcSdkArchiveSha256
            packagedFiles = @('wxc-exec.exe', 'wxc-host-prep.exe')
        }
    }
    [IO.File]::WriteAllText(
        (Join-Path $output 'runtime-payload-receipt.json'),
        (($receipt | ConvertTo-Json -Depth 6) + [Environment]::NewLine),
        [Text.UTF8Encoding]::new($false)
    )
} catch {
    if (Test-Path -LiteralPath $output) {
        [IO.Directory]::Delete($output, $true)
    }
    throw
} finally {
    if ($candidatePackageJsonTemporarilyModified) {
        [IO.File]::WriteAllBytes($candidatePackageJsonPath, $candidatePackageJsonBytes)
    }
    if ($createdCandidateIdentityFiles) {
        Remove-Item -LiteralPath $candidateVersionPath, $candidateRevisionPath -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $workRoot) {
        [IO.Directory]::Delete($workRoot, $true)
    }
}

Write-Host "Prepared complete NemoClaw native Windows payload: $output"
