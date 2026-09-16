# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# The same installed acceptance body is used for current builds and exact built-preview replay.
[CmdletBinding()]
param([Parameter(Mandatory)][string]$SourceRoot,
    [Parameter(Mandatory)][string]$WorkDirectory,
    [Parameter(Mandatory)][string]$ProductVersion,
    [Parameter(Mandatory)][string]$ArtifactSourceRevision,
    [ValidateSet('current-build','built-0.1.3-replay')][string]$Mode = 'current-build',
    [ValidateSet('openclaw','hermes','pi')][string]$Agent = 'openclaw',
    [ValidateSet('full-acceptance','startup-only')][string]$ValidationScope = 'full-acceptance')
$ErrorActionPreference = 'Stop'
$controllerSource = $env:GITHUB_SHA
if ($Agent -cne 'openclaw' -and $Mode -cne 'current-build') { throw 'Only OpenClaw can reuse the historical replay lane.' }
if ($Agent -ceq 'pi' -and $ValidationScope -cne 'startup-only') { throw 'Pi supports startup-only smoke, not full installed acceptance.' }
if ($ValidationScope -ceq 'startup-only' -and ($Agent -ceq 'hermes' -or $Mode -cne 'current-build')) { throw 'Startup-only smoke supports current OpenClaw and Pi builds only.' }
if ($ValidationScope -ceq 'startup-only' -and ($env:NVIDIA_API_KEY -or $env:NVIDIA_INFERENCE_API_KEY)) { throw 'Startup-only smoke must not receive inference credentials.' }
if ($env:OS -cne 'Windows_NT' -or $env:GITHUB_ACTIONS -cne 'true' -or $PSVersionTable.PSEdition -cne 'Core' -or
    $controllerSource -cnotmatch '^[a-f0-9]{40}$' -or $ArtifactSourceRevision -cnotmatch '^[a-f0-9]{40}$' -or
    $ProductVersion -cnotmatch '^[0-9]+\.[0-9]+\.[0-9]+$') { throw 'Installed acceptance requires explicit Windows CI identities.' }
