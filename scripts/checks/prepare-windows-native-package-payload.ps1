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
    Copy-Item -LiteralPath (Join-Path $candidate 'packaging\windows\runtime\run-installed-native-pi.mts') -Destination $qualificationRoot
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
        'onboarding\index.html',
        'onboarding\styles.css',
        'onboarding\app.ts',
        'config\mxc-gateway.toml',
        'qualification\run-installed-native-turn.mts',
        'qualification\run-installed-native-web-ui.mts',
        'qualification\run-installed-native-pi.mts',
        'agent-support.json'
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
        }
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
