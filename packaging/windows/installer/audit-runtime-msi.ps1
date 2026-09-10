# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$MsiPath,
    [Parameter(Mandatory)][string]$HelperSha256,
    [Parameter(Mandatory)][string]$ReceiptPath
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -cne 'Windows_NT') { throw 'The compiled MSI audit requires the Windows Installer API.' }
if ($HelperSha256 -cnotmatch '^[a-f0-9]{64}$' -or (Test-Path -LiteralPath $ReceiptPath)) {
    throw 'The MSI audit requires an exact helper identity and fresh receipt.'
}

if (-not ('NativeRuntimeMsiAudit' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
public static class NativeRuntimeMsiAudit {
    [DllImport("msi.dll", CharSet=CharSet.Unicode)] static extern uint MsiOpenDatabaseW(string path, IntPtr mode, out uint database);
    [DllImport("msi.dll", CharSet=CharSet.Unicode)] static extern uint MsiDatabaseOpenViewW(uint database, string query, out uint view);
    [DllImport("msi.dll")] static extern uint MsiViewExecute(uint view, uint record);
    [DllImport("msi.dll")] static extern uint MsiViewFetch(uint view, out uint record);
    [DllImport("msi.dll", CharSet=CharSet.Unicode)] static extern uint MsiRecordGetStringW(uint record, uint field, StringBuilder buffer, ref uint chars);
    [DllImport("msi.dll")] static extern uint MsiRecordReadStream(uint record, uint field, [Out] byte[] bytes, ref uint count);
    [DllImport("msi.dll")] static extern uint MsiCloseHandle(uint handle);
    [DllImport("msi.dll", CharSet=CharSet.Unicode, EntryPoint="MsiQueryProductStateW")] public static extern int ProductState(string productCode);
    public static string ProductCode(string path) {
        var rows=Rows(path,"SELECT `Value` FROM `Property` WHERE `Property`='ProductCode'",1);
        if(rows.Length!=1) throw new InvalidOperationException("MSI ProductCode is not unique."); return rows[0][0];
    }
    static void Check(uint status) { if(status!=0) throw new InvalidOperationException("Windows Installer database status " + status); }
    static string Value(uint record, uint field) {
        uint size=16384; var text=new StringBuilder((int)size);
        Check(MsiRecordGetStringW(record,field,text,ref size)); return text.ToString();
    }
    static uint Open(string path) { uint database; Check(MsiOpenDatabaseW(path,IntPtr.Zero,out database)); return database; }
    public static string[][] Rows(string path, string query, uint fields) {
        uint database=Open(path),view=0;
        try {
            Check(MsiDatabaseOpenViewW(database,query,out view)); Check(MsiViewExecute(view,0));
            var rows=new List<string[]>();
            while(true) {
                uint record; var status=MsiViewFetch(view,out record); if(status==259) break; Check(status);
                try { if(rows.Count>=1024) throw new InvalidOperationException("MSI table exceeds its bound.");
                    var row=new string[fields]; for(uint index=0;index<fields;index++) row[index]=Value(record,index+1); rows.Add(row);
                } finally { MsiCloseHandle(record); }
            }
            return rows.ToArray();
        } finally { if(view!=0) MsiCloseHandle(view); MsiCloseHandle(database); }
    }
    public static string HelperHash(string path) {
        uint database=Open(path),view=0,record=0;
        try {
            Check(MsiDatabaseOpenViewW(database,"SELECT `Data` FROM `Binary` WHERE `Name`='NativeRuntimeTransaction'",out view));
            Check(MsiViewExecute(view,0)); Check(MsiViewFetch(view,out record));
            using(var hash=SHA256.Create()) {
                var buffer=new byte[65536]; long total=0;
                while(true) { uint count=(uint)buffer.Length; Check(MsiRecordReadStream(record,1,buffer,ref count)); if(count==0) break;
                    total+=count; if(total>16*1024*1024) throw new InvalidOperationException("Embedded helper exceeds its bound.");
                    hash.TransformBlock(buffer,0,(int)count,buffer,0);
                }
                hash.TransformFinalBlock(new byte[0],0,0);
                if(total==0) throw new InvalidOperationException("Embedded helper is empty.");
                return BitConverter.ToString(hash.Hash).Replace("-","").ToLowerInvariant();
            }
        } finally { if(record!=0) MsiCloseHandle(record); if(view!=0) MsiCloseHandle(view); MsiCloseHandle(database); }
    }
}
'@
}

$receipt = [ordered]@{ schemaVersion = 1; classification = 'compiled-msi-transaction-audit';
    status = 'failed'; msiSha256 = (Get-FileHash -LiteralPath $MsiPath -Algorithm SHA256).Hash.ToLowerInvariant();
    helperSha256 = $HelperSha256; installedExecution = $false }
$primary = $null
try {
    $restartPolicy = @([NativeRuntimeMsiAudit]::Rows($MsiPath, 'SELECT `Value` FROM `Property` WHERE `Property`=''MSIRESTARTMANAGERCONTROL''', 1))
    if ($restartPolicy.Length -ne 1 -or $restartPolicy[0][0] -cne 'DisableShutdown') {
        throw 'The compiled immutable MSI must preserve running file owners for the lease boundary.'
    }
    $receipt.restartManagerControl = $restartPolicy[0][0]
    $sequence = @{}
    foreach ($row in [NativeRuntimeMsiAudit]::Rows($MsiPath, 'SELECT `Action`,`Condition`,`Sequence` FROM `InstallExecuteSequence`', 3)) {
        if ($sequence.ContainsKey($row[0])) { throw 'The MSI contains a duplicate action sequence entry.' }
        $sequence[$row[0]] = [pscustomobject]@{ condition = $row[1]; sequence = [int]$row[2] }
    }
    $actions = @{}
    foreach ($row in [NativeRuntimeMsiAudit]::Rows($MsiPath, 'SELECT `Action`,`Type`,`Source`,`Target` FROM `CustomAction`', 4)) {
        $actions[$row[0]] = [pscustomobject]@{ type = [int]$row[1]; source = $row[2]; target = $row[3] }
    }
    $owned = @('NativeRuntimeRollback','NativeRuntimeBeginInstall','NativeRuntimeBeginRemove',
        'NativeRuntimeJoinRemoval','NativeRuntimeVerify','NativeRuntimeCommitInstall','NativeRuntimeCommitRemove')
    foreach ($name in @('InstallInitialize','InstallExecute','RemoveExistingProducts','ProcessComponents','InstallFiles','InstallFinalize') + $owned) {
        if (-not $sequence.ContainsKey($name)) { throw "The MSI sequence is missing $name." }
    }
    if (-not ($sequence.InstallInitialize.sequence -lt $sequence.NativeRuntimeRollback.sequence -and
        $sequence.NativeRuntimeRollback.sequence -lt $sequence.NativeRuntimeBeginInstall.sequence -and
        $sequence.NativeRuntimeRollback.sequence -lt $sequence.NativeRuntimeBeginRemove.sequence -and
        $sequence.NativeRuntimeBeginInstall.sequence -lt $sequence.InstallExecute.sequence -and
        $sequence.NativeRuntimeBeginRemove.sequence -lt $sequence.InstallExecute.sequence -and
        $sequence.NativeRuntimeJoinRemoval.sequence -lt $sequence.InstallExecute.sequence -and
        $sequence.InstallExecute.sequence -lt $sequence.RemoveExistingProducts.sequence -and
        $sequence.RemoveExistingProducts.sequence -lt $sequence.ProcessComponents.sequence -and
        $sequence.InstallFiles.sequence -lt $sequence.NativeRuntimeVerify.sequence -and
        $sequence.NativeRuntimeVerify.sequence -lt $sequence.NativeRuntimeCommitInstall.sequence -and
        $sequence.NativeRuntimeCommitInstall.sequence -lt $sequence.InstallFinalize.sequence -and
        $sequence.NativeRuntimeCommitRemove.sequence -lt $sequence.InstallFinalize.sequence)) {
        throw 'The compiled MSI does not execute retirement before old-product removal and file mutation.'
    }
    foreach ($name in @('CreateFolders','RemoveFolders','RemoveFiles','InstallFiles','WriteRegistryValues','RemoveRegistryValues')) {
        if ($sequence.ContainsKey($name) -and $sequence[$name].sequence -le $sequence.RemoveExistingProducts.sequence) {
            throw 'A compiled MSI mutation is scheduled before protected retirement and old removal.'
        }
    }
    foreach ($name in $owned) {
        if (-not $actions.ContainsKey($name)) { throw "The MSI custom action is missing $name." }
        $action = $actions[$name]
        if (($action.type -band 0x3f) -ne 2 -or ($action.type -band 0xC00) -ne 0xC00 -or
            ($action.type -band 0xC0) -ne 0 -or $action.source -cne 'NativeRuntimeTransaction' -or
            -not $action.target.StartsWith('--runtime-msi ', [StringComparison]::Ordinal)) {
            throw 'A runtime action is not a synchronous, elevated embedded executable.'
        }
    }
    $commits = @($actions.Keys | Where-Object { ($actions[$_].type -band 0x600) -eq 0x600 })
    if ($commits.Count -ne 2 -or $commits -cnotcontains 'NativeRuntimeCommitInstall' -or
        $commits -cnotcontains 'NativeRuntimeCommitRemove' -or
        $sequence.NativeRuntimeCommitInstall.condition -cne 'NOT UPGRADINGPRODUCTCODE AND NOT (REMOVE ~= "ALL")' -or
        $sequence.NativeRuntimeCommitRemove.condition -cne 'NOT UPGRADINGPRODUCTCODE AND REMOVE ~= "ALL"') {
        throw 'Runtime admission requires the sole applicable final commit action.'
    }
    if (($actions.NativeRuntimeRollback.type -band 0x500) -ne 0x500 -or
        $sequence.NativeRuntimeRollback.condition -cne 'NOT UPGRADINGPRODUCTCODE' -or
        $sequence.NativeRuntimeJoinRemoval.condition -cne 'UPGRADINGPRODUCTCODE') {
        throw 'The root rollback and guarded nested-uninstall conditions differ from the contract.'
    }
    $actualHelper = [NativeRuntimeMsiAudit]::HelperHash($MsiPath)
    if ($actualHelper -cne $HelperSha256) { throw 'The compiled MSI embeds different native helper bytes.' }
    $receipt.sequence = $sequence; $receipt.actions = $actions; $receipt.status = 'pass'
} catch { $primary = $_; $receipt.error = $_.Exception.Message }
try {
    [IO.File]::WriteAllText($ReceiptPath, (($receipt | ConvertTo-Json -Depth 8) + "`n"), [Text.UTF8Encoding]::new($false))
} catch { if ($null -eq $primary) { throw }; Write-Warning ('MSI audit receipt could not be written: ' + $_.Exception.Message) }
if ($null -ne $primary) { throw $primary }
Write-Host 'Compiled MSI transaction ordering and embedded-helper identity passed; no installation was executed.'
