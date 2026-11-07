// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const builder = fileURLToPath(new URL("./build-finished-runtime-image.ps1", import.meta.url));
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

for (const scenario of [
  { name: "small prerequisite", bytes: 100_000_000, files: 10, directories: 4, maximumMiB: 4096 },
  {
    name: "recorded Hermes payload",
    bytes: 1_285_376_202,
    files: 48_460,
    directories: 6161,
    maximumMiB: 4855,
  },
  { name: "many small files", bytes: 100_000, files: 100_000, directories: 1, maximumMiB: 6827 },
  { name: "large payload", bytes: 8 * 1024 ** 3, files: 1, directories: 1, maximumMiB: 8769 },
]) {
  test(`runtime image capacity: ${scenario.name}`, () => {
    const command = String.raw`
$ErrorActionPreference = 'Stop'
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(${quote(builder)}, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
$function = @($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Get-RuntimeImageCapacity'}, $true))
if ($function.Count -ne 1) { throw 'missing capacity function' }
. ([scriptblock]::Create($function[0].Extent.Text))
Get-RuntimeImageCapacity -LogicalBytes ${scenario.bytes} -FileCount ${scenario.files} -DirectoryCount ${scenario.directories} | ConvertTo-Json -Compress
`;
    const result = spawnSync(
      process.env.NEMOCLAW_TEST_PWSH || "pwsh",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      { encoding: "utf8", timeout: 20_000 },
    );
    assert.equal(result.status, 0, result.stderr || String(result.error));
    const observed = JSON.parse(result.stdout);
    const allowance = scenario.files * 65_536 + scenario.directories * 4096 + 64 * 1024 ** 2;
    assert.equal(observed.allocationAllowanceBytes, allowance);
    assert.equal(observed.requiredPayloadBytes, scenario.bytes + allowance);
    assert.equal(observed.maximumMiB, scenario.maximumMiB);
    assert.ok(observed.maximumMiB * 1024 ** 2 >= observed.requiredPayloadBytes + 512 * 1024 ** 2);
  });
}

for (const scenario of [
  "sufficient",
  "backing-full",
  "inner-full",
  "undersized",
  "oversized",
  "wrong-filesystem",
  "ambiguous-backing",
  "ambiguous-inner",
]) {
  test(`runtime image storage: ${scenario}`, () => {
    const command = String.raw`
$ErrorActionPreference = 'Stop'
$scenario = ${quote(scenario)}
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(${quote(builder)}, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
foreach ($name in @('Get-RuntimeImageStorage', 'Assert-RuntimeImageStorage')) {
    $function = @($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name}, $true))
    if ($function.Count -ne 1) { throw 'missing storage function' }
    . ([scriptblock]::Create($function[0].Extent.Text))
}
function Get-Volume {
    param($FilePath, $Path, $ErrorAction)
    if ($FilePath -ceq 'image.vhdx') {
        if ($scenario -eq 'ambiguous-backing') { return @() }
        return [pscustomobject]@{Path='backing'; Size=100GB; SizeRemaining=$(if ($scenario -eq 'backing-full') { 1GB } else { 20GB })}
    }
    if ($Path -cne 'volume-root') { throw 'wrong volume query' }
    $volume = [pscustomobject]@{Path='inner'; Size=4GB-1MB; SizeRemaining=3GB; FileSystem='NTFS'}
    if ($scenario -eq 'inner-full') { $volume.SizeRemaining = 1MB }
    if ($scenario -eq 'undersized') { $volume.Size = 2GB }
    if ($scenario -eq 'oversized') { $volume.Size = 100GB }
    if ($scenario -eq 'wrong-filesystem') { $volume.FileSystem = 'ReFS' }
    if ($scenario -eq 'ambiguous-inner') { return @($volume, $volume) }
    return $volume
}
function Get-Item { param($LiteralPath) if ($LiteralPath -cne 'image.vhdx') { throw 'wrong image query' }; return @{Length=64MB} }
$failure = $null; $storage = $null
try {
    $storage = Get-RuntimeImageStorage -ImagePath 'image.vhdx' -VolumeRoot 'volume-root'
    Assert-RuntimeImageStorage -Storage $storage -MaximumBytes 4GB -RequiredPayloadBytes 2GB
} catch { $failure = $_.Exception.Message }
@{failure=$failure; storage=$storage} | ConvertTo-Json -Depth 5 -Compress
`;
    const result = spawnSync(
      process.env.NEMOCLAW_TEST_PWSH || "pwsh",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      { encoding: "utf8", timeout: 20_000 },
    );
    assert.equal(result.status, 0, result.stderr || String(result.error));
    const observed = JSON.parse(result.stdout);
    if (scenario === "sufficient") {
      assert.equal(observed.failure, null);
      assert.equal(observed.storage.backing.freeBytes, 20 * 1024 ** 3);
      assert.equal(observed.storage.inner.freeBytes, 3 * 1024 ** 3);
      assert.equal(observed.storage.imageBytes, 64 * 1024 ** 2);
    } else {
      const error = scenario.startsWith("ambiguous")
        ? "storage volumes are ambiguous"
        : scenario === "backing-full"
          ? "backing volume no longer"
          : "requested NTFS payload capacity";
      assert.match(observed.failure, new RegExp(error));
    }
  });
}
