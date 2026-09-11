# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# Reuses the actual published WPF bootstrapper and Bundle package identifiers.
# This fixture never enters the downloadable product artifact.
[CmdletBinding()]
param([Parameter(Mandatory)][string]$SourceRoot, [Parameter(Mandatory)][string]$PackageDirectory,
    [Parameter(Mandatory)][string]$OutputDirectory, [Parameter(Mandatory)][string]$ProductVersion,
    [Parameter(Mandatory)][string]$WixPath)
Set-StrictMode -Version Latest; $ErrorActionPreference = 'Stop'
if ($env:OS -cne 'Windows_NT' -or $env:GITHUB_ACTIONS -cne 'true') { throw 'The Burn fixture requires disposable Windows CI.' }
if (Test-Path -LiteralPath $OutputDirectory) { throw 'The fixture output must be fresh.' }
$output = [IO.Path]::GetFullPath($OutputDirectory); [void][IO.Directory]::CreateDirectory($output)
$receipt = Get-Content -LiteralPath (Join-Path $PackageDirectory 'immutable-package-build.json') -Raw | ConvertFrom-Json
if ($receipt.sourceRevision -cne $env:GITHUB_SHA -or $receipt.status -cne 'candidate-built-for-installed-qualification') { throw 'The fixture must follow the exact current product build.' }
$inputs = Get-Content -LiteralPath (Join-Path $PackageDirectory 'migration-inputs.json') -Raw | ConvertFrom-Json
if ($inputs.schemaVersion -ne 1 -or $inputs.sourceRevision -cne $env:GITHUB_SHA -or @($inputs.files).Count -gt 32) { throw 'The native UI input receipt is invalid.' }
foreach ($item in $inputs.files) {
    if ($item.file -cnotmatch '^build/(bootstrapper/[A-Za-z0-9_.-]+|BootstrapperPayloads\.wxs|payload/mxc/wxc-host-prep\.exe)$') { throw 'Unexpected setup fixture input.' }
    $file = Join-Path $PackageDirectory $item.file
    $info = Get-Item -LiteralPath $file -Force
    if ($info -isnot [IO.FileInfo] -or ($info.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $info.Length -ne $item.bytes -or
        (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $item.sha256) { throw 'A same-build native UI input changed.' }
}
$nativeUi = Join-Path $PackageDirectory 'build\bootstrapper\NemoClaw.Bootstrapper.exe'
$uiHash = (Get-FileHash -LiteralPath $nativeUi -Algorithm SHA256).Hash.ToLowerInvariant()
$fixture = Join-Path $output 'NemoClawPreparationFailure.exe'
& rustup run 1.95.0-aarch64-pc-windows-msvc rustc --edition=2024 --target aarch64-pc-windows-msvc `
    -C target-feature=+crt-static -C opt-level=s `
    (Join-Path $SourceRoot 'packaging\windows\tests\host-preparation-diagnostics\failure-fixture.rs') -o $fixture
if ($LASTEXITCODE -ne 0) { throw 'The failure-before-stdout fixture did not compile.' }
$fixtureHash = (Get-FileHash -LiteralPath $fixture -Algorithm SHA256).Hash.ToLowerInvariant()
$marker = Join-Path $output 'fixture.txt'; [IO.File]::WriteAllText($marker, 'This MSI must never execute in the prerequisite-failure test.')
$msiSource = Join-Path $output 'Fixture.wxs'
[IO.File]::WriteAllText($msiSource, @'
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">
 <Package Name="NemoClaw diagnostics fixture" Manufacturer="NVIDIA Corporation" Version="1.0.0" UpgradeCode="FD7D8D80-B661-4832-9567-BCA2F3DB8D61" Scope="perMachine">
  <MediaTemplate EmbedCab="yes" />
  <StandardDirectory Id="ProgramFiles64Folder"><Directory Id="FixtureRoot" Name="NemoClaw Diagnostics Fixture"><Component Id="FixtureComponent" Guid="*"><File Source="$(var.MarkerPath)" KeyPath="yes" /></Component></Directory></StandardDirectory>
  <Feature Id="Main"><ComponentRef Id="FixtureComponent" /></Feature>
 </Package>
</Wix>
'@)
$msi = Join-Path $output 'Fixture.msi'
& $WixPath build -arch arm64 -d "MarkerPath=$marker" $msiSource -pdbtype none -wx -out $msi
if ($LASTEXITCODE -ne 0) { throw 'The guarded downstream fixture MSI did not build.' }
$bundle = Get-Content -LiteralPath (Join-Path $SourceRoot 'packaging\windows\Bundle.wxs') -Raw
$family = 'UpgradeCode="1BA739B8-B632-4A8C-BB02-95058CC3A960"'
if (@([regex]::Matches($bundle, [regex]::Escape($family))).Count -ne 1) { throw 'The actual Bundle family seam changed.' }
$bundle = $bundle.Replace($family, 'UpgradeCode="70539D4F-3228-48CC-BC4D-EF6128487509"')
$bundleSource = Join-Path $output 'FixtureBundle.wxs'; [IO.File]::WriteAllText($bundleSource, $bundle)
$setup = Join-Path $output 'NemoClawSetup-DiagnosticsFixture.exe'
$nullDevice = Join-Path $PackageDirectory 'build\payload\mxc\wxc-host-prep.exe'
$authoring = Join-Path $output 'BootstrapperPayloads.wxs'
[xml]$payloadXml = Get-Content -LiteralPath (Join-Path $PackageDirectory 'build\BootstrapperPayloads.wxs') -Raw
foreach ($payload in $payloadXml.SelectNodes('//*[local-name()="Payload"]')) {
    $name = [string]$payload.Name
    if ([IO.Path]::GetFileName($name) -cne $name -or @($inputs.files | Where-Object file -ceq ('build/bootstrapper/' + $name)).Count -ne 1) { throw 'The relocated bootstrapper payload is not in its verified input inventory.' }
    $payload.SourceFile = Join-Path ([IO.Path]::GetDirectoryName($nativeUi)) $name
}
$payloadXml.Save($authoring)
& $WixPath build -arch arm64 -d "ProductVersion=$ProductVersion" -d "SourceRoot=$SourceRoot" `
    -d "MsiPath=$msi" -d "WxcHostPrepPath=$nullDevice" -d 'SystemDriveMetadataPreparation=true' `
    -d "SystemDrivePrepPath=$fixture" -d "SystemDrivePrepSha256=$fixtureHash" -d "BootstrapperPath=$nativeUi" `
    -d "BootstrapperRoot=$([IO.Path]::GetDirectoryName($nativeUi))" $bundleSource $authoring `
    -pdbtype none -wx -sw1161 -out $setup
if ($LASTEXITCODE -ne 0) { throw 'The actual Burn/WPF failure fixture did not build.' }
if ((Get-FileHash -LiteralPath $nativeUi -Algorithm SHA256).Hash.ToLowerInvariant() -cne $uiHash) { throw 'The shared production UI changed during fixture composition.' }
$record = [ordered]@{schemaVersion=1;classification='actual-burn-host-preparation-failure-fixture';sourceRevision=$env:GITHUB_SHA;
    intendedForDistribution=$false;bootstrapperSha256=$uiHash;expectedStage='open-metadata-inspection-target';expectedWin32Error=32;
    helper=@{file=[IO.Path]::GetFileName($fixture);bytes=(Get-Item -LiteralPath $fixture).Length;sha256=$fixtureHash};
    setup=@{file=[IO.Path]::GetFileName($setup);bytes=(Get-Item -LiteralPath $setup).Length;sha256=(Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash.ToLowerInvariant()}}
[IO.File]::WriteAllText((Join-Path $output 'fixture.json'), ($record | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
