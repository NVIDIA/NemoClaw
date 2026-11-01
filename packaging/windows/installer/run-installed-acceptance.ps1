# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# The same installed acceptance body is used for current builds and exact built-preview replay.
[CmdletBinding()]
param([Parameter(Mandatory)][string]$SourceRoot,
    [Parameter(Mandatory)][string]$WorkDirectory,
    [Parameter(Mandatory)][string]$ProductVersion,
    [Parameter(Mandatory)][string]$ArtifactSourceRevision,
    [ValidateSet('current-build','built-0.1.3-replay')][string]$Mode = 'current-build',
    [ValidateSet('openclaw','hermes')][string]$Agent = 'openclaw',
    [ValidateSet('full-acceptance','startup-only')][string]$ValidationScope = 'full-acceptance',
    [switch]$RuntimeBootstrap,
    [string]$ControllerNodePath = '',
    [string]$ArtifactSourceRoot = '')
$ErrorActionPreference = 'Stop'
$controllerSource = $env:GITHUB_SHA
if ($RuntimeBootstrap -and ($Agent -cne 'hermes' -or $Mode -cne 'current-build' -or $ValidationScope -cne 'full-acceptance')) {
    throw 'Runtime bootstrap supports only the protected current Hermes full-runtime journey.'
}
if ($Agent -cne 'openclaw' -and $Mode -cne 'current-build') { throw 'Only OpenClaw can reuse the historical replay lane.' }
if ($ValidationScope -ceq 'startup-only' -and ($Agent -ceq 'hermes' -or $Mode -cne 'current-build')) { throw 'Startup-only smoke supports current OpenClaw builds only.' }
if ($ValidationScope -ceq 'startup-only' -and ($env:NVIDIA_API_KEY -or $env:NVIDIA_INFERENCE_API_KEY)) { throw 'Startup-only smoke must not receive inference credentials.' }
if ($env:OS -cne 'Windows_NT' -or $env:GITHUB_ACTIONS -cne 'true' -or $PSVersionTable.PSEdition -cne 'Core' -or
    $controllerSource -cnotmatch '^[a-f0-9]{40}$' -or $ArtifactSourceRevision -cnotmatch '^[a-f0-9]{40}$' -or
    $ProductVersion -cnotmatch '^[0-9]+\.[0-9]+\.[0-9]+$') { throw 'Installed acceptance requires explicit Windows CI identities.' }
