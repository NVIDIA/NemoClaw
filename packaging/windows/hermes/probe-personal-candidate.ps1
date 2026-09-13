# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
[CmdletBinding()]
param([Parameter(Mandatory)][string]$ArtifactDirectory,
    [Parameter(Mandatory)][string]$BootstrapDirectory,
    [Parameter(Mandatory)][string]$HelperDirectory,
    [switch]$RecordStartup,
    [switch]$CaptureRendererContext,
    [switch]$ColdJobProbe,
    [switch]$RendererWer)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:OS -cne 'Windows_NT') { throw 'This candidate test requires disposable Windows CI.' }
if ($ColdJobProbe -and ($RecordStartup -or $CaptureRendererContext)) { throw 'The cold owned-job experiment cannot record startup or capture renderer context.' }
if ($RendererWer -and ($ColdJobProbe -or $RecordStartup -or $CaptureRendererContext)) { throw 'The renderer WER diagnostic must run without other diagnostic modes.' }
$output=[IO.Path]::GetFullPath($ArtifactDirectory)
if (Test-Path -LiteralPath $output) { throw 'The Personal evidence directory must be fresh.' }
$null=New-Item -ItemType Directory -Path $output
$downloads=Join-Path $output 'downloads'
$null=New-Item -ItemType Directory -Path $downloads
$root=[IO.Path]::GetPathRoot([Environment]::SystemDirectory)
$runtime=Join-Path $root 'NemoClawHermesProbe-274d797050ea'
$primary=$null;$mxcAttempted=$false;$runtimeOwned=$false;$faultWindowStart=$null
$classification=if($RendererWer){'canonical-personal-mxc-renderer-wer-diagnostic'}elseif($ColdJobProbe){'canonical-personal-mxc-cold-job-diagnostic'}else{'canonical-personal-mxc-candidate-feasibility'}
$receipt=[ordered]@{schemaVersion=1;classification=$classification;sourceRevision=$env:GITHUB_SHA;diagnosticOnly=[bool]($ColdJobProbe -or $RendererWer);coldJobProbe=[bool]$ColdJobProbe;rendererWer=[bool]$RendererWer;
    candidateSource='8d78fe458e9268a7afdc8ed06b85c23306452036';artifactId=10293082661;status='failed';runtimeRebuilt=$false;runtimeExported=$false;
    installedAcceptance=$false;fullAgentQualified=$false;runtimeRoot=$runtime;cleanupErrors=@()}