$head = (& git -C $SourceRoot rev-parse HEAD | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $head -cne $controllerSource) { throw 'The acceptance controller differs from this checkout.' }
if ($Mode -ceq 'current-build') {
    if ($ArtifactSourceRevision -cne $controllerSource) { throw 'Normal build acceptance requires the exact current source.' }
} elseif ($ArtifactSourceRevision -cne '491a3a3d5e7206d82c741198062b6e2aa98dc72c' -or $ProductVersion -cne '0.1.3') {
    throw 'Built-preview replay accepts only the fixed 0.1.3 artifact source.'
}
# These held-pipe controls run outside install/startup timing and do not execute app code.
$ciNode = Join-Path $WorkDirectory 'application\node\node.exe'
if ((Get-FileHash -LiteralPath $ciNode -Algorithm SHA256).Hash.ToLowerInvariant() -cne '97cce5301a815d2dce07ac5bfd1e6039eae88185ec1d10ae4f8cb712f1732878') {
    throw 'The CI controller Node executable differs from the pinned Windows ARM64 input.'
}
& $ciNode --experimental-strip-types --no-warnings --test (Join-Path $SourceRoot 'packaging\windows\installer\control-installed-openclaw-input.test.mts') (Join-Path $SourceRoot 'packaging\windows\installer\run-installed-acceptance.test.mts') (Join-Path $SourceRoot 'packaging\windows\installer\qualify-finished-package.test.mts')
if ($LASTEXITCODE -ne 0) { throw 'The Windows observer or diagnostic controls failed.' }

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
$timings = [ordered]@{ schemaVersion = 1; sourceRevision = $ArtifactSourceRevision; artifactSourceRevision = $ArtifactSourceRevision; controllerSourceRevision = $controllerSource; currentHeadQualification = $false; mode = $Mode; measurement = 'fresh-runner-installed-preview'; agent = $Agent;
  validationScope = $ValidationScope; fullInstalledQualification = $false; migrationQualified = $false;
  hostPreparationRunBeforeInstall = $false; upgradeMeasured = $false; installTargetMilliseconds = 30000; installTargetSatisfied = $false; primaryException = $null; nativeRuntimeFailure = $null; compiledMsi = $build.compiledMsi; stages = [ordered]@{} }
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
  if ($ValidationScope -ceq 'startup-only') {
    & $ciNode --experimental-strip-types --no-warnings "$SourceRoot\packaging\windows\installer\qualify-finished-package.mts" `
      --agent $Agent --install-root $installation --runtime-identity "$work\assembled\runtime-identity.json" --output "$work\installed-smoke"
    if ($LASTEXITCODE -ne 0) { throw 'The installed startup-only smoke failed.' }
    $smoke = Get-Content -LiteralPath "$work\installed-smoke\finished-package-smoke.json" -Raw | ConvertFrom-Json
    if ($smoke.verdict -cne 'pass' -or $smoke.agent -cne $Agent -or $smoke.validationScope -cne 'startup-only' -or
        $smoke.fullInstalledQualification -isnot [bool] -or $smoke.fullInstalledQualification) { throw 'The installed startup-only receipt is incomplete.' }
    $timings['startupSmoke'] = @{ receipt = 'installed-smoke/finished-package-smoke.json'; deterministicLocalModel = $true }
  } else {
  foreach ($case in @(
    @{ name = 'firstInstalledLaunch'; directory = 'installed-acceptance' },
    @{ name = 'warmInstalledLaunch'; directory = 'installed-acceptance-warm' }
  )) {
    $qualification = Join-Path $SourceRoot ("packaging\windows\installer\qualify-installed-$Agent.mts")
    $driverRoot = if ($Agent -ceq 'hermes') { "$work\application\inputs\tools\node_modules\playwright-core" } else { "$work\application\build\app\node_modules\playwright-core" }
    $caseArguments = @()
    if ($Agent -ceq 'hermes') {
      $caseArguments = if ($case.name -ceq 'firstInstalledLaunch') { @('--preserve-configuration') } else { @('--reuse-configuration') }
    }
    & "$work\application\node\node.exe" --experimental-strip-types --no-warnings $qualification `
      --install-root $installation --runtime-identity "$work\assembled\runtime-identity.json" `
      --output "$work\$($case.directory)" --browser-driver-root $driverRoot @caseArguments
    $code = $LASTEXITCODE
    $timings[$case.name] = @{ exitCode = $code; receipt = "$($case.directory)/installed-$Agent-acceptance.json";
      modelAndToolDurationsSeparate = ($Agent -ceq 'openclaw'); conversationIntervalsSeparateFromStartup = ($Agent -ceq 'hermes'); isolatedProviderLatencyClaimed = $false; agentStateResetPerCase = ($Agent -ceq 'openclaw') }
    if ($code -ne 0) { throw "The $($case.name) selected-agent acceptance failed; no startup comparison is claimed." }
    $accepted = Get-Content -LiteralPath "$work\$($case.directory)\installed-$Agent-acceptance.json" -Raw | ConvertFrom-Json
    if ($accepted.verdict -cne 'pass' -or @($accepted.cleanupErrors).Count -ne 0) {
      throw 'Ordinary launch did not finish its required model/tool checks and owned cleanup.'
    }
  }
  $timings.startupComparisonAvailable = $true
  if ($Agent -ceq 'openclaw') {
    & "$work\application\node\node.exe" --experimental-strip-types `
      "$SourceRoot\packaging\windows\installer\qualify-finished-package.mts" `
      --install-root "$env:ProgramFiles\NVIDIA\NemoClaw" --runtime-identity "$work\assembled\runtime-identity.json" --output "$work\installed-smoke"
    if ($LASTEXITCODE -ne 0) { throw 'The installed compiled/contained smoke failed.' }
  } else { $timings['compiledRuntimeControls'] = 'Hermes acceptance validated capabilities, SEA identity and held runtime tuple.' }
  }
} catch { $primary = $_ }
finally {
  try {
    $diagnostic = Get-ItemProperty -LiteralPath 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\NVIDIA\NemoClaw\InstallDiagnostics' -ErrorAction Stop
    $diagnostic = $diagnostic.PSObject.Properties['RuntimeMaintenancePrimary']
    if ($null -ne $diagnostic) { $timings.nativeRuntimeFailure = @{ retainedPrimary = [string]$diagnostic.Value } }
  } catch [System.Management.Automation.ItemNotFoundException] {
    # A successful transaction need not retain a diagnostic key or value.
  } catch { if ($null -eq $primary) { $primary = $_ } else { Write-Warning 'The original failure is preserved; retained native diagnostic collection also failed.' } }
  # MSI records the helper's actual exit code even when Burn cannot retain its
  # stderr. Capture the bounded classification before uninstall adds another
  # transaction to the same evidence directory.
  try {
    $runtimeFailures = @()
    foreach ($log in @(Get-ChildItem -LiteralPath $work -Filter 'install*.log' -File)) {
      foreach ($match in @(Select-String -LiteralPath $log.FullName -Pattern 'CustomAction (NativeRuntime[A-Za-z]+) returned actual error code ([0-9]+)' -AllMatches)) {
        foreach ($capture in $match.Matches) {
          $runtimeFailures += @{ log = $log.Name; action = $capture.Groups[1].Value; exitCode = [int]$capture.Groups[2].Value }
        }
      }
    }
    if ($runtimeFailures.Count -gt 0) {
      $classified = $runtimeFailures[-1]
      if ($null -eq $timings.nativeRuntimeFailure) { $timings.nativeRuntimeFailure = $classified }
      else { $timings.nativeRuntimeFailure['msiLogClassification'] = $classified }
    }
  } catch { if ($null -eq $primary) { $primary = $_ } else { Write-Warning 'The original failure is preserved; native runtime failure classification also failed.' } }
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
    if (-not $timings.installationRootRemoved -and $Mode -ceq 'current-build') {
      throw 'The installed preview uninstall retained its installation root; see remainingInstallation.'
    }
  } catch { if ($null -eq $primary) { $primary = $_ } else { Write-Warning 'The original failure is preserved; preview cleanup also failed.' } }
}
$timings.installTargetSatisfied = $timings.stages.Contains('-install') -and
  $timings.stages['-install'].exitCode -eq 0 -and
  $timings.stages['-install'].elapsedMilliseconds -lt $timings.installTargetMilliseconds
if (-not $timings.installTargetSatisfied -and $null -eq $primary) {
  try { throw 'The installed preview missed its measured30-second installation target.' } catch { $primary = $_ }
}
$timings.primaryException = if ($null -eq $primary) { $null } else { $primary.Exception.Message }
$timings.fullInstalledQualification = $ValidationScope -ceq 'full-acceptance' -and $null -eq $primary
try { [IO.File]::WriteAllText("$work\installed-stage-timings.json", ($timings | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false)) }
catch { if ($null -eq $primary) { $primary = $_ } else { Write-Warning 'The original failure is preserved; timing evidence also could not be saved.' } }
if ($null -ne $primary) { throw $primary }
