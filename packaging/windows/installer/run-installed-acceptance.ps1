# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# The same installed acceptance body is used for current builds and exact published replay.
[CmdletBinding()]
param([Parameter(Mandatory)][string]$SourceRoot,
    [Parameter(Mandatory)][string]$WorkDirectory,
    [Parameter(Mandatory)][string]$ProductVersion,
    [Parameter(Mandatory)][string]$ArtifactSourceRevision,
    [ValidateSet('current-build','published-0.1.2-replay')][string]$Mode = 'current-build')
$ErrorActionPreference = 'Stop'
$controllerSource = $env:GITHUB_SHA
if ($env:OS -cne 'Windows_NT' -or $env:GITHUB_ACTIONS -cne 'true' -or $PSVersionTable.PSEdition -cne 'Core' -or
    $controllerSource -cnotmatch '^[a-f0-9]{40}$' -or $ArtifactSourceRevision -cnotmatch '^[a-f0-9]{40}$' -or
    $ProductVersion -cnotmatch '^[0-9]+\.[0-9]+\.[0-9]+$') { throw 'Installed acceptance requires explicit Windows CI identities.' }
$head = (& git -C $SourceRoot rev-parse HEAD | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $head -cne $controllerSource) { throw 'The acceptance controller differs from this checkout.' }
if ($Mode -ceq 'current-build') {
    if ($ArtifactSourceRevision -cne $controllerSource) { throw 'Normal build acceptance requires the exact current source.' }
} elseif ($ArtifactSourceRevision -cne 'b54a1f3a54ab28dff7813de2db9430f6735ec624' -or $ProductVersion -cne '0.1.2') {
    throw 'Published replay accepts only the fixed0.1.2 artifact source.'
}
# These held-pipe controls run outside install/startup timing and do not execute app code.
$ciNode = Join-Path $WorkDirectory 'application\node\node.exe'
if ((Get-FileHash -LiteralPath $ciNode -Algorithm SHA256).Hash.ToLowerInvariant() -cne '97cce5301a815d2dce07ac5bfd1e6039eae88185ec1d10ae4f8cb712f1732878') {
    throw 'The CI controller Node executable differs from the pinned Windows ARM64 input.'
}
& $ciNode --experimental-strip-types --no-warnings --test (Join-Path $SourceRoot 'packaging\windows\installer\control-installed-openclaw-input.test.mts')
if ($LASTEXITCODE -ne 0) { throw 'The actual Windows observer input controls failed.' }

