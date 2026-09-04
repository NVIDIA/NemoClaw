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

function Get-StableWixIdentifier {
    param(
        [Parameter(Mandatory)][string]$Prefix,
        [Parameter(Mandatory)][string]$Value
    )

    $bytes = [Text.Encoding]::UTF8.GetBytes($Value.ToLowerInvariant())
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        $digest = $sha256.ComputeHash($bytes)
    } finally {
        $sha256.Dispose()
    }
    $hex = ($digest | ForEach-Object { $_.ToString('x2') }) -join ''
    return "$Prefix$($hex.Substring(0, 32))"
}

function Get-StableWixGuid {
    param([Parameter(Mandatory)][string]$Value)

    $bytes = [Text.Encoding]::UTF8.GetBytes("NVIDIA/NemoClaw/windows-component/$($Value.ToLowerInvariant())")
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        $digest = $sha256.ComputeHash($bytes)
    } finally {
        $sha256.Dispose()
    }
    $hex = ($digest | ForEach-Object { $_.ToString('x2') }) -join ''
    return "$($hex.Substring(0, 8))-$($hex.Substring(8, 4))-$($hex.Substring(12, 4))-$($hex.Substring(16, 4))-$($hex.Substring(20, 12))"
}

function New-GroupedPayloadAuthoring {
    param(
        [Parameter(Mandatory)][string]$PayloadRoot,
        [Parameter(Mandatory)][string]$OutputPath
    )

    $settings = [Xml.XmlWriterSettings]::new()
    $settings.Encoding = [Text.UTF8Encoding]::new($false)
    $settings.Indent = $true
    $settings.NewLineChars = [Environment]::NewLine
    $settings.NewLineHandling = [Xml.NewLineHandling]::Replace
    $writer = [Xml.XmlWriter]::Create($OutputPath, $settings)
    $componentIds = [Collections.Generic.List[string]]::new()
    $stats = @{ fileCount = 0 }
    $namespace = 'http://wixtoolset.org/schemas/v4/wxs'
    $writeDirectory = $null
    $writeDirectory = {
        param(
            [Parameter(Mandatory)][string]$DirectoryPath,
            [Parameter(Mandatory)][AllowEmptyString()][string]$RelativeDirectory,
            [Parameter(Mandatory)][bool]$Root
        )

        if ($Root) {
            $writer.WriteStartElement('DirectoryRef', $namespace)
            $writer.WriteAttributeString('Id', 'INSTALLFOLDER')
        } else {
            $writer.WriteStartElement('Directory', $namespace)
            $writer.WriteAttributeString('Id', (Get-StableWixIdentifier -Prefix 'Dir_' -Value $RelativeDirectory))
            $writer.WriteAttributeString('Name', (Split-Path -Leaf $DirectoryPath))
        }

        $files = @(Get-ChildItem -LiteralPath $DirectoryPath -File -Force | Sort-Object Name)
        if ($files.Count -gt 0) {
            $componentIdentity = if ($Root) { '<root>' } else { $RelativeDirectory }
            $componentId = Get-StableWixIdentifier -Prefix 'Cmp_' -Value $componentIdentity
            $componentGuidIdentity = "$componentIdentity|$(($files.Name | ForEach-Object { $_.ToLowerInvariant() }) -join '|')"
            $componentIds.Add($componentId)
            $writer.WriteStartElement('Component', $namespace)
            $writer.WriteAttributeString('Id', $componentId)
            $writer.WriteAttributeString('Guid', (Get-StableWixGuid -Value $componentGuidIdentity))
            $writer.WriteAttributeString('Bitness', 'always64')
            for ($index = 0; $index -lt $files.Count; $index++) {
                $file = $files[$index]
                $relativeFile = $file.FullName.Substring($PayloadRoot.Length + 1)
                $writer.WriteStartElement('File', $namespace)
                $writer.WriteAttributeString('Id', (Get-StableWixIdentifier -Prefix 'Fil_' -Value $relativeFile))
                $writer.WriteAttributeString('Name', $file.Name)
                $writer.WriteAttributeString('Source', $file.FullName)
                if ($index -eq 0) {
                    $writer.WriteAttributeString('KeyPath', 'yes')
                }
                $writer.WriteEndElement()
                $stats.fileCount++
            }
            $writer.WriteEndElement()
        }

        foreach ($child in @(Get-ChildItem -LiteralPath $DirectoryPath -Directory -Force | Sort-Object Name)) {
            if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                Fail-WindowsPackageBuild "Payload contains a reparse-point directory: $($child.FullName)"
            }
            $childRelative = if ([string]::IsNullOrEmpty($RelativeDirectory)) {
                $child.Name
            } else {
                "$RelativeDirectory\$($child.Name)"
            }
            & $writeDirectory $child.FullName $childRelative $false
        }
        $writer.WriteEndElement()
    }

    try {
        $writer.WriteStartDocument()
        $writer.WriteStartElement('Wix', $namespace)
        $writer.WriteStartElement('Fragment', $namespace)
        & $writeDirectory $PayloadRoot '' $true
        $writer.WriteEndElement()
        $writer.WriteStartElement('Fragment', $namespace)
        $writer.WriteStartElement('ComponentGroup', $namespace)
        $writer.WriteAttributeString('Id', 'PayloadComponents')
        foreach ($componentId in $componentIds) {
            $writer.WriteStartElement('ComponentRef', $namespace)
            $writer.WriteAttributeString('Id', $componentId)
            $writer.WriteEndElement()
        }
        $writer.WriteEndElement()
        $writer.WriteEndElement()
        $writer.WriteEndElement()
        $writer.WriteEndDocument()
    } finally {
        $writer.Dispose()
    }
    if ($stats.fileCount -eq 0) {
        Fail-WindowsPackageBuild 'Grouped payload authoring did not contain any files.'
    }
    if ($componentIds.Count -ge 65536) {
        Fail-WindowsPackageBuild "Grouped payload still exceeds the MSI component limit: $($componentIds.Count)."
    }
    Write-Host "Grouped WiX payload authoring: files=$($stats.fileCount) components=$($componentIds.Count)"
}

