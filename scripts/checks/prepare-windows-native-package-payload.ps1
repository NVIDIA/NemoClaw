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
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$CandidateCheckout,
    [Parameter(Mandatory)][string]$OpenShellPayloadRoot,
    [Parameter(Mandatory)][string]$OutputDirectory
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
$script:RuamelYamlWheelSha256 = '9c8ba9eb3e793efdf924b60d521820869d5bf0cb9c6f1b82d82de8295e290b9d'
$script:ForbiddenFruitArchiveSha256 = 'e3f7e66561a29ae129aac139a85d610dbf3dd896128187ed5454b6421f624253'
$script:TiktokenVersion = '0.13.0'
$script:TiktokenSourceDigest = 'c9435714c3a84c2319499de9a300c0e604449dd0799ff246458b3bb6a7f433c1' # gitleaks:allow -- public PyPI source integrity pin
$script:TiktokenCargoLockDigest = '63a3cbad932c43582c3293b0c6ca2d3c74970d1a6a67c18a1712c3519da4d8ba' # gitleaks:allow -- checked-in Cargo lock integrity pin
$script:LangGraphLoggingSourceDigest = '5754429ea54bb8cbc9b6b062c8c30b7da11d6d2de4e40d8cf149e1af815451d4' # gitleaks:allow -- public wheel source integrity pin
$script:LangGraphLoggingPatchedDigest = '862a676aad507986ce65ba6805feae97406508f994d25b2e4fcdfafc1b366874' # gitleaks:allow -- deterministic compatibility output pin
$script:RustVersion = '1.95.0'
$script:MxcSdkVersion = '0.8.0'
$script:MxcSdkArchiveSha256 = '06bb2399d7e98ab1907acf851e12a4e44748dd467b79d3e53c2f2fbf569da14e'
$script:OpenShellRevision = 'bcd517bbe08cc80860c9be57699390cd32e8445f'

