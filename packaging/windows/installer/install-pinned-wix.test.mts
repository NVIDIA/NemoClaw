// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const script = new URL("./install-pinned-wix.ps1", import.meta.url);
const pin = JSON.parse(readFileSync(new URL("./wix-tool-input.json", import.meta.url), "utf8"));
const pwsh = process.env.NEMOCLAW_TEST_PWSH || "pwsh";

for (const scenario of [
  "success",
  "hash",
  "size",
  "download",
  "install",
  "missing-executable",
  "existing",
]) {
  test(`pinned WiX installation: ${scenario}`, () => {
    const root = mkdtempSync(join(tmpdir(), "wix-input-"));
    try {
      const bytes = Buffer.from("verified-package-fixture");
      copyFileSync(script, join(root, "install-pinned-wix.ps1"));
      writeFileSync(join(root, "fixture.nupkg"), bytes);
      writeFileSync(
        join(root, "wix-tool-input.json"),
        JSON.stringify({
          ...pin,
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        }),
      );
      const command = String.raw`
$ErrorActionPreference = 'Stop'
$root = ${quote(root)}
$scenario = ${quote(scenario)}
$tools = Join-Path $root 'tools with spaces & symbols'
$global:downloaded = $false
$global:installed = $false
$env:NUGET_PACKAGES = 'original-package-cache'
$env:NUGET_HTTP_CACHE_PATH = 'original-http-cache'
$env:NUGET_FALLBACK_PACKAGES = 'unverified-fallback'
function Invoke-WebRequest {
    param($Uri, $OutFile, $TimeoutSec)
    $global:downloaded = $true
    if ($Uri -cne 'https://api.nuget.org/v3-flatcontainer/wix/5.0.2/wix.5.0.2.nupkg' -or $TimeoutSec -ne 120) { throw 'wrong download' }
    if ($scenario -eq 'download') { throw 'download failed' }
    $bytes = [IO.File]::ReadAllBytes((Join-Path $root 'fixture.nupkg'))
    if ($scenario -eq 'hash') { $bytes[0] = $bytes[0] -bxor 1 }
    if ($scenario -eq 'size') { $bytes = $bytes[0..($bytes.Length - 2)] }
    [IO.File]::WriteAllBytes($OutFile, $bytes)
}
function dotnet {
    $global:installed = $true
    $expected = @('tool', 'install', 'wix', '--version', '5.0.2', '--tool-path', $tools, '--configfile', (Join-Path $tools 'NuGet.Config'), '--no-cache')
    if (($args | ConvertTo-Json -Compress) -cne ($expected | ConvertTo-Json -Compress)) { throw 'wrong install arguments' }
    $config = [xml](Get-Content -LiteralPath $expected[8] -Raw)
    if ($config.configuration.packageSources.ChildNodes.Count -ne 2 -or
        $config.configuration.packageSources.clear -eq $null -or
        $config.configuration.packageSources.add.value -cne (Join-Path $tools 'verified-feed') -or
        $config.configuration.fallbackPackageFolders.clear -eq $null -or
        $config.configuration.config.add.value -cne (Join-Path $tools 'packages') -or
        $env:NUGET_PACKAGES -cne (Join-Path $tools 'packages') -or
        $env:NUGET_HTTP_CACHE_PATH -cne (Join-Path $tools 'http-cache') -or
        $env:NUGET_FALLBACK_PACKAGES) { throw 'ambient package source or cache' }
    if ($scenario -ne 'missing-executable') { [IO.File]::WriteAllText((Join-Path $tools 'wix.exe'), 'fixture only') }
    $global:LASTEXITCODE = $(if ($scenario -eq 'install') { 1 } else { 0 })
}
if ($scenario -eq 'existing') { [void][IO.Directory]::CreateDirectory($tools) }
$failure = $null
try { & (Join-Path $root 'install-pinned-wix.ps1') -ToolDirectory $tools }
catch { $failure = $_.Exception.Message }
if ($env:NUGET_PACKAGES -cne 'original-package-cache' -or $env:NUGET_HTTP_CACHE_PATH -cne 'original-http-cache' -or $env:NUGET_FALLBACK_PACKAGES -cne 'unverified-fallback') { throw 'environment not restored' }
@{ downloaded=$global:downloaded; installed=$global:installed; failure=$failure; receipt=(Test-Path -LiteralPath (Join-Path $tools 'wix-input.json')) } | ConvertTo-Json -Compress
`;
      const result = spawnSync(
        pwsh,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
        {
          encoding: "utf8",
          timeout: 20_000,
        },
      );
      assert.equal(result.status, 0, result.stderr || String(result.error));
      const observed = JSON.parse(result.stdout);
      assert.equal(observed.downloaded, scenario !== "existing", result.stdout);
      assert.equal(
        observed.installed,
        ["success", "install", "missing-executable"].includes(scenario),
      );
      assert.equal(observed.receipt, scenario === "success", result.stdout);
      const errors: Record<string, string> = {
        hash: "WiX package bytes differ",
        size: "WiX package bytes differ",
        download: "download failed",
        install: "Installing the verified WiX package failed",
        "missing-executable": "did not produce its executable",
        existing: "fresh tool directory",
      };
      if (scenario === "success") assert.equal(observed.failure, null);
      else assert.match(observed.failure, new RegExp(errors[scenario]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
