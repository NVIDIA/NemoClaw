# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Execute the actual bounded capture-command helper with owned real children.
# These process controls do not claim Windows ETW or ACL execution.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$source = Join-Path $PSScriptRoot 'measure-directory-enumeration.ps1'
$ast = [Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'The capture helper did not parse.' }
$definition = $ast.Find({param($item) $item -is [Management.Automation.Language.FunctionDefinitionAst] -and $item.Name -eq 'Invoke-CaptureCommand'}, $false)
if ($null -eq $definition) { throw 'The actual capture-command helper is missing.' }
. ([scriptblock]::Create($definition.Extent.Text))
$commands = [Collections.Generic.List[object]]::new()
$cleanupErrors = [Collections.Generic.List[string]]::new()
$shell = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
foreach ($case in @(
    @{ Name = 'success'; Command = "[Console]::Out.WriteLine('owned-output');[Console]::Error.WriteLine('owned-error');exit 0"; Exit = 0; Error = $null; Timeout = $false },
    @{ Name = 'failure'; Command = "[Console]::Out.WriteLine('owned-output');[Console]::Error.WriteLine('owned-error');exit 23"; Exit = 23; Error = 'Capture command failed: failure'; Timeout = $false },
    @{ Name = 'timeout'; Command = "[Console]::Out.WriteLine('owned-output');[Console]::Error.WriteLine('owned-error');Start-Sleep -Seconds 30"; Exit = $null; Error = 'A bounded capture command timed out.'; Timeout = $true }
)) {
    $actualError = $null
    try { Invoke-CaptureCommand -Path $shell -Name $case.Name -Arguments @('-NoProfile','-NonInteractive','-Command',$case.Command) }
    catch { $actualError = $_.Exception.Message }
    $row = $commands[$commands.Count - 1]
    if ($actualError -cne $case.Error -or $row.timedOut -ne $case.Timeout -or -not $row.stopped -or
        -not $row.stdout.Contains('owned-output') -or -not $row.stderr.Contains('owned-error') -or
        ($null -ne $case.Exit -and $row.exitCode -ne $case.Exit)) {
        throw ('The actual process/output/cleanup control failed: ' + $case.Name)
    }
}
if ($commands.Count -ne 3 -or $cleanupErrors.Count -ne 0) { throw 'Capture process controls did not retain three cleanly stopped children.' }
[pscustomobject]@{ classification = 'capture-process-controls'; passed = 3; commands = @($commands.ToArray()); windowsApiExecuted = $false } | ConvertTo-Json -Depth 6
