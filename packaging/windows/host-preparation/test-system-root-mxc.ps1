# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

param([Parameter(Mandatory)][string]$HelperPath,
    [Parameter(Mandatory)][string]$MxcDirectory,
    [Parameter(Mandatory)][string]$NodePath,
    [Parameter(Mandatory)][string]$ArtifactDirectory)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS  -cne  'Windows_NT'  -or  $env:GITHUB_ACTIONS  -cne  'true') {
    throw 'System-root preparation proof requires the disposable Windows runner.'
}
$output = [IO.Path]::GetFullPath($ArtifactDirectory)
$temporary = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\') + '\'
if ( -not  $output.StartsWith($temporary,[StringComparison]::OrdinalIgnoreCase)  -or  (Test-Path -LiteralPath $output)) {
    throw 'The proof requires a fresh runner-owned evidence directory.'
}
foreach ($value in @($HelperPath,$MxcDirectory,$NodePath,$output)) {
    if ($value  -match  '["\r\n]') { throw 'A proof path cannot be represented safely.' }
}
[IO.Directory]::CreateDirectory($output) | Out-Null
$root = [IO.Path]::GetPathRoot([Environment]::SystemDirectory)
$work = Join-Path $root ('NemoClawHostPrepProof-' + [guid]::NewGuid().ToString('N').Substring(0,12))
$container = 'hp-' + [guid]::NewGuid().ToString('N').Substring(0,12)
$wxc = Join-Path $MxcDirectory 'wxc-exec.exe'
$nullPrep = Join-Path $MxcDirectory 'wxc-host-prep.exe'
$commands = [Collections.Generic.List[object]]::new()
$cleanupErrors = [Collections.Generic.List[string]]::new()
$primary = $null; $mxcAttempted = $false; $mxcStopped = $true
$receipt = [ordered]@{schemaVersion=1;classification='actual-system-root-and-mxc-proof';sourceRevision=$env:GITHUB_SHA
    status='failed';systemDriveRoot=$root;commands=$commands;cleanupErrors=$cleanupErrors;admissionAllowed=$false;
    requestProfile='existing-personal-node-compatibility';stdio='explicit-pipes-with-closed-input';networkAccessTested=$false}

# Proof-only: the observed regular Node file can gain only SE_DACL_AUTO_INHERITED.
# Owner/group, every ACE byte/order/flag and all protection text remain exact.
function Compare-ProofNodeAcl {
    param([string]$Before, [string]$After, [int]$BeforeAttributes, [int]$AfterAttributes)
    $regular = $BeforeAttributes -ge 0 -and $AfterAttributes -ge 0 -and
        ($BeforeAttributes -band 0x410) -eq 0 -and ($AfterAttributes -band 0x410) -eq 0
    $exact = $regular -and $Before.Length -gt 0 -and $Before -ceq $After
    $added = $false
    if ($regular -and -not $exact -and $Before -cmatch '^O:[^:()]+G:[^:()]+D:(?:\([^()]+\))+$') {
        $index = $Before.IndexOf('D:(', [StringComparison]::Ordinal)
        $added = $index -ge 0 -and $After -ceq $Before.Insert($index + 2, 'AI')
    }
    return [pscustomobject]@{ restored = ($exact -or $added); exactRestored = $exact;
        metadataChange = $(if ($added) { 'dacl-auto-inherited-added' } else { $null }) }
}

function Get-ProofNodeAttributes([string]$Path) {
    $file = Get-Item -LiteralPath $Path -Force
    if ($file -isnot [IO.FileInfo] -or ($file.Attributes -band 0x410) -ne 0) {
        throw 'The proof Node input must remain an ordinary non-reparse file.'
    }
    return [int]$file.Attributes
}

