// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { signalObserverStop } from "./observer-stop.mts";

async function heldSentinelControl(reader: string, contents: string, disableModuleLoading = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "installed-observer-input-"));
  const sentinel = path.join(root, `observer-stop-${"a".repeat(64)}.sentinel`);
  const script = path.join(root, "observer.ps1");
  fs.writeFileSync(
    script,
    `$ErrorActionPreference='Stop'
${disableModuleLoading ? "$PSModuleAutoLoadingPreference='None'" : ""}
$stopSentinelPath = '${sentinel.replaceAll("'", "''")}'
${reader}
$controlWatch = [Diagnostics.Stopwatch]::StartNew()
function Write-ControlStage([string]$Stage) {
  [Console]::Error.WriteLine('[observer-sentinel-control] ' + $Stage + ' elapsedMs=' + $controlWatch.ElapsedMilliseconds)
  [Console]::Error.Flush()
}
Write-ControlStage 'initial-check-start'
if (Test-OwnedStopSentinel) { throw 'Stop arrived before discovery.' }
Write-ControlStage 'initial-check-finished'
[Console]::Out.WriteLine('before-sentinel'); [Console]::Out.Flush()
[Console]::Out.WriteLine('discovery-entered'); [Console]::Out.Flush()
$pollCount = 0
while ($true) {
  if ($pollCount -lt 2) { Write-ControlStage 'poll-check-start' }
  $observed = Test-OwnedStopSentinel
  if ($pollCount -lt 2) { Write-ControlStage 'poll-check-finished' }
  if ($observed) { break }
  if ($pollCount -lt 2) { Write-ControlStage 'poll-sleep-start' }
  [Threading.Thread]::Sleep(10)
  if ($pollCount -lt 2) { Write-ControlStage 'poll-sleep-finished' }
  $pollCount++
}
[Console]::Out.WriteLine('stop-observed'); [Console]::Out.Flush()
`,
  );
  const powershell =
    process.platform === "win32"
      ? path.join(
          process.env.SystemRoot ?? process.env.SYSTEMROOT!,
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        )
      : "pwsh";
  const child = spawn(powershell, ["-NoProfile", "-File", script], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "",
    stderr = "",
    discoveryBeforeSignal = false,
    signalFailure: unknown;
  let signalSent = false;
  let rejectDeadline: ((error: Error) => void) | undefined;
  const deadlineExpired = new Promise<never>((_, reject) => {
    rejectDeadline = reject;
  });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const armDeadline = (milliseconds: number) => {
    clearTimeout(deadline);
    deadline = setTimeout(() => {
      child.kill();
      const sentinelState = fs.statSync(sentinel, { throwIfNoEntry: false });
      rejectDeadline!(
        new Error(
          `Sentinel control timed out (signal=${signalSent}, bytes=${sentinelState?.size ?? "absent"}).\n${stdout}${stderr}`,
        ),
      );
    }, milliseconds);
  };
  armDeadline(60_000);
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
    if (stdout.includes("discovery-entered") && !signalSent) {
      // The child checked absence before announcing discovery. Publication itself
      // must enforce exclusive creation, without a parent-side existence check.
      discoveryBeforeSignal = stdout.includes("before-sentinel");
      try {
        if (contents === "") signalObserverStop(sentinel);
        else fs.writeFileSync(sentinel, contents, { flag: "wx" });
        signalSent = true;
        // Measure Stop after publication, not while the parent is publishing it.
        armDeadline(15_000);
      } catch (error) {
        signalFailure = error;
        child.kill();
      }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  try {
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    const code = await Promise.race([closed, deadlineExpired]);
    if (signalFailure) throw signalFailure;
    return { code, stdout, stderr, discoveryBeforeSignal };
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null) {
      child.stdout.destroy();
      child.stderr.destroy();
      child.kill();
      child.unref();
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("the exact observer sentinel preserves discovery before Stop", async () => {
  const source = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "control-installed-openclaw.ps1"),
    "utf8",
  );
  const reader = source.match(/^function Test-OwnedStopSentinel \{[\s\S]*?^\}$/mu)?.[0];
  assert(reader);
  assert.doesNotMatch(source, /OpenStandardInput|ReadLine/u);
  const result = await heldSentinelControl(reader, "");
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.discoveryBeforeSignal, true);
  assert.match(result.stdout, /stop-observed/u);
});

