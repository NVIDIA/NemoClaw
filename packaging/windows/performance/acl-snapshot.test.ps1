# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
[CmdletBinding()]
param([string]$OriginalScriptPath)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
function Get-ActualPathValidator {
    param([string]$Path)
    $tokens=$null; $errors=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile($Path,[ref]$tokens,[ref]$errors)
    if($errors.Count){throw 'The path helper does not parse.'}
    $statements=@($ast.EndBlock.Statements)
    $first=@($statements|Where-Object {$_ -is [Management.Automation.Language.AssignmentStatementAst] -and $_.Left.Extent.Text -in @('$parseOptions','$paths')})[0]
    $loop=@($statements|Where-Object {$_ -is [Management.Automation.Language.ForEachStatementAst]})[0]
    $prefix=$ast.Extent.Text.Substring($first.Extent.StartOffset,$loop.Extent.StartOffset-$first.Extent.StartOffset)
    $guard=$loop.Body.Statements[0].Extent.Text
    return [scriptblock]::Create('param($InputPath,$OutputPath)' + "`n" + $prefix + "`nforeach(`$value in `$paths){"+$guard+"`n`$value}")
}
$validator=Get-ActualPathValidator (Join-Path $PSScriptRoot 'acl-snapshot.ps1')
$root=Join-Path ([IO.Path]::GetTempPath()) ('acl-array-control-'+[guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root)|Out-Null
$results=[Collections.Generic.List[object]]::new()
$inputFile=Join-Path $root 'paths.json'; $outputFile=Join-Path $root 'absent.json'
function Invoke-Case {
    param([string]$Name,[string]$Json,[bool]$Pass,[int]$ExpectedCount=0)
    [IO.File]::WriteAllText($inputFile,$Json,[Text.UTF8Encoding]::new($false))
    $actual=@();$failure=$null
    try {$actual=@(& $validator $inputFile $outputFile)}catch{$failure=$_}
    if($Pass -and ($null -ne $failure -or $actual.Count -ne $ExpectedCount)){throw ("Expected valid paths: "+$Name+" "+$failure)}
    if(-not $Pass -and $null -eq $failure){throw ("Invalid paths accepted: "+$Name)}
    $results.Add(@{name=$Name;passed=$true;legacyEmission=$script:legacyEmission})
}
$legacyEmission=$false
try {
    foreach($legacyEmission in @($false,$true)){
        if($legacyEmission){
            # Exact historical cmdlet contract: write the parsed array as ONE
            # pipeline object. Actual JSON parsing remains the installed cmdlet.
            function ConvertFrom-Json {
                [CmdletBinding()]param([Parameter(ValueFromPipeline)][string]$InputObject)
                process {
                    $options=@{InputObject=$InputObject}
                    if((Get-Command Microsoft.PowerShell.Utility\ConvertFrom-Json).Parameters.ContainsKey('NoEnumerate')){$options.NoEnumerate=$true}
                    $value=Microsoft.PowerShell.Utility\ConvertFrom-Json @options
                    $PSCmdlet.WriteObject($value,$false)
                }
            }
        }
        Invoke-Case 'actual Windows roots and executable paths' '["C:\\","C:\\Program Files","C:\\Program Files\\NVIDIA\\NemoClaw\\bin\\node.exe","c:\\program files\\nvidia"]' $true 4
        Invoke-Case 'single-element Windows path array' '["C:\\"]' $true 1
        Invoke-Case 'empty array' '[]' $false
        Invoke-Case 'nested array stays non-string' '[["C:\\"]]' $false
        Invoke-Case 'scalar is not the required array' '"C:\\"' $false
        Invoke-Case 'object is not the required array' '{"path":"C:\\"}' $false
        Invoke-Case 'null input' 'null' $false
        Invoke-Case 'non-string element' '[7]' $false
        Invoke-Case 'relative path' '["relative\\node.exe"]' $false
        Invoke-Case 'drive-relative path' '["C:node.exe"]' $false
        Invoke-Case 'UNC path' '["\\\\server\\share"]' $false
        Invoke-Case 'device path' '["\\\\?\\C:\\node.exe"]' $false
        Invoke-Case 'too many paths' ('['+((@('"C:\\"')*33)-join ',')+']') $false
        if($OriginalScriptPath -and $legacyEmission){
            $original=Get-ActualPathValidator $OriginalScriptPath
            [IO.File]::WriteAllText($inputFile,'["C:\\","C:\\Program Files"]')
            $rejected=$false
            try {$null=& $original $inputFile $outputFile}catch{$rejected=$_.Exception.Message -eq 'ACL snapshot requires an absolute local Windows path.'}
            if(-not $rejected){throw 'The exact original source did not reproduce its reported failure.'}
            $results.Add(@{name='original published assignment rejects the valid array under 5.1 emission';passed=$true;legacyEmission=$true})
        }
        if($legacyEmission){Remove-Item Function:\ConvertFrom-Json}
    }
    # Companion helper has scalar parameters, not a JSON-array loader. Exercise
    # its ACTUAL comparison statement for Windows-style case variants and sibling.
    $tokens=$null;$errors=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'process-start.ps1'),[ref]$tokens,[ref]$errors)
    if($errors.Count){throw 'The companion helper does not parse.'}
    $guard=$ast.Find({param($node) $node -is [Management.Automation.Language.IfStatementAst] -and $node.Extent.Text.Contains('StringComparison')},$true)
    $check=[scriptblock]::Create('param($actual,$ExpectedExecutable)' + "`n" + $guard.Extent.Text)
    & $check 'C:\Program Files\NVIDIA\NemoClaw\bin\node.exe' 'c:\program files\nvidia\nemoclaw\bin\NODE.EXE'
    $rejected=$false
    try {& $check 'C:\Program Files\NVIDIA\NemoClaw\bin\node.exe' 'C:\Program Files\NVIDIA\Other\bin\node.exe'}catch{$rejected=$true}
    if(-not $rejected){throw 'The process-start helper accepted a sibling executable.'}
    $results.Add(@{name='companion actual scalar comparison accepts case variants and rejects sibling';passed=$true})
    [pscustomobject]@{passed=$results.Count;failed=0;powerShellVersion=$PSVersionTable.PSVersion.ToString();windowsAclReadProof=$false;scope='actual source JSON/path guards and companion path comparison; Windows ACL/process APIs remain native follow-up';results=@($results)}|ConvertTo-Json -Depth 6
} finally {
    if(Test-Path Function:\ConvertFrom-Json){Remove-Item Function:\ConvertFrom-Json}
    Remove-Item -LiteralPath $root -Recurse -Force
}