function Fail-PayloadPreparation {
    param([Parameter(Mandatory)][string]$Message)
    throw "Windows native payload preparation failed: $Message"
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

$candidate = [IO.Path]::GetFullPath($CandidateCheckout).TrimEnd('\')
$openShellPayload = [IO.Path]::GetFullPath($OpenShellPayloadRoot).TrimEnd('\')
$output = [IO.Path]::GetFullPath($OutputDirectory).TrimEnd('\')
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
$pythonBuilder = (Get-Command python.exe -ErrorAction Stop).Source
$reportedNodeVersion = (& $node --version).Trim()
if ($LASTEXITCODE -ne 0 -or $reportedNodeVersion -cne "v$($script:NodeVersion)") {
    Fail-PayloadPreparation "Node.js $($script:NodeVersion) is required to build the payload."
}
$reportedRustVersion = (& $rustup run $script:RustVersion rustc --version).Trim()
if ($LASTEXITCODE -ne 0 -or -not $reportedRustVersion.StartsWith("rustc $($script:RustVersion) ", [StringComparison]::Ordinal)) {
    Fail-PayloadPreparation "Rust $($script:RustVersion) is required to build the native launcher."
}
$reportedPythonVersion = (& $pythonBuilder --version).Trim()
if ($LASTEXITCODE -ne 0 -or $reportedPythonVersion -cne "Python $($script:PythonVersion)") {
    Fail-PayloadPreparation "Python $($script:PythonVersion) is required to build the native agent payloads."
}
Assert-Arm64PortableExecutable -Path $pythonBuilder -Label 'Python agent payload builder'

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

    $piRoot = Join-Path $output 'pi'
    [IO.Directory]::CreateDirectory($piRoot) | Out-Null
    Copy-Item -LiteralPath (Join-Path $candidate 'agents\pi\pi-runtime\package.json') -Destination $piRoot
    Copy-Item -LiteralPath (Join-Path $candidate 'agents\pi\pi-runtime\package-lock.json') -Destination $piRoot
    Invoke-Checked -FilePath $npm -Arguments @('ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund') -Label 'Pi production runtime restore' -WorkingDirectory $piRoot

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
    Invoke-WebRequest -UseBasicParsing -Uri 'https://files.pythonhosted.org/packages/e5/30/c85be8290e9565dc3c7a9720e93f3e59e09b1b163487be4946c3aa848f80/hermes_agent-0.19.0-py3-none-any.whl' -OutFile $hermesWheel
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

    $deepAgentsRoot = Join-Path $output 'deepagents'
    $deepAgentsSitePackages = Join-Path $deepAgentsRoot 'site-packages'
    [IO.Directory]::CreateDirectory($deepAgentsSitePackages) | Out-Null
    $deepAgentsLock = Join-Path $candidate 'packaging\windows\python\deepagents-windows-arm64.lock'
    Invoke-Checked `
        -FilePath $pythonBuilder `
        -Arguments @(
            '-m', 'pip', 'install',
            '--disable-pip-version-check',
            '--require-hashes',
            '--only-binary=:all:',
            '--no-deps',
            '--no-compile',
            '--target', $deepAgentsSitePackages,
            '--requirement', $deepAgentsLock
        ) `
        -Label 'Deep Agents Code native ARM64 runtime restore'
    $langGraphPatch = Join-Path $candidate 'packaging\windows\python\langgraph-api-0.14.0.dev3-python313.patch'
    $langGraphLogging = Join-Path $deepAgentsSitePackages 'langgraph_api\logging.py'
    Assert-Sha256 -Path $langGraphLogging -Expected $script:LangGraphLoggingSourceDigest -Label 'langgraph-api logging source'
    Invoke-Checked `
        -FilePath $git `
        -Arguments @('-c', 'core.autocrlf=false', 'apply', '--check', '--whitespace=nowarn', $langGraphPatch) `
        -Label 'langgraph-api Python 3.13 compatibility patch check' `
        -WorkingDirectory $deepAgentsSitePackages
    Invoke-Checked `
        -FilePath $git `
        -Arguments @('-c', 'core.autocrlf=false', 'apply', '--whitespace=nowarn', $langGraphPatch) `
        -Label 'langgraph-api Python 3.13 compatibility patch' `
        -WorkingDirectory $deepAgentsSitePackages
    Assert-Sha256 -Path $langGraphLogging -Expected $script:LangGraphLoggingPatchedDigest -Label 'patched langgraph-api logging source'
    Copy-Item -LiteralPath $langGraphPatch -Destination (Join-Path $output 'LANGGRAPH-PYTHON313-COMPATIBILITY.patch')
    $forbiddenFruitArchive = Join-Path $workRoot 'forbiddenfruit-0.1.4.tar.gz'
    Invoke-WebRequest -UseBasicParsing -Uri 'https://files.pythonhosted.org/packages/e6/79/d4f20e91327c98096d605646bdc6a5ffedae820f38d378d3515c42ec5e60/forbiddenfruit-0.1.4.tar.gz' -OutFile $forbiddenFruitArchive
    Assert-Sha256 -Path $forbiddenFruitArchive -Expected $script:ForbiddenFruitArchiveSha256 -Label 'forbiddenfruit source archive'
    $forbiddenFruitExtract = Join-Path $workRoot 'forbiddenfruit'
    [IO.Directory]::CreateDirectory($forbiddenFruitExtract) | Out-Null
    Invoke-Checked -FilePath $tar -Arguments @('-xzf', $forbiddenFruitArchive, '-C', $forbiddenFruitExtract) -Label 'forbiddenfruit extraction'
    Copy-Item -LiteralPath (Join-Path $forbiddenFruitExtract 'forbiddenfruit-0.1.4\forbiddenfruit') -Destination $deepAgentsSitePackages -Recurse
    Copy-Item -LiteralPath (Join-Path $forbiddenFruitExtract 'forbiddenfruit-0.1.4\forbiddenfruit.egg-info') -Destination $deepAgentsSitePackages -Recurse
    Copy-Item -LiteralPath (Join-Path $forbiddenFruitExtract 'forbiddenfruit-0.1.4\COPYING.mit') -Destination (Join-Path $deepAgentsRoot 'FORBIDDENFRUIT-LICENSE.txt')

    $tiktokenBuildDependencies = @(
        @{
            File = 'setuptools-80.9.0-py3-none-any.whl'
            Uri = 'https://files.pythonhosted.org/packages/a3/dc/17031897dae0efacfea57dfd3a82fdd2a2aeb58e0ff71b77b87e44edc772/setuptools-80.9.0-py3-none-any.whl'
            Sha256 = '062d34222ad13e0cc312a4c02d73f059e86a4acbfbdea8f8f76b28c99f306922'
        },
        @{
            File = 'wheel-0.45.1-py3-none-any.whl'
            Uri = 'https://files.pythonhosted.org/packages/0b/2c/87f3254fd8ffd29e4c02732eee68a83a1d3c346ae39bc6822dcbcb697f2b/wheel-0.45.1-py3-none-any.whl'
            Sha256 = '708e7481cc80179af0e556bbf0cc00b8444c7321e2700b8d8580231d13017248'
        },
        @{
            File = 'setuptools_rust-1.12.0-py3-none-any.whl'
            Uri = 'https://files.pythonhosted.org/packages/f9/7b/d05b1778f2d4e354d103e3421c6267d923032fefcc5ca5b7df0cb21cefd0/setuptools_rust-1.12.0-py3-none-any.whl'
            Sha256 = '7e7db90547f224a835b45f5ad90c983340828a345554a9a660bdb2de8605dcdd'
        },
        @{
            File = 'semantic_version-2.10.0-py2.py3-none-any.whl'
            Uri = 'https://files.pythonhosted.org/packages/6a/23/8146aad7d88f4fcb3a6218f41a60f6c2d4e3a72de72da1825dc7c8f7877c/semantic_version-2.10.0-py2.py3-none-any.whl'
            Sha256 = 'de78a3b8e0feda74cabc54aab2da702113e33ac9d9eb9d2389bcf1f58b7d9177'
        }
    )
    $tiktokenBuildWheels = @()
    foreach ($dependency in $tiktokenBuildDependencies) {
        $dependencyPath = Join-Path $workRoot $dependency.File
        Invoke-WebRequest -UseBasicParsing -Uri $dependency.Uri -OutFile $dependencyPath
        Assert-Sha256 -Path $dependencyPath -Expected $dependency.Sha256 -Label $dependency.File
        $tiktokenBuildWheels += $dependencyPath
    }
    Invoke-Checked `
        -FilePath $pythonBuilder `
        -Arguments (@(
            '-m', 'pip', 'install',
            '--disable-pip-version-check',
            '--force-reinstall',
            '--no-deps',
            '--no-index'
        ) + $tiktokenBuildWheels) `
        -Label 'Pinned tiktoken build dependency restore'
    $tiktokenArchive = Join-Path $workRoot "tiktoken-$($script:TiktokenVersion).tar.gz"
    Invoke-WebRequest `
        -UseBasicParsing `
        -Uri 'https://files.pythonhosted.org/packages/e4/e5/5f3cb2159769d0f4324c0e9e87f9de3c4b1cd45848a96b2eb3566ad5ca77/tiktoken-0.13.0.tar.gz' `
        -OutFile $tiktokenArchive
    Assert-Sha256 -Path $tiktokenArchive -Expected $script:TiktokenSourceDigest -Label 'tiktoken source archive'
    $tiktokenExtract = Join-Path $workRoot 'tiktoken'
    [IO.Directory]::CreateDirectory($tiktokenExtract) | Out-Null
    Invoke-Checked -FilePath $tar -Arguments @('-xzf', $tiktokenArchive, '-C', $tiktokenExtract) -Label 'tiktoken source extraction'
    $tiktokenSource = Join-Path $tiktokenExtract "tiktoken-$($script:TiktokenVersion)"
    Copy-Item -LiteralPath (Join-Path $tiktokenSource 'LICENSE') -Destination (Join-Path $deepAgentsRoot 'TIKTOKEN-LICENSE.txt')
    $tiktokenCargoLock = Join-Path $candidate 'packaging\windows\python\tiktoken-0.13.0.Cargo.lock'
    Assert-Sha256 -Path $tiktokenCargoLock -Expected $script:TiktokenCargoLockDigest -Label 'tiktoken Cargo lock'
    Copy-Item -LiteralPath $tiktokenCargoLock -Destination (Join-Path $tiktokenSource 'Cargo.lock')
    $tiktokenWheelRoot = Join-Path $workRoot 'tiktoken-wheel'
    [IO.Directory]::CreateDirectory($tiktokenWheelRoot) | Out-Null
    $priorRustupToolchain = $env:RUSTUP_TOOLCHAIN
    try {
        $env:RUSTUP_TOOLCHAIN = $script:RustVersion
        Invoke-Checked `
            -FilePath $pythonBuilder `
            -Arguments @(
                '-m', 'pip', 'wheel',
                '--disable-pip-version-check',
                '--no-build-isolation',
                '--no-deps',
                '--no-index',
                '--wheel-dir', $tiktokenWheelRoot,
                $tiktokenSource
            ) `
            -Label 'Pinned tiktoken native ARM64 wheel build'
    } finally {
        $env:RUSTUP_TOOLCHAIN = $priorRustupToolchain
    }
    $tiktokenWheels = @(Get-ChildItem -LiteralPath $tiktokenWheelRoot -Filter 'tiktoken-0.13.0-cp313-cp313-win_arm64.whl' -File)
    if ($tiktokenWheels.Count -ne 1) {
        Fail-PayloadPreparation 'The tiktoken native ARM64 build did not produce one exact wheel.'
    }
    Invoke-Checked `
        -FilePath $pythonBuilder `
        -Arguments @(
            '-m', 'pip', 'install',
            '--disable-pip-version-check',
            '--no-compile',
            '--no-deps',
            '--no-index',
            '--target', $deepAgentsSitePackages,
            $tiktokenWheels[0].FullName
        ) `
        -Label 'tiktoken native ARM64 runtime restore'
    Assert-Arm64PortableExecutable -Path (Join-Path $deepAgentsSitePackages 'tiktoken\_tiktoken.cp313-win_arm64.pyd') -Label 'tiktoken native ARM64 extension'
    Invoke-Checked `
        -FilePath (Join-Path $pythonRoot 'python.exe') `
        -Arguments @('-I', '-c', 'import sys; sys.path.insert(0, sys.argv[1]); import concurrent_log_handler; import hermes_cli.main', $hermesSitePackages) `
        -Label 'Hermes native ARM64 import preflight'
    Invoke-Checked `
        -FilePath (Join-Path $pythonRoot 'python.exe') `
        -Arguments @('-I', '-c', 'import sys; sys.path.insert(0, sys.argv[1]); import colorama; import tiktoken; import langchain_openai; import langgraph_api.logging; langgraph_api.logging.Formatter(); from deepagents_code import cli_main', $deepAgentsSitePackages) `
        -Label 'Deep Agents Code native ARM64 import preflight'

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

    $launcher = "@echo off`r`nset `"NEMOCLAW_NATIVE_INSTALL_ROOT=%~dp0..`"`r`n`"%~dp0node.exe`" `"%~dp0..\nemoclaw\app\bin\nemoclaw.js`" %*`r`n"
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
pc_least_privilege = false
pc_capabilities = ["privateNetworkClientServer"]
debug = false
"@
    [IO.File]::WriteAllText((Join-Path $configRoot 'mxc-gateway.toml'), $gatewayConfig, [Text.UTF8Encoding]::new($false))
    $qualificationRoot = Join-Path $output 'qualification'
    [IO.Directory]::CreateDirectory($qualificationRoot) | Out-Null
    Copy-Item -LiteralPath (Join-Path $candidate 'packaging\windows\runtime\run-installed-native-turn.mts') -Destination $qualificationRoot
    Copy-Item -LiteralPath (Join-Path $candidate 'packaging\windows\runtime\run-installed-native-web-ui.mts') -Destination $qualificationRoot
    Copy-Item -LiteralPath (Join-Path $candidate 'packaging\windows\runtime\run-installed-native-console-agent.mts') -Destination $qualificationRoot
    Copy-Item -LiteralPath (Join-Path $candidate 'packaging\windows\runtime\run-installed-native-pi.mts') -Destination $qualificationRoot
    Copy-Item -LiteralPath (Join-Path $candidate 'packaging\windows\runtime\run-installed-native-nemocua.mts') -Destination $qualificationRoot
    Copy-Item -LiteralPath (Join-Path $candidate 'packaging\windows\runtime\nemocua') -Destination (Join-Path $output 'nemocua') -Recurse
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
    foreach ($required in @(
        'bin\nemoclaw.cmd',
        'nemoclaw\app\bin\nemoclaw.js',
        'openclaw\node_modules\openclaw\openclaw.mjs',
        'pi\node_modules\@earendil-works\pi-coding-agent\dist\cli.js',
        'python\python.exe',
        'hermes\site-packages\hermes_cli\main.py',
        'hermes\site-packages\concurrent_log_handler\__init__.py',
        'deepagents\site-packages\deepagents_code\main.py',
        'deepagents\site-packages\colorama\__init__.py',
        'deepagents\site-packages\tiktoken\_tiktoken.cp313-win_arm64.pyd',
        'nemocua\run_with_harness.py',
        'onboarding\index.html',
        'onboarding\styles.css',
        'onboarding\app.ts',
        'config\mxc-gateway.toml',
        'qualification\run-installed-native-turn.mts',
        'qualification\run-installed-native-web-ui.mts',
        'qualification\run-installed-native-console-agent.mts',
        'qualification\run-installed-native-pi.mts',
        'qualification\run-installed-native-nemocua.mts',
        'agent-support.json',
        'LANGGRAPH-PYTHON313-COMPATIBILITY.patch'
    )) {
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
            [pscustomobject]@{ agent = 'hermes'; interface = 'Hermes native terminal'; status = 'candidate' },
            [pscustomobject]@{ agent = 'langchain-deepagents-code'; interface = 'Deep Agents Code terminal'; status = 'candidate' },
            [pscustomobject]@{ agent = 'pi'; interface = 'Pi native terminal'; status = 'experimental-candidate' },
            [pscustomobject]@{ agent = 'nemocua'; interface = 'NemoCUA visible browser'; status = 'experimental-candidate' }
        )
        openClaw = [pscustomobject]@{ version = '2026.7.1' }
        pi = [pscustomobject]@{
            version = '0.84.1'
            lockSha256 = (Get-FileHash -LiteralPath (Join-Path $candidate 'agents\pi\pi-runtime\package-lock.json') -Algorithm SHA256).Hash.ToLowerInvariant()
        }
        python = [pscustomobject]@{
            version = $script:PythonVersion
            archiveSha256 = $script:PythonEmbedArchiveSha256
        }
        hermes = [pscustomobject]@{
            version = $script:HermesVersion
            wheelSha256 = $script:HermesWheelSha256
            dependencyLockSha256 = (Get-FileHash -LiteralPath $hermesLock -Algorithm SHA256).Hash.ToLowerInvariant()
            omittedUnqualifiedNativeExtensions = @('cryptography==46.0.7', 'pywinpty==2.0.15')
        }
        deepAgentsCode = [pscustomobject]@{
            version = '0.1.55'
            dependencyLockSha256 = (Get-FileHash -LiteralPath $deepAgentsLock -Algorithm SHA256).Hash.ToLowerInvariant()
            langGraphPython313Compatibility = [pscustomobject]@{
                sourceSha256 = $script:LangGraphLoggingSourceDigest
                patchedSha256 = $script:LangGraphLoggingPatchedDigest
                patchSha256 = (Get-FileHash -LiteralPath $langGraphPatch -Algorithm SHA256).Hash.ToLowerInvariant()
            }
            tiktoken = [pscustomobject]@{
                version = $script:TiktokenVersion
                sourceArchiveSha256 = $script:TiktokenSourceDigest
                cargoLockSha256 = $script:TiktokenCargoLockDigest
                nativeExtensionSha256 = (Get-FileHash -LiteralPath (Join-Path $deepAgentsSitePackages 'tiktoken\_tiktoken.cp313-win_arm64.pyd') -Algorithm SHA256).Hash.ToLowerInvariant()
            }
            omittedUnqualifiedNativeExtensions = @(
                'bsdiff4==1.2.6',
                'cryptography==50.0.0',
                'grpcio==1.81.1',
                'grpcio-tools==1.81.1',
                'httptools==0.8.0',
                'jsonschema-rs==0.44.1',
                'quickjs-rs==0.2.5',
                'sqlite-vec==0.1.9',
                'textual-speedups==0.2.1',
                'uvloop==0.22.1'
            )
        }
        nemoCua = [pscustomobject]@{
            version = '0.1.0-windows-experimental'
            entrypointSha256 = (Get-FileHash -LiteralPath (Join-Path $output 'nemocua\run_with_harness.py') -Algorithm SHA256).Hash.ToLowerInvariant()
            source = 'NVIDIA/NemoClaw exact candidate commit'
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
