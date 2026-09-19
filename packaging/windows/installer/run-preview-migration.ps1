# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# Separate-runner migration qualification. It does not send inference requests.
[CmdletBinding()]
param([Parameter(Mandatory)][string]$WorkDirectory, [Parameter(Mandatory)][string]$ProductVersion,
    [ValidateSet('openclaw','hermes','pi')][string]$NewAgent = 'openclaw')
Set-StrictMode -Version Latest; $ErrorActionPreference = 'Stop'
$parsedVersion = $null
if ($ProductVersion -cnotmatch '^[0-9]+\.[0-9]+\.[0-9]+$' -or
    -not [version]::TryParse($ProductVersion, [ref]$parsedVersion) -or $parsedVersion -le [version]'0.1.4') {
    throw 'Migration requires a candidate MSI version newer than baseline 0.1.4.'
}
$NewAgent=$NewAgent.ToLowerInvariant()
. (Join-Path $PSScriptRoot 'preview-ui-controls.ps1')
$work = [IO.Path]::GetFullPath($WorkDirectory)
$output = Join-Path $work 'migration'
if (Test-Path -LiteralPath $output) { throw 'Migration evidence must be fresh.' }
[void][IO.Directory]::CreateDirectory($output)
$installation = Join-Path $env:ProgramFiles 'NVIDIA\NemoClaw'
$configuration = Join-Path $env:LOCALAPPDATA 'NVIDIA\NemoClaw\agents\openclaw\native-windows.json'
$userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$state = $env:SystemDrive.ToUpperInvariant() + '\NemoClawState-' + $userSid + '-openclaw'
$newConfiguration = Join-Path $env:LOCALAPPDATA ('NVIDIA\NemoClaw\agents\'+$NewAgent+'\native-windows.json')
$newState = $env:SystemDrive.ToUpperInvariant() + '\NemoClawState-' + $userSid + '-'+$NewAgent
foreach ($path in @($installation,$configuration,$state,$newConfiguration,$newState)) {
    if (Test-Path -LiteralPath $path) { throw 'Migration requires an empty disposable runner; existing state is not adopted.' }
}
$build = Get-Content -LiteralPath (Join-Path $work 'package\immutable-package-build.json') -Raw | ConvertFrom-Json
if ($build.sourceRevision -cne $env:GITHUB_SHA -or $build.status -cne 'candidate-built-for-installed-qualification') { throw 'Migration must use this exact same-run product artifact.' }
foreach ($row in $build.files) {
    $file = Join-Path $work ('package\' + $row.file)
    if ([IO.Path]::GetFileName([string]$row.file) -cne $row.file -or (Get-Item -LiteralPath $file).Length -ne $row.bytes -or
        (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $row.sha256) { throw 'Migration product input changed.' }
}
$newSetup = Join-Path $work "package\NemoClawSetup-$ProductVersion-windows-arm64.exe"
$newHash = (Get-FileHash -LiteralPath $newSetup -Algorithm SHA256).Hash.ToLowerInvariant()
$oldSetup = Join-Path $output 'NemoClawSetup-0.1.4-windows-arm64.exe'
$oldHash = '99a1f9db86f9be25cf5b903545f6dce626f9f09700c0e51b0b4040f1fd82d750'
$oldUrl = 'https://media.githubusercontent.com/media/NVIDIA/NemoClaw/7c570e3f09bac5a48df7a5f2b85456e35cbe77ec/NemoClawSetup-0.1.4-windows-arm64.exe'
$report = [ordered]@{schemaVersion=1;classification='actual-published-preview-native-migration';sourceRevision=$env:GITHUB_SHA;productVersion=$ProductVersion;
    oldSource='7935e0ccee812d365fd58d32e7291fd3286a98bf';oldVersion='0.1.4';oldAgent='openclaw';newAgent=$NewAgent;oldSha256=$oldHash;newSha256=$newHash;status='failed';
    freshInstallTimingContaminated=$false;realModelRequests=0;cases=@();cleanupErrors=@()}
$primary = $null; $retainedHelper = $null; $retainedHelperHash = $null; $binding = $null; $configHash = $null; $ownedCanary = $false; $script:MigrationInstallerOpen = $false

function Get-MigrationRegistrations {
    $rows = @()
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64,[Microsoft.Win32.RegistryView]::Registry32)) {
        $machine = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine,$view)
        try {
            $uninstall = $machine.OpenSubKey('SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall')
            if ($null -eq $uninstall) { continue }
            try {
                $names = $uninstall.GetSubKeyNames(); if ($names.Length -gt 16384) { throw 'The installed-application registry exceeds its bound.' }
                foreach ($name in $names) {
                    $entry = $uninstall.OpenSubKey($name)
                    if ($null -eq $entry) { continue }
                    try {
                        $codes = @($entry.GetValue('BundleUpgradeCode'))
                        $bundle = @($codes | Where-Object { $_ -ieq '{1BA739B8-B632-4A8C-BB02-95058CC3A960}' -or $_ -ieq '1BA739B8-B632-4A8C-BB02-95058CC3A960' }).Count -gt 0
                        $msi = $entry.GetValue('DisplayName') -ceq 'NemoClaw Runtime' -and $entry.GetValue('Publisher') -ceq 'NVIDIA Corporation'
                        if ($bundle -or $msi) { $rows += [pscustomobject]@{kind=$(if($bundle){'bundle'}else{'msi'});version=[string]$entry.GetValue('DisplayVersion');id=$name} }
                    } finally { $entry.Dispose() }
                }
            } finally { $uninstall.Dispose() }
        } finally { $machine.Dispose() }
    }
    return $rows
}
function Assert-MigrationRegistrations([string]$Version) {
    $rows = @(Get-MigrationRegistrations)
    if (-not $Version) { if ($rows.Count -ne 0) { throw 'Conventional uninstall retained NemoClaw registration.' }; return }
    if ($rows.Count -ne 2 -or @($rows | Where-Object kind -ceq 'bundle').Count -ne 1 -or @($rows | Where-Object kind -ceq 'msi').Count -ne 1) { throw 'The migration did not leave exactly one bundle and one MSI.' }
    foreach ($row in $rows) { if (([version]$row.version).ToString(3) -cne $Version) { throw 'An older or unexpected preview registration remains.' } }
}
function Invoke-MigrationHelper([string]$Executable, [string[]]$Arguments, [string]$InputText = '') {
    $info = New-PreviewProcess $Executable $Arguments
    $info.RedirectStandardInput=$true; $info.RedirectStandardOutput=$true; $info.RedirectStandardError=$true; $info.CreateNoWindow=$true
    $child = [Diagnostics.Process]::Start($info)
    try {
        $stdout=$child.StandardOutput.ReadToEndAsync(); $stderr=$child.StandardError.ReadToEndAsync()
        $child.StandardInput.Write($InputText); $child.StandardInput.Close()
        if (-not $child.WaitForExit(30000)) { throw 'The exact native canary helper did not finish.' }
        $text=$stdout.GetAwaiter().GetResult(); $errorText=$stderr.GetAwaiter().GetResult()
        if ([Text.Encoding]::UTF8.GetByteCount($text) -gt 8192 -or [Text.Encoding]::UTF8.GetByteCount($errorText) -gt 8192) { throw 'Native canary helper output exceeded its bound.' }
        return [pscustomobject]@{exitCode=$child.ExitCode;stdout=$text;stderr=$errorText}
    } finally {
        if (-not $child.HasExited) { $child.Kill($true); if (-not $child.WaitForExit(5000)) { throw 'The owned canary helper did not close.' } }
        $child.Dispose()
    }
}
function Assert-MigrationCanary([string]$MarkerPath, [string]$MarkerHash, [string]$ConfigHash, [string]$Key) {
    if ((Get-FileHash -LiteralPath $MarkerPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $MarkerHash -or
        (Get-FileHash -LiteralPath $configuration -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ConfigHash) { throw 'Migration changed preserved agent state or configuration.' }
    $read = Invoke-MigrationHelper $retainedHelper @('--credential-read','compatible','--binding',$binding)
    if ($read.exitCode -ne 0 -or $read.stdout -cne $Key) { throw 'Migration did not preserve the exact owned Windows credential.' }
}
function Remove-MigrationOldCanary {
    if ($null -eq $retainedHelperHash -or (Get-FileHash -LiteralPath $retainedHelper -Algorithm SHA256).Hash.ToLowerInvariant() -cne $retainedHelperHash) { throw 'The retained old native cleanup helper changed.' }
    $failures=@()
    foreach ($command in @(@('--state-remove','openclaw'), @('--credential-delete','compatible','--binding',$binding))) {
        try {
            $cleanupResult=Invoke-MigrationHelper $retainedHelper $command
            if ($cleanupResult.exitCode -ne 0) { throw 'Retained native canary cleanup failed.' }
        } catch { $failures+=@($_.Exception.Message) }
    }
    try {
        if (Test-Path -LiteralPath $configuration -PathType Leaf) {
            if ($null -eq $configHash -or (Get-FileHash -LiteralPath $configuration -Algorithm SHA256).Hash.ToLowerInvariant() -cne $configHash) { throw 'The remaining old configuration changed; it was preserved.' }
            [IO.File]::Delete($configuration)
        }
    } catch { $failures+=@($_.Exception.Message) }
    try {
        $read=Invoke-MigrationHelper $retainedHelper @('--credential-read','compatible','--binding',$binding)
        if ((Test-Path -LiteralPath $state) -or (Test-Path -LiteralPath $configuration) -or $read.exitCode -eq 0 -or $read.stdout.Length -ne 0) { throw 'The exact old canary reset is incomplete.' }
    } catch { $failures+=@($_.Exception.Message) }
    if ($failures.Count) { throw ($failures -join ' ') }
}
function Invoke-MigrationQuietUninstall([string]$SetupPath, [string]$Label) {
    $info = New-PreviewProcess $SetupPath @('-uninstall','-quiet','-norestart','-log',(Join-Path $output ($Label + '.log')))
    $clock=[Diagnostics.Stopwatch]::StartNew(); $child=[Diagnostics.Process]::Start($info); $script:MigrationInstallerOpen=$true
    try {
        if (-not $child.WaitForExit(180000)) { throw 'Windows uninstall did not complete; its live transaction was not killed.' }
        $script:MigrationInstallerOpen=$false
        if ($child.ExitCode -ne 0) { throw "Windows uninstall failed with status $($child.ExitCode)." }
        return @{elapsedMilliseconds=$clock.ElapsedMilliseconds;exitCode=$child.ExitCode}
    } finally { $child.Dispose() }
}
function Assert-MigrationPreparationNoop([string]$LogPath) {
    $logFile = Get-Item -LiteralPath $LogPath
    if ($logFile.PSIsContainer -or $logFile.Length -le 0 -or $logFile.Length -gt 1048576) { throw 'The migrated installer log is missing or exceeds its bound.' }
    $logText = Get-Content -LiteralPath $logFile.FullName -Raw
    $tiers = @([regex]::Matches($logText, 'MXC preparation tier: (base-container|appcontainer-dacl)(?:\r?\n|$)'))
    if ($tiers.Count -ne 1) { throw 'The migrated installer did not record one supported MXC preparation tier.' }
    $tier = $tiers[0].Groups[1].Value
    $helperExecutions = @([regex]::Matches($logText, 'Applying execute package: MxcSystemDrivePreparation'))
    $files = @(Get-ChildItem -LiteralPath ([IO.Path]::GetDirectoryName($LogPath)) -Filter ([IO.Path]::GetFileName($LogPath) + '.host-preparation-*.json') -File)
    if ($tier -ceq 'base-container') {
        if ($helperExecutions.Count -ne 0 -or $files.Count -ne 0) { throw 'BaseContainer migration unexpectedly invoked the AppContainer preparation helper.' }
        return @{tier=$tier;helperSkipped=$true;addedAces=0;writeCalls=0;elapsedMilliseconds=$null;sidecarSha256=$null}
    }
    if ($helperExecutions.Count -ne 1 -or $files.Count -ne 1 -or $files[0].Length -gt 8192) { throw 'The AppContainer migration did not retain its exact helper diagnostic.' }
    $detail = Get-Content -LiteralPath $files[0].FullName -Raw | ConvertFrom-Json
    if ($detail.classification -cne 'nemoclaw-host-preparation-diagnostic' -or $detail.operation -cne 'prepare-system-drive' -or
        $detail.status -cne 'succeeded' -or $detail.addedAces -ne 0 -or $detail.writeCalls -ne 0 -or
        $detail.attemptId -cnotmatch '^[a-f0-9]{32}$' -or $files[0].Name -cne ([IO.Path]::GetFileName($LogPath) + '.host-preparation-' + $detail.attemptId + '.json')) { throw 'The new installer did not prove a zero-write preparation on the already prepared root.' }
    return @{tier=$tier;helperSkipped=$false;addedAces=$detail.addedAces;writeCalls=$detail.writeCalls;elapsedMilliseconds=$detail.elapsedMilliseconds;sidecarSha256=(Get-FileHash -LiteralPath $files[0].FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
}
try {
    Assert-MigrationRegistrations ''
    Invoke-WebRequest -Uri $oldUrl -OutFile $oldSetup -TimeoutSec 180
    if ((Get-Item -LiteralPath $oldSetup).Length -ne 204621797 -or (Get-FileHash -LiteralPath $oldSetup -Algorithm SHA256).Hash.ToLowerInvariant() -cne $oldHash) { throw 'The anonymous previous-preview download differs from the pinned full artifact.' }
    foreach ($kind in @('conventional-reinstall','native-replace-preview')) {
        $caseRoot = Join-Path $output $kind; [void][IO.Directory]::CreateDirectory($caseRoot)
        $nonce=[guid]::NewGuid().ToString('N'); $canary='disposable-migration-key-'+$nonce; $endpoint='https://127.0.0.1:17193/migration-'+$nonce+'/v1'
        $newBinding=$null
        $case = [ordered]@{kind=$kind;oldAgent='openclaw';newAgent=$NewAgent;oldVersion='0.1.4';newVersion=$ProductVersion;oldInstall=$null;oldUninstall=$null;newInstall=$null;newUninstall=$null;preservedBeforeNewOnboarding=$false;preservedAfterSelectiveReset=$false;preparation=$null;resetVerified=$false}
        $report.cases+=@($case)
        $case.oldInstall = Invoke-PreviewUi -SetupPath $oldSetup -SetupSha256 $oldHash -Mode install -LogPath (Join-Path $caseRoot 'old-install.log') -Endpoint $endpoint -CanaryKey $canary
        Assert-MigrationRegistrations '0.1.4'
        $launcher=Join-Path $installation 'bin\NemoClaw.exe'; $retainedHelper=Join-Path $caseRoot 'retained-NemoClaw.exe'
        [IO.File]::Copy($launcher,$retainedHelper,$false)
        if ((Get-FileHash -LiteralPath $launcher -Algorithm SHA256).Hash -cne (Get-FileHash -LiteralPath $retainedHelper -Algorithm SHA256).Hash) { throw 'The retained canary helper differs from the installed old preview.' }
        $retainedHelperHash=(Get-FileHash -LiteralPath $retainedHelper -Algorithm SHA256).Hash.ToLowerInvariant()
        $case['retainedOldHelperSha256']=$retainedHelperHash
        $prepared=Invoke-MigrationHelper $launcher @('--configure-native','--prepare-all') (Get-Content -LiteralPath $configuration -Raw)
        if ($prepared.exitCode -ne 0) { throw 'The existing configuration bindings could not be inspected.' }
        $binding=($prepared.stdout | ConvertFrom-Json).inference
        if ($binding -cnotmatch '^[a-f0-9]{64}$') { throw 'The canary credential binding is invalid.' }
        $lease=Invoke-MigrationHelper $retainedHelper @('--state-session','openclaw')
        if ($lease.exitCode -ne 0) { throw 'The migration state owner could not open its exact agent root.' }
        $stateReceipt=$lease.stdout | ConvertFrom-Json
        if ($stateReceipt.stateRoot -cne $state -or $stateReceipt.agent -cne 'openclaw' -or $stateReceipt.leaseHeld -ne $true) { throw 'The migration state receipt names another root.' }
        $ownedCanary=$true; $marker=Join-Path $state ('migration-'+$nonce+'.txt')
        [IO.File]::WriteAllText($marker,'Disposable native migration state '+$nonce,[Text.UTF8Encoding]::new($false))
        $markerHash=(Get-FileHash -LiteralPath $marker -Algorithm SHA256).Hash.ToLowerInvariant(); $configHash=(Get-FileHash -LiteralPath $configuration -Algorithm SHA256).Hash.ToLowerInvariant()
        Assert-MigrationCanary $marker $markerHash $configHash $canary
        $afterRemoval = { Assert-MigrationRegistrations ''; Assert-MigrationCanary $marker $markerHash $configHash $canary; $case.preservedBeforeNewOnboarding=$true }
        $newLog=Join-Path $caseRoot 'new-install.log'
        if ($kind -ceq 'conventional-reinstall') {
            $case.oldUninstall=Invoke-MigrationQuietUninstall $oldSetup ($kind+'-old-uninstall')
            & $afterRemoval
            $case.newInstall=Invoke-PreviewUi -SetupPath $newSetup -SetupSha256 $newHash -Mode install -LogPath $newLog -Endpoint $endpoint -CanaryKey $canary -Agent $NewAgent
        } else {
            $case.newInstall=Invoke-PreviewUi -SetupPath $newSetup -SetupSha256 $newHash -Mode replace -LogPath $newLog -Endpoint $endpoint -CanaryKey $canary -AfterReplacement $afterRemoval -Agent $NewAgent
        }
        Assert-MigrationRegistrations $ProductVersion
        Assert-MigrationCanary $marker $markerHash $configHash $canary
        if (-not $case.preservedBeforeNewOnboarding -or $case.newInstall.installClicks -ne 1 -or $case.newInstall.configureClicks -ne 1) { throw 'The native migration did not preserve data before its single onboarding flow.' }
        $case.preparation=Assert-MigrationPreparationNoop $newLog
        $identity=Invoke-MigrationHelper (Join-Path $installation 'bin\NemoClaw.exe') @('--runtime-session',$NewAgent) "release`n"
        $leaseIdentity=$identity.stdout | ConvertFrom-Json
        $expected=Get-Content -LiteralPath (Join-Path $work 'assembled\runtime-identity.json') -Raw | ConvertFrom-Json
        if ($identity.exitCode -ne 0 -or $leaseIdentity.agent -cne $NewAgent -or $leaseIdentity.leaseHeld -ne $true -or $leaseIdentity.runtimeId -cne $expected.runtimeId -or $leaseIdentity.sourceRevision -cne $env:GITHUB_SHA) { throw 'The migrated installed runtime differs from the same-run selected-agent artifact.' }
        if ($NewAgent -cne 'openclaw') {
            $newConfigText=Get-Content -LiteralPath $newConfiguration -Raw
            $newConfig=$newConfigText | ConvertFrom-Json
            if ($newConfig.agent -cne $NewAgent) { throw 'The migrated configuration names another agent.' }
            $prepared=Invoke-MigrationHelper $launcher @('--configure-native','--prepare-all') $newConfigText
            if ($prepared.exitCode -ne 0) { throw 'The migrated agent binding could not be inspected.' }
            $newBinding=($prepared.stdout | ConvertFrom-Json).inference
            if ($newBinding -cnotmatch '^[a-f0-9]{64}$' -or $newBinding -ceq $binding) { throw 'The old and new agent credential bindings are not distinct.' }
            $newRead=Invoke-MigrationHelper $launcher @('--credential-read','compatible','--binding',$newBinding)
            if ($newRead.exitCode -ne 0 -or $newRead.stdout -cne $canary) { throw 'The migrated agent credential differs.' }
            $newLease=Invoke-MigrationHelper $launcher @('--state-session',$NewAgent)
            $newStateReceipt=$newLease.stdout | ConvertFrom-Json
            if ($newLease.exitCode -ne 0 -or $newStateReceipt.agent -cne $NewAgent -or $newStateReceipt.stateRoot -cne $newState -or $newStateReceipt.leaseHeld -ne $true) { throw 'The migrated agent state owner differs.' }
            [IO.File]::WriteAllText((Join-Path $newState ('migration-'+$nonce+'.txt')),'Disposable migrated agent state '+$nonce,[Text.UTF8Encoding]::new($false))
            $case['newAgentBindingVerified']=$true
        }
        $case.newUninstall=Invoke-PreviewUi -SetupPath $newSetup -SetupSha256 $newHash -Mode uninstall -LogPath (Join-Path $caseRoot 'new-uninstall.log') -RemoveAgentData -Agent $NewAgent
        Assert-MigrationRegistrations ''
        if ($NewAgent -cne 'openclaw') {
            $newRead=Invoke-MigrationHelper $retainedHelper @('--credential-read','compatible','--binding',$newBinding)
            if ((Test-Path -LiteralPath $newConfiguration) -or (Test-Path -LiteralPath $newState) -or $newRead.exitCode -eq 0 -or $newRead.stdout.Length -ne 0) { throw 'Selective agent reset retained its owned data or credential.' }
            Assert-MigrationCanary $marker $markerHash $configHash $canary
            $case.preservedAfterSelectiveReset=$true
            Remove-MigrationOldCanary
        }
        $read=Invoke-MigrationHelper $retainedHelper @('--credential-read','compatible','--binding',$binding)
        $case['resetObserved'] = @{installationRootExists=(Test-Path -LiteralPath $installation);configurationExists=(Test-Path -LiteralPath $configuration);stateRootExists=(Test-Path -LiteralPath $state);credentialReadExitCode=$read.exitCode;credentialOutputEmpty=($read.stdout.Length -eq 0)}
        if ($case.resetObserved.installationRootExists) { throw 'Native tester reset retained the installation root.' }
        if ($case.resetObserved.configurationExists) { throw 'Native tester reset retained the selected agent configuration.' }
        if ($case.resetObserved.stateRootExists) { throw 'Native tester reset retained the selected agent state root.' }
        if ($read.exitCode -eq 0 -or $read.stdout.Length -ne 0) { throw 'Native tester reset retained the selected canary key.' }
        $ownedCanary=$false; $binding=$null; $case.resetVerified=$true
    }
    $report.status='pass'
} catch { $primary=$_; $report['error']=$_.Exception.Message }
finally {
    foreach ($uiRecord in Get-ChildItem -LiteralPath $output -Recurse -Filter '*.ui.json' -File) {
        try { if ((Get-Content -LiteralPath $uiRecord.FullName -Raw | ConvertFrom-Json).cleanupClosed -ne $true) { $script:MigrationInstallerOpen=$true } } catch { $script:MigrationInstallerOpen=$true }
    }
    if ($script:MigrationInstallerOpen) { $report.cleanupErrors+=@('A live Windows installer transaction remains; no concurrent cleanup was attempted.') }
    $installedHelper=Join-Path $installation 'bin\NemoClaw.exe'
    if (-not $script:MigrationInstallerOpen -and (Test-Path -LiteralPath $installedHelper -PathType Leaf)) {
        if ($ownedCanary -and ($NewAgent -ceq 'openclaw' -or $case.preservedBeforeNewOnboarding)) {
            try {
                $cleanupResult=Invoke-MigrationHelper $installedHelper @('--remove-native-data','--agent',$NewAgent)
                if ($cleanupResult.exitCode -ne 0) { throw 'Installed owned-data cleanup failed.' }
            } catch { $report.cleanupErrors+=@($_.Exception.Message) }
        }
        try { $null=Invoke-MigrationQuietUninstall $newSetup 'cleanup-uninstall' }
        catch { $report.cleanupErrors+=@($_.Exception.Message) }
    }
    if (-not $script:MigrationInstallerOpen -and $ownedCanary -and $null -ne $retainedHelper -and (Test-Path -LiteralPath $retainedHelper)) {
        # These two commands execute directly in the native launcher and do not
        # require the removed installed runtime. Never use --remove-native-data
        # through a retained copy: it dispatches into the installed application.
        try { Remove-MigrationOldCanary }
        catch { $report.cleanupErrors+=@($_.Exception.Message) }
    }
    $report['installationRootRemoved']= -not(Test-Path -LiteralPath $installation)
    if ($report.cleanupErrors.Count -ne 0) { $report.status='failed' }
    [IO.File]::WriteAllText((Join-Path $output 'preview-migration.json'), ($report | ConvertTo-Json -Depth 9), [Text.UTF8Encoding]::new($false))
}
if ($null -ne $primary) { throw $primary }
if ($report.status -cne 'pass') { throw 'Migration cleanup did not finish.' }
