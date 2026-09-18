# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

param([Parameter(Mandatory)][string]$OfficialInstallerPath,
    [Parameter(Mandatory)][string]$ReceiptPath)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -cne 'Windows_NT' -or $env:GITHUB_ACTIONS -cne 'true') {
    throw 'Real registry/process controls require the disposable GitHub Windows runner.'
}
if ((Get-FileHash -LiteralPath $OfficialInstallerPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne '53a077364aa28bbd6e8d987cdec11a4552e22ff2c5137845725a1c99770f392f') {
    throw 'The registry control requires the pinned official installer bytes.'
}
. (Join-Path $PSScriptRoot 'build-registry-path.ps1')
$tokens = $null; $parseErrors = $null
$official = [Management.Automation.Language.Parser]::ParseFile($OfficialInstallerPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'The official installer does not parse.' }
foreach ($name in @('Sync-EnvPath','Invoke-Stage')) {
    $definition = $official.Find({param($item) $item -is [Management.Automation.Language.FunctionDefinitionAst] -and $item.Name -eq $name}, $false)
    if ($null -eq $definition) { throw 'An official stage environment function is missing.' }
    . ([scriptblock]::Create($definition.Extent.Text))
}
$priorProcessPath = $env:PATH
$fixture = Join-Path $env:RUNNER_TEMP ('registry-path-control-' + [guid]::NewGuid().ToString('N'))
$fixtureRegistry = 'Software\NVIDIA\NemoClawBuildPathControl-' + [guid]::NewGuid().ToString('N')
$system32 = Join-Path $env:SystemRoot 'System32'
$shell = Join-Path $system32 'WindowsPowerShell\v1.0\powershell.exe'
$results = [Collections.Generic.List[object]]::new()
$primary = $null; $cleanupErrors = [Collections.Generic.List[string]]::new()
$Json = $true; $Stage = $null

function Observe-BuildPath {
    $script:ObservedBuildPath = $env:PATH
    $script:ObservedLegacy = @(Get-Command winpty-agent -CommandType Application -ErrorAction SilentlyContinue | ForEach-Object { $_.Source })
}

function Invoke-RegistryProcessControl {
    param([string]$Name, [string]$MachinePath, [string]$Command, [AllowNull()][object]$ExpectedError, [bool]$ExpectLegacy)
    $scopes = @(); $process = $null; $failure = $null; $restoration = $null
    $childExit = $null; $timedOut = $false; $childStopped = $true
    try {
        $scopes += New-BuildRegistryPathScope -Name 'User' -Key ([Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true))
        $scopes += New-BuildRegistryPathScope -Name 'Machine' -Key ([Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\CurrentControlSet\Control\Session Manager\Environment', $true))
        Set-BuildRegistryPathScope -Scope $scopes[0] -Value $system32
        Set-BuildRegistryPathScope -Scope $scopes[1] -Value $MachinePath
        $env:PATH = $system32
        if (Get-Command winpty-agent -CommandType Application -ErrorAction SilentlyContinue) { throw 'The inherited control PATH is already contaminated.' }
        # These are the exact official functions, with only the leaf worker
        # replaced by an observation; no Python dependency build is simulated.
        try {
            Set-StrictMode -Off
            Invoke-Stage -StageDef @{ Name = 'dependency-path-control'; Worker = 'Observe-BuildPath' } | Out-Null
        } finally { Set-StrictMode -Version Latest }
        if ($script:ObservedBuildPath -cne ($system32 + ';' + $MachinePath) -or
            ($script:ObservedLegacy.Count -gt 0) -ne $ExpectLegacy) { throw 'Official stage PATH refresh did not have the expected discovery result.' }
        if ($Command) {
            $start = [Diagnostics.ProcessStartInfo]::new()
            $start.FileName = $shell
            $start.Arguments = '-NoProfile -NonInteractive -Command "' + $Command + '"'
            $start.UseShellExecute = $false; $start.CreateNoWindow = $true
            $process = [Diagnostics.Process]::Start($start)
            $childStopped = $false
            $wait = 10000
            if ($ExpectedError -ceq 'expected-child-timeout') { $wait = 300 }
            if (-not $process.WaitForExit($wait)) { $timedOut = $true; throw 'expected-child-timeout' }
            $childStopped = $true; $childExit = $process.ExitCode
            if ($childExit -ne 0) { throw ('expected-child-exit-' + $childExit) }
        }
    } catch { $failure = $_.Exception.Message }
    finally {
        if ($null -ne $process) {
            try {
                if (-not $process.HasExited) { $process.Kill(); $childStopped = $process.WaitForExit(5000) }
                $childExit = $process.ExitCode
            } catch { $cleanupErrors.Add($Name + ' child: ' + $_.Exception.Message) }
            finally { try { $process.Dispose() } catch { $cleanupErrors.Add($Name + ' child handle: ' + $_.Exception.Message) } }
        }
        $restoration = Restore-BuildRegistryPathScopes -Scopes $scopes
        foreach ($item in $restoration.errors) { $cleanupErrors.Add($Name + ': ' + $item) }
        $env:PATH = $priorProcessPath
    }
    $row = [pscustomobject]@{ name = $Name; error = $failure; expectedError = $ExpectedError
        effectivePath = $script:ObservedBuildPath; legacyPaths = $script:ObservedLegacy
        childExit = $childExit; timedOut = $timedOut; childStopped = $childStopped
        registryPathRestoration = $restoration.paths }
    $results.Add($row)
    if ($failure -cne $ExpectedError -or -not $childStopped -or $restoration.errors.Count -ne 0) {
        throw 'A registry/process control did not preserve its expected result and exact restoration.'
    }
}

try {
    [IO.Directory]::CreateDirectory($fixture) | Out-Null
    [IO.File]::WriteAllText((Join-Path $fixture 'winpty-agent.exe'), 'Discovery fixture only; never executed.')
    Invoke-RegistryProcessControl -Name 'old-user-only-admits-machine-git' -MachinePath $fixture -Command '' -ExpectedError $null -ExpectLegacy $true
    Invoke-RegistryProcessControl -Name 'clean-success' -MachinePath $system32 -Command 'exit 0' -ExpectedError $null -ExpectLegacy $false
    Invoke-RegistryProcessControl -Name 'clean-child-failure' -MachinePath $system32 -Command 'exit 23' -ExpectedError 'expected-child-exit-23' -ExpectLegacy $false
    Invoke-RegistryProcessControl -Name 'clean-child-timeout' -MachinePath $system32 -Command 'Start-Sleep -Seconds 30' -ExpectedError 'expected-child-timeout' -ExpectLegacy $false
    foreach ($kind in @('String','ExpandString','Absent')) {
        $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($fixtureRegistry + '\' + $kind)
        if ($kind -cne 'Absent') { $key.SetValue('Path', '%SystemRoot%\literal fixture', [Microsoft.Win32.RegistryValueKind]([Enum]::Parse([Microsoft.Win32.RegistryValueKind], $kind))) }
        $scope = New-BuildRegistryPathScope -Key $key -Name $kind
        try { Set-BuildRegistryPathScope -Scope $scope -Value $system32 }
        finally { $restoration = Restore-BuildRegistryPathScopes -Scopes @($scope) }
        $results.Add([pscustomobject]@{ name = 'raw-type-restore-' + $kind; registryPathRestoration = $restoration.paths })
        if ($restoration.errors.Count -ne 0) { throw 'A registry raw-value/type restoration control failed.' }
    }
} catch { $primary = $_ }
finally {
    $env:PATH = $priorProcessPath
    try { [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($fixtureRegistry, $false) } catch { $cleanupErrors.Add($_.Exception.Message) }
    try { if ([IO.Directory]::Exists($fixture)) { [IO.Directory]::Delete($fixture, $true) } } catch { $cleanupErrors.Add($_.Exception.Message) }
    $passed = $null -eq $primary -and $cleanupErrors.Count -eq 0 -and $results.Count -eq 7
    $receipt = [ordered]@{ schemaVersion = 1; classification = 'real-windows-build-registry-path-controls'
        pass = $passed; cases = @($results.ToArray()); cleanupErrors = @($cleanupErrors.ToArray())
        error = $(if ($null -ne $primary) { $primary.Exception.Message } else { $null })
        dependencyBuildExecuted = $false; installedAcceptance = $false }
    try { [IO.File]::WriteAllText($ReceiptPath, (($receipt | ConvertTo-Json -Depth 12) + "`n"), [Text.UTF8Encoding]::new($false)) }
    catch { if ($null -eq $primary) { $primary = $_ } }
}
if ($null -ne $primary) { $PSCmdlet.ThrowTerminatingError($primary) }
if (-not $passed) { throw 'The real Windows registry/process controls did not pass.' }
Write-Host 'Seven real Windows registry/process controls passed; no dependency build or runtime acceptance claimed.'