function Invoke-PersonalChecked([string]$Executable,[string[]]$Arguments,[string]$Label) {
    $receipt['activeStage']=$Label
    Write-Host ('[Hermes Personal] '+$Label)
    & $Executable @Arguments 2>&1 | Tee-Object -FilePath (Join-Path $output (($Label -replace '[^a-zA-Z0-9-]','-')+'.log'))
    if ($LASTEXITCODE -ne 0) { throw ($Label+' failed with exit '+$LASTEXITCODE) }
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
    $receipt['derivedCandidateReceiptSha256']=(Get-FileHash -LiteralPath (Join-Path $candidate 'runtime-candidate.json') -Algorithm SHA256).Hash.ToLowerInvariant()
    $receipt['compatibilityProofSource']='c830cd3ef8315ff46a7ebfcd3c0b2afefd152a4a'
    $receipt['completeBaseReused']=$true
    $sdk=Join-Path $downloads 'mxc-sdk.tgz'
    Invoke-WebRequest -Uri 'https://registry.npmjs.org/@microsoft/mxc-sdk/-/mxc-sdk-0.8.0.tgz' -OutFile $sdk -TimeoutSec 60
    if((Get-FileHash -LiteralPath $sdk -Algorithm SHA256).Hash.ToLowerInvariant() -cne '06bb2399d7e98ab1907acf851e12a4e44748dd467b79d3e53c2f2fbf569da14e'){throw 'The MXC SDK differs from the exact archive.'}
    Invoke-PersonalChecked (Join-Path ([Environment]::SystemDirectory) 'tar.exe') @('-xzf',$sdk,'-C',$downloads,'package/bin/arm64/wxc-exec.exe','package/bin/arm64/wxc-host-prep.exe') 'Pinned MXC extraction'
    $mxc=Join-Path $downloads 'package\bin\arm64'
    & (Join-Path $PSScriptRoot '..\host-preparation\test-system-root-mxc.ps1') -HelperPath (Join-Path $HelperDirectory 'NemoClawHostPreparation.exe') -MxcDirectory $mxc -NodePath $node -ArtifactDirectory (Join-Path $output 'system-root-proof')
    $systemProof=Get-Content -LiteralPath (Join-Path $output 'system-root-proof\system-root-mxc-proof.json') -Raw|ConvertFrom-Json
    if($systemProof.status -cne 'pass'){throw 'The same-run system-root/MXC proof failed.'}
    # Observe only metadata before the timed primary workload; failures stay secondary.
    try {
        $aclObservation=Get-PersonalRuntimeAclObservation $runtime $receipt.derivedCandidateReceiptSha256 $receipt.replayInputSha256
        $aclPath=Join-Path $output 'runtime-acl-observation.json'
        [IO.File]::WriteAllText($aclPath,($aclObservation|ConvertTo-Json -Depth 10)+"`n",[Text.UTF8Encoding]::new($false))
        $receipt['runtimeAclObservation']=@{file='runtime-acl-observation.json';bytes=(Get-Item -LiteralPath $aclPath).Length;sha256=(Get-FileHash -LiteralPath $aclPath -Algorithm SHA256).Hash.ToLowerInvariant()}
    } catch {$receipt['runtimeAclObservationError']=$_.Exception.Message}
    $faultWindowStart=[DateTime]::UtcNow
    $patchedMxc=Join-Path $compatEvidence 'mxc-token-inspection-build'
    $personalArguments = @('--experimental-strip-types','--no-warnings',(Join-Path $PSScriptRoot 'probe-personal-candidate.mts'),
        '--runtime-root',$runtime,'--mxc',(Join-Path $patchedMxc 'wxc-exec.exe'),'--stock-mxc',(Join-Path $mxc 'wxc-exec.exe'),'--host-controller-python',$python,'--wpr-powershell',(Join-Path $PSHOME 'pwsh.exe'),'--output',(Join-Path $output 'personal-mxc'),
        '--compatibility-root',(Join-Path $compatEvidence 'compatibility-build'),'--compatibility-receipt',(Join-Path $compatEvidence 'compatibility-build/build-receipt.json'),
        '--compatibility-proof',(Join-Path $compatEvidence 'result.json'),'--mxc-build-receipt',(Join-Path $patchedMxc 'mxc-token-inspection-build.json'),
        '--derived-runtime-receipt',(Join-Path $candidate 'runtime-candidate.json'),'--replay-receipt',(Join-Path $candidate 'replay-input.json'))
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
    if ($ColdJobProbe) { $personalArguments += '--cold-job-probe' }
    $mxcAttempted=$true
    Invoke-PersonalChecked $node $personalArguments 'Canonical Personal component execution'
    if(Test-Path -LiteralPath $original){throw 'The original build root became available during execution.'}
    $receipt.status='pass'
}catch{$primary=$_;$receipt['error']=$_.Exception.Message}
finally{
    if($null -ne $faultWindowStart) {
        try {
            $faults=Get-PersonalChromeFaultEvents (Join-Path $runtime 'browsers/chromium-1234/chrome-win64/chrome.exe') $faultWindowStart ([DateTime]::UtcNow)
            $faults['candidateReceiptSha256']=$receipt.derivedCandidateReceiptSha256;$faults['replayInputSha256']=$receipt.replayInputSha256
            $faultPath=Join-Path $output 'chrome-fault-events.json'
            [IO.File]::WriteAllText($faultPath,($faults|ConvertTo-Json -Depth 10)+"`n",[Text.UTF8Encoding]::new($false))
            $receipt['chromeFaultEvents']=@{file='chrome-fault-events.json';bytes=(Get-Item $faultPath).Length;sha256=(Get-FileHash $faultPath -Algorithm SHA256).Hash.ToLowerInvariant()}
        } catch {$receipt['chromeFaultEventsError']=$_.Exception.Message}
    }
    $removeRuntime=$runtimeOwned -and -not $mxcAttempted
    if($mxcAttempted){
        try{
            $completed=Get-Content -LiteralPath (Join-Path $output 'personal-mxc\personal-feasibility.json') -Raw|ConvertFrom-Json
            $removeRuntime=$runtimeOwned -and $completed.schemaVersion -eq 1 -and $completed.classification -ceq 'canonical-personal-mxc-feasibility' -and $completed.runtime -ceq $runtime -and $completed.rootsRetainedForUnclosedExecutor -ceq $false -and $completed.cleanup.hostDiagnosticChildrenClosed -ceq $true -and ($completed.executorAttempted -ceq $false -or $completed.cleanup.executorClosed -ceq $true)
        }catch{$receipt.cleanupErrors+=@('Runtime retained: executor completion receipt unavailable. '+$_.Exception.Message)}
    }
    $receipt['runtimeRetainedForUnclosedExecutor']=$runtimeOwned -and -not $removeRuntime
    try{if($removeRuntime -and (Test-Path -LiteralPath $runtime)){Remove-Item -LiteralPath $runtime -Recurse -Force}}
    catch{$receipt.cleanupErrors+=@($_.Exception.Message);if($null -eq $primary){$primary=$_}}
    $receipt['runtimeRootRemoved']= -not (Test-Path -LiteralPath $runtime)
    if($receipt.cleanupErrors.Count -gt 0){$receipt.status='failed'}
    try{[IO.File]::WriteAllText((Join-Path $output 'personal-phase.json'),($receipt|ConvertTo-Json -Depth 8)+"`n",[Text.UTF8Encoding]::new($false))}
    catch{if($null -eq $primary){$primary=$_}else{Write-Warning 'The Personal receipt could not also be saved.'}}
}
if($null -ne $primary){throw $primary}
