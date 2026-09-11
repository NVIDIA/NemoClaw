# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# CI-only transport of the fixed published0.1.2 bytes. It never installs/overlays files.
[CmdletBinding()]
param([Parameter(Mandatory)][string]$OutputDirectory,
    [Parameter(Mandatory)][string]$SourceRunId,
    [Parameter(Mandatory)][string]$ProductVersion)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -cne 'Windows_NT' -or $env:GITHUB_ACTIONS -cne 'true' -or
    $PSVersionTable.PSEdition -cne 'Core' -or $PSVersionTable.PSVersion -lt [version]'7.4' -or
    $env:GITHUB_REPOSITORY -cne 'NVIDIA/NemoClaw' -or -not $env:GH_TOKEN -or
    $SourceRunId -cne '34544062535' -or $ProductVersion -cne '0.1.2') {
    throw 'Replay requires the fixed published0.1.2 run in authorized Windows CI.'
}
if (Test-Path -LiteralPath $OutputDirectory) { throw 'The published replay directory must be fresh.' }
$work = [IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($work) | Out-Null
$downloads = Join-Path $work 'downloads'
[IO.Directory]::CreateDirectory($downloads) | Out-Null
$gh = (Get-Command gh.exe -CommandType Application | Select-Object -First 1).Source
$artifactSource = 'b54a1f3a54ab28dff7813de2db9430f6735ec624'

function Invoke-RawCapture {
    param([string]$Executable, [string[]]$Arguments, [string]$OutputPath,
        [string]$ErrorPath, [long]$MaximumBytes, [int]$TimeoutMilliseconds)
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $Executable; $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true; $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    $start.Environment.Remove('GH_DEBUG') | Out-Null
    foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
    $process = $null; $output = $null; $errors = $null; $stdout = $null; $stderr = $null
    $failure = $null; $clock = [Diagnostics.Stopwatch]::StartNew(); $exitCode = $null
    try {
        $output = [IO.File]::Open($OutputPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
        $errors = [IO.File]::Open($ErrorPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
        $process = [Diagnostics.Process]::Start($start)
        $process.StandardInput.Close()
        # Binary ZIP output never passes through PowerShell's text pipeline.
        $stdout = $process.StandardOutput.BaseStream.CopyToAsync($output)
        $stderr = $process.StandardError.BaseStream.CopyToAsync($errors)
        while (-not $process.WaitForExit(100)) {
            if ($clock.ElapsedMilliseconds -gt $TimeoutMilliseconds) { throw 'The owned artifact transport timed out.' }
            if ($output.Length -gt $MaximumBytes -or $errors.Length -gt 65536) { throw 'The owned artifact transport exceeded its output bound.' }
            if ($stdout.IsFaulted) { $stdout.GetAwaiter().GetResult() }
            if ($stderr.IsFaulted) { $stderr.GetAwaiter().GetResult() }
        }
        $exitCode = $process.ExitCode
        if (-not [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($stdout,$stderr), 5000)) { throw 'The owned artifact output did not close.' }
        $output.Flush($true); $errors.Flush($true)
        if ($output.Length -gt $MaximumBytes -or $errors.Length -gt 65536) { throw 'The artifact transport output exceeds its bound.' }
        if ($exitCode -ne 0) { throw "The owned artifact transport exited $exitCode; its error log is retained." }
    } catch { $failure = $_ }
    finally {
        if ($null -ne $process) {
            try {
                if (-not $process.HasExited) { $process.Kill($true); if (-not $process.WaitForExit(5000)) { throw 'The owned artifact process did not stop.' } }
            } catch { if ($null -eq $failure) { $failure = $_ } }
            finally { $process.Dispose() }
        }
        foreach ($task in @($stdout,$stderr)) {
            if ($null -ne $task) { try { if (-not $task.Wait(1000)) { throw 'Owned artifact output cleanup did not finish.' } } catch { if ($null -eq $failure) { $failure = $_ } } }
        }
        if ($null -ne $output) { $output.Dispose() }
        if ($null -ne $errors) { $errors.Dispose() }
    }
    if ($null -ne $failure) { throw $failure }
    return @{ exitCode=$exitCode; bytes=(Get-Item -LiteralPath $OutputPath).Length; elapsedMilliseconds=$clock.ElapsedMilliseconds }
}
function Read-GitHubMetadata([string]$ApiPath, [string]$Label) {
    $path = Join-Path $downloads ($Label + '.json')
    $null = Invoke-RawCapture $gh @('api','--hostname','github.com',$ApiPath) $path (Join-Path $downloads ($Label + '.stderr.log')) 1048576 60000
    return Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
}
function Assert-PinnedFile([string]$Path, [long]$Bytes, [string]$Sha256) {
    $file = Get-Item -LiteralPath $Path -Force
    if ($file -isnot [IO.FileInfo] -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        $file.Length -ne $Bytes -or (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Sha256) {
        throw 'A published replay file failed its complete byte/hash identity check.'
    }
}
function Assert-ArtifactMetadata($Metadata, $Expected, $Run) {
    if ($Metadata.id -ne $Expected.id -or $Metadata.name -cne $Expected.name -or $Metadata.expired -ne $false -or
        $Metadata.size_in_bytes -ne $Expected.bytes -or $Metadata.digest -cne ('sha256:' + $Expected.sha256) -or
        $Metadata.workflow_run.id -ne $Run.id -or $Metadata.workflow_run.head_sha -cne $Run.head_sha -or
        $Metadata.workflow_run.repository_id -ne $Run.repository.id -or $Metadata.workflow_run.head_repository_id -ne $Run.head_repository.id) {
        throw 'The artifact metadata differs from the fixed source/run/repository identity.'
    }
}

$receipt = [ordered]@{schemaVersion=1;classification='fixed-published-installer-replay-inputs';status='failed';
    artifactSourceRevision=$artifactSource;controllerSourceRevision=$env:GITHUB_SHA;sourceRunId=34544062535;sourceRunAttempt=1;
    productVersion='0.1.2';installedRuntimeOverlay=$false;currentHeadQualification=$false;archives=@()}
$primary = $null
try {
    $run = Read-GitHubMetadata 'repos/NVIDIA/NemoClaw/actions/runs/34544062535' 'source-run'
    if ($run.id -ne 34544062535 -or $run.head_sha -cne $artifactSource -or $run.run_attempt -ne 1 -or
        $run.repository.full_name -cne 'NVIDIA/NemoClaw' -or $run.head_repository.full_name -cne 'NVIDIA/NemoClaw' -or
        $run.path -cne '.github/workflows/windows-native-installer.yaml' -or $run.status -cne 'completed' -or
        $run.event -cne 'workflow_dispatch' -or $run.head_branch -cne 'feat/windows-native-installer') {
        throw 'The published source run does not match the fixed replay identity.'
    }
    # The source workflow's failed installed acceptance remains failed; the built
    # preview is explicitly unqualified and is the exact object being replayed.
    $expected = @(
        @{ id=10178641244; name=('finished-windows-preview-' + $artifactSource); bytes=341647780;
            sha256='8c6b339e6c1aa228d1fe5ab86d22169e3e6f6cf4dabedfd5299490216611af60'; label='preview'; destination=$work },
        @{ id=10178411226; name=('compiled-windows-application-' + $artifactSource); bytes=63714548;
            sha256='22ca3877bfc0cdb452ea113f428f88b1c080188415de11ad079f00f62d4349fb'; label='ci-application'; destination=(Join-Path $work 'application') }
    )
    foreach ($item in $expected) {
        $metadata = Read-GitHubMetadata ('repos/NVIDIA/NemoClaw/actions/artifacts/' + $item.id) ($item.label + '-metadata')
        Assert-ArtifactMetadata $metadata $item $run
        $archive = Join-Path $downloads ($item.label + '.zip')
        $transport = Invoke-RawCapture $gh @('api','--hostname','github.com',('repos/NVIDIA/NemoClaw/actions/artifacts/' + $item.id + '/zip')) `
            $archive (Join-Path $downloads ($item.label + '.stderr.log')) $item.bytes 180000
        Assert-PinnedFile $archive $item.bytes $item.sha256
        $receipt.archives += @{id=$item.id;sha256=$item.sha256;bytes=$item.bytes;fullArchiveVerified=$true;transport=$transport}
        Expand-Archive -LiteralPath $archive -DestinationPath $item.destination
    }
    Assert-PinnedFile (Join-Path $work 'package\NemoClawSetup-0.1.2-windows-arm64.exe') 198595309 'c738acc8b8d68e11f9555fe5798bf3e1241991aedded558d76f7506d6c7cb19a'
    Assert-PinnedFile (Join-Path $work 'package\NemoClaw-0.1.2-windows-arm64.msi') 144761392 '01c51f6cc74c5126dc6e900283b4df416e0ec4930a1ff332bf49c9cf171360a8'
    Assert-PinnedFile (Join-Path $work 'application\node\node.exe') 77132104 '97cce5301a815d2dce07ac5bfd1e6039eae88185ec1d10ae4f8cb712f1732878'
    $build = Get-Content -LiteralPath (Join-Path $work 'package\immutable-package-build.json') -Raw | ConvertFrom-Json
    if ($build.sourceRevision -cne $artifactSource -or $build.status -cne 'candidate-built-for-installed-qualification') { throw 'The preview receipt source is incorrect.' }
    $receipt.status = 'verified-for-installed-replay'
} catch { $primary = $_; $receipt.error = $_.Exception.Message }
try { [IO.File]::WriteAllText((Join-Path $work 'replay-inputs.json'), (($receipt|ConvertTo-Json -Depth 8)+"`n"), [Text.UTF8Encoding]::new($false)) }
catch { if ($null -eq $primary) { $primary = $_ } }
if ($null -ne $primary) { throw $primary }
