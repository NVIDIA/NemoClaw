# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# Disposable CI diagnostic build. This does not replace the installer runtime.
[CmdletBinding()]
param(
 [Parameter(Mandatory)][string]$SourceRoot,
 [Parameter(Mandatory)][string]$OutputDirectory,
 [Parameter(Mandatory)][string]$ToolchainReceipt,
 [Parameter(Mandatory)][string]$RustBinDirectory
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -cne 'true' -or $env:OS -cne 'Windows_NT' -or [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -ne [Runtime.InteropServices.Architecture]::Arm64){throw 'The MXC inspection build requires disposable Windows ARM64 CI.'}
$output=[IO.Path]::GetFullPath($OutputDirectory)
foreach($value in @($SourceRoot,$output,$ToolchainReceipt,$RustBinDirectory)){if($value -match '[^\x20-\x7e]|["\r\n&|<>^%]'){throw 'Unsupported build path.'}}
if(Test-Path -LiteralPath $output){throw 'The MXC inspection build output must be fresh.'}
[void][IO.Directory]::CreateDirectory($output)
$build=Join-Path $output 'build';[void][IO.Directory]::CreateDirectory($build)
$commit='7dac1a952f0c9ad13f0a4cb089c4e0e8b3e0013a'
$sourceHash='814659a1db0b4cd06854066705f274bba2b2702f563735d69ba72a407c0ad258'
$patch=Join-Path $SourceRoot 'packaging/windows/mxc-bash/mxc-token-inspection.patch'
$record=[ordered]@{schemaVersion=1;classification='mxc-owned-token-inspection-build';status='failed';sourceCommit=$commit;sourceSha256=$sourceHash;sourceBytes=6168990;patchSha256=$null;candidateRevision=$env:GITHUB_SHA;tokenQueryRepairSupported=$true;tokenAccessMode='owned-child-query-only';files=@()}
$failure=$null
function File-Hash([string]$Path){(Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()}
try{
 $record.patchSha256=File-Hash $patch
 $cargo=Join-Path $RustBinDirectory 'cargo.exe';$rustc=Join-Path $RustBinDirectory 'rustc.exe';$rustdoc=Join-Path $RustBinDirectory 'rustdoc.exe'
 foreach($file in @($cargo,$rustc,$rustdoc)){if(-not(Test-Path -LiteralPath $file -PathType Leaf)){throw 'The pinned Rust toolchain is missing.'}}
 $rustVersion=(& $rustc -Vv | Out-String).Trim();if($LASTEXITCODE -ne 0 -or $rustVersion -notmatch '(?m)^release: 1\.93\.0\r?$'){throw 'Expected the upstream public Rust 1.93.0 toolchain.'}
 $cargoVersion=(& $cargo -V | Out-String).Trim();if($LASTEXITCODE -ne 0 -or $cargoVersion -notmatch '^cargo 1\.93\.0 '){throw 'Unexpected Cargo version.'}
 $record['rust']=[ordered]@{rustcVersion=$rustVersion;cargoVersion=$cargoVersion;rustcSha256=(File-Hash $rustc);cargoSha256=(File-Hash $cargo);rustdocSha256=(File-Hash $rustdoc)}
 $compiler=Get-Content -LiteralPath $ToolchainReceipt -Raw|ConvertFrom-Json
 if($compiler.classification -cne 'mxc-msys-compatibility-prototype-build' -or $compiler.status -cne 'built'){throw 'The coordinated Windows compiler receipt is missing.'}
 $arms=@($compiler.toolchains|Where-Object target -ceq 'arm64');if($arms.Count -ne 1){throw 'Expected one native ARM64 compiler.'};$arm=$arms[0]
 if($arm.toolsetVersion -cne '14.51.36231' -or $arm.sdkVersion -cne '10.0.26100.0'){throw 'The reviewed Windows compiler tuple changed.'}
 foreach($pair in @(@($arm.cl,$arm.clSha256),@($arm.link,$arm.linkSha256))){if((File-Hash $pair[0]) -cne $pair[1]){throw 'Windows compiler bytes changed.'}}
 $record['windowsToolchain']=$arm
 $archive=Join-Path $build 'mxc-source.tar.gz'
 $url='https://codeload.github.com/microsoft/mxc/tar.gz/'+$commit
 Invoke-WebRequest -Uri $url -OutFile $archive -TimeoutSec 180
 if((Get-Item -LiteralPath $archive).Length -ne 6168990 -or (File-Hash $archive) -cne $sourceHash){throw 'The pinned upstream MXC archive changed.'}
 $record['sourceUrl']=$url
 & (Join-Path ([Environment]::SystemDirectory) 'tar.exe') -xzf $archive -C $build
 if($LASTEXITCODE -ne 0){throw 'MXC source extraction failed.'}
 $source=Join-Path $build ('mxc-'+$commit)
 $lock=Join-Path $source 'src/Cargo.lock';$lockHash=File-Hash $lock
 $config=Join-Path $source '.cargo/config.toml';$configBefore=File-Hash $config
 $git=(Get-Command git.exe -ErrorAction Stop).Source
 $record['gitSha256']=File-Hash $git
 Push-Location $source
 try{
  & $git -c core.hooksPath=/dev/null apply --check --whitespace=error-all $patch
  if($LASTEXITCODE -ne 0){throw 'The inspection patch does not match the pinned source.'}
  & $git -c core.hooksPath=/dev/null apply --whitespace=error-all $patch
  if($LASTEXITCODE -ne 0){throw 'The inspection patch failed to apply.'}
 }finally{Pop-Location}
 # Use the same public feed configuration as the upstream Windows build.
 $feed=Join-Path $source '.azure-pipelines/.cargo/config.public.toml'
 [IO.File]::AppendAllText($config,[Environment]::NewLine+[IO.File]::ReadAllText($feed),[Text.UTF8Encoding]::new($false))
 $record['cargoConfig']=[ordered]@{originalSha256=$configBefore;publicFeedSha256=(File-Hash $feed);effectiveSha256=(File-Hash $config)}
 $record['cargoLockSha256']=$lockHash
 $record['features']=@();$record['target']='aarch64-pc-windows-msvc'
 $vswhere=Join-Path ([Environment]::GetEnvironmentVariable('ProgramFiles(x86)')) 'Microsoft Visual Studio/Installer/vswhere.exe'
 $installations=@(& $vswhere -latest -products '*' -property installationPath)
 if($LASTEXITCODE -ne 0 -or $installations.Count -ne 1){throw 'The Visual Studio installation is ambiguous.'}
 $vsdev=Join-Path $installations[0] 'Common7/Tools/VsDevCmd.bat'
 $cargoHome=Join-Path $build 'cargo-home';$target=Join-Path $build 'target'
 foreach($dir in @($cargoHome,$target)){[void][IO.Directory]::CreateDirectory($dir)}
 $batch=Join-Path $build 'compile-mxc.cmd'
 $commands=@('@echo off',('call "'+$vsdev+'" -no_logo -arch=arm64 -host_arch=arm64 -vcvars_ver=14.51.36231 -winsdk=10.0.26100.0'),'if errorlevel 1 exit /b 1',('set "PATH='+$RustBinDirectory+';'+([IO.Path]::GetDirectoryName($arm.cl))+';%PATH%"'),('set "RUSTC='+$rustc+'"'),('set "RUSTDOC='+$rustdoc+'"'),('set "CARGO_HOME='+$cargoHome+'"'),('set "CARGO_TARGET_DIR='+$target+'"'),'set "CARGO_TERM_COLOR=never"',('cd /d "'+(Join-Path $source 'src')+'"'),('"'+$cargo+'" build --locked --release --target aarch64-pc-windows-msvc --no-default-features -p wxc --bin wxc-exec'),'if errorlevel 1 exit /b 1','exit /b 0')
 [IO.File]::WriteAllLines($batch,$commands,[Text.UTF8Encoding]::new($false))
 $start=[Diagnostics.ProcessStartInfo]::new();$start.FileName=Join-Path ([Environment]::SystemDirectory) 'cmd.exe';$start.Arguments='/d /s /c ""'+$batch+'""';$start.UseShellExecute=$false;$start.CreateNoWindow=$true
 $start.RedirectStandardInput=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
 $process=$null;$stdout=$null;$stderr=$null;$timer=[Diagnostics.Stopwatch]::StartNew();$compileFailure=$null;$cleanupErrors=@();$record['compilerClosed']=$false;$record['compilerForced']=$false
 try{
  $process=[Diagnostics.Process]::Start($start);$process.StandardInput.Close()
  $stdout=$process.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput());$stderr=$process.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())
  if(-not $process.WaitForExit(840000)){throw 'MXC compiler exceeded its CI build bound.'}
  if(-not [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($stdout,$stderr),5000)){throw 'MXC compiler output did not close.'}
  $record['compilerExitCode']=$process.ExitCode
  if($process.ExitCode -ne 0){throw ('MXC compilation failed with exit '+$process.ExitCode+'.')}
 }catch{$compileFailure=$_}finally{
  if($null -ne $process){
   try{if(-not $process.HasExited){$record['compilerForced']=$true;$process.Kill($true);if(-not $process.WaitForExit(5000)){throw 'The MXC compiler process tree did not stop.'}};$record['compilerClosed']=$process.HasExited}
   catch{$cleanupErrors+=@($_.Exception.Message);if($null -eq $compileFailure){$compileFailure=$_}}
   foreach($copy in @($stdout,$stderr)){try{if($null -ne $copy -and -not $copy.Wait(1000)){throw 'MXC compiler output remained open.'}}catch{$cleanupErrors+=@($_.Exception.Message);if($null -eq $compileFailure){$compileFailure=$_}}}
   $process.Dispose()
  }
  $record['compilerElapsedMs']=$timer.ElapsedMilliseconds;$record['compilerCleanupErrors']=$cleanupErrors
 }
 if($null -ne $compileFailure){throw $compileFailure}
 if((File-Hash $lock) -cne $lockHash -or (File-Hash $patch) -cne $record.patchSha256){throw 'Pinned build inputs changed during compilation.'}
 $binary=Join-Path $target 'aarch64-pc-windows-msvc/release/wxc-exec.exe';$bytes=[IO.File]::ReadAllBytes($binary)
 if($bytes.Length -lt 64){throw 'Missing executor PE header.'};$pe=[BitConverter]::ToInt32($bytes,60)
 if($pe -lt 64 -or $pe -gt 1048576 -or $pe+24 -gt $bytes.Length -or [BitConverter]::ToUInt32($bytes,$pe) -ne 0x4550 -or [BitConverter]::ToUInt16($bytes,$pe+4) -ne 0xAA64){throw 'The inspection executor is not ARM64 PE.'}
 Copy-Item -LiteralPath $binary -Destination (Join-Path $output 'wxc-exec.exe')
 Copy-Item -LiteralPath $lock -Destination (Join-Path $output 'Cargo.lock')
 Copy-Item -LiteralPath (Join-Path $source 'LICENSE.md') -Destination (Join-Path $output 'MXC-LICENSE.txt')
 $record['licenseSha256']=File-Hash (Join-Path $output 'MXC-LICENSE.txt')
 Copy-Item -LiteralPath (Join-Path $SourceRoot 'LICENSE') -Destination (Join-Path $output 'NEMOCLAW-LICENSE.txt')
 Copy-Item -LiteralPath $patch -Destination (Join-Path $output 'mxc-token-inspection.patch')
 $record['nemoClawLicenseSha256']=File-Hash (Join-Path $output 'NEMOCLAW-LICENSE.txt')
 $record.files=@([ordered]@{file='wxc-exec.exe';bytes=$bytes.Length;sha256=(File-Hash $binary);machine=0xAA64})
 $record['embeddedProductVersion']=[Diagnostics.FileVersionInfo]::GetVersionInfo($binary).ProductVersion
 $record.status='built'
}catch{$failure=$_;$record['error']=$_.Exception.Message}
finally{[IO.File]::WriteAllText((Join-Path $output 'mxc-token-inspection-build.json'),($record|ConvertTo-Json -Depth 10)+[Environment]::NewLine,[Text.UTF8Encoding]::new($false))}
if($null -ne $failure){throw $failure}
