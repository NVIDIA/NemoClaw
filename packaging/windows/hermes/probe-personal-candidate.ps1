# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
[CmdletBinding()]
param([Parameter(Mandatory)][string]$ArtifactDirectory,
    [Parameter(Mandatory)][string]$BootstrapDirectory,
    [Parameter(Mandatory)][string]$HelperDirectory,
    [string]$NativeCompatibilityDirectory = '',
    [string]$RustBinDirectory = '',
    [string]$PreparedHostRoot = '',
    [string]$PreparedSystemRootProof = '',
    [switch]$RecordStartup,
    [switch]$CaptureRendererContext,
    [switch]$ColdJobProbe,
    [switch]$RendererWer,
    [switch]$RendererPostmortem,
    [switch]$BrowserFirst)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:OS -cne 'Windows_NT') { throw 'This candidate test requires disposable Windows CI.' }
if ($BrowserFirst -and ($ColdJobProbe -or $RendererWer -or $RendererPostmortem -or $RecordStartup -or $CaptureRendererContext)) { throw 'Browser-first scheduling requires other diagnostic modes off.' }
if ($ColdJobProbe -and ($RecordStartup -or $CaptureRendererContext)) { throw 'The cold owned-job experiment cannot record startup or capture renderer context.' }
if ($RendererWer -and ($ColdJobProbe -or $RecordStartup -or $CaptureRendererContext)) { throw 'The renderer WER diagnostic must run without other diagnostic modes.' }
if ($RendererPostmortem -and ($RendererWer -or $ColdJobProbe -or $CaptureRendererContext)) { throw 'Postmortem capture requires WER-clone, cold-job and renderer-context modes off.' }
$nativeProduction = -not [string]::IsNullOrEmpty($NativeCompatibilityDirectory)
$reuseSystemRoot = -not [string]::IsNullOrEmpty($PreparedSystemRootProof)
if ($reuseSystemRoot -ne (-not [string]::IsNullOrEmpty($PreparedHostRoot)) -or ($reuseSystemRoot -and -not $nativeProduction)) {
    throw 'Prepared system-root reuse requires both same-run host and proof inputs for current native production.'
}
if ($nativeProduction -and ([string]::IsNullOrEmpty($RustBinDirectory) -or $BrowserFirst -or $ColdJobProbe -or $RendererWer -or $RendererPostmortem -or $CaptureRendererContext)) {
    throw 'Current native production requires its Rust tools and ordinary Personal qualification, without historical replay diagnostics.'
}
$output=[IO.Path]::GetFullPath($ArtifactDirectory)
if (Test-Path -LiteralPath $output) { throw 'The Personal evidence directory must be fresh.' }
$null=New-Item -ItemType Directory -Path $output
$downloads=Join-Path $output 'downloads'
$null=New-Item -ItemType Directory -Path $downloads
$root=[IO.Path]::GetPathRoot([Environment]::SystemDirectory)
$runtime=Join-Path $root $(if ($nativeProduction) { 'NemoClawHermesProbe-'+[guid]::NewGuid().ToString('N').Substring(0,12) } else { 'NemoClawHermesProbe-274d797050ea' })
$primary=$null;$mxcAttempted=$false;$runtimeOwned=$false;$faultWindowStart=$null;$buildAttempted=$false;$buildProcessesClosed=$true
$hostOwnerAttempted=$false;$hostOwnerClosed=$true
$classification=if($BrowserFirst){'canonical-personal-mxc-browser-first-diagnostic'}elseif($RendererPostmortem){'canonical-personal-mxc-postmortem-diagnostic'}elseif($RendererWer){'canonical-personal-mxc-renderer-wer-diagnostic'}elseif($ColdJobProbe){'canonical-personal-mxc-cold-job-diagnostic'}else{'canonical-personal-mxc-candidate-feasibility'}
$receipt=[ordered]@{schemaVersion=1;classification=$classification;sourceRevision=$env:GITHUB_SHA;diagnosticOnly=[bool]($BrowserFirst -or $ColdJobProbe -or $RendererWer -or $RendererPostmortem);browserFirst=[bool]$BrowserFirst;coldJobProbe=[bool]$ColdJobProbe;rendererWer=[bool]$RendererWer;rendererPostmortem=[bool]$RendererPostmortem;recordStartupRequested=[bool]$RecordStartup;
    candidateSource='8d78fe458e9268a7afdc8ed06b85c23306452036';artifactId=10293082661;status='failed';runtimeRebuilt=$false;runtimeExported=$false;
    installedAcceptance=$false;fullAgentQualified=$false;runtimeRoot=$runtime;cleanupErrors=@()}
