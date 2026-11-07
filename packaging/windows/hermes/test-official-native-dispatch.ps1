# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$UvPath,
    [Parameter(Mandatory)][string]$PythonPath,
    [Parameter(Mandatory)][string]$ReceiptPath
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$receipt=[ordered]@{schemaVersion=1;classification='official-python-native-dispatch';status='failed';effectivePathExt=$env:PATHEXT;uv=$null;python=$null;uvFailure=$null;pythonFailure=$null;dependencyStageStarted=$false;runnerTrackingPresent=([bool]$env:RUNNER_TRACKING_ID)}
$failure=$null
try {
    if($env:OS -cne 'Windows_NT' -or @($env:PATHEXT -split ';' | Where-Object {$_ -ieq '.EXE'}).Count -ne 1){throw 'The isolated Windows worker does not recognize native .exe commands.'}
    # Unlike launching a document, capturing a real native pipeline requires
    # redirected output and an actual numeric exit result from PowerShell.
    $before=$ErrorActionPreference
    try {
        $ErrorActionPreference='Continue'
        $uvOutput=@(& $UvPath --version 2>&1)
        $uvCode=Get-Variable LASTEXITCODE -ValueOnly -ErrorAction SilentlyContinue
    } finally {$ErrorActionPreference=$before}
    if(($uvCode -isnot [int] -and $uvCode -isnot [long]) -or $uvCode -ne 0 -or $uvOutput.Count -ne 1 -or [string]$uvOutput[0] -notmatch '^uv 0\.9\.28(?:\s|$)') {throw 'The pinned uv did not complete its actual native invocation.'}
    $receipt.uv=[ordered]@{output=[string]$uvOutput[0];exitCode=$uvCode}
    try {
        $ErrorActionPreference='Continue'
        $pythonOutput=@(& $PythonPath --version 2>&1)
        $pythonCode=Get-Variable LASTEXITCODE -ValueOnly -ErrorAction SilentlyContinue
    } finally {$ErrorActionPreference=$before}
    if(($pythonCode -isnot [int] -and $pythonCode -isnot [long]) -or $pythonCode -ne 0 -or $pythonOutput.Count -ne 1 -or [string]$pythonOutput[0] -cne 'Python 3.11.16') {throw 'The managed Python did not complete its actual native invocation.'}
    $receipt.python=[ordered]@{output=[string]$pythonOutput[0];exitCode=$pythonCode}
    try {
        $ErrorActionPreference='Continue'
        $uvFailureOutput=@(& $UvPath --nemoclaw-native-dispatch-invalid-option 2>&1)
        $uvFailureCode=Get-Variable LASTEXITCODE -ValueOnly -ErrorAction SilentlyContinue
    } finally {$ErrorActionPreference=$before}
    $uvFailureText=($uvFailureOutput|ForEach-Object {[string]$_}) -join "`n"
    if(($uvFailureCode -isnot [int] -and $uvFailureCode -isnot [long]) -or $uvFailureCode -ne 2 -or $uvFailureText.Length -gt 4096 -or -not $uvFailureText.Contains('--nemoclaw-native-dispatch-invalid-option')) {throw 'The real uv error/output boundary did not preserve its nonzero result.'}
    $receipt.uvFailure=[ordered]@{output=$uvFailureText;exitCode=$uvFailureCode}
    $control=Join-Path (Split-Path -Parent $ReceiptPath) 'native-dispatch-control.py'
    if(Test-Path -LiteralPath $control){throw 'The native dispatch control requires a fresh owned script.'}
    [IO.File]::WriteAllText($control,"import sys`nprint('NEMOCLAW_NATIVE_STDOUT', flush=True)`nprint('NEMOCLAW_NATIVE_STDERR', file=sys.stderr, flush=True)`nsys.exit(37)`n",[Text.UTF8Encoding]::new($false))
    try {
        $ErrorActionPreference='Continue'
        $pythonFailureOutput=@(& $PythonPath -I $control 2>&1)
        $pythonFailureCode=Get-Variable LASTEXITCODE -ValueOnly -ErrorAction SilentlyContinue
    } finally {$ErrorActionPreference=$before}
    $pythonFailureText=($pythonFailureOutput|ForEach-Object {[string]$_}) -join "`n"
    if(($pythonFailureCode -isnot [int] -and $pythonFailureCode -isnot [long]) -or $pythonFailureCode -ne 37 -or $pythonFailureText.Length -gt 4096 -or -not $pythonFailureText.Contains('NEMOCLAW_NATIVE_STDOUT') -or -not $pythonFailureText.Contains('NEMOCLAW_NATIVE_STDERR')) {throw 'The real Python error/output boundary did not preserve both channels and its nonzero result.'}
    $receipt.pythonFailure=[ordered]@{output=$pythonFailureText;exitCode=$pythonFailureCode}
    $receipt.status='native-dispatch-proved'
} catch {$failure=$_;$receipt['error']=$_.Exception.Message}
finally {
    try {[IO.File]::WriteAllText($ReceiptPath,($receipt|ConvertTo-Json -Depth 6)+"`n",[Text.UTF8Encoding]::new($false))}
    catch {if($null -eq $failure){$failure=$_}else{Write-Warning 'Native dispatch also failed to write its receipt.'}}
}
if($null -ne $failure){$PSCmdlet.ThrowTerminatingError($failure)}
