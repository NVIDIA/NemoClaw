# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ArtifactDirectory,
    [Parameter(Mandatory)][string]$HarnessNodePath,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{40}$')][string]$ControllerSha
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
if($env:GITHUB_ACTIONS -cne 'true' -or $env:OS -cne 'Windows_NT' -or $env:PROCESSOR_ARCHITECTURE -cne 'ARM64') {throw 'Profiling requires a disposable GitHub Windows ARM64 runner.'}
if(-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {throw 'The existing WPR/installer operations require the elevated runner token.'}
$root=[IO.Path]::GetFullPath($ArtifactDirectory)
$temporary=[IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\')+'\'
if(-not $root.StartsWith($temporary,[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $root)) {throw 'Profiling requires a fresh runner-owned output directory.'}
[IO.Directory]::CreateDirectory($root)|Out-Null
$baseline=Join-Path $root 'baseline'
[IO.Directory]::CreateDirectory($baseline)|Out-Null
$setup=Join-Path $baseline 'baseline-setup.exe'
$lock=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'profiling-baseline.lock.json') -Raw|ConvertFrom-Json
$installed=Join-Path $env:ProgramFiles 'NVIDIA\NemoClaw'
if(Test-Path -LiteralPath $installed) {throw 'The profiling runner already contains an installation.'}
$nodeHash=(Get-FileHash -LiteralPath $HarnessNodePath -Algorithm SHA256).Hash.ToLowerInvariant()
$expectedNode=@($lock.files|Where-Object {$_.path -ceq 'bin/node.exe'})
if($expectedNode.Count -ne 1 -or $nodeHash -cne $expectedNode[0].sha256) {throw 'The profiling controller Node does not match its immutable version/hash pin.'}
. (Join-Path $PSScriptRoot 'wpr-trace.ps1')
$summary=[ordered]@{schemaVersion=1;classification='f8-installed-baseline-profiling';controllerSource=$ControllerSha;baselineSource=$lock.source;beforeAfterComparison=$false;artifactAcceptanceClaimed=$false;liveTavilyTested=$false;pythonBytecode=$lock.pythonBytecode;status='failed';baselineInstallAttempted=$false;baselineUninstalled=$false;phase='wpr-smoke'}
$primary=$null
$cleanupErrors=[Collections.Generic.List[string]]::new()
$recordingFailures=[Collections.Generic.List[string]]::new()
function Write-ProfileJson {
    param([object]$Value,[string]$Path)
    [IO.File]::WriteAllText($Path,($Value|ConvertTo-Json -Depth 16)+"`n",[Text.UTF8Encoding]::new($false))
}
function Receive-ProfileBaseline {
    [CmdletBinding()]
    param([string]$Uri,[string]$Destination,[long]$ExpectedBytes)
    Add-Type -AssemblyName System.Net.Http
    $client=[Net.Http.HttpClient]::new()
    $client.Timeout=[TimeSpan]::FromSeconds(300)
    $cancel=[Threading.CancellationTokenSource]::new(300000)
    $response=$null;$stream=$null;$output=$null;$downloadFailure=$null
    try {
        $response=$client.GetAsync($Uri,[Net.Http.HttpCompletionOption]::ResponseHeadersRead,$cancel.Token).GetAwaiter().GetResult()
        $null=$response.EnsureSuccessStatusCode()
        if($null -ne $response.Content.Headers.ContentLength -and $response.Content.Headers.ContentLength -ne $ExpectedBytes){throw 'The baseline response length differs from its exact pin.'}
        $stream=$response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $output=[IO.File]::Open($Destination,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        $buffer=[byte[]]::new(65536);$total=[long]0
        while($true){
            $reading=$stream.ReadAsync($buffer,0,$buffer.Length,$cancel.Token)
            if(-not $reading.Wait(30000)){$cancel.Cancel();throw 'The bounded baseline download stalled.'}
            $count=$reading.GetAwaiter().GetResult()
            if($count -eq 0){break}
            $total+=$count
            if($total -gt $ExpectedBytes){throw 'The baseline download exceeded its exact byte bound.'}
            $output.Write($buffer,0,$count)
        }
        if($total -ne $ExpectedBytes){throw 'The baseline download ended before its exact byte count.'}
    } catch {$downloadFailure=$_}
    finally {
        foreach($resource in @($output,$stream,$response,$cancel,$client)) {
            if($null -ne $resource){try {$resource.Dispose()} catch {if($null -eq $downloadFailure){$downloadFailure=$_}else{Write-Warning 'The bounded download also failed resource cleanup.'}}}
        }
    }
    if($null -ne $downloadFailure){throw $downloadFailure}
}
function Invoke-ProfileCases {
    param([string]$Name,[object[]]$Cases,[bool]$UninstalledStart=$false)
    $plan=Join-Path $root ($Name+'-plan.json')
    Write-ProfileJson -Value ([ordered]@{schemaVersion=1;fixtureOnly=$true;requireUninstalledStart=$UninstalledStart;continueAfterTraceFailure=$true;cases=$Cases}) -Path $plan
    & (Join-Path $PSScriptRoot 'run-windows-measurement.ps1') -PlanPath $plan -HarnessNodePath $HarnessNodePath -HarnessNodeSha256 $nodeHash -ArtifactDirectory (Join-Path $root $Name)
    $result=Get-Content -LiteralPath (Join-Path (Join-Path $root $Name) 'measurement-summary.json') -Raw|ConvertFrom-Json
    if($result.status -ceq 'trace-failed'){$recordingFailures.Add($Name)}
}
try {
    $summary.phase='recorder-controls'
    & (Join-Path $PSScriptRoot 'test-recording-lifecycle.ps1') -ArtifactDirectory (Join-Path $root 'recorder-controls') -NodePath $HarnessNodePath
    $summary.phase='wpr-smoke'
    # Reject unsupported WPR profiles before downloading/installing the large baseline.
    $smoke=$null;$smokeFailure=$null
    try {$smoke=Start-WindowsPerformanceTrace -Directory (Join-Path $root 'wpr-smoke');Start-Sleep -Milliseconds 750;Update-WindowsPerformanceTraceBudget -Trace $smoke}
    catch {$smokeFailure=$_}
    finally {
        if($null -ne $smoke) {try {Stop-WindowsPerformanceTrace -Trace $smoke} catch {if($null -eq $smokeFailure){$smokeFailure=$_}else{Write-Warning 'The WPR smoke also failed cleanup.'}}}
    }
    if($null -ne $smokeFailure){throw $smokeFailure}
    $summary.phase='baseline-download'
    Receive-ProfileBaseline -Uri $lock.setup.url -Destination $setup -ExpectedBytes $lock.setup.bytes
    if((Get-Item -LiteralPath $setup).Attributes.HasFlag([IO.FileAttributes]::ReparsePoint) -or (Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash.ToLowerInvariant() -cne $lock.setup.sha256) {throw 'The exact f8 installer failed its immutable digest check.'}
    $summary.phase='baseline-install';$summary.baselineInstallAttempted=$true
    Invoke-ProfileCases -Name 'installation' -UninstalledStart $true -Cases @(
        [ordered]@{id='f8-install';variant='baseline';action='install';executable=$setup;sha256=$lock.setup.sha256;source=$lock.source;args=@('/install','/quiet','/norestart','/log',(Join-Path $baseline 'profile-install.log'));timeoutMs=900000;wpr=$true;wprInstallerLog=(Join-Path $baseline 'profile-install.log');observeProcess=$false;diagnostics=$false;sampleKind='instrumented-install';fixtureStateLabel='fresh disposable runner; installer warms filesystem caches';expectInstalled=$true}
    )
    foreach($payloadEntry in $lock.files) {
        $file=Join-Path $installed $payloadEntry.path
        $info=Get-Item -LiteralPath $file
        if($info.PSIsContainer -or $info.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint) -or $info.Length -ne $payloadEntry.bytes -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $payloadEntry.sha256) {throw 'An installed profiling baseline file differs from the exact f8 manifest.'}
    }
    $hostPrep=Join-Path $installed 'mxc\wxc-host-prep.exe'
    $hostPrepPin=@($lock.files|Where-Object {$_.path -ceq 'mxc/wxc-host-prep.exe'})[0]
    $drive=$env:SystemDrive+'\'
    $aclBefore=(Get-Acl -LiteralPath $drive).Sddl
    Write-ProfileJson -Value @{classification='system-drive-before-warm-reapply';sddl=$aclBefore} -Path (Join-Path $root 'host-prep-acl-before.json')
    $summary.phase='unchanged-host-prep-reapply'
    $cases=@()
    foreach($index in @(1,2)) {$cases += [ordered]@{id="system-drive-warm-$index";variant='baseline';action='prepare';executable=$hostPrep;sha256=$hostPrepPin.sha256;source=$lock.source;args=@('prepare-system-drive');timeoutMs=900000;wpr=$true;observeProcess=$true;diagnostics=$false;sampleKind='diagnostic-warm-reapply';fixtureStateLabel='exact baseline already applied; no ACL reset or API substitution';expectInstalled=$true}}
    try {Invoke-ProfileCases -Name 'host-preparation' -Cases $cases}
    finally {
        try {$aclAfter=(Get-Acl -LiteralPath $drive).Sddl;Write-ProfileJson -Value @{classification='system-drive-after-warm-reapply';sddl=$aclAfter;equalsBefore=($aclAfter -ceq $aclBefore)} -Path (Join-Path $root 'host-prep-acl-after.json')}
        catch {Write-Warning 'The post-reapply ACL snapshot could not be saved.'}
    }
    $summary.phase='installed-openclaw-dashboard'
    $node=Join-Path $installed 'bin\node.exe'
    $nodePin=@($lock.files|Where-Object {$_.path -ceq 'bin/node.exe'})[0]
    $driver=Join-Path $PSScriptRoot 'profile-installed-openclaw.mts'
    $driverFiles=@('profile-installed-openclaw.mts','profile-replay.mts','profiling-baseline.lock.json','measurement.mts')|ForEach-Object {$file=Join-Path $PSScriptRoot $_;[ordered]@{path=$file;sha256=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()}}
    $cases=@()
    foreach($mode in @('diagnostic','ordinary')) {
        $id='openclaw-'+$mode
        $directory=Join-Path (Join-Path (Join-Path $root 'openclaw') $id) 'driver'
        $cases += [ordered]@{id=$id;variant='baseline';action='launch';executable=$node;sha256=$nodePin.sha256;source=$lock.source;args=@('--experimental-strip-types','--no-warnings',$driver,$directory,$mode);driverFiles=@($driverFiles);timeoutMs=1350000;deadlineContract='f8-installed-openclaw-qualification';wpr=($mode -ceq 'diagnostic');observeProcess=($mode -ceq 'diagnostic');diagnostics=($mode -ceq 'diagnostic');sampleKind=$(if($mode -ceq 'diagnostic'){'explicitly-instrumented-replay'}else{'unaltered-installed-runner-after-successful-diagnostic'});fixtureStateLabel='deterministic contained provider, actual dashboard three-turn control, no external key';expectInstalled=$true}
    }
    $cases += [ordered]@{id='f8-post-timing-inventory';variant='baseline';action='inventory';root=$installed}
    Invoke-ProfileCases -Name 'openclaw' -Cases $cases
    $summary.status='collected'
    if($recordingFailures.Count -gt 0){throw 'One or more diagnostic recordings failed; successful target outcomes and later measurements are retained separately.'}
} catch {$primary=$_;$summary['error']=$_.Exception.Message}
finally {
    if($summary.baselineInstallAttempted) {
        try {
            & (Join-Path (Split-Path -Parent $PSScriptRoot) 'hermes\component-probe-baseline.ps1') -ArtifactDirectory $baseline -Uninstall
            $summary.baselineUninstalled=-not(Test-Path -LiteralPath $installed)
            if(-not $summary.baselineUninstalled){throw 'The profiling baseline remains installed.'}
        } catch {$cleanupErrors.Add('baseline uninstall');if($null -eq $primary){$primary=$_}else{Write-Warning 'The profiling baseline also failed uninstall.'}}
    }
    $summary['recordingFailures']=@($recordingFailures.ToArray())
    $summary['cleanupFailures']=@($cleanupErrors.ToArray())
    if($null -ne $primary){$summary.status='failed'}
    try {Write-ProfileJson -Value $summary -Path (Join-Path $root 'profiling-phase.json')}
    catch {if($null -eq $primary){$primary=$_}else{Write-Warning 'The profiling phase summary also could not be saved.'}}
}
if($null -ne $primary){throw $primary}