function Invoke-ProofProcess {
    param([string]$Executable,[string[]]$Arguments,[string]$Label,[int]$Seconds=30)
    $start=[Diagnostics.ProcessStartInfo]::new();$start.FileName=$Executable
    $start.Arguments=($Arguments|ForEach-Object {'"'+$_+'"'}) -join ' '
    $start.UseShellExecute=$false;$start.CreateNoWindow=$true
    $start.RedirectStandardInput=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
    $start.EnvironmentVariables.Clear()
    foreach($name in @('SystemRoot','SystemDrive','WINDIR','COMSPEC','OS','TEMP','TMP','LOCALAPPDATA','APPDATA','USERPROFILE','PROCESSOR_ARCHITECTURE','PROCESSOR_ARCHITEW6432','RUNNER_TRACKING_ID')){
        $value=[Environment]::GetEnvironmentVariable($name);if($null  -ne  $value){$start.EnvironmentVariables[$name]=$value}
    }
    $start.EnvironmentVariables['PATH']=[Environment]::SystemDirectory
    $start.EnvironmentVariables['PATHEXT']='.COM;.EXE;.BAT;.CMD'
    $row=[pscustomobject]@{label=$Label;executable=$Executable;arguments=$Arguments;pid=$null;exitCode=$null;elapsedMilliseconds=$null;stopped=$false}
    $commands.Add($row);$process=$null;$stdout=$null;$stderr=$null;$failure=$null
    $watch=[Diagnostics.Stopwatch]::StartNew()
    try{
        $process=[Diagnostics.Process]::Start($start);$row.pid=$process.Id
        $process.StandardInput.Close()
        $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
        if( -not  $process.WaitForExit($Seconds*1000)){throw ('The bounded '+$Label+' process timed out.')}
        $row.exitCode=$process.ExitCode;$row.stopped=$true
        if( -not  $stdout.Wait(5000) -or  -not  $stderr.Wait(5000)){throw 'Owned proof output did not close.'}
        if($row.exitCode -ne  0){throw ('The '+$Label+' process failed with exit '+$row.exitCode)}
        return $stdout.GetAwaiter().GetResult()
    }catch{$failure=$_}
    finally{
        if($null  -ne  $process){
            try{
                if( -not  $process.HasExited){
                    $killStart=[Diagnostics.ProcessStartInfo]::new()
                    $killStart.FileName=Join-Path ([Environment]::SystemDirectory) 'taskkill.exe'
                    $killStart.Arguments='/PID '+$process.Id+' /T /F'
                    $killStart.UseShellExecute=$false;$killStart.CreateNoWindow=$true
                    $killer=[Diagnostics.Process]::Start($killStart)
                    try{
                        if( -not  $killer.WaitForExit(10000)){$killer.Kill();$null=$killer.WaitForExit(1000);throw 'The owned tree cleanup command timed out.'}
                    }finally{$killer.Dispose()}
                    $row.stopped=$process.WaitForExit(10000)
                }
                if($process.HasExited){$row.exitCode=$process.ExitCode;$row.stopped=$true}
            }catch{$cleanupErrors.Add($Label+': '+$_.Exception.Message)}
            finally{try{$process.Dispose()}catch{$cleanupErrors.Add($_.Exception.Message)}}
        }
        foreach($stream in @(@('stdout',$stdout),@('stderr',$stderr))){
            try{if($null  -ne  $stream[1]  -and  $stream[1].Wait(1000)){[IO.File]::WriteAllText((Join-Path $output ($Label+'.'+$stream[0]+'.log')),$stream[1].GetAwaiter().GetResult())}}
            catch{$cleanupErrors.Add($Label+' output: '+$_.Exception.Message)}
        }
        $row.elapsedMilliseconds=$watch.Elapsed.TotalMilliseconds
    }
    if($null  -ne  $failure){throw $failure}
}

