# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$InstallRoot,
    [Parameter(Mandatory)][string]$ReceiptPath,
    [ValidateSet('openclaw', 'hermes', 'langchain-deepagents-code', 'pi', 'nemocua')]
    [string[]]$Agents = @('openclaw', 'hermes', 'langchain-deepagents-code', 'pi', 'nemocua'),
    [ValidateSet('Present', 'Absent')][string]$Expected = 'Present'
)

$ErrorActionPreference = 'Stop'
$desktop = [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)
$normalizedInstallRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\', '/')
$launcher = Join-Path $normalizedInstallRoot 'bin\NemoClaw.exe'
$names = @{ openclaw = 'OpenClaw'; hermes = 'Hermes'; 'langchain-deepagents-code' = 'Deep Agents'; pi = 'Pi'; nemocua = 'NemoCUA' }
$expectedLinks = @([pscustomobject]@{ Name = 'NemoClaw Setup'; Arguments = '--installer'; Icon = 'NemoClaw' })
foreach ($agent in $Agents) {
    $expectedLinks += [pscustomobject]@{ Name = "NemoClaw $($names[$agent])"; Arguments = "--configured --agent $agent"; Icon = $agent }
}
$shell = New-Object -ComObject WScript.Shell
$records = @()
try {
    foreach ($expectedLink in $expectedLinks) {
        $path = Join-Path $desktop ($expectedLink.Name + '.lnk')
        if ($Expected -eq 'Absent') {
            if (Test-Path -LiteralPath $path) { throw "Uninstall retained an owned desktop link: $($expectedLink.Name)" }
            $records += [pscustomobject]@{ name = $expectedLink.Name; absent = $true }
            continue
        }
        $file = Get-Item -LiteralPath $path
        if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'A desktop link is not an ordinary file.' }
        $link = $shell.CreateShortcut($path)
        try {
            $icon = (Join-Path $normalizedInstallRoot "desktop-icons\$($expectedLink.Icon).ico") + ',0'
            if ($link.TargetPath -ine $launcher -or $link.Arguments -cne $expectedLink.Arguments -or
                $link.IconLocation -ine $icon -or $link.Description -cne 'NVIDIA NemoClaw native desktop shortcut v1') {
                throw "The actual Windows shortcut target, arguments, icon, or ownership marker is wrong: $($expectedLink.Name)"
            }
            $records += [pscustomobject]@{ name = $expectedLink.Name; target = $link.TargetPath; arguments = $link.Arguments; icon = $link.IconLocation; nativeShellLink = $true }
        } finally { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($link) | Out-Null }
    }
} finally { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) | Out-Null }
$receipt = [ordered]@{ schemaVersion = 1; classification = 'native-windows-desktop-shortcut-qualification'; expected = $Expected; passed = $true; links = $records }
if (Test-Path -LiteralPath $ReceiptPath) { throw 'The shortcut qualification receipt already exists.' }
[IO.File]::WriteAllText($ReceiptPath, (($receipt | ConvertTo-Json -Depth 8) + [Environment]::NewLine), (New-Object Text.UTF8Encoding($false)))