function New-BootstrapperPayloadAuthoring {
    param(
        [Parameter(Mandatory)][string]$BootstrapperRoot,
        [Parameter(Mandatory)][string]$PrimaryExecutable,
        [Parameter(Mandatory)][string]$OutputPath
    )

    $settings = [Xml.XmlWriterSettings]::new()
    $settings.Encoding = [Text.UTF8Encoding]::new($false)
    $settings.Indent = $true
    $settings.NewLineChars = [Environment]::NewLine
    $settings.NewLineHandling = [Xml.NewLineHandling]::Replace
    $writer = [Xml.XmlWriter]::Create($OutputPath, $settings)
    $namespace = 'http://wixtoolset.org/schemas/v4/wxs'
    $root = [IO.Path]::GetFullPath($BootstrapperRoot).TrimEnd('\')
    $primary = [IO.Path]::GetFullPath($PrimaryExecutable)
    $payloads = @(Get-ChildItem -LiteralPath $root -Recurse -File -Force | Where-Object {
        -not [string]::Equals($_.FullName, $primary, [StringComparison]::OrdinalIgnoreCase)
    } | Sort-Object FullName)
    if ($payloads.Count -eq 0) {
        Fail-WindowsPackageBuild 'Bootstrapper publish did not contain any support payloads.'
    }

    try {
        $writer.WriteStartDocument()
        $writer.WriteStartElement('Wix', $namespace)
        $writer.WriteStartElement('Fragment', $namespace)
        $writer.WriteStartElement('PayloadGroup', $namespace)
        $writer.WriteAttributeString('Id', 'NemoClawBootstrapperPayloads')
        foreach ($payload in $payloads) {
            $relativePath = $payload.FullName.Substring($root.Length + 1)
            $writer.WriteStartElement('Payload', $namespace)
            $writer.WriteAttributeString('Id', (Get-StableWixIdentifier -Prefix 'BaPayload_' -Value $relativePath))
            $writer.WriteAttributeString('Name', $relativePath)
            $writer.WriteAttributeString('SourceFile', $payload.FullName)
            $writer.WriteEndElement()
        }
        $writer.WriteEndElement()
        $writer.WriteEndElement()
        $writer.WriteEndElement()
        $writer.WriteEndDocument()
    } finally {
        $writer.Dispose()
    }
    Write-Host "Explicit WiX bootstrapper authoring: supportPayloads=$($payloads.Count)"
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
    'bin\NemoClaw.exe',
    'bin\nemoclaw.cmd',
    'nemoclaw\app\bin\nemoclaw.js',
    'openclaw\node_modules\openclaw\openclaw.mjs',
    'pi\node_modules\@earendil-works\pi-coding-agent\dist\cli.js',
    'python\python.exe',
    'hermes\site-packages\hermes_cli\main.py',
    'hermes\site-packages\concurrent_log_handler\__init__.py',
    'deepagents\site-packages\deepagents_code\main.py',
    'deepagents\site-packages\tiktoken\_tiktoken.cp313-win_arm64.pyd',
    'nemocua\run_with_harness.py',
    'onboarding\index.html',
    'onboarding\styles.css',
    'onboarding\app.ts',
    'mxc\wxc-exec.exe',
    'mxc\wxc-host-prep.exe',
    'config\mxc-gateway.toml',
    'qualification\run-installed-native-turn.mts',
    'qualification\run-installed-native-web-ui.mts',
    'qualification\run-installed-native-console-agent.mts',
    'qualification\run-installed-native-pi.mts',
    'qualification\run-installed-native-nemocua.mts',
    'agent-support.json',
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
Assert-Arm64PortableExecutable -Path (Join-Path $payload 'bin\NemoClaw.exe') -Label 'NemoClaw.exe payload'
Assert-Arm64PortableExecutable -Path (Join-Path $payload 'python\python.exe') -Label 'python.exe payload'
Assert-Arm64PortableExecutable -Path (Join-Path $payload 'mxc\wxc-exec.exe') -Label 'wxc-exec.exe payload'
Assert-Arm64PortableExecutable -Path (Join-Path $payload 'mxc\wxc-host-prep.exe') -Label 'wxc-host-prep.exe payload'

$authoringText = @(
    [IO.File]::ReadAllText((Join-Path $sourceRoot 'packaging\windows\Product.wxs')),
    [IO.File]::ReadAllText((Join-Path $sourceRoot 'packaging\windows\Bundle.wxs'))
) -join [Environment]::NewLine
$bootstrapperText = (@(Get-ChildItem -LiteralPath (Join-Path $sourceRoot 'packaging\windows\bootstrapper') -File | ForEach-Object {
    [IO.File]::ReadAllText($_.FullName)
}) -join [Environment]::NewLine)
if ($authoringText -match '<\s*CustomAction\b' -or
    $authoringText -match '(?i)\b(powershell|pwsh|wsl|bash|ubuntu|docker)\b') {
    Fail-WindowsPackageBuild 'WiX authoring contains a prohibited custom-action or non-native execution path.'
}
if ($bootstrapperText -match '(?i)\b(powershell|pwsh|wsl[.]exe|bash[.]exe|ubuntu[.]exe|docker[.]exe)\b') {
    Fail-WindowsPackageBuild 'Bootstrapper source contains a prohibited non-native execution path.'
}
if ($authoringText -notmatch '<\s*MajorUpgrade\b[^>]*Schedule="afterInstallInitialize"') {
    Fail-WindowsPackageBuild 'Major-upgrade removal must remain inside MSI rollback protection.'
}
foreach ($requiredAsset in @(
    'packaging\windows\assets\NemoClaw.ico',
    'packaging\windows\assets\NemoClawLogo.png',
    'packaging\windows\onboarding\assets\openclaw.png',
    'packaging\windows\onboarding\assets\hermes.png',
    'packaging\windows\onboarding\assets\deepagents.png',
    'packaging\windows\onboarding\assets\nemocua.png'
)) {
    if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot $requiredAsset) -PathType Leaf)) {
        Fail-WindowsPackageBuild "Required branded setup asset is missing: $requiredAsset"
    }
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
$bootstrapperProject = Join-Path $sourceRoot 'packaging\windows\bootstrapper\NemoClaw.Bootstrapper.csproj'
$bootstrapperOutput = Join-Path $intermediate 'bootstrapper\publish'
$bootstrapperPath = Join-Path $bootstrapperOutput 'NemoClaw.Bootstrapper.exe'
$bootstrapperPayloadAuthoring = Join-Path $intermediate 'BootstrapperPayloads.wxs'
$bootstrapperSha256 = $null
$bootstrapperAuthenticodeStatus = $null
$payloadAuthoring = Join-Path $intermediate 'GroupedPayload.wxs'
New-GroupedPayloadAuthoring -PayloadRoot $payload -OutputPath $payloadAuthoring
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
        "-p:GeneratedPayloadAuthoring=$payloadAuthoring",
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

    $bootstrapperRestoreArguments = @(
        'restore', $bootstrapperProject,
        '--nologo',
        '--force',
        '--no-cache',
        '--runtime', 'win-arm64',
        '--packages', $restorePackages
    ) + $commonProperties
    & dotnet @bootstrapperRestoreArguments
    if ($LASTEXITCODE -ne 0) {
        Fail-WindowsPackageBuild 'Pinned NemoClaw bootstrapper dependency restore failed.'
    }
    $bootstrapperPublishArguments = @(
        'publish', $bootstrapperProject,
        '--configuration', 'Release',
        '--nologo',
        '--no-restore',
        '--disable-build-servers',
        '--runtime', 'win-arm64',
        '--self-contained', 'true',
        '--output', $bootstrapperOutput
    ) + $commonProperties
    & dotnet @bootstrapperPublishArguments
    if ($LASTEXITCODE -ne 0) {
        Fail-WindowsPackageBuild 'Native ARM64 NemoClaw bootstrapper build failed.'
    }
    Assert-Arm64PortableExecutable -Path $bootstrapperPath -Label 'NemoClaw.Bootstrapper.exe'
    Assert-Arm64PortableExecutable `
        -Path (Join-Path $bootstrapperOutput 'mbanative.dll') `
        -Label 'WiX managed-bootstrapper native bridge'
    $expectedBootstrapperSupportPayloads = @(
        'mbanative.dll',
        'PenImc_cor3.dll',
        'PresentationNative_cor3.dll',
        'vcruntime140_cor3.dll',
        'wpfgfx_cor3.dll'
    )
    $observedBootstrapperSupportPayloads = @(Get-ChildItem -LiteralPath $bootstrapperOutput -File | Where-Object {
        $_.Name -cne 'NemoClaw.Bootstrapper.exe'
    } | ForEach-Object { $_.Name } | Sort-Object)
    if (@(Compare-Object $expectedBootstrapperSupportPayloads $observedBootstrapperSupportPayloads).Count -ne 0) {
        Fail-WindowsPackageBuild 'The single-file bootstrapper publish did not contain the exact native support payload set.'
    }
    foreach ($bootstrapperDependency in $expectedBootstrapperSupportPayloads) {
        if (-not (Test-Path -LiteralPath (Join-Path $bootstrapperOutput $bootstrapperDependency) -PathType Leaf)) {
            Fail-WindowsPackageBuild "Native bootstrapper publish is missing $bootstrapperDependency."
        }
        Assert-Arm64PortableExecutable `
            -Path (Join-Path $bootstrapperOutput $bootstrapperDependency) `
            -Label "Native bootstrapper support payload $bootstrapperDependency"
    }
    $bootstrapperSha256 = (Get-FileHash -LiteralPath $bootstrapperPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $bootstrapperAuthenticodeStatus = (Get-AuthenticodeSignature -LiteralPath $bootstrapperPath).Status.ToString()
    New-BootstrapperPayloadAuthoring `
        -BootstrapperRoot $bootstrapperOutput `
        -PrimaryExecutable $bootstrapperPath `
        -OutputPath $bootstrapperPayloadAuthoring

    $bundleProperties = $commonProperties + @(
        "-p:MsiPath=$msiPath",
        "-p:BootstrapperPath=$bootstrapperPath",
        "-p:BootstrapperRoot=$bootstrapperOutput",
        "-p:GeneratedBootstrapperPayloadAuthoring=$bootstrapperPayloadAuthoring"
    )
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
    bootstrapper = [pscustomobject]@{
        framework = 'net8.0-windows'
        runtimeIdentifier = 'win-arm64'
        wixApiVersion = $script:ExpectedWixVersion
        sha256 = $bootstrapperSha256
        authenticodeStatus = $bootstrapperAuthenticodeStatus
    }
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