try {
    foreach($pin in @(
        @($NodePath,'97cce5301a815d2dce07ac5bfd1e6039eae88185ec1d10ae4f8cb712f1732878'),
        @($wxc,'dde1c592270e9a659b01dccad70362da7b99fec114885fa4d625507aa775a503'),
        @($nullPrep,'c8ddcf0461ae3d7ddff4656abb87b51236146742bb711a2e03fdc23cb8a966b0')
    )) {
        if((Get-FileHash -LiteralPath $pin[0] -Algorithm SHA256).Hash.ToLowerInvariant()  -cne  $pin[1]){throw 'A proof executable differs from its immutable input.'}
    }
    $receipt.helperSha256=(Get-FileHash -LiteralPath $HelperPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $receipt.rootSddlBefore=(Get-Acl -LiteralPath $root).Sddl
    $first=(Invoke-ProofProcess $HelperPath @('prepare-system-drive') 'metadata-first')|ConvertFrom-Json
    $receipt.first=$first
    if($first.verified  -ne  $true  -or  $first.systemDriveRoot  -cne  $root  -or  $first.addedAces  -lt  1  -or  $first.addedAces  -gt  2  -or  $first.writeCalls  -ne  1){throw 'Fresh system-root metadata preparation was not proved.'}
    $second=(Invoke-ProofProcess $HelperPath @('prepare-system-drive') 'metadata-repeat')|ConvertFrom-Json
    $receipt.repeat=$second
    if($second.verified  -ne  $true  -or  $second.addedAces  -ne  0  -or  $second.writeCalls  -ne  0  -or  $second.beforeDescriptorHex  -cne  $first.afterDescriptorHex  -or  $second.afterDescriptorHex  -cne  $first.afterDescriptorHex){throw 'System-root repeat was not an exact zero-write no-op.'}
    $receipt.first=$first;$receipt.repeat=$second;$receipt.rootSddlAfterPreparation=(Get-Acl -LiteralPath $root).Sddl
    $null=Invoke-ProofProcess $nullPrep @('prepare-null-device','--json') 'upstream-null-device'
    [IO.Directory]::CreateDirectory($work)|Out-Null
    $receipt.nodeFileKind='regular-file'
    $receipt.nodeFileAttributesBefore=Get-ProofNodeAttributes $NodePath
    $nodeAcl=(Get-Acl -LiteralPath $NodePath).Sddl
    $receipt.nodeSddlBefore=$nodeAcl
    $denied=Join-Path $output 'not-granted.txt';[IO.File]::WriteAllText($denied,'not granted')
    $worker=Join-Path $work 'worker.mjs';$result=Join-Path $work 'result.json'
    [IO.File]::WriteAllText((Join-Path $work 'input.txt'),'owned read')
    [IO.File]::WriteAllText($worker,@'
import fs from 'node:fs';
import path from 'node:path';
const [result,denied]=process.argv.slice(2);
if(process.platform!=='win32'||process.arch!=='arm64'||process.versions.node!=='22.23.2')throw Error('Unexpected Node');
if(fs.readFileSync(path.join(process.cwd(),'input.txt'),'utf8')!=='owned read')throw Error('Allowed read failed');
let deniedRead=false;try{fs.readFileSync(denied)}catch(error){deniedRead=['EACCES','EPERM'].includes(error.code)}
if(!deniedRead)throw Error('Unlisted file read was not denied');
fs.writeFileSync(result,JSON.stringify({schemaVersion:1,marker:'NEMOCLAW_SYSTEM_METADATA_MXC_OK',platform:process.platform,architecture:process.arch,node:process.versions.node,pid:process.pid,allowedRead:true,deniedRead:true,ownedWrite:true}));
console.log('NEMOCLAW_SYSTEM_METADATA_MXC_OK');
'@,[Text.UTF8Encoding]::new($false))
    # Match the existing Personal Node request used by the OpenShell derivative.
    # The stronger LPAC/Win32k-disabled b3ad observation remains separate evidence.
    $guestHome=Join-Path $work 'home';$temp=Join-Path $work 'temp'
    [IO.Directory]::CreateDirectory($guestHome)|Out-Null
    [IO.Directory]::CreateDirectory($temp)|Out-Null
    $windows=[Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
    $childEnvironment=[ordered]@{
        NODE_DISABLE_COMPILE_CACHE='1';COMSPEC=(Join-Path $windows 'System32\cmd.exe')
        LOCALAPPDATA=$guestHome;APPDATA=$guestHome;HOME=$guestHome;USERPROFILE=$guestHome
        OS='Windows_NT';PATH=((Split-Path -Parent $NodePath)+';'+[Environment]::SystemDirectory+';'+$windows)
        PATHEXT='.COM;.EXE;.BAT;.CMD';PROCESSOR_ARCHITECTURE='ARM64'
        SYSTEMDRIVE=$root.TrimEnd('\');SYSTEMROOT=$windows;WINDIR=$windows;TEMP=$temp;TMP=$temp
    }
    $receipt.childEnvironmentKeys=@($childEnvironment.Keys)
    $policy=Join-Path $output 'policy.json'
    $request=[ordered]@{version='0.6.0-alpha';containerId=$container;containment='processcontainer'
        process=@{commandLine='"'+$NodePath+'" "'+$worker+'" "'+$result+'" "'+$denied+'"';cwd=$work;timeout=30000;env=@($childEnvironment.GetEnumerator()|ForEach-Object {$_.Key+'='+$_.Value})}
        processContainer=@{leastPrivilege=$false;capabilities=@('privateNetworkClientServer','internetClient')};ui=@{disable=$false}
        network=@{defaultPolicy='allow';allowedHosts=@();blockedHosts=@();allowLocalNetwork=$true};filesystem=@{readonlyPaths=@($NodePath);readwritePaths=@($work)}
        lifecycle=@{destroyOnExit=$false;preservePolicy=$false}}
    [IO.File]::WriteAllText($policy,($request|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
    $receipt.policySha256=(Get-FileHash -LiteralPath $policy -Algorithm SHA256).Hash.ToLowerInvariant()
    $receipt.requestPolicy=[ordered]@{leastPrivilege=$request.processContainer.leastPrivilege;capabilities=$request.processContainer.capabilities;win32kDisabled=$request.ui.disable;networkDefaultPolicy=$request.network.defaultPolicy;allowLocalNetwork=$request.network.allowLocalNetwork;childTimeoutMilliseconds=$request.process.timeout}
    $mxcAttempted=$true;$mxcStopped=$false
    $null=Invoke-ProofProcess $wxc @($policy,'--log-file',(Join-Path $output 'mxc-native.log')) 'mxc-execution' 40
    $mxcStopped=$commands[$commands.Count-1].stopped
    $guest=Get-Content -LiteralPath $result -Raw|ConvertFrom-Json
    if($guest.marker  -cne  'NEMOCLAW_SYSTEM_METADATA_MXC_OK'  -or  $guest.allowedRead  -ne  $true  -or  $guest.deniedRead  -ne  $true  -or  $guest.ownedWrite  -ne  $true){throw 'The actual MXC file-access controls failed.'}
    $mxcLog = [regex]::Replace((Get-Content -LiteralPath (Join-Path $output 'mxc-native.log') -Raw), '\[\d+\][ \t]*', '')
    if($mxcLog -notmatch '(?m)^selected isolation tier:\s*appcontainer-dacl\s*$'){throw 'The system-root-dependent AppContainer DACL tier was not exercised.'}
    if($mxcLog -match 'Win32k mitigation applied to child process'){throw 'The existing Personal Node UI compatibility setting was not honored.'}
    $receipt.guest=$guest
    $receipt.nodeSddlAfter=(Get-Acl -LiteralPath $NodePath).Sddl
    $receipt.nodeFileAttributesAfter=Get-ProofNodeAttributes $NodePath
    $receipt.nodeAclComparison=Compare-ProofNodeAcl $nodeAcl $receipt.nodeSddlAfter $receipt.nodeFileAttributesBefore $receipt.nodeFileAttributesAfter
    $receipt.nodeAclRestored=$receipt.nodeAclComparison.restored
    $receipt.rootSddlAfterMxc=(Get-Acl -LiteralPath $root).Sddl
    if(  -not  $receipt.nodeAclRestored  -or  $receipt.rootSddlAfterMxc  -cne  $receipt.rootSddlAfterPreparation){throw 'MXC cleanup changed the prepared root or input executable ACL.'}
    $receipt.status='pass'
}catch{$primary=$_;$receipt.error=$_.Exception.Message}
finally{
    if($mxcAttempted){
        $last=@($commands|Where-Object label -eq 'mxc-execution')[-1];$mxcStopped=$last.stopped
        if($mxcStopped){try{$null=Invoke-ProofProcess $wxc @('--delete','--containername',$container) 'owned-profile-delete'}catch{$cleanupErrors.Add($_.Exception.Message)}}
        else{$cleanupErrors.Add('The owned MXC process did not stop; profile cleanup was not overlapped.')}
    }
    try{if([IO.Directory]::Exists($work)){[IO.Directory]::Delete($work,$true)}}catch{$cleanupErrors.Add($_.Exception.Message)}
    $receipt.mxcStopped=$mxcStopped;$receipt.workspaceRemoved=  -not  [IO.Directory]::Exists($work)
    if($cleanupErrors.Count){$receipt.status='failed'}
    try{[IO.File]::WriteAllText((Join-Path $output 'system-root-mxc-proof.json'),(($receipt|ConvertTo-Json -Depth 12)+"`n"),[Text.UTF8Encoding]::new($false))}catch{if($null  -eq  $primary){$primary=$_}}
}
if($null  -ne  $primary){$PSCmdlet.ThrowTerminatingError($primary)}
if($receipt.status  -cne  'pass'){throw 'The system-root/MXC proof did not complete its cleanup.'}
