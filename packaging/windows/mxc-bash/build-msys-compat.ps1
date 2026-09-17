# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
[CmdletBinding()]
param([Parameter(Mandatory)][string]$OutputDirectory)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -cne 'true' -or $env:OS -cne 'Windows_NT' -or $PSEdition -cne 'Core') {
    throw 'This is a disposable Windows CI compatibility build.'
}
$output=[IO.Path]::GetFullPath($OutputDirectory)
foreach($value in @($output,$PSScriptRoot)) {
    if($value -match '[^\x20-\x7e]|["\r\n&|<>^%]'){throw 'Build paths must be bounded ordinary ASCII paths.'}
}
if(Test-Path -LiteralPath $output){throw 'The compatibility build output must be fresh.'}
$null=New-Item -ItemType Directory -Path $output
$work=Join-Path $output 'build';$null=New-Item -ItemType Directory -Path $work
$pin=[ordered]@{commit='adb07604aa56508448b95bf037c2a6d0d3b6831a';url='https://codeload.github.com/microsoft/Detours/tar.gz/adb07604aa56508448b95bf037c2a6d0d3b6831a';bytes=507933;sha256='42125d318f607cded3332bb61bb7bebac8a58a57e46ced6de573610f1d4cedba'}
$receipt=[ordered]@{schemaVersion=1;classification='mxc-msys-compatibility-prototype-build';sourceRevision=$env:GITHUB_SHA;status='failed';detours=$pin;sourceFiles=@();toolchains=@();files=@();runtimeExecuted=$false;qualified=$false;cleanupErrors=@()}
$primary=$null
function Invoke-CompatibilityBuild([string]$Batch,[string]$Label){
    $start=[Diagnostics.ProcessStartInfo]::new()
    $start.FileName=Join-Path ([Environment]::SystemDirectory) 'cmd.exe'
    $start.Arguments='/d /s /c ""'+$Batch+'""'
    $start.UseShellExecute=$false;$start.CreateNoWindow=$true
    $start.RedirectStandardInput=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
    $process=[Diagnostics.Process]::new();$process.StartInfo=$start
    $stdout=$null;$stderr=$null;$failure=$null
    try{
        if(-not $process.Start()){throw 'Build process did not start.'}
        $process.StandardInput.Close()
        $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
        if(-not $process.WaitForExit(300000)){throw ($Label+' exceeded its five-minute build bound.')}
        if(-not $stdout.Wait(5000) -or -not $stderr.Wait(5000)){throw 'Build output did not close.'}
        if($process.ExitCode -ne 0){throw ($Label+' failed with exit '+$process.ExitCode)}
    }catch{$failure=$_}
    finally{
        try{
            if(-not $process.HasExited){$process.Kill($true);if(-not $process.WaitForExit(10000)){throw 'The owned build tree did not stop.'}}
        }catch{$receipt.cleanupErrors+=@($_.Exception.Message);if($null -eq $failure){$failure=$_}}
        foreach($entry in @(@('stdout',$stdout),@('stderr',$stderr))){
            try{if($null -ne $entry[1] -and $entry[1].Wait(1000)){[IO.File]::WriteAllText((Join-Path $work ($Label+'.'+$entry[0]+'.log')),$entry[1].GetAwaiter().GetResult(),[Text.UTF8Encoding]::new($false))}}
            catch{$receipt.cleanupErrors+=@($_.Exception.Message);if($null -eq $failure){$failure=$_}}
        }
        $process.Dispose()
    }
    if($null -ne $failure){throw $failure}
}
try{
    foreach($name in @('compat-launcher.cpp','process-propagation.cpp','process-propagation.h','namespace-compat.cpp','namespace-path.h','namespace-security.h','namespace-controls.cpp','compat.def')){
        $file=Join-Path $PSScriptRoot $name
        if(-not(Test-Path -LiteralPath $file -PathType Leaf)){throw ('Missing coordinated source '+$name)}
        $receipt.sourceFiles+=@{path=$name;sha256=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()}
    }
    $archive=Join-Path $work 'detours.tar.gz'
    Invoke-WebRequest -Uri $pin.url -OutFile $archive -TimeoutSec 120
    if((Get-Item -LiteralPath $archive).Length -ne $pin.bytes -or (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pin.sha256){throw 'The official Detours archive differs from its immutable pin.'}
    $vswhere=Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    $installations=@(& $vswhere -latest -products '*' -property installationPath)
    if($LASTEXITCODE -ne 0 -or $installations.Count -ne 1){throw 'The native Visual Studio installation is ambiguous or absent.'}
    $vsdev=Join-Path $installations[0] 'Common7\Tools\VsDevCmd.bat'
    if(-not(Test-Path -LiteralPath $vsdev -PathType Leaf)){throw 'The native compiler environment is absent.'}
    $shell=(Get-Process -Id $PID).Path
    foreach($target in @('arm64','x64')){
        $targetRoot=Join-Path $work $target;$null=New-Item -ItemType Directory -Path $targetRoot
        & (Join-Path ([Environment]::SystemDirectory) 'tar.exe') -xzf $archive -C $targetRoot
        if($LASTEXITCODE -ne 0){throw 'Pinned Detours extraction failed.'}
        $detours=Join-Path $targetRoot ('Detours-'+$pin.commit)
        $identity=Join-Path $targetRoot 'toolchain.json'
        $identitySource=@'
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$target='__TARGET__'
$toolset=$env:VCToolsVersion.TrimEnd('\');$sdk=$env:WindowsSDKVersion.TrimEnd('\')
if($toolset -cne '14.51.36231' -or $sdk -cne '10.0.26100.0'){throw 'The measured compiler/SDK tuple changed.'}
$cl=Join-Path $env:VCToolsInstallDir ('bin\HostARM64\'+$target+'\cl.exe')
$link=Join-Path $env:VCToolsInstallDir ('bin\HostARM64\'+$target+'\link.exe')
$record=@{target=$target;cl=$cl;clSha256=(Get-FileHash -LiteralPath $cl -Algorithm SHA256).Hash.ToLowerInvariant();link=$link;linkSha256=(Get-FileHash -LiteralPath $link -Algorithm SHA256).Hash.ToLowerInvariant();toolsetVersion=$toolset;sdkVersion=$sdk}
[IO.File]::WriteAllText('__IDENTITY__',($record|ConvertTo-Json)+"`n",[Text.UTF8Encoding]::new($false))
'@
        $identitySource=$identitySource.Replace('__TARGET__',$target).Replace('__IDENTITY__',$identity.Replace("'","''"))
        $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($identitySource))
        $machine=$target.ToUpperInvariant();$dll=Join-Path $output ('NemoClawMsysCompat-'+$target+'.dll')
        $common='/nologo /W4 /WX /std:c++17 /EHsc /MT /DUNICODE /D_UNICODE /D_WIN32_WINNT=0x0A00 /I"'+$PSScriptRoot+'" /I"'+$detours+'\include"'
        $commands=@('@echo off',('call "'+$vsdev+'" -no_logo -arch='+$target+' -host_arch=arm64 -vcvars_ver=14.51.36231 -winsdk=10.0.26100.0'),'if errorlevel 1 exit /b 1',('set "PATH=%VCToolsInstallDir%bin\HostARM64\'+$target+';%PATH%"'),('"'+$shell+'" -NoProfile -EncodedCommand '+$encoded),'if errorlevel 1 exit /b 1',('cd /d "'+$detours+'\src"'),('nmake /nologo DETOURS_TARGET_PROCESSOR='+$machine),'if errorlevel 1 exit /b 1',('cd /d "'+$targetRoot+'"'),('cl '+$common+' /c "'+$PSScriptRoot+'\process-propagation.cpp" /Fo"'+$targetRoot+'\process-propagation.obj"'),'if errorlevel 1 exit /b 1',('cl '+$common+' /LD "'+$PSScriptRoot+'\namespace-compat.cpp" "'+$targetRoot+'\process-propagation.obj" "'+$detours+'\lib.'+$machine+'\detours.lib" /Fe:"'+$dll+'" /link /DEF:"'+$PSScriptRoot+'\compat.def" /IMPLIB:"'+$targetRoot+'\compat.lib" /INCREMENTAL:NO advapi32.lib ntdll.lib kernel32.lib'),'if errorlevel 1 exit /b 1')
        if($target -ceq 'arm64'){
            $commands+=@(('cl '+$common+' "'+$PSScriptRoot+'\compat-launcher.cpp" "'+$targetRoot+'\process-propagation.obj" "'+$detours+'\lib.'+$machine+'\detours.lib" /Fe:"'+$output+'\NemoClawMsysLauncher.exe" /link /SUBSYSTEM:CONSOLE /INCREMENTAL:NO advapi32.lib kernel32.lib'),'if errorlevel 1 exit /b 1')
            $commands+=@(('cl '+$common+' "'+$PSScriptRoot+'\namespace-controls.cpp" /Fe:"'+$targetRoot+'\namespace-controls.exe" /link /SUBSYSTEM:CONSOLE /INCREMENTAL:NO advapi32.lib kernel32.lib'),'if errorlevel 1 exit /b 1',('"'+$targetRoot+'\namespace-controls.exe"'),'if errorlevel 1 exit /b 1')
        }
        $commands+='exit /b 0'
        $batch=Join-Path $targetRoot 'compile.cmd';[IO.File]::WriteAllText($batch,($commands -join "`r`n")+"`r`n",[Text.UTF8Encoding]::new($false))
        Invoke-CompatibilityBuild $batch $target
        $receipt.toolchains+=@(Get-Content -LiteralPath $identity -Raw|ConvertFrom-Json)
        if($target -ceq 'arm64'){
            $license=Join-Path $output 'DETOURS-LICENSE.txt';Copy-Item -LiteralPath (Join-Path $detours 'LICENSE.md') -Destination $license
            $receipt['license']=@{file='DETOURS-LICENSE.txt';bytes=(Get-Item -LiteralPath $license).Length;sha256=(Get-FileHash -LiteralPath $license -Algorithm SHA256).Hash.ToLowerInvariant()}
        }
    }
    foreach($item in @(@('NemoClawMsysLauncher.exe',0xAA64,'arm64'),@('NemoClawMsysCompat-arm64.dll',0xAA64,'arm64'),@('NemoClawMsysCompat-x64.dll',0x8664,'x64'))){
        $file=Join-Path $output $item[0];$bytes=[IO.File]::ReadAllBytes($file);$offset=[BitConverter]::ToInt32($bytes,60)
        if($bytes[0] -ne 0x4d -or $bytes[1] -ne 0x5a -or $offset -lt 64 -or $offset+6 -gt $bytes.Length -or [BitConverter]::ToUInt32($bytes,$offset) -ne 0x4550 -or [BitConverter]::ToUInt16($bytes,$offset+4) -ne $item[1]){throw 'An output is not the expected native PE architecture.'}
        $receipt.files+=@{file=$item[0];bytes=$bytes.Length;sha256=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant();machine=$item[2]}
    }
    foreach($row in $receipt.sourceFiles){if((Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $row.path) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $row.sha256){throw 'A coordinated source changed during compilation.'}}
    $receipt.status='built'
}catch{$primary=$_;$receipt['error']=$_.Exception.Message}
finally{
    try{[IO.File]::WriteAllText((Join-Path $output 'build-receipt.json'),($receipt|ConvertTo-Json -Depth 8)+"`n",[Text.UTF8Encoding]::new($false))}
    catch{if($null -eq $primary){$primary=$_}else{Write-Warning 'The build receipt also failed to write.'}}
}
if($null -ne $primary){throw $primary}
