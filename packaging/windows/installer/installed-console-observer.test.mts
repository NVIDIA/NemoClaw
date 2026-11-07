// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test(
  "session observation rejects linked and oversized files and redirected directories",
  {
    skip: process.platform !== "win32",
  },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nc-pi-session-test-"));
    try {
      const script = `
$ErrorActionPreference='Stop'
Add-Type -Path $env:OBSERVER_SOURCE
$root=[IO.Path]::GetFullPath($env:OBSERVER_FIXTURE)
$encoded='--'+$root.TrimStart('/','\\').Replace('/','-').Replace('\\','-').Replace(':','-')+'--'
$directory=Join-Path $root ('.pi/agent/sessions/'+$encoded)
$null=[IO.Directory]::CreateDirectory($directory)
$file=Join-Path $directory 'test.jsonl'
[IO.File]::WriteAllText($file, "session-fixture"+[char]10)
$documents=[NemoClaw.InstalledConsole.Observer]::ReadSessionFiles($root)
if ($documents.Count -ne 1 -or [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($documents[0])) -cne ("session-fixture"+[char]10)) { throw 'Missing actual file evidence' }
$link=Join-Path $root 'hard-link'
$null=New-Item -ItemType HardLink -Path $link -Target $file
$rejected=$false; try { $null=[NemoClaw.InstalledConsole.Observer]::ReadSessionFiles($root) } catch { $rejected=$true }
if (-not $rejected) { throw 'Accepted linked session file' }
Remove-Item -LiteralPath $link
[IO.File]::WriteAllText($file, ('x'*1048577))
$rejected=$false; try { $null=[NemoClaw.InstalledConsole.Observer]::ReadSessionFiles($root) } catch { $rejected=$true }
if (-not $rejected) { throw 'Accepted oversized session file' }
Remove-Item -LiteralPath $file
$moved=Join-Path $root 'moved-sessions'
[IO.Directory]::Move($directory, $moved)
$null=New-Item -ItemType Junction -Path $directory -Target $moved
$rejected=$false; try { $null=[NemoClaw.InstalledConsole.Observer]::ReadSessionFiles($root) } catch { $rejected=$true }
if (-not $rejected) { throw 'Accepted redirected session directory' }
Remove-Item -LiteralPath $directory
Write-Output 'SESSION_OBSERVER_PASS'
`;
      const result = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        {
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(([key]) =>
                /^(SystemRoot|WINDIR|PATH|PATHEXT|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|OS)$/iu.test(
                  key,
                ),
              ),
            ),
            OBSERVER_SOURCE: fileURLToPath(
              new URL("./InstalledConsoleObserver.cs", import.meta.url),
            ),
            OBSERVER_FIXTURE: root,
          },
          encoding: "utf8",
          windowsHide: true,
          timeout: 30000,
        },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes("SESSION_OBSERVER_PASS"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "console observer targets an owned hidden console and rejects control input",
  {
    skip: process.platform !== "win32",
  },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nc-pi-console-test-"));
    try {
      const fixture = path.join(root, "fixture.cjs");
      fs.writeFileSync(
        fixture,
        `
if (!process.stdin.isTTY || !process.stdout.isTTY) process.exit(2);
process.stdin.setRawMode(true);
process.stdout.write("OWNED_CONSOLE_READY\\n");
let text = "";
process.stdin.on("data", (chunk) => {
  text += chunk.toString();
  if (text.includes("CONSOLE_INPUT_PROOF\\r")) {
    process.stdout.write("OWNED_REPLY_PROOF\\n");
    text = "";
  }
  if (text.includes("/quit\\r")) process.exit(0);
});
setTimeout(() => process.exit(3), 30000);
`,
      );
      const script = `
$ErrorActionPreference='Stop'
Add-Type -Path $env:OBSERVER_SOURCE
$writer=[IO.StreamWriter]::new([Console]::OpenStandardOutput()); $writer.AutoFlush=$true
$child=$null; $observer=$null
try {
  $child=Start-Process -FilePath $env:OBSERVER_NODE -ArgumentList ('"'+$env:OBSERVER_FIXTURE+'"') -WindowStyle Hidden -PassThru
  $null=$child.Handle
  $clock=[Diagnostics.Stopwatch]::StartNew()
  while ($null -eq $observer -and $clock.ElapsedMilliseconds -lt 10000 -and -not $child.HasExited) {
    try { $observer=[NemoClaw.InstalledConsole.Observer]::new($child) } catch { Start-Sleep -Milliseconds 50 }
  }
  if ($null -eq $observer) { throw 'No owned console' }
  while ((-not $observer.RawInput -or -not $observer.ReadScreen().Contains('OWNED_CONSOLE_READY')) -and $clock.ElapsedMilliseconds -lt 10000) { Start-Sleep -Milliseconds 50 }
  if (-not $observer.RawInput -or -not $observer.ReadScreen().Contains('OWNED_CONSOLE_READY')) { throw 'Fixture raw input unavailable' }
  foreach ($invalid in @('', ('x'*2049), ("forbidden"+[char]27), ("forbidden"+[char]13), ([string][char]233))) {
    $rejected=$false
    try { $observer.Submit($invalid) } catch { $rejected=$true }
    if (-not $rejected) { throw 'Accepted invalid input' }
  }
  $observer.Submit('CONSOLE_INPUT_PROOF')
  while (-not $observer.ReadScreen().Contains('OWNED_REPLY_PROOF') -and $clock.ElapsedMilliseconds -lt 15000) { Start-Sleep -Milliseconds 50 }
  if (-not $observer.ReadScreen().Contains('OWNED_REPLY_PROOF')) { throw 'Console response absent' }
  $observer.Submit('/quit')
  if (-not $child.WaitForExit(5000) -or $child.ExitCode -ne 0) { throw 'Fixture did not stop' }
  $rejected=$false
  try { $observer.Submit('after-exit') } catch { $rejected=$true }
  if (-not $rejected) { throw 'Accepted input after exit' }
  $writer.WriteLine('CONSOLE_OBSERVER_PASS')
} finally {
  if ($null -ne $observer) { $observer.Dispose() }
  if ($null -ne $child) { if (-not $child.HasExited) { $child.Kill(); $null=$child.WaitForExit(5000) }; $child.Dispose() }
  $writer.Dispose()
}
`;
      const result = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        {
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(([key]) =>
                /^(SystemRoot|WINDIR|PATH|PATHEXT|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|OS)$/iu.test(
                  key,
                ),
              ),
            ),
            OBSERVER_NODE: process.execPath,
            OBSERVER_SOURCE: fileURLToPath(
              new URL("./InstalledConsoleObserver.cs", import.meta.url),
            ),
            OBSERVER_FIXTURE: fixture,
          },
          encoding: "utf8",
          windowsHide: true,
          timeout: 45000,
        },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes("CONSOLE_OBSERVER_PASS"), result.stdout);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