$receipt['currentNativeProduction']=$nativeProduction
$receipt['workflowRunId']=$env:GITHUB_RUN_ID
$receipt['workflowRunAttempt']=$env:GITHUB_RUN_ATTEMPT
$receipt['replayInputSha256']=$null
function Invoke-PersonalChecked([string]$Executable,[string[]]$Arguments,[string]$Label) {
    $receipt['activeStage']=$Label
    Write-Host ('[Hermes Personal] '+$Label)
    & $Executable @Arguments 2>&1 | Tee-Object -FilePath (Join-Path $output (($Label -replace '[^a-zA-Z0-9-]','-')+'.log'))
    if ($LASTEXITCODE -ne 0) { throw ($Label+' failed with exit '+$LASTEXITCODE) }
}
function Confirm-PersonalPreparedSystemRoot([string]$PythonPath,[string]$HostRoot,[string]$ProofDirectory,
    [string]$HelperRoot,[string]$EvidenceDirectory,[string]$SystemRoot,[string]$SourceRoot) {
    $gatePath=Join-Path $EvidenceDirectory 'prepared-system-root-gate.json'
    Invoke-PersonalChecked $PythonPath @('-I',(Join-Path $SourceRoot 'packaging/windows/installer/verify-system-drive-proof.py'),
        '--helper',(Join-Path $HelperRoot 'NemoClawHostPreparation.exe'),
        '--build-receipt',(Join-Path $HelperRoot 'build-receipt.json'),
        '--proof-directory',$ProofDirectory,'--source-root',$sourceRoot,'--source-revision',$env:GITHUB_SHA,
        '--node-path',(Join-Path $HostRoot 'bin/node.exe'),'--host-payload-root',$HostRoot,
        '--output',$gatePath) 'Verify same-run prepared system root'
    $gate=Get-Content -LiteralPath $gatePath -Raw|ConvertFrom-Json
    $proofPath=Join-Path $ProofDirectory 'system-root-mxc-proof.json'
    $file=Get-Item -LiteralPath $proofPath -Force
    if ($file -isnot [IO.FileInfo] -or ($file.Attributes -band 0x400) -ne 0 -or $file.Length -gt 1048576) {
        throw 'The prepared system-root proof must remain bounded and ordinary.'
    }
    $bytes=[IO.File]::ReadAllBytes($proofPath)
    $hash=[Security.Cryptography.SHA256]::Create()
    try {$proofSha=([BitConverter]::ToString($hash.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose()}
    $proof=[Text.Encoding]::UTF8.GetString($bytes).TrimStart([char]0xfeff)|ConvertFrom-Json
    if ($env:GITHUB_SHA -cnotmatch '^[a-f0-9]{40}$' -or $env:GITHUB_RUN_ID -cnotmatch '^[1-9][0-9]*$' -or
        $env:GITHUB_RUN_ATTEMPT -cnotmatch '^[1-9][0-9]*$' -or
        $SystemRoot -cnotmatch '^[A-Za-z]:\\$' -or
        $gate.classification -cne 'same-job-system-drive-helper-build-gate' -or
        $gate.sourceRevision -cne $env:GITHUB_SHA -or $gate.proofSha256 -cne $proofSha -or
        $gate.sameJobHostAlreadyPrepared -isnot [bool] -or $gate.sameJobHostAlreadyPrepared -cne $true -or
        $gate.mxcInput.workflowRunId -cne $env:GITHUB_RUN_ID -or
        $gate.mxcInput.workflowRunAttempt -cne $env:GITHUB_RUN_ATTEMPT -or
        $proof.systemDriveRoot -cne $systemRoot -or [string]::IsNullOrEmpty($proof.rootSddlAfterMxc) -or
        (Get-Acl -LiteralPath $systemRoot).Sddl -cne $proof.rootSddlAfterMxc) {
        throw 'The verified prepared system root no longer matches this source, run or drive permissions.'
    }
    return [ordered]@{classification='same-run-prepared-system-root-reuse';proofSha256=$proofSha;
        gateSha256=(Get-FileHash -LiteralPath $gatePath -Algorithm SHA256).Hash.ToLowerInvariant();
        systemDriveRoot=$systemRoot;rootPermissionsUnchanged=$true;installedAcceptance=$false}
}
function New-PersonalNativeBuildCommand([string]$DeveloperCommand,[string]$PowerShellPath,[string]$ScriptPath,
    [string]$RuntimeRoot,[string]$ArtifactDirectory,[string]$ControllerSource,[string]$InputFile,[object]$Toolchain) {
    if ($ControllerSource -cnotmatch '^[a-f0-9]{40}$' -or
        $Toolchain.msvcToolset -cnotmatch '^\d+\.\d+\.\d+$' -or
        $Toolchain.windowsSdk -cnotmatch '^\d+\.\d+\.\d+\.\d+$' -or
        $Toolchain.msvcHost -cne 'arm64' -or $Toolchain.msvcTarget -cne 'arm64') {
        throw 'The Personal build requires the pinned native ARM64 toolchain.'
    }
    foreach ($value in @($DeveloperCommand,$PowerShellPath,$ScriptPath,$RuntimeRoot,$ArtifactDirectory,$InputFile)) {
        if ([string]::IsNullOrWhiteSpace($value) -or $value -match '["\r\n%!]') {
            throw 'A Personal build path cannot be represented safely.'
        }
    }
    # VsDevCmd and the build must share a child environment; earlier CI steps do not persist it.
    return ('call "'+$DeveloperCommand+'" -arch=arm64 -host_arch=arm64 -vcvars_ver='+$Toolchain.msvcToolset+
        ' -winsdk='+$Toolchain.windowsSdk+' && "'+$PowerShellPath+'" -NoProfile -NonInteractive -File "'+$ScriptPath+
        '" -RuntimeRoot "'+$RuntimeRoot+'" -ArtifactDirectory "'+$ArtifactDirectory+'" -ControllerSource "'+$ControllerSource+
        '" -InputFile "'+$InputFile+'"')
}
function Test-PersonalRuntimeRemoval([object]$Completed,[string]$Runtime,[string]$SourceRevision) {
    # Failure of the workload is separate from closure of everything using its runtime.
    # Never accept a legacy, foreign or partially written receipt as cleanup authority.
    try {
        if ($SourceRevision -cnotmatch '^[a-f0-9]{40}$' -or
            ($Completed.schemaVersion -isnot [long] -and $Completed.schemaVersion -isnot [int]) -or
            $Completed.schemaVersion -ne 2 -or
            $Completed.classification -cne 'canonical-personal-mxc-feasibility' -or
            $Completed.sourceRevision -cne $SourceRevision -or $Completed.runtime -cne $Runtime) { return $false }
        foreach ($field in @('executorAttempted','rootsRetainedForUnclosedExecutor')) {
            if ($Completed.$field -isnot [bool]) { return $false }
        }
        if ($Completed.rootsRetainedForUnclosedExecutor) { return $false }
        foreach ($field in @('hostDiagnosticChildrenClosed','ownedRootsRemoved','nativeStateComplete')) {
            if ($Completed.cleanup.$field -isnot [bool] -or $Completed.cleanup.$field -cne $true) { return $false }
        }
        if ($Completed.executorAttempted) {
            foreach ($field in @('executorClosed','nativeTeardownVerified','hostDesktopsReleased')) {
                if ($Completed.cleanup.$field -isnot [bool] -or $Completed.cleanup.$field -cne $true) { return $false }
            }
        }
        return $true
    } catch { return $false }
}
function Get-PersonalChromeFaultEvents([string]$ChromePath,[datetime]$StartUtc,[datetime]$EndUtc) {
    $ChromePath=$ChromePath.Replace('/','\')
    $result=[ordered]@{schemaVersion=1;classification='readonly-owned-Chrome-fault-events';sourceRevision=$env:GITHUB_SHA;chromePath=$ChromePath;
        startUtc=$StartUtc.ToUniversalTime().ToString('o');endUtc=$EndUtc.ToUniversalTime().ToString('o');
        maximumEventsPerProvider=64;windowObservationOnly=$true;rawMessagesRetained=$false;queries=@();events=@();errors=@()}
    if($EndUtc -lt $StartUtc -or ($EndUtc-$StartUtc).TotalMinutes -gt 30){throw 'Chrome event observation window exceeds its bound.'}
    $reports=@{};$pending=@()
    foreach($spec in @(@('Application Error',1000),@('Windows Error Reporting',1001))) {
        $query=[ordered]@{provider=$spec[0];eventId=$spec[1];recordsRead=0;recordsDisposed=0;limitReached=$false;error=$null}
        try {
            $events=@(Get-WinEvent -FilterHashtable @{LogName='Application';ProviderName=$spec[0];Id=$spec[1];StartTime=$StartUtc;EndTime=$EndUtc} -MaxEvents 64 -ErrorAction Stop)
            $query.recordsRead=$events.Count;$query.limitReached=$events.Count -eq 64
            foreach($event in $events) {
                try {
                    $text=$event.ToXml()
                    if($text.Length -gt 65536){throw 'Event XML exceeds its read bound.'}
                    $settings=[Xml.XmlReaderSettings]::new();$settings.DtdProcessing=[Xml.DtdProcessing]::Prohibit;$settings.XmlResolver=$null
                    $reader=[Xml.XmlReader]::Create([IO.StringReader]::new($text),$settings)
                    $doc=[Xml.XmlDocument]::new();$doc.XmlResolver=$null
                    try{$doc.Load($reader)}finally{$reader.Dispose()}
                    $ns=[Xml.XmlNamespaceManager]::new($doc.NameTable);$ns.AddNamespace('e','http://schemas.microsoft.com/win/2004/08/events/event')
                    $system=$doc.SelectSingleNode('/e:Event/e:System',$ns)
                    $provider=$system.SelectSingleNode('e:Provider',$ns).GetAttribute('Name')
                    $id=[int]$system.SelectSingleNode('e:EventID',$ns).InnerText
                    $time=[datetime]::Parse($system.SelectSingleNode('e:TimeCreated',$ns).GetAttribute('SystemTime')).ToUniversalTime()
                    if($provider -cne $spec[0] -or $id -ne $spec[1] -or $time -lt $StartUtc -or $time -gt $EndUtc){throw 'Event provider/time differs from the bounded query.'}
                    $data=@{}
                    foreach($node in $doc.SelectNodes('/e:Event/e:EventData/e:Data',$ns)) {
                        $name=$node.GetAttribute('Name');if(-not $name){continue}
                        if($data.ContainsKey($name)){throw 'Event contains duplicate named data.'}
                        $data[$name]=$node.InnerText
                    }
                    $recordId=[long]$system.SelectSingleNode('e:EventRecordID',$ns).InnerText
                    if($id -eq 1000) {
                        if(-not $data.ContainsKey('AppPath') -or -not [string]::Equals($data.AppPath,$ChromePath,[StringComparison]::OrdinalIgnoreCase)){continue}
                        $fields=@{}
                        foreach($name in @('AppName','AppVersion','AppTimeStamp','ModuleName','ModuleVersion','ModuleTimeStamp','ExceptionCode','FaultingOffset','ProcessId','ProcessCreationTime','AppPath','ModulePath','IntegratorReportId')) {
                            if($data.ContainsKey($name)) {if($data[$name].Length -gt 512){throw 'Selected fault field exceeds its bound.'};$fields[$name]=$data[$name]}
                        }
                        $row=@{provider=$provider;eventId=$id;recordId=$recordId;timeUtc=$time.ToString('o');match='exact-canonical-Chrome-AppPath';fields=$fields}
                        $result.events+=@($row)
                        $reportId=$data['IntegratorReportId']
                        if($reportId -and $reportId -match '^[0-9a-fA-F-]{36}$' -and $reportId -ne '00000000-0000-0000-0000-000000000000'){
                            if($reports.ContainsKey($reportId)){$reports[$reportId]=$null}else{$reports[$reportId]=$row}
                        }
                    } else {
                        # WER1001 often has no AppPath. Only retain it through an exact
                        # report-ID link to an already matched Application Error row.
                        $reportId=$data['ReportId'];$eventName=$data['EventName']
                        if($reportId -and $reportId.Length -le 64 -and $eventName -and $eventName.Length -le 128){
                            $pending+=@(@{provider=$provider;eventId=$id;recordId=$recordId;timeUtc=$time.ToString('o');reportId=$reportId;eventName=$eventName})
                        }
                    }
                } catch {$result.errors+=@(@{provider=$spec[0];error=$_.Exception.Message.Substring(0,[Math]::Min(256,$_.Exception.Message.Length))})}
                finally{try{$event.Dispose();$query.recordsDisposed++}catch{$result.errors+=@(@{provider=$spec[0];error='Event record disposal failed.'})}}
            }
        } catch {
            if($_.FullyQualifiedErrorId -notlike 'NoMatchingEventsFound*'){$query.error=$_.Exception.Message.Substring(0,[Math]::Min(256,$_.Exception.Message.Length))}
        }
        $result.queries+=@($query)
    }
    $unlinked=0
    foreach($row in $pending){
        if($reports.ContainsKey($row.reportId) -and $null -ne $reports[$row.reportId]){
            $row['match']='report-ID-linked-to-exact-Chrome-AppPath';$row['applicationErrorRecordId']=$reports[$row.reportId].recordId;$result.events+=@($row)
        }else{$unlinked++}
    }
    $result['unlinkedWerCandidatesOmitted']=$unlinked
    return $result
}

function Get-PersonalRuntimeAclObservation([string]$Runtime,[string]$CandidateSha256,[string]$ReplaySha256) {
    $clock=[Diagnostics.Stopwatch]::StartNew()
    $result=[ordered]@{schemaVersion=1;classification='readonly-canonical-runtime-acl-observation';sourceRevision=$env:GITHUB_SHA;
        runtimeRoot=$Runtime;candidateReceiptSha256=$CandidateSha256;replayInputSha256=$ReplaySha256;
        observedBeforePrimary=$true;maximumEntries=7;contentRead=$false;aclWriteAttempted=$false;
        requestedSections='Owner,Group,Access (READ_CONTROL; no SACL)';requiredMxcReadonlyMask='0x001200a9';
        mxcSkipDecisionObserved=$false;eventPidPathAttributionEstablished=$false;entries=@()}
    # Fixed paths from the already verified complete canonical inventory; no tree walk.
    foreach($relative in @('','hermes-agent/venv/Scripts/python.exe','tools/browser-use/Scripts/python.exe',
        'browsers/chromium-1234/chrome-win64/chrome.exe','agent-browser/bin/agent-browser-win32-x64.exe',
        'git/usr/bin/bash.exe','node/node.exe')) {
        $path=if($relative){Join-Path $Runtime $relative}else{$Runtime}
        $row=[ordered]@{relativePath=$relative;path=$path;readSucceeded=$false;error=$null}
        try {
            $item=Get-Item -LiteralPath $path -Force
            if($item.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)){throw 'ACL observation target is a reparse point.'}
            $row['kind']=if($item.PSIsContainer){'directory'}else{'file'}
            $row['attributes']=[int]$item.Attributes
            $acl=Get-Acl -LiteralPath $path
            $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
            if($rules.Count -gt 128 -or $acl.GetSecurityDescriptorBinaryForm().Length -gt 32768){throw 'ACL observation exceeds its descriptor/ACE bound.'}
            $row['ownerSid']=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
            $row['groupSid']=$acl.GetGroup([Security.Principal.SecurityIdentifier]).Value
            $row['daclSddl']=$acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
            $row['accessRulesProtected']=$acl.AreAccessRulesProtected
            $row['accessRulesCanonical']=$acl.AreAccessRulesCanonical
            $row['aces']=@($rules|ForEach-Object {@{sid=$_.IdentityReference.Value;type=$_.AccessControlType.ToString();
                mask=('0x{0:x8}' -f ([int64]$_.FileSystemRights -band 0xffffffffL));inherited=$_.IsInherited;
                inheritanceFlags=$_.InheritanceFlags.ToString();propagationFlags=$_.PropagationFlags.ToString()}})
            $row.readSucceeded=$true
        } catch {$row.error=$_.Exception.Message}
        $result.entries+=@($row)
    }
    $result['elapsedMs']=$clock.Elapsed.TotalMilliseconds
    return $result
}
try {
    $bootstrap=Get-Content -LiteralPath (Join-Path $BootstrapDirectory 'export-controls.json') -Raw|ConvertFrom-Json
    if ($bootstrap.status -cne 'pass') { throw 'Pinned interpreter/bootstrap controls did not pass.' }
    $python=[string]$bootstrap.pythonPath
    $node=Join-Path $BootstrapDirectory 'tools\node\node-v22.23.2-win-arm64\node.exe'
    foreach($pin in @(@($python,'54e17da389d3aae8c56b08a06fea5cd2f5acd57d2a7acb4061fc572964d4108b'),@($node,'97cce5301a815d2dce07ac5bfd1e6039eae88185ec1d10ae4f8cb712f1732878'))) {
        if ((Get-FileHash -LiteralPath $pin[0] -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pin[1]) { throw 'A bootstrap interpreter changed after archive verification.' }
    }
    $receipt['bootstrapPythonSha256']=$bootstrap.pythonSha256
    $receipt['bootstrapNodeSha256']='97cce5301a815d2dce07ac5bfd1e6039eae88185ec1d10ae4f8cb712f1732878'
    if ($nativeProduction) {
        $previousTestPython=$env:NEMOCLAW_TEST_PYTHON
        try {
            $env:NEMOCLAW_TEST_PYTHON=$python
            Invoke-PersonalChecked $node @('--experimental-strip-types','--no-warnings','--test',
                (Join-Path $PSScriptRoot 'personal-native-state.test.mts')) 'Native state ownership controls'
        } finally {$env:NEMOCLAW_TEST_PYTHON=$previousTestPython}
        $receipt.candidateSource='8f54e647a1cda1c3c879ad4e350700a13bb8fc2e'
        $receipt.artifactId=11995339173
        $compatEvidence=[IO.Path]::GetFullPath($NativeCompatibilityDirectory)
        $proof=Get-Content -LiteralPath (Join-Path $compatEvidence 'result.json') -Raw|ConvertFrom-Json
        $runner=Get-Content -LiteralPath (Join-Path $compatEvidence 'runner-result.json') -Raw|ConvertFrom-Json
        if ($proof.schemaVersion -ne 2 -or $proof.classification -cne 'small-msys-native-basecontainer-compatibility-proof' -or
            $proof.sourceRevision -cne $env:GITHUB_SHA -or $proof.passed -cne $true -or $proof.normalCleanup -cne $true -or
            $runner.sourceRevision -cne $env:GITHUB_SHA -or $runner.status -cne 'pass' -or
            $runner.cleanup.workRootRemoved -cne $true -or $runner.cleanup.workRetainedForUnconfirmedExecutor -cne $false) {
            throw 'Current Personal production requires this source native Bash proof and closed producer.'
        }
        $sourceLock=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'official-components.lock.json') -Raw|ConvertFrom-Json
        $sourceInputs=@($sourceLock.artifacts|Where-Object {$_.id -ceq 'hermes-source'})
        if ($sourceInputs.Count -ne 1 -or $sourceInputs[0].sha256 -cne 'c1f2401c8096e9372c46fa4ef8bdada18ed3cc84c0f5274562b86b7646ed3a87' -or
            $sourceInputs[0].size -ne 69242564 -or
            $sourceInputs[0].url -cne 'https://codeload.github.com/NousResearch/hermes-agent/tar.gz/2237be355906fbe6065ce1815711eee52b2d646e') { throw 'Current source download identity differs.' }
        $sourceArchive=Join-Path $downloads 'hermes-source.tar.gz'
        Invoke-WebRequest -Uri $sourceInputs[0].url -OutFile $sourceArchive -TimeoutSec 120
        $baseZip=Join-Path $downloads 'current-base.zip'
        $verification=Join-Path $output 'base-verification'
        try {
            Invoke-PersonalChecked $python @('-I','-B',(Join-Path $PSScriptRoot 'verify-personal-candidate.py'),
                '--zip',$baseZip,'--output',$verification,'--runtime-root',$runtime,'--source-archive',$sourceArchive) 'Verify and extract complete current base'
        } finally {
            Remove-Item Env:GH_TOKEN -ErrorAction SilentlyContinue
            $ownershipFile=Join-Path $verification 'runtime-ownership.json'
            if (Test-Path -LiteralPath $ownershipFile) {
                $ownership=Get-Content -LiteralPath $ownershipFile -Raw|ConvertFrom-Json
                $runtimeOwned=$ownership.schemaVersion -eq 1 -and $ownership.classification -ceq 'verified-current-Hermes-base-extraction' -and
                    $ownership.controllerSource -ceq $env:GITHUB_SHA -and $ownership.runtimeRoot -ceq $runtime -and
                    $ownership.createdByExtraction -is [bool] -and $ownership.createdByExtraction -ceq $true -and
                    $ownership.baseSource -ceq $receipt.candidateSource -and $ownership.baseZipSha256 -ceq 'bd59f69d7bba8177239f3d0028de493c55be814c0ee206fff796db08ab941390'
            }
        }
        if (-not $runtimeOwned) { throw 'Current base extraction ownership is not confirmed.' }
        $extraction=Get-Content -LiteralPath (Join-Path $verification 'extraction.json') -Raw|ConvertFrom-Json
        $original=[string]$extraction.originalBuildRoot
        if ($extraction.controllerSource -cne $env:GITHUB_SHA -or $extraction.runtimeRoot -cne $runtime -or
            $extraction.allFilesRehashed -cne $true -or $extraction.allLinksContained -cne $true -or
            $original -cne 'C:\NemoClawHermesProbe-5804d8b1dcca' -or (Test-Path -LiteralPath $original)) { throw 'Current base extraction identity differs.' }
        $reuseInput=Join-Path $output 'current-base-reuse-inputs.json'
        $reuse=@{bootstrapPython=$python;bootstrapNode=$node;sourceArchive=$sourceArchive;baseZip=$baseZip;
            originalBuildRoot=$original;rustBinDirectory=[IO.Path]::GetFullPath($RustBinDirectory);compatibilityEvidence=$compatEvidence}
        [IO.File]::WriteAllText($reuseInput,($reuse|ConvertTo-Json -Depth 4)+"`n",[Text.UTF8Encoding]::new($false))
        $vswhere=Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
        $developerCommands=@(& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.ARM64 -find 'Common7\Tools\VsDevCmd.bat')
        if ($LASTEXITCODE -ne 0 -or $developerCommands.Count -ne 1 -or -not (Test-Path -LiteralPath $developerCommands[0] -PathType Leaf)) {
            throw 'The Personal build requires one installed Visual Studio ARM64 developer environment.'
        }
        $toolchain=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'official-python.lock.json') -Raw|ConvertFrom-Json
        $buildCommand=New-PersonalNativeBuildCommand -DeveloperCommand $developerCommands[0] -PowerShellPath (Join-Path $PSHOME 'pwsh.exe') `
            -ScriptPath (Join-Path $PSScriptRoot 'prepare-reused-runtime.ps1') -RuntimeRoot $runtime `
            -ArtifactDirectory (Join-Path $output 'current-base') -ControllerSource $env:GITHUB_SHA -InputFile $reuseInput -Toolchain $toolchain
        $buildAttempted=$true;$buildProcessesClosed=$false
        try {
            & "$env:SystemRoot\System32\cmd.exe" /d /v:off /c $buildCommand
            if ($LASTEXITCODE -ne 0) { throw 'The pinned native Personal runtime build failed; output retained.' }
        } finally {
            $phaseFile=Join-Path $output 'official-hermes-runtime-phase.json'
            if (Test-Path -LiteralPath $phaseFile) {
                $phase=Get-Content -LiteralPath $phaseFile -Raw|ConvertFrom-Json
                $buildProcessesClosed=$phase.schemaVersion -eq 1 -and $phase.classification -ceq 'official-hermes-runtime-build-phase' -and
                    $phase.controllerSource -ceq $env:GITHUB_SHA -and $phase.runtimeRoot -ceq $runtime -and
                    $phase.buildProcessesClosed -is [bool] -and $phase.buildProcessesClosed -ceq $true
            }
        }
        if (-not $buildProcessesClosed -or $phase.status -cne 'candidate-bytes-exported-unqualified') { throw 'Current runtime build did not complete and close.' }
        $candidate=Join-Path $output 'official-hermes-runtime-candidate'
        $receipt.runtimeRebuilt=$true;$receipt.runtimeExported=$true
        $receipt['originalFullStagesReexecuted']=$false
        $receipt['compatibilityProofSource']=$env:GITHUB_SHA
        $receipt['originalBuildRoot']=$original
        $receipt['originalBuildRootAbsent']=$true
    } else {
        $candidate=Join-Path $output 'verification'
        Invoke-PersonalChecked $python @('-I',(Join-Path $PSScriptRoot 'replay-personal-runtime.py'),
            '--zip',(Join-Path $downloads 'candidate.zip'),'--output',$candidate,'--runtime-root',$runtime) 'Verify and place complete immutable runtime'
        $ownership=Get-Content -LiteralPath (Join-Path $candidate 'runtime-ownership.json') -Raw|ConvertFrom-Json
        if($ownership.runtimeRoot -cne $runtime -or $ownership.createdByReplay -cne $true){throw 'Completed replay extraction ownership is not confirmed.'}
        $runtimeOwned=$true
        $derivation=Get-Content -LiteralPath (Join-Path $candidate 'candidate-derivation.json') -Raw|ConvertFrom-Json
        $original=[string]$derivation.originalBuildRoot
        if($original -ceq $runtime -or (Test-Path -LiteralPath $original)){throw 'The original pre-adaptation root must remain absent.'}
        $receipt['originalBuildRoot']=$original
        $receipt['originalBuildRootAbsent']=$true
        $receipt['replayInputSha256']=(Get-FileHash -LiteralPath (Join-Path $candidate 'replay-input.json') -Algorithm SHA256).Hash.ToLowerInvariant()
        $compatZip=Join-Path $downloads 'passed-bash-compatibility.zip'
        $headers=@{Authorization=('Bearer '+$env:GH_TOKEN);Accept='application/vnd.github+json'}
        Invoke-WebRequest -Uri 'https://api.github.com/repos/NVIDIA/NemoClaw/actions/artifacts/10310050928/zip' -Headers $headers -OutFile $compatZip -TimeoutSec 120
        if((Get-Item -LiteralPath $compatZip).Length -ne 11333076 -or (Get-FileHash -LiteralPath $compatZip -Algorithm SHA256).Hash.ToLowerInvariant() -cne '4d191b31060dacbc582678e026da5799cfe3d0574c39bd882684fc4863c5c4ad'){throw 'The passed Bash artifact changed.'}
        $compatExtract=Join-Path $downloads 'passed-bash'
        $zip=[IO.Compression.ZipFile]::OpenRead($compatZip)
        try{
            if($zip.Entries.Count -ne 100 -or ($zip.Entries|Measure-Object -Property Length -Sum).Sum -ne 34636106){throw 'The passed Bash archive layout changed.'}
            foreach($entry in $zip.Entries){
                $target=[IO.Path]::GetFullPath((Join-Path $compatExtract $entry.FullName))
                if(-not $target.StartsWith($compatExtract+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'The passed Bash archive path escapes its owned output.'}
            }
        }finally{$zip.Dispose()}
        Expand-Archive -LiteralPath $compatZip -DestinationPath $compatExtract
        $compatEvidence=Join-Path $compatExtract 'bash-compat-evidence'
        Remove-Item Env:GH_TOKEN -ErrorAction SilentlyContinue
        $receipt['compatibilityProofSource']='c830cd3ef8315ff46a7ebfcd3c0b2afefd152a4a'
    }
    $receipt['derivedCandidateReceiptSha256']=(Get-FileHash -LiteralPath (Join-Path $candidate 'runtime-candidate.json') -Algorithm SHA256).Hash.ToLowerInvariant()
    $receipt['completeBaseReused']=$true
    $sdk=Join-Path $downloads 'mxc-sdk.tgz'
    Invoke-WebRequest -Uri 'https://registry.npmjs.org/@microsoft/mxc-sdk/-/mxc-sdk-0.8.0.tgz' -OutFile $sdk -TimeoutSec 60
    if((Get-FileHash -LiteralPath $sdk -Algorithm SHA256).Hash.ToLowerInvariant() -cne '06bb2399d7e98ab1907acf851e12a4e44748dd467b79d3e53c2f2fbf569da14e'){throw 'The MXC SDK differs from the exact archive.'}
    Invoke-PersonalChecked (Join-Path ([Environment]::SystemDirectory) 'tar.exe') @('-xzf',$sdk,'-C',$downloads,'package/bin/arm64/wxc-exec.exe','package/bin/arm64/wxc-host-prep.exe') 'Pinned MXC extraction'
    $mxc=Join-Path $downloads 'package\bin\arm64'
    if ($reuseSystemRoot) {
        # The finished builder already owns the fresh-write and no-op proof on this host.
        $receipt['systemRootPreparation']=Confirm-PersonalPreparedSystemRoot $python $PreparedHostRoot $PreparedSystemRootProof $HelperDirectory $output $root ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..')))
    } else {
        & (Join-Path $PSScriptRoot '..\host-preparation\test-system-root-mxc.ps1') -HelperPath (Join-Path $HelperDirectory 'NemoClawHostPreparation.exe') -MxcDirectory $mxc -NodePath $node -ArtifactDirectory (Join-Path $output 'system-root-proof')
        $systemProof=Get-Content -LiteralPath (Join-Path $output 'system-root-proof\system-root-mxc-proof.json') -Raw|ConvertFrom-Json
        if($systemProof.status -cne 'pass'){throw 'The same-run system-root/MXC proof failed.'}
    }
    # Observe only metadata before the timed primary workload; failures stay secondary.
    try {
        $aclObservation=Get-PersonalRuntimeAclObservation $runtime $receipt.derivedCandidateReceiptSha256 $receipt.replayInputSha256
        $aclPath=Join-Path $output 'runtime-acl-observation.json'
        [IO.File]::WriteAllText($aclPath,($aclObservation|ConvertTo-Json -Depth 10)+"`n",[Text.UTF8Encoding]::new($false))
        $receipt['runtimeAclObservation']=@{file='runtime-acl-observation.json';bytes=(Get-Item -LiteralPath $aclPath).Length;sha256=(Get-FileHash -LiteralPath $aclPath -Algorithm SHA256).Hash.ToLowerInvariant()}
    } catch {$receipt['runtimeAclObservationError']=$_.Exception.Message}
    $faultWindowStart=[DateTime]::UtcNow
    $patchedMxc=Join-Path $compatEvidence 'mxc-token-inspection-build'
    $compatibilityRoot=if ($nativeProduction) { Join-Path $runtime 'mxc-compat' } else { Join-Path $compatEvidence 'compatibility-build' }
    $personalArguments = @('--experimental-strip-types','--no-warnings',(Join-Path $PSScriptRoot 'probe-personal-candidate.mts'),
        '--runtime-root',$runtime,'--mxc',(Join-Path $patchedMxc 'wxc-exec.exe'),'--stock-mxc',(Join-Path $mxc 'wxc-exec.exe'),'--host-controller-python',$python,'--wpr-powershell',(Join-Path $PSHOME 'pwsh.exe'),'--output',(Join-Path $output 'personal-mxc'),
        '--compatibility-root',$compatibilityRoot,'--compatibility-receipt',(Join-Path $compatibilityRoot 'build-receipt.json'),
        '--compatibility-proof',(Join-Path $compatEvidence 'result.json'),'--mxc-build-receipt',(Join-Path $patchedMxc 'mxc-token-inspection-build.json'),
        '--derived-runtime-receipt',(Join-Path $candidate 'runtime-candidate.json'))
    if ($nativeProduction) { $personalArguments += @('--state-owner-build',(Join-Path $output 'state-owner-build.json')) }
    if (-not $nativeProduction) { $personalArguments += @('--replay-receipt',(Join-Path $candidate 'replay-input.json')) }
    if ($RendererWer) {
        $receipt['activeStage']='Build out-of-process renderer diagnostic'
        Write-Host '[Hermes Personal] Build out-of-process renderer diagnostic'
        $compatBuildReceipt=Join-Path $compatEvidence 'compatibility-build/build-receipt.json'
        & (Join-Path $PSScriptRoot 'build-renderer-wer-observer.ps1') -SourceRoot ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))) -Directory $output `
            -CompatibilityReceipt $compatBuildReceipt -CompatibilitySourceRevision $receipt.compatibilityProofSource `
            -CompatibilityReceiptSha256 ((Get-FileHash -LiteralPath $compatBuildReceipt -Algorithm SHA256).Hash.ToLowerInvariant())
        $personalArguments += @('--renderer-wer-build',(Join-Path $output 'renderer-wer-observer/build-receipt.json'))
    }
    if ($CaptureRendererContext) {
        # Build only this optional diagnostic; current native proof/runtime remain unchanged.
        $contextBuild=Join-Path $output 'renderer-context-helper/build-receipt.json'
        $compatBuildReceipt=Join-Path $compatEvidence 'compatibility-build/build-receipt.json'
        try {
            & (Join-Path $PSScriptRoot 'build-renderer-context-helper.ps1') -SourceRoot ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))) -Directory $output `
                -CompatibilityReceipt $compatBuildReceipt -CompatibilitySourceRevision $receipt.compatibilityProofSource `
                -CompatibilityReceiptSha256 ((Get-FileHash -LiteralPath $compatBuildReceipt -Algorithm SHA256).Hash.ToLowerInvariant())
        } catch { $receipt['rendererContextBuildError']=$_.Exception.Message }
        # Unknown compiler/capture lifetime is not a safe successor boundary.
        if (-not (Test-Path -LiteralPath $contextBuild)) { throw 'Renderer context build did not retain its ownership receipt.' }
        $contextReceipt=Get-Content -LiteralPath $contextBuild -Raw | ConvertFrom-Json
        if (@($contextReceipt.cleanupErrors).Count -ne 0 -or @($contextReceipt.diagnostics | Where-Object { $_.closed -ne $true -or $_.captureClosed -ne $true }).Count -ne 0) {
            throw 'Renderer context compiler ownership did not close.'
        }
        $personalArguments += @('--renderer-context-build',$contextBuild)
    }
    if ($RecordStartup) { $personalArguments += '--record-startup' }
    if ($BrowserFirst) { $personalArguments += '--browser-first' }
    if ($ColdJobProbe) { $personalArguments += '--cold-job-probe' }
    if ($RendererPostmortem) { $personalArguments += '--renderer-postmortem' }
    $mxcAttempted=$true
    if ($nativeProduction) {
        $hostOwnerAttempted=$true;$hostOwnerClosed=$false
        $hostOwnerScript=Join-Path $PSScriptRoot 'personal-native-host.py'
        $hostOwnerReceipt=Join-Path $output 'personal-host-owner.json'
        try {
            Invoke-PersonalChecked $python (@('-I','-B',$hostOwnerScript,'--node',$node,'--receipt',$hostOwnerReceipt,'--')+$personalArguments) 'Canonical Personal component execution'
        } finally {
            if (Test-Path -LiteralPath $hostOwnerReceipt) {
                & $python -I -B $hostOwnerScript --check-closure --receipt $hostOwnerReceipt --runtime-root $runtime
                $hostOwnerClosed=$LASTEXITCODE -eq 0
                $receipt['hostProcessOwner']=@{file='personal-host-owner.json';
                    bytes=(Get-Item -LiteralPath $hostOwnerReceipt).Length;
                    sha256=(Get-FileHash -LiteralPath $hostOwnerReceipt -Algorithm SHA256).Hash.ToLowerInvariant();
                    childrenClosed=$hostOwnerClosed}
            }
        }
    } else {
        Invoke-PersonalChecked $node $personalArguments 'Canonical Personal component execution'
    }
    if(Test-Path -LiteralPath $original){throw 'The original build root became available during execution.'}
    $receipt.status='pass'
}catch{$primary=$_;$receipt['error']=$_.Exception.Message}
finally{
    Remove-Item Env:GH_TOKEN -ErrorAction SilentlyContinue
    if($null -ne $faultWindowStart) {
        try {
            $faultChrome=Join-Path $runtime 'browsers/chromium-1234/chrome-win64/chrome.exe'
            if ($RendererWer) {
                $ownerPath=Join-Path $output 'personal-mxc/renderer-wer-owner.json'
                if (Test-Path -LiteralPath $ownerPath) {
                    $ownerItem=Get-Item -LiteralPath $ownerPath -Force
                    if ($ownerItem.PSIsContainer -or ($ownerItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $ownerItem.Length -gt 262144) { throw 'WER event ownership receipt is not bounded and ordinary.' }
                    $werOwner=Get-Content -LiteralPath $ownerPath -Raw | ConvertFrom-Json
                    if ($werOwner.classification -cne 'renderer-wer-clone-owner' -or $werOwner.sourceRevision -cne $env:GITHUB_SHA -or $werOwner.nonce -cnotmatch '^[a-f0-9]{24}$') { throw 'WER event ownership source or nonce differs.' }
                    if ($werOwner.ready -ceq $true) {
                        $expectedChrome=Join-Path $root ('NemoClawRendererWer-'+$werOwner.nonce.Substring(0,12)+'\chrome-win64\chrome.exe')
                        if ($werOwner.chromePath -cne $expectedChrome -or $werOwner.status -cne 'prepared') { throw 'WER event Chrome path differs from its prepared owner.' }
                        $faultChrome=$expectedChrome
                    }
                }
            }
            $faults=Get-PersonalChromeFaultEvents $faultChrome $faultWindowStart ([DateTime]::UtcNow)
            $faults['candidateReceiptSha256']=$receipt.derivedCandidateReceiptSha256;$faults['replayInputSha256']=$receipt.replayInputSha256
            $faultPath=Join-Path $output 'chrome-fault-events.json'
            [IO.File]::WriteAllText($faultPath,($faults|ConvertTo-Json -Depth 10)+"`n",[Text.UTF8Encoding]::new($false))
            $receipt['chromeFaultEvents']=@{file='chrome-fault-events.json';bytes=(Get-Item $faultPath).Length;sha256=(Get-FileHash $faultPath -Algorithm SHA256).Hash.ToLowerInvariant()}
        } catch {$receipt['chromeFaultEventsError']=$_.Exception.Message}
    }
    $removeRuntime=$runtimeOwned -and -not $mxcAttempted -and $buildProcessesClosed
    if($mxcAttempted){
        try{
            $completed=Get-Content -LiteralPath (Join-Path $output 'personal-mxc\personal-feasibility.json') -Raw|ConvertFrom-Json
            $removeRuntime=$runtimeOwned -and $buildProcessesClosed -and $hostOwnerClosed -and (Test-PersonalRuntimeRemoval $completed $runtime $env:GITHUB_SHA)
            if (-not $removeRuntime) { $receipt.cleanupErrors+=@('Runtime retained: current-source native executor, desktop and diagnostic closure was not confirmed.') }
        }catch{$receipt.cleanupErrors+=@('Runtime retained: executor completion receipt unavailable. '+$_.Exception.Message)}
    }
    $receipt['buildProcessesClosed']=$buildProcessesClosed
    $receipt['hostProcessOwnerAttempted']=$hostOwnerAttempted
    $receipt['hostProcessOwnerClosed']=$hostOwnerClosed
    $receipt['runtimeRetainedForUnclosedBuild']=$runtimeOwned -and $buildAttempted -and -not $buildProcessesClosed
    if ($receipt.runtimeRetainedForUnclosedBuild) { $receipt.cleanupErrors+=@('Runtime retained: targeted build process closure was not confirmed.') }
    $receipt['runtimeRetainedForUnclosedExecutor']=$runtimeOwned -and -not $removeRuntime
    try{if($removeRuntime -and (Test-Path -LiteralPath $runtime)){Remove-Item -LiteralPath $runtime -Recurse -Force}}
    catch{$receipt.cleanupErrors+=@($_.Exception.Message);if($null -eq $primary){$primary=$_}}
    $receipt['runtimeRootRemoved']= -not (Test-Path -LiteralPath $runtime)
    if($receipt.cleanupErrors.Count -gt 0){$receipt.status='failed'}
    try{[IO.File]::WriteAllText((Join-Path $output 'personal-phase.json'),($receipt|ConvertTo-Json -Depth 8)+"`n",[Text.UTF8Encoding]::new($false))}
    catch{if($null -eq $primary){$primary=$_}else{Write-Warning 'The Personal receipt could not also be saved.'}}
}
if($null -ne $primary){throw $primary}
if($receipt.status -cne 'pass'){throw 'Personal production or cleanup did not pass; no finished runtime may be promoted.'}
