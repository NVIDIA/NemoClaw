# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Build one finished NTFS application image in Windows CI. Customer installation
# places this image as one payload object; it never expands the runtime tree.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$RuntimeRoot,
    [Parameter(Mandatory)][string]$RuntimeId,
    [Parameter(Mandatory)][string]$OutputImage,
    [Parameter(Mandatory)][string]$ReceiptPath
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -cne 'Windows_NT' -or $env:GITHUB_ACTIONS -cne 'true' -or
    $RuntimeId -cnotmatch '^[a-f0-9]{64}$') {
    throw 'Finished runtime images require an explicit Windows CI runtime identity.'
}
$RuntimeRoot = [IO.Path]::GetFullPath($RuntimeRoot)
$OutputImage = [IO.Path]::GetFullPath($OutputImage)
$ReceiptPath = [IO.Path]::GetFullPath($ReceiptPath)
foreach ($value in @($RuntimeRoot, $OutputImage, $ReceiptPath)) {
    if ($value -match '[\r\n"]') { throw 'A runtime image path cannot be represented safely.' }
}
if (-not (Test-Path -LiteralPath (Join-Path $RuntimeRoot 'runtime.manifest') -PathType Leaf) -or
    -not (Test-Path -LiteralPath (Join-Path $RuntimeRoot 'runtime.ready') -PathType Leaf) -or
    (Test-Path -LiteralPath $OutputImage) -or (Test-Path -LiteralPath $ReceiptPath)) {
    throw 'The finished runtime image inputs or outputs are invalid.'
}
$files = @(Get-ChildItem -LiteralPath $RuntimeRoot -Recurse -File -Force)
$logicalBytes = [long](($files | Measure-Object -Property Length -Sum).Sum)
$sourceManifestSha256 = (Get-FileHash -LiteralPath (Join-Path $RuntimeRoot 'runtime.manifest') -Algorithm SHA256).Hash.ToLowerInvariant()
$maximumMiB = [Math]::Max(4096, [Math]::Ceiling(($logicalBytes + 536870912) / 1MB))
$mount = Join-Path $env:RUNNER_TEMP ('nemoclaw-image-' + [guid]::NewGuid().ToString('N'))
$diskpart = Join-Path $env:SystemRoot 'System32\diskpart.exe'
$script = Join-Path $env:RUNNER_TEMP ('nemoclaw-image-' + [guid]::NewGuid().ToString('N') + '.txt')
$detach = Join-Path $env:RUNNER_TEMP ('nemoclaw-image-' + [guid]::NewGuid().ToString('N') + '-detach.txt')
$receipt = [ordered]@{
    schemaVersion = 1
    classification = 'finished-runtime-application-image'
    runtimeId = $RuntimeId
    status = 'failed'
    format = 'vhdx'
    filesystem = 'ntfs'
    payloadObjects = 1
    source = @{ files = $files.Count; logicalBytes = $logicalBytes }
    customerExtractionRequired = $false
    runtimeLaunchCopiesRequired = $false
    mountedReadOnly = $true
}
$primary = $null
try {
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($OutputImage)) | Out-Null
    [IO.Directory]::CreateDirectory($mount) | Out-Null
    @(
        "create vdisk file=`"$OutputImage`" maximum=$maximumMiB type=expandable"
        "select vdisk file=`"$OutputImage`""
        'attach vdisk'
        'create partition primary'
        'format fs=ntfs quick unit=4096 label=NemoClawRuntime'
        "assign mount=`"$mount`""
        'exit'
    ) | Set-Content -LiteralPath $script -Encoding ascii
    & $diskpart /s $script | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Runtime image creation failed with status $LASTEXITCODE." }
    & (Join-Path $env:SystemRoot 'System32\compact.exe') /C /I /Q $mount | Out-Null
    $compressionProbe = Join-Path $mount '.nemoclaw-compression-probe'
    [IO.File]::WriteAllBytes($compressionProbe, [byte[]]::new(65536))
    $compressionInherited = (Get-Item -LiteralPath $compressionProbe).Attributes.HasFlag([IO.FileAttributes]::Compressed)
    Remove-Item -LiteralPath $compressionProbe -Force
    if ($LASTEXITCODE -ne 0 -or -not $compressionInherited) {
        throw 'The runtime image NTFS root could not enable inherited compression.'
    }
    $copyLog = [IO.Path]::ChangeExtension($ReceiptPath, '.robocopy.log')
    & (Join-Path $env:SystemRoot 'System32\robocopy.exe') $RuntimeRoot $mount /E /MOV /COPY:DT /DCOPY:DT /R:0 /W:0 /NP "/LOG:$copyLog" | Out-Null
    $copyStatus = $LASTEXITCODE
    $receipt['population'] = @{ status = $copyStatus; log = [IO.Path]::GetFileName($copyLog) }
    if ($copyStatus -ge 8) {
        $detail = ((Get-Content -LiteralPath $copyLog -Tail 40) -join ' | ')
        throw "Runtime image population failed with status ${copyStatus}: $detail"
    }
    $mountedFiles = @(Get-ChildItem -LiteralPath $mount -Recurse -File -Force)
    $mountedBytes = [long](($mountedFiles | Measure-Object -Property Length -Sum).Sum)
    if ($mountedFiles.Count -ne $files.Count -or $mountedBytes -ne $logicalBytes -or
        (Get-FileHash -LiteralPath (Join-Path $mount 'runtime.manifest') -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sourceManifestSha256) {
        throw 'The mounted runtime manifest differs after image population.'
    }
    @("select vdisk file=`"$OutputImage`"", 'detach vdisk', 'compact vdisk', 'exit') |
        Set-Content -LiteralPath $detach -Encoding ascii
    & $diskpart /s $detach | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Runtime image detach failed with status $LASTEXITCODE." }
    $receipt['image'] = @{
        file = [IO.Path]::GetFileName($OutputImage)
        bytes = (Get-Item -LiteralPath $OutputImage).Length
        sha256 = (Get-FileHash -LiteralPath $OutputImage -Algorithm SHA256).Hash.ToLowerInvariant()
        maximumMiB = $maximumMiB
    }
    $receipt['innerFilesystemCompression'] = 'ntfs-inherited-before-population'
    $receipt['manifestSha256'] = $sourceManifestSha256
    $receipt.status = 'built-detached-and-verified'
} catch {
    $primary = $_
    $receipt['error'] = $_.Exception.Message
} finally {
    if (Test-Path -LiteralPath $OutputImage) {
        try {
            @("select vdisk file=`"$OutputImage`"", 'detach vdisk noerr', 'exit') |
                Set-Content -LiteralPath $detach -Encoding ascii
            & $diskpart /s $detach | Out-Null
        } catch { if ($null -eq $primary) { $primary = $_ } }
    }
    foreach ($path in @($script, $detach)) { if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force } }
    if (Test-Path -LiteralPath $mount) { Remove-Item -LiteralPath $mount -Force -Recurse }
    try { [IO.File]::WriteAllText($ReceiptPath, ($receipt | ConvertTo-Json -Depth 5) + "`n", [Text.UTF8Encoding]::new($false)) }
    catch { if ($null -eq $primary) { $primary = $_ } }
}
if ($null -ne $primary) { throw $primary }