test("the exact observer sentinel rejects nonempty files", async () => {
  const source = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "control-installed-openclaw.ps1"),
    "utf8",
  );
  const reader = source.match(/^function Test-OwnedStopSentinel \{[\s\S]*?^\}$/mu)?.[0];
  assert(reader);
  const result = await heldSentinelControl(reader, "stop\n");
  assert.notEqual(result.code, 0);
  assert.equal(result.discoveryBeforeSignal, true);
  assert.match(result.stderr, /empty regular file/u);
});

test("Stop does not depend on loading a PowerShell provider module", async () => {
  const source = fs.readFileSync(
    new URL("./control-installed-openclaw.ps1", import.meta.url),
    "utf8",
  );
  const reader = source.match(/^function Test-OwnedStopSentinel \{[\s\S]*?^\}$/mu)?.[0];
  assert(reader);
  const result = await heldSentinelControl(reader, "", true);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.discoveryBeforeSignal, true);
  assert.match(result.stdout, /stop-observed/u);
});

test("installed observers receive private runner-owned controls", () => {
  for (const name of ["qualify-installed-openclaw.mts", "qualify-installed-hermes.mts"]) {
    const source = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), name),
      "utf8",
    );
    assert.match(source, /RUNNER_TEMP: runnerTemp/u);
    assert.match(source, /NEMOCLAW_OBSERVER_CONTROLLER_PID: String\(process\.pid\)/u);
    assert.match(source, /NEMOCLAW_OBSERVER_STOP_SENTINEL: observerStopSentinel/u);
    assert.match(source, /stdio: \["ignore", "pipe", "pipe"\]/u);
  }
});

