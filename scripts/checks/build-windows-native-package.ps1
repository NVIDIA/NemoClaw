# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

<#
.SYNOPSIS
    Build the ARM64 NemoClaw native Windows MSI and Burn setup executable.

.DESCRIPTION
    Uses the pinned WiX Toolset projects under packaging/windows. The package
    consumes local ARM64 OpenShell payload files and contains no custom action
    or PowerShell execution path.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ProductVersion,
    [Parameter(Mandatory)][string]$PayloadRoot,
    [Parameter(Mandatory)][string]$OutputDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:ExpectedDotNetSdk = '8.0.419'
$script:ExpectedWixVersion = '5.0.2'

function Fail-WindowsPackageBuild {
    param([Parameter(Mandatory)][string]$Message)
    throw "Windows native package build failed: $Message"
}

function Resolve-PlainDirectory {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Label
    )

    $resolved = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    if (-not (Test-Path -LiteralPath $resolved -PathType Container)) {
        Fail-WindowsPackageBuild "$Label is missing."
    }
    $item = Get-Item -LiteralPath $resolved -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        Fail-WindowsPackageBuild "$Label must not be a reparse point."
    }
    return $resolved
}

function Assert-Arm64PortableExecutable {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Label
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        Fail-WindowsPackageBuild "$Label is missing."
    }
    $stream = [IO.File]::OpenRead($Path)
    $reader = [IO.BinaryReader]::new($stream)
    try {
        if ($reader.ReadUInt16() -ne 0x5A4D) {
            Fail-WindowsPackageBuild "$Label is not a Windows PE file."
        }
        $stream.Position = 0x3C
        $peOffset = $reader.ReadInt32()
        if ($peOffset -lt 0x40 -or $peOffset -gt ($stream.Length - 6)) {
            Fail-WindowsPackageBuild "$Label has an invalid PE header offset."
        }
        $stream.Position = $peOffset
        if ($reader.ReadUInt32() -ne 0x00004550 -or $reader.ReadUInt16() -ne 0xAA64) {
            Fail-WindowsPackageBuild "$Label is not an ARM64 Windows executable."
        }
    } finally {
        $reader.Dispose()
        $stream.Dispose()
    }
}

if ($ProductVersion -cnotmatch '^[0-9]{1,3}\.[0-9]{1,5}\.[0-9]{1,5}$') {
    Fail-WindowsPackageBuild 'ProductVersion must be a strict three-part MSI version.'
}

