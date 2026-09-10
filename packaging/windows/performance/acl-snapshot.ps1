# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
[CmdletBinding()]
param([Parameter(Mandatory)][string]$InputPath, [Parameter(Mandatory)][string]$OutputPath)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if($env:OS -cne 'Windows_NT'){throw 'ACL snapshots require Windows.'}
$paths = @(Get-Content -LiteralPath $InputPath -Raw | ConvertFrom-Json)
if($paths.Count -lt 1 -or $paths.Count -gt 32 -or (Test-Path -LiteralPath $OutputPath)){throw 'ACL snapshot paths/output are invalid.'}
$rows = @()
foreach($value in $paths){
 if($value -isnot [string] -or $value -notmatch '^[A-Za-z]:\\'){throw 'ACL snapshot requires an absolute local Windows path.'}
 $file=[IO.Path]::GetFullPath($value)
 $item=Get-Item -LiteralPath $file -Force
 if($item.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)){throw 'ACL snapshot cannot traverse a reparse path.'}
 $acl=Get-Acl -LiteralPath $file
 $sections=[Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group -bor [Security.AccessControl.AccessControlSections]::Access
 $rows += [pscustomobject]@{path=$file;sddl=$acl.GetSecurityDescriptorSddlForm($sections);owner=$acl.Owner;sections='owner,group,DACL'}
}
[IO.File]::WriteAllText($OutputPath,(ConvertTo-Json -InputObject $rows -Depth 5)+"`n",[Text.UTF8Encoding]::new($false))
