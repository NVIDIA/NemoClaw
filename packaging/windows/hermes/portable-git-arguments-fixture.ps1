# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

param([string]$Source, [string]$Mode, [string]$Payload)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($Source, [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) { throw 'The actual component helper did not parse.' }
$definitions = @($ast.FindAll({ param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'Get-ComponentProcessCommandLine'
}, $true))
if ($definitions.Count -ne 1) { throw 'Expected exactly one actual command-line helper.' }
. ([scriptblock]::Create($definitions[0].Extent.Text))
$decoded = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload))
if ($Mode -eq 'portable') {
    $result = Get-ComponentProcessCommandLine -PortableGitDestination $decoded
} elseif ($Mode -eq 'arguments') {
    $result = Get-ComponentProcessCommandLine -Arguments $decoded.Split([char]0)
} else { throw 'Unknown formatter control.' }
[Console]::WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($result)))