$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..')).TrimEnd('\')
$payload = Resolve-PlainDirectory -Path $PayloadRoot -Label 'PayloadRoot'
$output = [IO.Path]::GetFullPath($OutputDirectory).TrimEnd('\')
if (Test-Path -LiteralPath $output) {
    Fail-WindowsPackageBuild 'OutputDirectory must not already exist.'
}
$outputParent = Split-Path -Parent $output
if (-not (Test-Path -LiteralPath $outputParent -PathType Container)) {
    Fail-WindowsPackageBuild 'OutputDirectory parent must exist.'
}

$openshell = Join-Path $payload 'bin\openshell.exe'
$gateway = Join-Path $payload 'bin\openshell-gateway.exe'
Assert-Arm64PortableExecutable -Path $openshell -Label 'openshell.exe payload'
Assert-Arm64PortableExecutable -Path $gateway -Label 'openshell-gateway.exe payload'
foreach ($requiredPayload in @(
    'bin\node.exe',
    'bin\nemoclaw.cmd',
    'nemoclaw\app\bin\nemoclaw.js',
    'openclaw\node_modules\openclaw\openclaw.mjs',
    'mxc\wxc-exec.exe',
    'mxc\wxc-host-prep.exe',
    'config\mxc-gateway.toml',
    'qualification\run-installed-native-turn.mts',
    'OPENSHELL-NODE-UI-COMPATIBILITY.patch',
    'LICENSE.txt',
    'NATIVE-PREVIEW.txt'
)) {
    if (-not (Test-Path -LiteralPath (Join-Path $payload $requiredPayload) -PathType Leaf)) {
        Fail-WindowsPackageBuild "Required NemoClaw runtime payload is missing: $requiredPayload"
    }
}
$mxcRoot = Join-Path $payload 'mxc'
$mxcPayloadFiles = @(Get-ChildItem -LiteralPath $mxcRoot -Recurse -File | ForEach-Object {
    $_.FullName.Substring($mxcRoot.Length + 1)
} | Sort-Object)
if (@(Compare-Object @('wxc-exec.exe', 'wxc-host-prep.exe') $mxcPayloadFiles).Count -ne 0) {
    Fail-WindowsPackageBuild 'MXC payload must contain only the ProcessContainer executor and host-preparation utility.'
}
Assert-Arm64PortableExecutable -Path (Join-Path $payload 'bin\node.exe') -Label 'node.exe payload'
Assert-Arm64PortableExecutable -Path (Join-Path $payload 'mxc\wxc-exec.exe') -Label 'wxc-exec.exe payload'
Assert-Arm64PortableExecutable -Path (Join-Path $payload 'mxc\wxc-host-prep.exe') -Label 'wxc-host-prep.exe payload'

$authoringText = @(
    [IO.File]::ReadAllText((Join-Path $sourceRoot 'packaging\windows\Product.wxs')),
    [IO.File]::ReadAllText((Join-Path $sourceRoot 'packaging\windows\Bundle.wxs'))
) -join [Environment]::NewLine
if ($authoringText -match '<\s*CustomAction\b' -or
    $authoringText -match '(?i)\b(powershell|pwsh|wsl|bash|ubuntu|docker)\b') {
    Fail-WindowsPackageBuild 'WiX authoring contains a prohibited custom-action or non-native execution path.'
}
if ($authoringText -notmatch '<\s*MajorUpgrade\b[^>]*Schedule="afterInstallInitialize"') {
    Fail-WindowsPackageBuild 'Major-upgrade removal must remain inside MSI rollback protection.'
}
$exePackages = @([regex]::Matches($authoringText, '<\s*ExePackage\b[^>]*/>', 'IgnoreCase, Singleline'))
$systemDrivePreparation = @($exePackages | Where-Object {
    $_.Value -match 'Id="MxcSystemDrivePreparation"' -and
    $_.Value -match 'InstallArguments="prepare-system-drive"'
})
$nullDevicePreparation = @($exePackages | Where-Object {
    $_.Value -match 'Id="MxcNullDevicePreparation"' -and
    $_.Value -match 'InstallArguments="prepare-null-device"'
})
$invalidPrerequisite = @($exePackages | Where-Object {
    $_.Value -notmatch 'SourceFile="\$\(var\.WxcHostPrepPath\)"' -or
    $_.Value -notmatch 'PerMachine="yes"' -or
    $_.Value -notmatch 'Permanent="yes"' -or
    $_.Value -notmatch 'Vital="yes"'
})
if ($exePackages.Count -ne 2 -or $systemDrivePreparation.Count -ne 1 -or
    $nullDevicePreparation.Count -ne 1 -or $invalidPrerequisite.Count -ne 0) {
    Fail-WindowsPackageBuild 'WiX Burn authoring must contain only the exact pinned MXC host prerequisites.'
}

[IO.Directory]::CreateDirectory($output) | Out-Null
$intermediate = Join-Path $outputParent ('.windows-package-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($intermediate) | Out-Null
$restorePackages = Join-Path $intermediate 'nuget'
$wixRoot = Join-Path $sourceRoot 'packaging\windows'
$msiName = "NemoClaw-$ProductVersion-windows-arm64.msi"
$setupName = "NemoClawSetup-$ProductVersion-windows-arm64.exe"
$msiPath = Join-Path $output $msiName
$setupPath = Join-Path $output $setupName
Push-Location $wixRoot
try {
    $dotnetVersion = (& dotnet --version).Trim()
    if ($LASTEXITCODE -ne 0 -or $dotnetVersion -cne $script:ExpectedDotNetSdk) {
        Fail-WindowsPackageBuild "dotnet SDK $($script:ExpectedDotNetSdk) is required."
    }

    $msiProject = Join-Path $sourceRoot 'packaging\windows\NemoClaw.wixproj'
    $bundleProject = Join-Path $sourceRoot 'packaging\windows\NemoClaw.Bundle.wixproj'
    $commonProperties = @(
        "-p:ProductVersion=$ProductVersion",
        "-p:PayloadRoot=$payload",
        "-p:SourceRoot=$sourceRoot",
        "-p:PackageOutputRoot=$output",
        "-p:PackageIntermediateRoot=$intermediate",
        "-p:RestorePackagesPath=$restorePackages",
        '-p:ContinuousIntegrationBuild=true',
        '-p:RestoreIgnoreFailedSources=false'
    )
    $msiRestoreArguments = @(
        'restore', $msiProject,
        '--nologo',
        '--force',
        '--no-cache',
        '--packages', $restorePackages
    ) + $commonProperties
    & dotnet @msiRestoreArguments
    if ($LASTEXITCODE -ne 0) {
        Fail-WindowsPackageBuild 'Pinned WiX MSI dependency restore failed.'
    }
    $msiBuildArguments = @(
        'build', $msiProject,
        '--configuration', 'Release',
        '--nologo',
        '--no-restore',
        '--disable-build-servers'
    ) + $commonProperties
    & dotnet @msiBuildArguments
    if ($LASTEXITCODE -ne 0) {
        Fail-WindowsPackageBuild 'WiX MSI build failed.'
    }
    if (-not (Test-Path -LiteralPath $msiPath -PathType Leaf) -or (Get-Item -LiteralPath $msiPath).Length -eq 0) {
        Fail-WindowsPackageBuild "Expected package output is missing: $msiName"
    }

    $bundleProperties = $commonProperties + "-p:MsiPath=$msiPath"
    $bundleRestoreArguments = @(
        'restore', $bundleProject,
        '--nologo',
        '--force',
        '--no-cache',
        '--packages', $restorePackages
    ) + $bundleProperties
    & dotnet @bundleRestoreArguments
    if ($LASTEXITCODE -ne 0) {
        Fail-WindowsPackageBuild 'Pinned WiX Burn dependency restore failed.'
    }
    $bootstrapperExtension = Join-Path $restorePackages 'wixtoolset.bootstrapperapplications.wixext\5.0.2\wixext5\WixToolset.BootstrapperApplications.wixext.dll'
    if (-not (Test-Path -LiteralPath $bootstrapperExtension -PathType Leaf)) {
        Fail-WindowsPackageBuild 'Pinned WiX BootstrapperApplications extension was not restored.'
    }

    $bundleBuildArguments = @(
        'build', $bundleProject,
        '--configuration', 'Release',
        '--nologo',
        '--no-restore',
        '--disable-build-servers'
    ) + $bundleProperties
    & dotnet @bundleBuildArguments
    if ($LASTEXITCODE -ne 0) {
        Fail-WindowsPackageBuild 'WiX Burn build failed.'
    }
} finally {
    Pop-Location
    if (Test-Path -LiteralPath $intermediate -PathType Container) {
        [IO.Directory]::Delete($intermediate, $true)
    }
}

foreach ($package in @($msiPath, $setupPath)) {
    if (-not (Test-Path -LiteralPath $package -PathType Leaf) -or (Get-Item -LiteralPath $package).Length -eq 0) {
        Fail-WindowsPackageBuild "Expected package output is missing: $(Split-Path -Leaf $package)"
    }
}
Assert-Arm64PortableExecutable -Path $setupPath -Label $setupName

$payloadManifest = @(Get-ChildItem -LiteralPath $payload -Recurse -File | ForEach-Object {
    [pscustomobject]@{
        relativePath = $_.FullName.Substring($payload.Length + 1)
        sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        size = $_.Length
    }
} | Sort-Object relativePath)

$manifest = [pscustomobject]@{
    schemaVersion = 2
    classification = 'native-windows-candidate-preview'
    productVersion = $ProductVersion
    architecture = 'arm64'
    dotnetSdk = $dotnetVersion
    wixToolset = $script:ExpectedWixVersion
    payload = $payloadManifest
    packages = @(
        [pscustomobject]@{
            file = $msiName
            sha256 = (Get-FileHash -LiteralPath $msiPath -Algorithm SHA256).Hash.ToLowerInvariant()
            authenticodeStatus = (Get-AuthenticodeSignature -LiteralPath $msiPath).Status.ToString()
        },
        [pscustomobject]@{
            file = $setupName
            sha256 = (Get-FileHash -LiteralPath $setupPath -Algorithm SHA256).Hash.ToLowerInvariant()
            authenticodeStatus = (Get-AuthenticodeSignature -LiteralPath $setupPath).Status.ToString()
        }
    )
}
$manifestText = ($manifest | ConvertTo-Json -Depth 8) + [Environment]::NewLine
[IO.File]::WriteAllText(
    (Join-Path $output 'package-manifest.json'),
    $manifestText,
    [Text.UTF8Encoding]::new($false)
)

Write-Host "Windows native MSI: $msiPath"
Write-Host "Windows native setup executable: $setupPath"