$head = (& git -C $SourceRoot rev-parse HEAD | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $head -cne $controllerSource) { throw 'The acceptance controller differs from this checkout.' }
if ($ValidationScope -ceq 'full-acceptance' -and -not $ControllerNodePath) {
    throw 'Full acceptance requires an isolated controller-owned Node executable.'
}
# The trusted default-branch controller may qualify a separately authorized PR
# artifact. Its checkout and four-file controller receipt remain bound to
# controllerSource; the package receipt below remains bound independently to
# ArtifactSourceRevision.
if ($Mode -ceq 'built-0.1.3-replay' -and
    ($ArtifactSourceRevision -cne '491a3a3d5e7206d82c741198062b6e2aa98dc72c' -or $ProductVersion -cne '0.1.3')) {
    throw 'Built-preview replay accepts only the fixed 0.1.3 artifact source.'
}
# These held-pipe controls run outside install/startup timing and do not execute app code.
$work = [IO.Path]::GetFullPath($WorkDirectory)
$ciNode = if ($ControllerNodePath) { [IO.Path]::GetFullPath($ControllerNodePath) } else { Join-Path $work 'application\node\node.exe' }
$ciNodeItem = Get-Item -LiteralPath $ciNode -Force
if (($ciNodeItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
    (Get-FileHash -LiteralPath $ciNode -Algorithm SHA256).Hash.ToLowerInvariant() -cne '97cce5301a815d2dce07ac5bfd1e6039eae88185ec1d10ae4f8cb712f1732878') {
    throw 'The CI controller Node executable differs from the pinned Windows ARM64 input.'
}
if ($ControllerNodePath) {
    $nodeDirectory = Get-Item -LiteralPath (Split-Path -Parent $ciNode) -Force
    $workPrefix = [IO.Path]::TrimEndingDirectorySeparator($work) + [IO.Path]::DirectorySeparatorChar
    $nodeInventory = @(Get-ChildItem -LiteralPath $nodeDirectory.FullName -Force)
    if ($ciNode.StartsWith($workPrefix, [StringComparison]::OrdinalIgnoreCase) -or
        ($nodeDirectory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        $nodeInventory.Count -ne 1 -or $nodeInventory[0] -isnot [IO.FileInfo] -or
        $nodeInventory[0].Name -cne 'node.exe') {
        throw 'Credentialed acceptance requires an isolated controller-owned Node directory.'
    }
}
$controlFiles = @(
    'packaging/windows/installer/control-installed-openclaw-input.test.mts',
    'packaging/windows/installer/run-installed-acceptance.test.mts',
    'packaging/windows/installer/qualify-finished-package.test.mts',
    'packaging/windows/runtime/native-ui-tunnel.test.mts')
if ($Mode -ceq 'current-build') {
    $controlReceiptPath = Join-Path $WorkDirectory 'application\controls\installed-acceptance-controller.json'
    $controlReceipt = Get-Content -LiteralPath $controlReceiptPath -Raw | ConvertFrom-Json
    if ($controlReceipt.schemaVersion -ne 1 -or $controlReceipt.classification -cne 'same-run-installed-acceptance-controller-controls' -or
        $controlReceipt.sourceRevision -cne $controllerSource -or $controlReceipt.nodeSha256 -cne '97cce5301a815d2dce07ac5bfd1e6039eae88185ec1d10ae4f8cb712f1732878' -or
        $controlReceipt.passed -cne $true -or @($controlReceipt.files).Count -ne $controlFiles.Count) {
        throw 'The same-run Windows acceptance-controller proof is invalid.'
    }
    foreach ($relative in $controlFiles) {
        $rows = @($controlReceipt.files | Where-Object file -CEQ $relative)
        $file = Join-Path $SourceRoot $relative
        if ($rows.Count -ne 1 -or $rows[0].bytes -ne (Get-Item -LiteralPath $file).Length -or
            $rows[0].sha256 -cne (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()) {
            throw 'The same-run Windows acceptance-controller input identity differs.'
        }
    }
} else {
    & $ciNode --experimental-strip-types --no-warnings --test @($controlFiles | ForEach-Object { Join-Path $SourceRoot $_ })
    if ($LASTEXITCODE -ne 0) { throw 'The Windows observer or diagnostic controls failed.' }
}

$setup = "$work\package\NemoClawSetup-$ProductVersion-windows-arm64.exe"
$installation = "$env:ProgramFiles\NVIDIA\NemoClaw"
if (Test-Path -LiteralPath $installation) { throw 'Fresh preview acceptance requires no preexisting NemoClaw installation.' }
$primary = $null
$restartCustodyUnresolved = $false
$openClawRestart = $Agent -ceq 'openclaw' -and $Mode -ceq 'current-build' -and $ValidationScope -ceq 'full-acceptance'
$sourceBoundAcceptance = $openClawRestart -or $Agent -ceq 'hermes'
$restartHandoff = if ($openClawRestart) { [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant() } else { '' }
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
$expectedOpenClawRuntime = $null
$expectedOpenClawLauncher = ''
$expectedOpenClawPackageBuild = ''
$expectedHermesLauncher = ''
$expectedHermesPackageBuild = ''
$artifactSourceSnapshot = ''
$artifactSourceSnapshotSha256 = ''
$expectedHermesRuntime = if ($Agent -ceq 'hermes') {
  $runtime = Get-Content -LiteralPath "$work\assembled\runtime-identity.json" -Raw | ConvertFrom-Json
  if ($runtime.sourceRevision -cne $ArtifactSourceRevision) { throw 'Hermes runtime differs from the selected artifact source.' }
  $runtime
} else { $null }
if ($sourceBoundAcceptance) {
  if (-not $ArtifactSourceRoot) { throw 'Installed acceptance requires an independent artifact source checkout.' }
  $artifactSourceSnapshot = Join-Path $work "$Agent-artifact-source.json"
  # Capture independent source bytes before installation. Product processes cannot
  # replace this caller-held hash with a later read of mutable candidate source.
  $captureArguments = @('--capture-artifact-source', '--artifact-source-root', $ArtifactSourceRoot,
    '--controller-source-root', $SourceRoot, '--artifact-source-revision', $ArtifactSourceRevision,
    '--controller-source-revision', $controllerSource, '--controller-run', ($env:GITHUB_RUN_ID + ':' + $env:GITHUB_RUN_ATTEMPT),
    '--output', $artifactSourceSnapshot)
  $capturedHash = @(& $ciNode --experimental-strip-types --no-warnings "$SourceRoot\packaging\windows\installer\qualify-installed-$Agent.mts" @captureArguments)
  if ($LASTEXITCODE -ne 0 -or $capturedHash.Count -ne 1 -or [string]$capturedHash[0] -cnotmatch '^[a-f0-9]{64}$') {
    throw 'Independent candidate launcher source capture failed.'
  }
  $artifactSourceSnapshotSha256 = [string]$capturedHash[0]
  if ((Get-FileHash -LiteralPath $artifactSourceSnapshot -Algorithm SHA256).Hash.ToLowerInvariant() -cne $artifactSourceSnapshotSha256) {
    throw 'Independent candidate launcher source capture changed.'
  }
  $selectedLauncher = (Get-Content -LiteralPath "$work\package\launcher-build-inputs.json" -Raw | ConvertFrom-Json).retainedLauncher.sha256
  $selectedPackageBuild = (Get-FileHash -LiteralPath "$work\package\immutable-package-build.json" -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($openClawRestart) {
    $expectedOpenClawRuntime = Get-Content -LiteralPath "$work\assembled\runtime-identity.json" -Raw | ConvertFrom-Json
    $expectedOpenClawLauncher = $selectedLauncher
    $expectedOpenClawPackageBuild = $selectedPackageBuild
  } else {
    $expectedHermesLauncher = $selectedLauncher
    $expectedHermesPackageBuild = $selectedPackageBuild
  }
}
$timings = [ordered]@{ schemaVersion = 1; sourceRevision = $ArtifactSourceRevision; artifactSourceRevision = $ArtifactSourceRevision; controllerSourceRevision = $controllerSource; currentHeadQualification = ($ArtifactSourceRevision -ceq $controllerSource); mode = $Mode; measurement = 'fresh-runner-installed-preview'; agent = $Agent;
  validationScope = $ValidationScope; runtimeBootstrap = [bool]$RuntimeBootstrap; runtimeQualified = $false; fullInstalledQualification = $false; migrationQualified = $false;
  hostPreparationRunBeforeInstall = $false; upgradeMeasured = $false; installTargetMilliseconds = 30000; installTargetSatisfied = $false; primaryException = $null; nativeRuntimeFailure = $null; compiledMsi = $build.compiledMsi; stages = [ordered]@{} }
$script:SetupTransactionUnconfirmed = $false
function Invoke-OwnedSetup([string]$Action, [string]$Log) {
  if ($script:SetupTransactionUnconfirmed) { throw 'A prior setup transaction is unconfirmed; no overlapping installer was started.' }
  $info = [Diagnostics.ProcessStartInfo]::new()
  $info.FileName = $setup; $info.UseShellExecute = $false; $info.CreateNoWindow = $true
  # Installation and uninstall must not receive the controller's inference keys
  # or runtime overrides. Keep credentials in this process for later acceptance.
  $info.Environment.Clear()
  foreach ($name in @('SystemRoot','WINDIR','SystemDrive','COMSPEC','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA','ProgramData','ProgramFiles','ProgramFiles(x86)','CommonProgramFiles','CommonProgramFiles(x86)','PROCESSOR_ARCHITECTURE','PROCESSOR_ARCHITEW6432','NUMBER_OF_PROCESSORS','OS')) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if ($null -ne $value) { $info.Environment[$name] = $value }
  }
  $info.Environment['PATH'] = [Environment]::SystemDirectory + ';' + [Environment]::GetEnvironmentVariable('SystemRoot')
  foreach ($value in @($Action, '-quiet', '-norestart', '-log', $Log)) { $info.ArgumentList.Add($value) }
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $process = $null; $code = $null; $startedPid = $null; $setupFailure = $null
  $script:SetupTransactionUnconfirmed = $true
  try {
    $process = [Diagnostics.Process]::Start($info)
    $startedPid = $process.Id
    if ($startedPid -isnot [int] -or $startedPid -le 0) { throw 'Setup process identity is unavailable.' }
    if (-not $process.WaitForExit(1200000)) { throw 'Setup exceeded its 20-minute deadline; the live transaction was retained, not killed.' }
    $code = $process.ExitCode
    if ($code -isnot [int]) { throw 'Setup process exit status is unavailable.' }
    $script:SetupTransactionUnconfirmed = $false
  } catch { $setupFailure = $_ }
  finally {
    if ($null -ne $process) {
      try { $process.Dispose() }
      catch { if ($null -eq $setupFailure) { $setupFailure = $_ } else { Write-Warning 'The setup failure is preserved; its process handle also failed to close.' } }
    }
    $timings.stages[$Action] = @{ elapsedMilliseconds = $clock.ElapsedMilliseconds; exitCode = $code; processId = $startedPid; transactionStopped = -not $script:SetupTransactionUnconfirmed }
    if ($Action -cin @('-install', '-repair') -and -not $script:SetupTransactionUnconfirmed) {
      $measurement = @{ diagnosticOnly = $true; available = $false; milliseconds = @{} }
      try {
        $retained = Get-ItemProperty -LiteralPath 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\NVIDIA\NemoClaw\InstallDiagnostics' -ErrorAction Stop
        foreach ($name in @('RuntimeImageHashMilliseconds','RuntimeImageAttachMilliseconds','RuntimeImageMountMilliseconds','RuntimeNodeHashMilliseconds')) {
          $property = $retained.PSObject.Properties[$name]
          if ($null -ne $property) {
            [ulong]$value = 0
            if ($property.Value -isnot [string] -or $property.Value -cnotmatch '^[0-9]{1,20}$' -or
                -not [ulong]::TryParse($property.Value, [ref]$value)) { throw 'Invalid native phase timing.' }
            $measurement.milliseconds[$name] = $value
          }
        }
        $measurement.available = $measurement.milliseconds.Count -gt 0
      } catch { $measurement.milliseconds = @{} }
      $timings.stages[$Action]['nativePhaseTimings'] = $measurement
    }
  }
  if ($null -ne $setupFailure) { throw $setupFailure }
  if ($code -ne 0) { throw "Finished preview $Action failed with status $code." }
}
function Assert-HermesCaseReceipt($Receipt, [string]$CaseName, $ColdReceipt) {
  $warm = $CaseName -ceq 'warmInstalledLaunch'
  if ($Receipt.results.runtimeBootstrap -isnot [bool] -or $Receipt.results.runtimeBootstrap -ne [bool]$RuntimeBootstrap -or
      $Receipt.results.configuration.nativeOnboardingUsed -isnot [bool] -or
      $Receipt.results.configuration.nativeOnboardingUsed -ne (-not $warm -and -not $RuntimeBootstrap)) {
    throw 'Hermes acceptance changed its runtime-bootstrap or native-onboarding scope.'
  }
  $admission = $Receipt.results.launcherAdmission
  foreach ($pair in @(
      @('launcherSha256', $expectedHermesLauncher),
      @('packageBuildSha256', $expectedHermesPackageBuild),
      @('artifactSourceSnapshotSha256', $artifactSourceSnapshotSha256),
      @('controllerSourceRevision', $controllerSource))) {
    if ($admission -isnot [pscustomobject] -or $pair[1] -isnot [string] -or
        $admission.($pair[0]) -isnot [string] -or $admission.($pair[0]) -cne $pair[1]) {
      throw 'Hermes launcher admission differs from the independently selected package and source.'
    }
  }
  if ($admission.launcherSha256 -cnotmatch '^[a-f0-9]{64}$' -or
      $admission.packageBuildSha256 -cnotmatch '^[a-f0-9]{64}$' -or
      $admission.artifactSourceSnapshotSha256 -cnotmatch '^[a-f0-9]{64}$' -or
      $admission.controllerSourceRevision -cnotmatch '^[a-f0-9]{40}$') {
    throw 'Hermes launcher admission lacks complete identities.'
  }
  if ($CaseName -cnotin @('firstInstalledLaunch','warmInstalledLaunch') -or
      $Receipt -isnot [pscustomobject] -or $Receipt.results -isnot [pscustomobject] -or
      $Receipt.runtime -isnot [pscustomobject] -or $Receipt.results.custody -isnot [pscustomobject] -or
      $Receipt.results.cleanup -isnot [pscustomobject] -or
      ($Receipt.schemaVersion -isnot [long] -and $Receipt.schemaVersion -isnot [int]) -or $Receipt.schemaVersion -ne 1 -or
      $Receipt.classification -isnot [string] -or $Receipt.verdict -isnot [string] -or $Receipt.controllerRun -isnot [string] -or
      $Receipt.classification -cne 'installed-canonical-hermes-acceptance' -or $Receipt.verdict -cne 'pass' -or
      $Receipt.controllerRun -cne ($env:GITHUB_RUN_ID + ':' + $env:GITHUB_RUN_ATTEMPT) -or
      $Receipt.cleanupErrors -isnot [array] -or @($Receipt.cleanupErrors).Count -ne 0 -or
      $Receipt.fullInstalledQualification -isnot [bool] -or $Receipt.fullInstalledQualification -or
      $Receipt.results.configurationReused -isnot [bool] -or $Receipt.results.configurationReused -ne $warm -or
      $Receipt.results.configurationPreserved -isnot [bool] -or $Receipt.results.configurationPreserved -eq $warm -or
      $Receipt.results.stateRoot -isnot [string] -or $Receipt.results.stateRoot -cnotmatch '^[A-Z]:\\NemoClawState-S-1-(?:\d+-)*\d+-hermes$' -or
      $Receipt.results.configurationSha256 -isnot [string] -or $Receipt.results.configurationSha256 -cnotmatch '^[a-f0-9]{64}$') {
    throw 'Hermes acceptance lacks current-case identity and configuration evidence.'
  }
  if (($Receipt.results.cleanup.schemaVersion -isnot [long] -and $Receipt.results.cleanup.schemaVersion -isnot [int]) -or
      $Receipt.results.cleanup.schemaVersion -ne 1 -or $Receipt.results.cleanup.classification -isnot [string] -or
      $Receipt.results.cleanup.classification -cne 'native-hermes-dashboard-qualification' -or
      $Receipt.results.cleanup.agent -isnot [string] -or $Receipt.results.cleanup.agent -cne 'hermes') {
    throw 'Hermes backend cleanup receipt identity differs.'
  }
  foreach ($name in @('nativeLaunchAttempted','nativeCleanupConfirmed','processesStopped','uninstallSafe')) {
    if ($Receipt.results.custody.$name -isnot [bool] -or -not $Receipt.results.custody.$name) {
      throw 'Hermes process and native cleanup custody is unresolved.'
    }
  }
  if ($Receipt.results.custody.configurationMutationUnconfirmed -isnot [bool] -or $Receipt.results.custody.configurationMutationUnconfirmed) {
    throw 'Hermes configuration completion is unresolved.'
  }
  if ($Receipt.results.custody.configurationRetainedForRecovery -isnot [bool] -or $Receipt.results.custody.configurationRetainedForRecovery) {
    throw 'Hermes recovery state remains retained.'
  }
  foreach ($name in @('sandboxDeleted','gatewayStopped','ephemeralRootsRemoved','stateRetained','leaseReleased','cleanupSucceeded',
      'guardianClosed','observerClosed','runtimeLeaseOwnerClosedWithGuardian')) {
    if ($Receipt.results.cleanup.$name -isnot [bool] -or -not $Receipt.results.cleanup.$name) {
      throw 'Hermes acceptance lacks confirmed backend cleanup.'
    }
  }
  foreach ($name in @('runtimeId','manifestSha256','sourceRevision','nodeSha256','nodeVersion')) {
    if ($expectedHermesRuntime.$name -isnot [string] -or [string]::IsNullOrWhiteSpace($expectedHermesRuntime.$name) -or
        $Receipt.runtime.$name -isnot [string] -or $Receipt.runtime.$name -cne $expectedHermesRuntime.$name) {
      throw 'Hermes cleanup differs from the selected artifact runtime.'
    }
  }
  # The backend receipt publishes the held runtime's three-field identity;
  # Node identity belongs to the independently checked qualifier runtime tuple.
  foreach ($name in @('runtimeId','manifestSha256','sourceRevision')) {
    if ($Receipt.results.cleanup.runtimeIdentity.$name -isnot [string] -or
        $Receipt.results.cleanup.runtimeIdentity.$name -cne $expectedHermesRuntime.$name) {
      throw 'Hermes backend cleanup differs from the selected runtime.'
    }
  }
  $conversationNames = @('retainedConversation')
  if ($warm) { $conversationNames += 'restoredConversation' }
  foreach ($name in $conversationNames) {
    $conversation = $Receipt.results.$name
    if ($conversation -isnot [pscustomobject] -or
        $conversation.storedSessionId -isnot [string] -or $conversation.storedSessionId.Length -lt 1 -or $conversation.storedSessionId.Length -gt 128 -or
        $conversation.profileName -isnot [string] -or $conversation.profileName.Length -lt 1 -or $conversation.profileName.Length -gt 128 -or
        ($conversation.messageCount -isnot [long] -and $conversation.messageCount -isnot [int]) -or
        $conversation.messageCount -lt 2 -or $conversation.messageCount -ge 500 -or
        ($conversation.lastMessageId -isnot [long] -and $conversation.lastMessageId -isnot [int]) -or
        $conversation.lastMessageId -lt $conversation.messageCount -or $conversation.lastMessageId -gt 9007199254740991 -or
        $conversation.transcriptSha256 -isnot [string] -or $conversation.transcriptSha256 -cnotmatch '^[a-f0-9]{64}$') {
      throw 'Hermes acceptance lacks a complete retained conversation identity.'
    }
  }
  if ($warm) {
    if ($ColdReceipt -isnot [pscustomobject]) { throw 'Hermes restart lacks its validated cold receipt.' }
    foreach ($name in @('stateRoot','configurationSha256')) {
      if ($Receipt.results.$name -cne $ColdReceipt.results.$name) { throw 'Hermes restart changed the retained state or configuration.' }
    }
    foreach ($name in @('storedSessionId','profileName','messageCount','lastMessageId','transcriptSha256')) {
      if ($Receipt.results.restoredConversation.$name -cne $ColdReceipt.results.retainedConversation.$name) {
        throw 'Hermes restart did not restore the cold conversation.'
      }
    }
    foreach ($name in @('storedSessionId','profileName')) {
      if ($Receipt.results.retainedConversation.$name -cne $ColdReceipt.results.retainedConversation.$name) {
        throw 'Hermes restart continued a different conversation.'
      }
    }
    if ($Receipt.results.retainedConversation.messageCount -le $ColdReceipt.results.retainedConversation.messageCount -or
        $Receipt.results.retainedConversation.lastMessageId -le $ColdReceipt.results.retainedConversation.lastMessageId -or
        $Receipt.results.retainedConversation.transcriptSha256 -ceq $ColdReceipt.results.retainedConversation.transcriptSha256) {
      throw 'Hermes restart lacks a new completed turn in the retained conversation.'
    }
  }
}
function Assert-OpenClawRestartReceipt($Receipt, [string]$CaseName, $ColdReceipt) {
  $restart = $Receipt.restart
  $warm = $CaseName -ceq 'warmInstalledLaunch'
  $expectedMode = if ($warm) { 'warm-reused' } else { 'cold-preserved' }
  $expectedCleanup = if ($warm) { 'removed-owned-state' } else { 'retained-for-warm-run' }
  if ($Receipt.schemaVersion -ne 2 -or $Receipt.classification -cne 'installed-compiled-openclaw-acceptance' -or
      $Receipt.verdict -cne 'pass' -or @($Receipt.cleanupErrors).Count -ne 0 -or @($Receipt.cleanupErrorDetails).Count -ne 0 -or
      $null -ne $Receipt.primaryFailure -or $restart.schemaVersion -ne 1 -or $restart.mode -cne $expectedMode -or
      $restart.controllerRun -cne ($env:GITHUB_RUN_ID + ':' + $env:GITHUB_RUN_ATTEMPT) -or
      $restart.handoff -cne $restartHandoff -or $restart.installation -cne $installation -or
      $restart.configurationReused -isnot [bool] -or $restart.configurationReused -ne $warm -or
      $restart.configurationPreserved -isnot [bool] -or $restart.configurationPreserved -eq $warm -or
      $restart.processesStopped -cne $true -or $restart.backendCleanupConfirmed -cne $true -or
      $restart.stateOwnerReleased -cne $true -or $restart.mutationUnconfirmed -cne $false -or
      $restart.credentialMutationConfirmed -cne $true -or
      ($warm -and $restart.cleanupScope -cne 'owned-configuration-state-and-credential') -or
      $restart.cleanupDisposition -cne $expectedCleanup -or $restart.provider -cne 'nvidia' -or
      $restart.endpoint -cne 'https://integrate.api.nvidia.com/v1' -or
      $restart.launcherSha256 -cne $expectedOpenClawLauncher -or $restart.packageBuildSha256 -cne $expectedOpenClawPackageBuild -or
      $restart.artifactSourceSnapshotSha256 -cne $artifactSourceSnapshotSha256 -or $restart.controllerSourceRevision -cne $controllerSource -or
      $restart.launcherSha256 -cnotmatch '^[a-f0-9]{64}$' -or $restart.packageBuildSha256 -cnotmatch '^[a-f0-9]{64}$' -or
      $restart.configurationSha256 -cnotmatch '^[a-f0-9]{64}$' -or
      $restart.ownedState.stateRoot -cnotmatch '^[A-Z]:\\NemoClawState-S-1-(?:\d+-)*\d+-openclaw$' -or
      $restart.ownedState.device -cnotmatch '^\d+$' -or $restart.ownedState.inode -cnotmatch '^[1-9]\d*$' -or
      $restart.retainedConversation.sessionKey -cnotmatch '^agent:main:[A-Za-z0-9:._-]{1,256}$' -or
      $restart.retainedConversation.sha256 -cnotmatch '^[a-f0-9]{64}$' -or
      $restart.retainedConversation.messageCount -lt 1 -or $restart.retainedConversation.messageCount -ge 100 -or
      $Receipt.results.response.provider -cne 'nvidia' -or $Receipt.results.response.model -cne $restart.model -or
      $Receipt.results.response.deterministicModel -cne $false -or
      $Receipt.results.response.visibleReply -cnotmatch '^NEMOCLAW_NVIDIA_[a-f0-9]{24}$') {
    throw 'The OpenClaw cold/warm receipt lacks required restart and cleanup evidence.'
  }
  foreach ($name in @('processesStopped','backendCleanupConfirmed','stateOwnerReleased','mutationUnconfirmed','credentialMutationConfirmed')) {
    if ($restart.$name -isnot [bool]) { throw 'OpenClaw restart cleanup evidence must use Boolean values.' }
  }
  foreach ($name in @('runtimeId','manifestSha256','sourceRevision','nodeSha256','nodeVersion')) {
    if ($Receipt.runtime.$name -cne $expectedOpenClawRuntime.$name) { throw 'OpenClaw restart differs from the selected runtime.' }
  }
  if ($warm) {
    foreach ($name in @('launcherSha256','packageBuildSha256','artifactSourceSnapshotSha256','controllerSourceRevision','configurationSha256','model')) {
      if ($restart.$name -cne $ColdReceipt.restart.$name) { throw 'OpenClaw restart changed its package or saved selection.' }
    }
    foreach ($name in @('stateRoot','device','inode')) {
      if ($restart.ownedState.$name -cne $ColdReceipt.restart.ownedState.$name) { throw 'OpenClaw restart changed its owned state.' }
    }
    foreach ($name in @('sessionKey','messageCount','sha256')) {
      if ($restart.restoredConversation.$name -cne $ColdReceipt.restart.retainedConversation.$name) { throw 'OpenClaw restart did not restore the cold conversation.' }
    }
    if ($restart.retainedConversation.sessionKey -cne $ColdReceipt.restart.retainedConversation.sessionKey -or
        $restart.retainedConversation.messageCount -le $ColdReceipt.restart.retainedConversation.messageCount -or
        $restart.retainedConversation.sha256 -ceq $ColdReceipt.restart.retainedConversation.sha256 -or
        $Receipt.results.response.visibleReply -ceq $ColdReceipt.results.response.visibleReply) {
      throw 'OpenClaw warm acceptance lacks a new response in the retained conversation.'
    }
    foreach ($name in @('runtimeId','manifestSha256','sourceRevision','nodeSha256','nodeVersion')) {
      if ($Receipt.runtime.$name -cne $ColdReceipt.runtime.$name) { throw 'OpenClaw restart changed the runtime identity.' }
    }
  }
}
function Test-OpenClawOwnedCleanupReceipt($Receipt, [string]$CaseName, $ColdReceipt) {
  $restart = $Receipt.restart
  $expectedMode = if ($CaseName -ceq 'warmInstalledLaunch') { 'warm-reused' } else { 'cold-preserved' }
  if ($Receipt.schemaVersion -ne 2 -or $Receipt.classification -cne 'installed-compiled-openclaw-acceptance' -or
      $Receipt.verdict -cnotin @('pass','fail') -or $Receipt.cleanupErrors -isnot [array] -or @($Receipt.cleanupErrors).Count -ne 0 -or
      $restart.schemaVersion -ne 1 -or $restart.mode -cne $expectedMode -or
      $restart.controllerRun -cne ($env:GITHUB_RUN_ID + ':' + $env:GITHUB_RUN_ATTEMPT) -or $restart.handoff -cne $restartHandoff -or
      $restart.installation -cne $installation -or $restart.launcherSha256 -cne $expectedOpenClawLauncher -or
      $restart.packageBuildSha256 -cne $expectedOpenClawPackageBuild -or $restart.cleanupDisposition -cne 'removed-owned-state' -or
      $restart.artifactSourceSnapshotSha256 -cne $artifactSourceSnapshotSha256 -or $restart.controllerSourceRevision -cne $controllerSource -or
      $restart.mutationUnconfirmed -isnot [bool] -or $restart.mutationUnconfirmed -or
      $restart.ownedState.stateRoot -cnotmatch '^[A-Z]:\\NemoClawState-S-1-(?:\d+-)*\d+-openclaw$' -or
      $restart.ownedState.device -cnotmatch '^\d+$' -or $restart.ownedState.inode -cnotmatch '^[1-9]\d*$') { return $false }
  foreach ($name in @('processesStopped','backendCleanupConfirmed','stateOwnerReleased')) {
    if ($restart.$name -isnot [bool] -or -not $restart.$name) { return $false }
  }
  foreach ($name in @('runtimeId','manifestSha256','sourceRevision','nodeSha256','nodeVersion')) {
    if ($Receipt.runtime.$name -cne $expectedOpenClawRuntime.$name) { return $false }
  }
  if ($restart.credentialMutationConfirmed -isnot [bool]) { return $false }
  if ($restart.credentialMutationConfirmed) {
    if ($restart.cleanupScope -cne 'owned-configuration-state-and-credential') { return $false }
  } elseif ($CaseName -ceq 'warmInstalledLaunch' -or $null -ne $restart.configurationSha256 -or
      $restart.cleanupScope -cne 'fresh-private-root-only-no-credentials-touched') { return $false }
  if ($CaseName -ceq 'warmInstalledLaunch') {
    foreach ($name in @('stateRoot','device','inode')) {
      if ($restart.ownedState.$name -cne $ColdReceipt.restart.ownedState.$name) { return $false }
    }
  }
  return $true
}
try {
  Invoke-OwnedSetup '-install' "$work\install.log"
  $timings['startupComparisonAvailable'] = $false
  if ($ValidationScope -ceq 'startup-only') {
    foreach ($case in @(
      @{ directory = 'installed-smoke'; timing = 'startupSmoke'; repair = $false },
      @{ directory = 'installed-smoke-after-repair'; timing = 'repairStartupSmoke'; repair = $true }
    )) {
      if ($case.repair) { Invoke-OwnedSetup '-repair' "$work\repair.log" }
      & $ciNode --experimental-strip-types --no-warnings "$SourceRoot\packaging\windows\installer\qualify-finished-package.mts" `
        --agent $Agent --install-root $installation --runtime-identity "$work\assembled\runtime-identity.json" --output "$work\$($case.directory)"
      if ($LASTEXITCODE -ne 0) { throw 'The installed startup-only smoke failed.' }
      $smoke = Get-Content -LiteralPath "$work\$($case.directory)\finished-package-smoke.json" -Raw | ConvertFrom-Json
      if ($smoke.verdict -cne 'pass' -or $smoke.agent -cne $Agent -or $smoke.validationScope -cne 'startup-only' -or
          $smoke.fullInstalledQualification -isnot [bool] -or $smoke.fullInstalledQualification) { throw 'The installed startup-only receipt is incomplete.' }
      $timings[$case.timing] = @{ receipt = "$($case.directory)/finished-package-smoke.json"; deterministicLocalModel = $true }
    }
  } else {
  $coldOpenClawReceipt = $null
  $coldHermesReceipt = $null
  foreach ($case in @(
    @{ name = 'firstInstalledLaunch'; directory = 'installed-acceptance' },
    @{ name = 'warmInstalledLaunch'; directory = 'installed-acceptance-warm' }
  )) {
    $qualification = Join-Path $SourceRoot ("packaging\windows\installer\qualify-installed-$Agent.mts")
    $driverRoot = if ($Agent -ceq 'hermes') { "$work\application\inputs\tools\node_modules\playwright-core" } else { "$work\application\build\app\node_modules\playwright-core" }
    [string[]]$caseArguments = @()
    if ($Agent -ceq 'hermes') {
      # Preserve recovery custody even when the qualifier exits before writing a
      # receipt. Cold success retains it until the matching warm case finishes.
      $restartCustodyUnresolved = $true
      if (Test-Path -LiteralPath "$work\$($case.directory)\installed-hermes-acceptance.json") {
        throw 'Hermes acceptance refuses a preexisting case receipt.'
      }
      $caseArguments = if ($case.name -ceq 'firstInstalledLaunch') { @('--preserve-configuration') } else { @('--reuse-configuration') }
      if ($RuntimeBootstrap) { $caseArguments += '--runtime-bootstrap' }
      $caseArguments += @('--package-root', "$work\package", '--artifact-source-snapshot', $artifactSourceSnapshot,
        '--artifact-source-snapshot-sha256', $artifactSourceSnapshotSha256)
    }
    if ($Agent -ceq 'hermes' -and $case.name -ceq 'warmInstalledLaunch') {
      $caseArguments += @('--previous-acceptance', "$work\installed-acceptance\installed-$Agent-acceptance.json")
    }
    if ($openClawRestart) {
      $caseArguments = if ($case.name -ceq 'firstInstalledLaunch') { @('--preserve-configuration') } else {
        @('--reuse-configuration', '--previous-acceptance', "$work\installed-acceptance\installed-openclaw-acceptance.json")
      }
      $caseArguments += @('--restart-handoff', $restartHandoff, '--package-root', "$work\package",
        '--artifact-source-snapshot', $artifactSourceSnapshot, '--artifact-source-snapshot-sha256', $artifactSourceSnapshotSha256)
      # A failed process or missing receipt cannot authorize deleting retained state
      # or uninstalling the helper required for its recovery.
      $restartCustodyUnresolved = $true
    }
    & $ciNode --experimental-strip-types --no-warnings $qualification `
      --install-root $installation --runtime-identity "$work\assembled\runtime-identity.json" `
      --output "$work\$($case.directory)" --browser-driver-root $driverRoot @caseArguments
    $code = $LASTEXITCODE
    $timings[$case.name] = @{ exitCode = $code; receipt = "$($case.directory)/installed-$Agent-acceptance.json";
      modelAndToolDurationsSeparate = ($Agent -ceq 'openclaw'); conversationIntervalsSeparateFromStartup = ($Agent -ceq 'hermes'); isolatedProviderLatencyClaimed = $false; agentStateResetPerCase = ($Agent -ceq 'openclaw' -and -not $openClawRestart) }
    $accepted = $null
    if ($openClawRestart) {
      $accepted = Get-Content -LiteralPath "$work\$($case.directory)\installed-$Agent-acceptance.json" -Raw | ConvertFrom-Json
      if (Test-OpenClawOwnedCleanupReceipt $accepted $case.name $coldOpenClawReceipt) { $restartCustodyUnresolved = $false }
    }
    if ($code -ne 0) { throw "The $($case.name) selected-agent acceptance failed; no startup comparison is claimed." }
    if (-not $openClawRestart) { $accepted = Get-Content -LiteralPath "$work\$($case.directory)\installed-$Agent-acceptance.json" -Raw | ConvertFrom-Json }
    if ($accepted.verdict -cne 'pass' -or @($accepted.cleanupErrors).Count -ne 0) {
      throw 'Ordinary launch did not finish its required agent checks and owned cleanup.'
    }
    if ($Agent -ceq 'hermes') {
      Assert-HermesCaseReceipt $accepted $case.name $coldHermesReceipt
      if ($case.name -ceq 'firstInstalledLaunch') { $coldHermesReceipt = $accepted }
      else {
        $restartCustodyUnresolved = $false
        $timings['restartPersistence'] = @{ qualified=$true; configurationUnchanged=$true; sameConversation=$true; sameStateRoot=$true;
          coldReceipt='installed-acceptance/installed-hermes-acceptance.json'; warmReceipt='installed-acceptance-warm/installed-hermes-acceptance.json' }
      }
    }
    if ($openClawRestart) {
      Assert-OpenClawRestartReceipt $accepted $case.name $coldOpenClawReceipt
      if ($case.name -ceq 'firstInstalledLaunch') { $coldOpenClawReceipt = $accepted }
      else {
        $restartCustodyUnresolved = $false
        $timings['restartPersistence'] = @{ qualified=$true; configurationRewritten=$false; credentialRecreated=$false;
          sameConversation=$true; sameOwnedState=$true; coldReceipt='installed-acceptance/installed-openclaw-acceptance.json'; warmReceipt='installed-acceptance-warm/installed-openclaw-acceptance.json' }
      }
    }

  }
  $timings.startupComparisonAvailable = $true
  if ($Agent -ceq 'openclaw') {
    & $ciNode --experimental-strip-types `
      "$SourceRoot\packaging\windows\installer\qualify-finished-package.mts" `
      --install-root "$env:ProgramFiles\NVIDIA\NemoClaw" --runtime-identity "$work\assembled\runtime-identity.json" --output "$work\installed-smoke"
    if ($LASTEXITCODE -ne 0) { throw 'The installed compiled/contained smoke failed.' }
  } else { $timings['compiledRuntimeControls'] = "$Agent acceptance validated capabilities, SEA identity and held runtime tuple." }
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
    if ($restartCustodyUnresolved -or $script:SetupTransactionUnconfirmed) {
      if ($script:SetupTransactionUnconfirmed) {
        $timings['uninstallDeferredForSetupTransaction'] = $true
        throw 'Setup transaction completion is unconfirmed; preserve the installation and do not start cleanup uninstall.'
      }
      $timings['uninstallDeferredForRecovery'] = $true
      throw 'Selected-agent retained-state custody is unresolved; preserve the installation, data and credentials for recovery.'
    }
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
$timings.runtimeQualified = $ValidationScope -ceq 'full-acceptance' -and $null -eq $primary
$timings.fullInstalledQualification = $timings.runtimeQualified -and -not $RuntimeBootstrap
try { [IO.File]::WriteAllText("$work\installed-stage-timings.json", ($timings | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false)) }
catch { if ($null -eq $primary) { $primary = $_ } else { Write-Warning 'The original failure is preserved; timing evidence also could not be saved.' } }
if ($null -ne $primary) { throw $primary }