$work = [IO.Path]::GetFullPath($WorkDirectory)
$setup = "$work\package\NemoClawSetup-$ProductVersion-windows-arm64.exe"
$installation = "$env:ProgramFiles\NVIDIA\NemoClaw"
if (Test-Path -LiteralPath $installation) { throw 'Fresh preview acceptance requires no preexisting NemoClaw installation.' }
$primary = $null
$build = Get-Content -LiteralPath "$work\package\immutable-package-build.json" -Raw | ConvertFrom-Json
if ($build.sourceRevision -cne $ArtifactSourceRevision -or $build.status -cne 'candidate-built-for-installed-qualification') { throw 'The preview build receipt differs from this acceptance source.' }
foreach ($file in $build.files) {
  $path = Join-Path "$work\package" $file.file
  if ([IO.Path]::GetFileName([string]$file.file) -cne $file.file -or
      (Get-Item -LiteralPath $path).Length -ne $file.bytes -or
      (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $file.sha256) {
    throw 'The downloaded preview executable/MSI differs from its build receipt.'
  }
}
$timings = [ordered]@{ schemaVersion = 1; sourceRevision = $ArtifactSourceRevision; artifactSourceRevision = $ArtifactSourceRevision; controllerSourceRevision = $controllerSource; currentHeadQualification = $false; mode = $Mode; measurement = 'fresh-runner-installed-preview';
  hostPreparationRunBeforeInstall = $false; upgradeMeasured = $false; installTargetMilliseconds = 30000; installTargetSatisfied = $false; compiledMsi = $build.compiledMsi; stages = [ordered]@{} }
function Invoke-OwnedSetup([string]$Action, [string]$Log) {
  $info = [Diagnostics.ProcessStartInfo]::new()
  $info.FileName = $setup; $info.UseShellExecute = $false; $info.CreateNoWindow = $true
  foreach ($value in @($Action, '-quiet', '-norestart', '-log', $Log)) { $info.ArgumentList.Add($value) }
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $process = [Diagnostics.Process]::Start($info)
  try { $process.WaitForExit(); $code = $process.ExitCode } finally { $process.Dispose() }
  $timings.stages[$Action] = @{ elapsedMilliseconds = $clock.ElapsedMilliseconds; exitCode = $code }
  if ($code -ne 0) { throw "Finished preview $Action failed with status $code." }
}
try {
  Invoke-OwnedSetup '-install' "$work\install.log"
  $timings['startupComparisonAvailable'] = $false
  foreach ($case in @(
    @{ name = 'firstInstalledLaunch'; directory = 'installed-acceptance' },
    @{ name = 'warmInstalledLaunch'; directory = 'installed-acceptance-warm' }
  )) {
    & "$work\application\node\node.exe" --experimental-strip-types `
      "$SourceRoot\packaging\windows\installer\qualify-installed-openclaw.mts" `
      --install-root $installation --runtime-identity "$work\assembled\runtime-identity.json" `
      --output "$work\$($case.directory)" --browser-driver-root "$work\application\build\app\node_modules\playwright-core"
    $code = $LASTEXITCODE
    $timings[$case.name] = @{ exitCode = $code; receipt = "$($case.directory)/installed-openclaw-acceptance.json";
      modelAndToolDurationsSeparate = $true; agentStateResetPerCase = $true }
    if ($code -ne 0) { throw "The $($case.name) OpenClaw acceptance failed; no startup comparison is claimed." }
    $accepted = Get-Content -LiteralPath "$work\$($case.directory)\installed-openclaw-acceptance.json" -Raw | ConvertFrom-Json
    if ($accepted.verdict -cne 'pass' -or @($accepted.cleanupErrors).Count -ne 0) {
      throw 'Ordinary launch did not finish its required model/tool checks and owned cleanup.'
    }
  }
  $timings.startupComparisonAvailable = $true
  & "$work\application\node\node.exe" --experimental-strip-types `
    "$SourceRoot\packaging\windows\installer\qualify-finished-package.mts" `
    --install-root "$env:ProgramFiles\NVIDIA\NemoClaw" --runtime-identity "$work\assembled\runtime-identity.json" --output "$work\installed-smoke"
  if ($LASTEXITCODE -ne 0) { throw 'The installed compiled/contained smoke failed.' }
} catch { $primary = $_ }
finally {
  # Enumerate only after launch samples, so counting does not warm startup paths.
  try {
    if (Test-Path -LiteralPath $installation) {
      $installedFiles = @(Get-ChildItem -LiteralPath $installation -Recurse -File)
      $timings['installedInventory'] = @{ fileCount = $installedFiles.Count;
        bytes = [long](($installedFiles | Measure-Object -Property Length -Sum).Sum);
        componentCount = $build.compiledMsi.componentCount; componentCountSource = 'compiled-msi-Component-table';
        observation = 'after-application-checks-before-uninstall'; contentHashesRead = $false }
    }
  } catch { if ($null -eq $primary) { $primary = $_ } else { Write-Warning 'The original failure is preserved; installed counts also failed.' } }
  try {
    Invoke-OwnedSetup '-uninstall' "$work\uninstall.log"
    $timings['installationRootRemoved'] = -not (Test-Path -LiteralPath $installation)
    $remaining = [Collections.Generic.List[object]]::new()
    $pending = [Collections.Generic.Queue[IO.FileSystemInfo]]::new()
    $truncated = $false
    if (-not $timings.installationRootRemoved) { $pending.Enqueue((Get-Item -LiteralPath $installation -Force)) }
    while ($pending.Count -gt 0) {
      $item = $pending.Dequeue()
      $redirected = ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
      $isDirectory = ($item.Attributes -band [IO.FileAttributes]::Directory) -ne 0
      $relative = [IO.Path]::GetRelativePath($installation, $item.FullName).Replace('\', '/')
      $kind = if ($redirected) { 'reparse' } elseif ($isDirectory) { 'directory' } else { 'file' }
      $length = if (-not $redirected -and $item -is [IO.FileInfo]) { $item.Length } else { $null }
      $remaining.Add(@{ path=$relative; type=$kind; bytes=$length })
      if ($isDirectory -and -not $redirected) {
        foreach ($child in ([IO.DirectoryInfo]$item).EnumerateFileSystemInfos()) {
          if ($remaining.Count + $pending.Count -ge 4096) { $truncated = $true; break }
          $pending.Enqueue($child)
        }
      }
    }
    $timings['remainingInstallation'] = @{ entries=$remaining.ToArray(); truncated=$truncated; entryLimit=4096; contentRead=$false; reparseTraversal=$false }
  } catch { if ($null -eq $primary) { $primary = $_ } else { Write-Warning 'The original failure is preserved; preview cleanup also failed.' } }
}
$timings.installTargetSatisfied = $timings.stages.Contains('-install') -and
  $timings.stages['-install'].exitCode -eq 0 -and
  $timings.stages['-install'].elapsedMilliseconds -lt $timings.installTargetMilliseconds
if (-not $timings.installTargetSatisfied -and $null -eq $primary) {
  try { throw 'The installed preview missed its measured30-second installation target.' } catch { $primary = $_ }
}
try { [IO.File]::WriteAllText("$work\installed-stage-timings.json", ($timings | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false)) }
catch { if ($null -eq $primary) { $primary = $_ } else { Write-Warning 'The original failure is preserved; timing evidence also could not be saved.' } }
if ($null -ne $primary) { throw $primary }