test("Stop exclusively creates an empty file and refuses existing paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "observer-stop-"));
  const sentinel = path.join(root, "stop.sentinel");
  try {
    signalObserverStop(sentinel);
    const empty = fs.openSync(sentinel, "r");
    try {
      assert.equal(fs.fstatSync(empty).size, 0);
    } finally {
      fs.closeSync(empty);
    }
    assert.throws(() => signalObserverStop(sentinel), { code: "EEXIST" });
    const occupied = path.join(root, "occupied.sentinel");
    const retainedFile = fs.openSync(occupied, "wx+", 0o600);
    try {
      fs.writeFileSync(retainedFile, "retain");
      assert.throws(() => signalObserverStop(occupied), { code: "EEXIST" });
      const retained = Buffer.alloc(6);
      assert.equal(fs.readSync(retainedFile, retained, 0, retained.length, 0), retained.length);
      assert.equal(retained.toString("utf8"), "retain");
    } finally {
      fs.closeSync(retainedFile);
    }
    assert.throws(() => signalObserverStop(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Stop refuses a hard-linked path without changing its target", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "observer-stop-link-"));
  const target = path.join(root, "retained.txt");
  const sentinel = path.join(root, "stop.sentinel");
  const retainedFile = fs.openSync(target, "wx+", 0o600);
  try {
    fs.writeFileSync(retainedFile, "retain");
    fs.linkSync(target, sentinel);
    assert.throws(() => signalObserverStop(sentinel), { code: "EEXIST" });
    const retained = Buffer.alloc(6);
    assert.equal(fs.readSync(retainedFile, retained, 0, retained.length, 0), retained.length);
    assert.equal(retained.toString("utf8"), "retain");
  } finally {
    fs.closeSync(retainedFile);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function failureNoticeControls(body: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "observer-failure-control-"));
  const source = fs.readFileSync(
    new URL("./control-installed-openclaw.ps1", import.meta.url),
    "utf8",
  );
  const functions = ["Assert-OwnedFailureNoticeIdentity", "Read-OwnedFailureSnapshot"].map(
    (name) => {
      const value = source.match(
        new RegExp(`^function ${name}[^\\n]*\\{[\\s\\S]*?^\\}`, "mu"),
      )?.[0];
      assert(value, name);
      return value;
    },
  );
  const script = path.join(root, "control.ps1");
  fs.writeFileSync(
    script,
    `$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
${functions.join("\n")}
$testRoot = '${root.replaceAll("'", "''")}'
function Reject([scriptblock]$Action) {
  $rejected = $false
  try { $null = & $Action } catch { $rejected = $true }
  if (-not $rejected) { throw 'Invalid failure notice was accepted.' }
}
${body}
[Console]::Out.WriteLine('failure-controls-passed')
`,
  );
  const powershell =
    process.platform === "win32"
      ? path.join(
          process.env.SystemRoot ?? process.env.SYSTEMROOT!,
          "System32/WindowsPowerShell/v1.0/powershell.exe",
        )
      : "pwsh";
  const child = spawn(powershell, ["-NoProfile", "-File", script], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "",
    stderr = "",
    timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 60_000);
  child.stdout.on("data", (data: Buffer) => {
    stdout += data.toString("utf8");
  });
  child.stderr.on("data", (data: Buffer) => {
    stderr += data.toString("utf8");
  });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(timedOut, false, stdout + stderr);
    assert.equal(code, 0, stdout + stderr);
    assert.match(stdout, /failure-controls-passed/u);
  } finally {
    clearTimeout(timer);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("failure notice requires the held host, session and failed action, not a shutdown timeout", async () => {
  await failureNoticeControls(`
$started = [datetime]::UtcNow.AddMinutes(-1)
function Identity {
  $hostOwner = [pscustomobject]@{ Id=111; HasExited=$false; StartTime=$started; MainModule=[pscustomobject]@{ FileName='host.exe' } }
  $sessionOwner = [pscustomobject]@{ Id=222; HasExited=$false; StartTime=$started; MainModule=[pscustomobject]@{ FileName='ui.exe' } }
  $window = [pscustomobject]@{ Current=[pscustomobject]@{ ProcessId=222; Name='NemoClaw Hermes session' } }
  $button = [pscustomobject]@{ Current=[pscustomobject]@{ ProcessId=222; AutomationId='NativeWebSessionStop'; Name='Close'; IsEnabled=$true } }
  $open = [pscustomobject]@{ Current=[pscustomobject]@{ ProcessId=222; AutomationId='NativeWebSessionOpen'; Name='Open diagnostics' } }
  return @($hostOwner, $sessionOwner, $started, $started, 'host.exe', 'ui.exe', $window, $button, $open)
}
$identityInputs = Identity
if ((Assert-OwnedFailureNoticeIdentity @identityInputs) -cne 'hermes') { throw 'Wrong agent.' }
$identityInputs[6].Current.Name='NemoClaw OpenClaw session'
if ((Assert-OwnedFailureNoticeIdentity @identityInputs) -cne 'openclaw') { throw 'Wrong sibling agent.' }
foreach ($change in @(
  { $identityInputs[0].HasExited=$true }, { $identityInputs[1].HasExited=$true },
  { $identityInputs[0].StartTime=$started.AddSeconds(1) }, { $identityInputs[1].StartTime=$started.AddSeconds(1) },
  { $identityInputs[0].MainModule.FileName='other.exe' }, { $identityInputs[1].MainModule.FileName='other.exe' },
  { $identityInputs[6].Current.ProcessId=333 }, { $identityInputs[7].Current.ProcessId=333 }, { $identityInputs[8].Current.ProcessId=333 },
  { $identityInputs[6].Current.Name='Unrelated window' }, { $identityInputs[7].Current.Name='Stop session' },
  { $identityInputs[7].Current.IsEnabled=$false }, { $identityInputs[8].Current.Name='Open Web UI' },
  { $identityInputs[7].Current.AutomationId='Other' }, { $identityInputs[8].Current.AutomationId='Other' },
  { $identityInputs[6]=$null }, { $identityInputs[7]=$null }, { $identityInputs[8]=$null }
)) { $identityInputs = Identity; . $change; Reject { Assert-OwnedFailureNoticeIdentity @identityInputs } }
`);
});

test("failure snapshot admission is bounded, fresh, host-bound and never success evidence", async () => {
  await failureNoticeControls(`
$started = [datetime]::UtcNow.AddMinutes(-1)
$file = [IO.Path]::Combine($testRoot, 'session-failure.json')
function Snapshot {
  return @{ schemaVersion=1; classification='native-session-failure-evidence'; agent='hermes'; interface='dashboard'; nodeProcessId=111; backendCleanupFinished=$true; stage='sandbox'; diagnostics=@{ schemaVersion=1; classification='native-session-failure'; agent='hermes'; stage='sandbox'; recordedAt=[datetime]::UtcNow.ToString('O'); failure=@{message='private diagnostic text'} } }
}
function Publish($Value) { [IO.File]::WriteAllText($file, ($Value | ConvertTo-Json -Depth 8 -Compress), [Text.UTF8Encoding]::new($false)) }
function Read-Snapshot { Read-OwnedFailureSnapshot $file $testRoot 111 $started 'hermes' }
Publish (Snapshot)
$accepted = Read-Snapshot
if ($accepted.snapshotSha256 -cnotmatch '^[a-f0-9]{64}$' -or $accepted.hostPid -ne 111 -or -not $accepted.backendCleanupFinished) { throw 'No bound failure evidence.' }
if (($accepted | ConvertTo-Json) -match 'private diagnostic text|diagnosticPath|stop-invoked') { throw 'Failure evidence leaked or became Stop evidence.' }
foreach ($change in @(
  { $value.schemaVersion='1' }, { $value.schemaVersion=2 }, { $value.classification='native-session-success' },
  { $value.agent='openclaw' }, { $value.interface='console' }, { $value.nodeProcessId=112 }, { $value.nodeProcessId='111' },
  { $value.agent=@('hermes') }, { $value.stage=@('sandbox') }, { $value.diagnostics.schemaVersion='1' },
  { $value.diagnostics.agent=@('hermes') },
  { $value.backendCleanupFinished=$false }, { $value.backendCleanupFinished='true' }, { $value.Remove('backendCleanupFinished') },
  { $value.stage='unknown' }, { $value.diagnostics.classification='native-session-success' },
  { $value.diagnostics.agent='openclaw' }, { $value.diagnostics.stage='cleanup' },
  { $value.diagnostics.failure=$null }, { $value.diagnostics.failure='error' },
  { $value.diagnostics.recordedAt=$started.AddSeconds(-1).ToString('O') },
  { $value.diagnostics.recordedAt=[datetime]::UtcNow.AddMinutes(5).ToString('O') }
)) { $value=Snapshot; . $change; Publish $value; Reject { Read-Snapshot } }
Publish (Snapshot)
[IO.File]::SetLastWriteTimeUtc($file, $started.AddMinutes(-1))
Reject { Read-Snapshot }
[IO.File]::WriteAllText($file, 'malformed-private-marker')
$parseFailure=$null
try { $null = Read-Snapshot } catch { $parseFailure=$_.Exception.Message }
if ($null -eq $parseFailure -or $parseFailure -match 'malformed-private-marker') { throw 'Malformed snapshot accepted or exposed diagnostic text.' }
[IO.File]::WriteAllText($file, ('x' * 1048577))
Reject { Read-Snapshot }
[IO.File]::WriteAllText($file, '')
Reject { Read-Snapshot }
[IO.File]::Delete($file)
Reject { Read-Snapshot }
Publish (Snapshot)
Reject { Read-OwnedFailureSnapshot $file ([IO.Path]::Combine($testRoot, 'other')) 111 $started 'hermes' }
`);
});

test("failed notice closure remains a separate nonzero terminal path", () => {
  const source = fs.readFileSync(
    new URL("./control-installed-openclaw.ps1", import.meta.url),
    "utf8",
  );
  const failureAction = source
    .split("$button.Current.Name -ceq 'Close') {")[1]
    ?.split("} elseif (-not $stopped)")[0];
  assert(failureAction);
  assert.match(failureAction, /Read-OwnedFailureSnapshot/u);
  assert.equal(failureAction.match(/Assert-OwnedFailureNoticeIdentity/gu)?.length, 2);
  assert.match(failureAction, /NativeWindowHandle -ne \$heldWindowHandle/u);
  assert.match(failureAction, /failure-notice-close-invoked/u);
  assert.doesNotMatch(failureAction, /stop-invoked|Write-StopSnapshot|\$stopped = \$true/u);
  const terminal = source
    .split("if ($failureCloseInvoked) {\n        $root.WaitForExit()")[1]
    ?.split("if (-not $stopped)")[0];
  assert(terminal);
  assert.match(terminal, /failure-notice-closed/u);
  assert.match(terminal, /exit 1/u);
  assert.doesNotMatch(terminal, /kind='closed'|Write-StopSnapshot/u);
});
