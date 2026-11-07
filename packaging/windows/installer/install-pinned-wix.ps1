# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

[CmdletBinding()]
param([Parameter(Mandatory)][string]$ToolDirectory)

$ErrorActionPreference = 'Stop'
$pin = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'wix-tool-input.json') -Raw | ConvertFrom-Json
if ($pin.version -cne '5.0.2' -or
    $pin.url -cne 'https://api.nuget.org/v3-flatcontainer/wix/5.0.2/wix.5.0.2.nupkg' -or
    $pin.bytes -le 0 -or $pin.sha256 -cnotmatch '^[0-9a-f]{64}$') {
    throw 'The checked-in WiX tool input is invalid.'
}
$tools = [IO.Path]::GetFullPath($ToolDirectory)
if (Test-Path -LiteralPath $tools) { throw 'WiX requires a fresh tool directory.' }
[void](New-Item -ItemType Directory -Path $tools -ErrorAction Stop)
$feed = Join-Path $tools 'verified-feed'
[void](New-Item -ItemType Directory -Path $feed -ErrorAction Stop)
$archive = Join-Path $feed 'wix.5.0.2.nupkg'
Invoke-WebRequest -Uri $pin.url -OutFile $archive -TimeoutSec 120
if ((Get-Item -LiteralPath $archive).Length -ne $pin.bytes -or
    (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pin.sha256) {
    throw 'WiX package bytes differ from the checked-in input; tool installation was not started.'
}

# WiX's tool package has no NuGet dependencies. Only the verified local feed is
# available to restore; separate caches prevent reuse of an ambient package.
$config = Join-Path $tools 'NuGet.Config'
$packages = Join-Path $tools 'packages'
$xml = [xml]'<configuration><packageSources><clear/><add key="verified" value=""/></packageSources><fallbackPackageFolders><clear/></fallbackPackageFolders><config><add key="globalPackagesFolder" value=""/></config></configuration>'
$xml.configuration.packageSources.add.SetAttribute('value', $feed)
$xml.configuration.config.add.SetAttribute('value', $packages)
$xml.Save($config)
$oldPackages = $env:NUGET_PACKAGES
$oldHttpCache = $env:NUGET_HTTP_CACHE_PATH
$oldFallbackPackages = $env:NUGET_FALLBACK_PACKAGES
try {
    $env:NUGET_PACKAGES = $packages
    $env:NUGET_HTTP_CACHE_PATH = Join-Path $tools 'http-cache'
    $env:NUGET_FALLBACK_PACKAGES = $null
    & dotnet tool install wix --version $pin.version --tool-path $tools --configfile $config --no-cache
    if ($LASTEXITCODE -ne 0) { throw 'Installing the verified WiX package failed.' }
} finally {
    $env:NUGET_PACKAGES = $oldPackages
    $env:NUGET_HTTP_CACHE_PATH = $oldHttpCache
    $env:NUGET_FALLBACK_PACKAGES = $oldFallbackPackages
}
if (-not (Test-Path -LiteralPath (Join-Path $tools 'wix.exe') -PathType Leaf)) {
    throw 'Verified WiX installation did not produce its executable.'
}
@{
    schemaVersion = 1
    classification = 'verified-wix-tool-input'
    version = $pin.version
    url = $pin.url
    bytes = $pin.bytes
    sha256 = $pin.sha256
    isolatedLocalFeed = $true
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $tools 'wix-input.json') -Encoding utf8NoBOM
