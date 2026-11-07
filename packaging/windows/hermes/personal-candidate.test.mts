// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  rendererContextBuild,
  rendererWerRequest,
  validateRendererPostmortemOwner,
  validatePersonalDiagnosticModes,
  finishRendererCaptureOwner,
  completeBrowserFirstHostControl,
  personalRequest,
  directBrowserRequest,
  primaryDebugRequest,
  directBrowserDiagnostic,
  stockBrowserEnvironment,
  inspectHermesDesktopCleanup,
  inspectPersonalNativeExecution,
  desktopAbsenceRequest,
  validateStockBrowserExecutor,
  validateBrowserUseLaunch,
  hostBrowserCompletion,
  stockDebugCompletion,
  validateJobOnlyConfiguration,
  primaryComparisonMetadata,
  completedPersonalReplayPin,
  validatePersonalReplayInput,
  verifyPersonalRuntimeInventory,
  removePersonalRoots,
  publishPersonalReceipt,
  validatePersonalBase,
  validatePersonalCompatibility,
} from "./probe-personal-candidate.mts";
import {
  parseComponent,
  personalCommand,
  withPersonalBrowserTunnel,
} from "./probe-personal-workload.mts";
import { personalBrowserEnvironment } from "./personal-native-browser.mts";
import { binaryPins, originalBinaryPins } from "../mxc-bash/bash-compat.mts";
import { originals } from "../mxc-bash/prepare-msys-aslr.mts";

const browserRuntime = "C:\\NemoClawHermesProbe-274d797050ea";
const browserOriginalNonce = "00112233445566778899aabb";
const browserNewNonce = "ffeeddccbbaa998877665544";
const browserController = "C:\\NemoClawPersonalNode-001122334455";

function nativeBrowserSelection() {
  return personalBrowserEnvironment({
    runtime: browserRuntime,
    controller: browserController,
    state: "C:\\NemoClawState-S-1-5-21-1000-hermes",
    nonce: browserOriginalNonce,
    relayToken: "a".repeat(43),
    cdpPath: "/devtools/browser/owned",
    bootstrapSha256: "b".repeat(64),
  });
}

test("Personal browser selects only its owned stage, nonce page and contained pipe", () => {
  const selected = nativeBrowserSelection();
  assert.equal(selected.BU_CDP_WS, "ws://127.0.0.1:8124/devtools/browser/owned");
  assert.equal(selected.BROWSER_CDP_URL, selected.BU_CDP_WS);
  assert.equal(selected.NEMOCLAW_AGENT_SESSION_ID, browserOriginalNonce.slice(0, 10));
  assert.equal(selected.NEMOCLAW_WORKER_ROOT, browserController + "\\workers");
  assert.equal(
    selected.NEMOCLAW_PERSONAL_BROWSER_PAGE,
    "data:text/html;base64," +
      Buffer.from(
        `<!doctype html><title>Hermes Personal proof</title><p id="sentinel">${browserOriginalNonce}</p>`,
      ).toString("base64"),
  );
  const options = {
    runtime: browserRuntime,
    controller: browserController,
    state: "C:\\NemoClawState-S-1-5-21-1000-hermes",
    nonce: browserOriginalNonce,
    relayToken: "a".repeat(43),
    cdpPath: "/devtools/browser/owned",
    bootstrapSha256: "b".repeat(64),
  };
  for (const change of [
    { controller: "C:\\workers" },
    { state: "D:\\NemoClawState-S-1-5-21-1000-hermes" },
    { nonce: "other" },
    { relayToken: "short" },
    { cdpPath: "/devtools/page/other" },
    { bootstrapSha256: "short" },
  ])
    assert.throws(() => personalBrowserEnvironment({ ...options, ...change }));
});

test("Personal retains Edge startup diagnostics after cleanup, including cleanup failure", async () => {
  const source = fs.readFileSync(new URL("./personal-native-browser.mts", import.meta.url), "utf8");
  const start = source.lastIndexOf("  } catch (error) {");
  assert(start > 0);
  const finish = new Function(
    "receipt",
    "error",
    "errorDetail",
    "close",
    "edgeOwner",
    "return " +
      stripTypeScriptTypes(
        `(async () => {${source.slice(start + "  } catch (error) {".length, source.lastIndexOf("\n  }"))}})();`,
      ),
  );
  for (const cleanupFails of [false, true]) {
    for (const hasOwner of [false, true]) {
      const receipt: Record<string, unknown> = {};
      const primary = new Error("Edge startup failed");
      const cleanup = new Error("Edge cleanup failed");
      let closed = false;
      const diagnostics = { stderr: "bounded startup evidence", exitCode: cleanupFails ? null : 0 };
      await assert.rejects(
        finish(
          receipt,
          primary,
          String,
          async () => {
            closed = true;
            if (cleanupFails) throw cleanup;
          },
          hasOwner
            ? {
                diagnostics() {
                  assert(closed);
                  return diagnostics;
                },
              }
            : undefined,
        ),
        (error: unknown) => {
          if (cleanupFails) {
            assert(error instanceof AggregateError);
            assert.deepEqual(error.errors, [primary, cleanup]);
          } else assert.equal(error, primary);
          return true;
        },
      );
      assert.equal(receipt.error, String(primary));
      assert.equal(receipt.edgeDiagnostics, hasOwner ? diagnostics : undefined);
    }
  }
});

test("Personal closes the browser tunnel after success or component failure", async () => {
  const selected = nativeBrowserSelection();
  const previous = Object.fromEntries(Object.keys(selected).map((key) => [key, process.env[key]]));
  Object.assign(process.env, selected);
  try {
    for (const failed of [false, true]) {
      const evidence: Record<string, unknown> = {};
      let opened = false,
        closed = false;
      const run = withPersonalBrowserTunnel(
        selected,
        browserOriginalNonce,
        async () => {
          assert(opened);
          assert(!closed);
          if (failed) throw new Error("component failure");
          return "component results";
        },
        evidence,
        async (options) => {
          assert.deepEqual(options, {
            relayRoot: selected.NEMOCLAW_BROWSER_RELAY_ROOT,
            relayToken: selected.NEMOCLAW_BROWSER_RELAY_TOKEN,
            sandboxPipePort: 8124,
          });
          opened = true;
          return {
            port: 8124,
            failure: new Promise<never>(() => {}),
            async close() {
              closed = true;
            },
            diagnostics: () => ({ activeConnections: 0 }),
          };
        },
      );
      if (failed) await assert.rejects(run, /component failure/u);
      else assert.equal(await run, "component results");
      assert(closed);
      assert.equal(evidence.closed, true);
      assert.equal(evidence.started, true);
    }
    process.env.BU_CDP_WS = "ws://foreign.invalid";
    await assert.rejects(
      withPersonalBrowserTunnel(
        selected,
        browserOriginalNonce,
        async () => {
          throw new Error("must not execute");
        },
        {},
        async () => {
          throw new Error("must not connect");
        },
      ),
      /declaration differs/u,
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("native Personal host retains fixed-command ownership and closure through failures", () => {
  const result = spawnSync(
    process.env.NEMOCLAW_TEST_PYTHON ?? "python3",
    ["-I", "-B", fileURLToPath(new URL("./test_personal_native_host.py", import.meta.url))],
    { encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(result.status, 0, result.stderr || String(result.error));
  assert.match(result.stderr, /Ran 9 tests/u);
  assert.match(result.stderr, /^OK(?: \(skipped=1\))?$/mu);
});

test("Personal consumes the strict same-run root proof and refuses stale or changed state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-prepared-root-"));
  const script = String.raw`
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:NEMOCLAW_PERSONAL_WRAPPER_PATH,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Personal wrapper parsing failed.'}
$functions=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Confirm-PersonalPreparedSystemRoot'},$true))
if($functions.Count -ne 1){throw 'Prepared-root consumer is missing or ambiguous.'}
Invoke-Expression $functions[0].Extent.Text
$env:GITHUB_SHA='a'*40;$env:GITHUB_RUN_ID='123';$env:GITHUB_RUN_ATTEMPT='1'
$proofPath=Join-Path $env:NEMOCLAW_PERSONAL_TEST_ROOT 'system-root-mxc-proof.json'
$proof=@{systemDriveRoot='C:\';rootSddlAfterMxc='verified fixture descriptor'}
[IO.File]::WriteAllText($proofPath,($proof|ConvertTo-Json))
$base=@{classification='same-job-system-drive-helper-build-gate';sourceRevision=$env:GITHUB_SHA;
 proofSha256=(Get-FileHash $proofPath -Algorithm SHA256).Hash.ToLowerInvariant();sameJobHostAlreadyPrepared=$true;
 mxcInput=@{workflowRunId='123';workflowRunAttempt='1'}}
$script:aclReads=0;$script:validatorFailure=$false;$script:observedSddl=$proof.rootSddlAfterMxc
function Get-Acl {param([string]$LiteralPath) if($LiteralPath -cne 'C:\'){throw 'Wrong observed root'};$script:aclReads++;return @{Sddl=$script:observedSddl}}
# The existing verifier has its own real positive/negative tests. Replace only its process boundary here.
function Invoke-PersonalChecked {param($Executable,$Arguments,$Label)
 $script:invocation=@{executable=$Executable;arguments=$Arguments;label=$Label}
 if($script:validatorFailure){throw 'Strict verifier rejected proof'}
 $destination=$Arguments[[Array]::IndexOf($Arguments,'--output')+1]
 [IO.File]::WriteAllText($destination,($script:gate|ConvertTo-Json -Depth 5))
}
$arguments=@{PythonPath='pinned-python';HostRoot=$env:NEMOCLAW_PERSONAL_TEST_ROOT;
 ProofDirectory=$env:NEMOCLAW_PERSONAL_TEST_ROOT;HelperRoot=$env:NEMOCLAW_PERSONAL_TEST_ROOT;
 EvidenceDirectory=$env:NEMOCLAW_PERSONAL_TEST_ROOT;SystemRoot='C:\';
 SourceRoot=[IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $env:NEMOCLAW_PERSONAL_WRAPPER_PATH) '../../..'))}
$script:gate=$base|ConvertTo-Json -Depth 5|ConvertFrom-Json
$accepted=Confirm-PersonalPreparedSystemRoot @arguments
$invocation=$script:invocation
$rejections=@(foreach($change in @(
 @{field='classification';value='historical-sdk-system-drive-proof'},
 @{field='sourceRevision';value=('b'*40)},
 @{field='proofSha256';value=('0'*64)},
 @{field='sameJobHostAlreadyPrepared';value=$false},
 @{field='sameJobHostAlreadyPrepared';value='true'}
)) {
 $script:gate=$base|ConvertTo-Json -Depth 5|ConvertFrom-Json
 $script:gate.($change.field)=$change.value
 try{$null=Confirm-PersonalPreparedSystemRoot @arguments;$false}catch{$true}
})
foreach($field in @('workflowRunId','workflowRunAttempt')) {
 $script:gate=$base|ConvertTo-Json -Depth 5|ConvertFrom-Json
 $script:gate.mxcInput.$field='999'
 $rejections+=try{$null=Confirm-PersonalPreparedSystemRoot @arguments;$false}catch{$true}
}
$script:gate=$base|ConvertTo-Json -Depth 5|ConvertFrom-Json
$script:observedSddl='changed permissions'
$rejections+=try{$null=Confirm-PersonalPreparedSystemRoot @arguments;$false}catch{$true}
$script:observedSddl=$proof.rootSddlAfterMxc
$arguments.SystemRoot='D:\'
$rejections+=try{$null=Confirm-PersonalPreparedSystemRoot @arguments;$false}catch{$true}
$arguments.SystemRoot='C:\'
$env:GITHUB_RUN_ID=''
$rejections+=try{$null=Confirm-PersonalPreparedSystemRoot @arguments;$false}catch{$true}
$env:GITHUB_RUN_ID='123'
$script:validatorFailure=$true;$script:aclReads=0
$rejections+=try{$null=Confirm-PersonalPreparedSystemRoot @arguments;$false}catch{$true}
$failureAclReads=$script:aclReads
$script:validatorFailure=$false
[IO.File]::AppendAllText($proofPath,' ')
$rejections+=try{$null=Confirm-PersonalPreparedSystemRoot @arguments;$false}catch{$true}
$guard=@($ast.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.IfStatementAst] -and $_.Extent.Text.StartsWith('if ($reuseSystemRoot -ne')})
if($guard.Count -ne 1){throw 'Prepared-root input guard missing'}
$inputCases=@(foreach($case in @(
 @{reuse=$true;host='host';native=$true},@{reuse=$false;host='';native=$true},
 @{reuse=$false;host='';native=$false},@{reuse=$true;host='';native=$true},
 @{reuse=$false;host='host';native=$true},@{reuse=$true;host='host';native=$false}
)) {
 $reuseSystemRoot=$case.reuse;$PreparedHostRoot=$case.host;$nativeProduction=$case.native
 try{Invoke-Expression $guard[0].Extent.Text;$true}catch{$false}
})
ConvertTo-Json -InputObject @{accepted=$accepted;invocation=$invocation;rejections=$rejections;failureAclReads=$failureAclReads;inputCases=$inputCases} -Depth 6 -Compress
`;
  try {
    const child = spawnSync(
      process.env.NEMOCLAW_TEST_PWSH ?? "pwsh",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        encoding: "utf8",
        timeout: 20_000,
        env: {
          ...process.env,
          NEMOCLAW_PERSONAL_WRAPPER_PATH: fileURLToPath(
            new URL("./probe-personal-candidate.ps1", import.meta.url),
          ),
          NEMOCLAW_PERSONAL_TEST_ROOT: root,
        },
      },
    );
    assert.equal(child.status, 0, child.stderr || String(child.error));
    const result = JSON.parse(child.stdout);
    assert.equal(result.accepted.classification, "same-run-prepared-system-root-reuse");
    assert.equal(result.accepted.rootPermissionsUnchanged, true);
    assert.equal(result.accepted.installedAcceptance, false);
    assert.match(result.accepted.proofSha256, /^[a-f0-9]{64}$/);
    assert.match(result.accepted.gateSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(result.rejections, Array(12).fill(true));
    assert.equal(result.failureAclReads, 0);
    assert.deepEqual(result.inputCases, [true, true, true, false, false, false]);
    assert.equal(result.invocation.executable, "pinned-python");
    const args = result.invocation.arguments as string[];
    assert.deepEqual(args, [
      "-I",
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "../installer/verify-system-drive-proof.py",
      ),
      "--helper",
      path.join(root, "NemoClawHostPreparation.exe"),
      "--build-receipt",
      path.join(root, "build-receipt.json"),
      "--proof-directory",
      root,
      "--source-root",
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."),
      "--source-revision",
      "a".repeat(40),
      "--node-path",
      path.join(root, "bin/node.exe"),
      "--host-payload-root",
      root,
      "--output",
      path.join(root, "prepared-system-root-gate.json"),
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Personal build selects locked ARM64 tools before starting its child build", () => {
  const script = String.raw`
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:NEMOCLAW_PERSONAL_WRAPPER_PATH,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Personal wrapper parsing failed.'}
$functions=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'New-PersonalNativeBuildCommand'},$true))
if($functions.Count -ne 1){throw 'Personal native build command is missing or ambiguous.'}
Invoke-Expression $functions[0].Extent.Text
$toolchain=Get-Content -LiteralPath $env:NEMOCLAW_PERSONAL_TOOLCHAIN_PATH -Raw|ConvertFrom-Json
$arguments=@{DeveloperCommand='C:\Program Files\Visual Studio\Common7\Tools\VsDevCmd.bat';PowerShellPath='C:\Program Files\PowerShell\7\pwsh.exe';
 ScriptPath='C:\source & tools\prepare-reused-runtime.ps1';RuntimeRoot='C:\NemoClawHermesProbe-0123456789ab';
 ArtifactDirectory='C:\build evidence\current-base';ControllerSource=('a'*40);InputFile='C:\build evidence\inputs.json';Toolchain=$toolchain}
$command=New-PersonalNativeBuildCommand @arguments
$rejections=@(foreach($field in @('DeveloperCommand','PowerShellPath','ScriptPath','RuntimeRoot','ArtifactDirectory','InputFile')) {
 foreach($bad in @('', 'C:\bad"path', 'C:\bad%PATH%', 'C:\bad!PATH!', ('C:\bad'+[char]13+[char]10+'path'))) {
  $case=$arguments.Clone();$case[$field]=$bad
  try {$null=New-PersonalNativeBuildCommand @case;$false}catch{$true}
 }
})
$invalidToolchains=@(foreach($field in @('msvcHost','msvcTarget','msvcToolset','windowsSdk')) {
 $case=$arguments.Clone();$lock=$toolchain|ConvertTo-Json|ConvertFrom-Json
 $lock.$field=if($field -in @('msvcHost','msvcTarget')){'x64'}else{'1 & exit 0'}
 $case.Toolchain=$lock
 try {$null=New-PersonalNativeBuildCommand @case;$false}catch{$true}
})
$arguments.ControllerSource='invalid'
$badSource=try {$null=New-PersonalNativeBuildCommand @arguments;$false}catch{$true}
ConvertTo-Json -InputObject @{command=$command;rejections=$rejections;toolchains=$invalidToolchains;badSource=$badSource} -Compress
`;
  const child = spawnSync(
    process.env.NEMOCLAW_TEST_PWSH ?? "pwsh",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      encoding: "utf8",
      timeout: 20_000,
      env: {
        ...process.env,
        NEMOCLAW_PERSONAL_WRAPPER_PATH: fileURLToPath(
          new URL("./probe-personal-candidate.ps1", import.meta.url),
        ),
        NEMOCLAW_PERSONAL_TOOLCHAIN_PATH: fileURLToPath(
          new URL("./official-python.lock.json", import.meta.url),
        ),
      },
    },
  );
  assert.equal(child.status, 0, child.stderr || String(child.error));
  const result = JSON.parse(child.stdout);
  assert.equal(
    result.command,
    String.raw`call "C:\Program Files\Visual Studio\Common7\Tools\VsDevCmd.bat" -arch=arm64 -host_arch=arm64 -vcvars_ver=14.51.36231 -winsdk=10.0.26100.0 && "C:\Program Files\PowerShell\7\pwsh.exe" -NoProfile -NonInteractive -File "C:\source & tools\prepare-reused-runtime.ps1" -RuntimeRoot "C:\NemoClawHermesProbe-0123456789ab" -ArtifactDirectory "C:\build evidence\current-base" -ControllerSource "${"a".repeat(40)}" -InputFile "C:\build evidence\inputs.json"`,
  );
  assert.deepEqual(result.rejections, Array(30).fill(true));
  assert.deepEqual(result.toolchains, Array(4).fill(true));
  assert.equal(result.badSource, true);
});

test("Personal wrapper removes only its current runtime after confirmed native closure", () => {
  const source = "a".repeat(40);
  const closed = {
    schemaVersion: 2,
    classification: "canonical-personal-mxc-feasibility",
    sourceRevision: source,
    runtime: browserRuntime,
    executorAttempted: true,
    rootsRetainedForUnclosedExecutor: false,
    cleanup: {
      executorClosed: true,
      nativeTeardownVerified: true,
      hostDesktopsReleased: true,
      hostDiagnosticChildrenClosed: true,
      ownedRootsRemoved: true,
      nativeStateComplete: true,
    },
  };
  const cases: { name: string; receipt: any; expected: boolean }[] = [
    { name: "closed native workload", receipt: closed, expected: true },
    {
      name: "failed workload with confirmed cleanup",
      receipt: { ...closed, feasibilityPassed: false, error: "browser failed" },
      expected: true,
    },
    {
      name: "rejected before executor with all host resources closed",
      receipt: {
        ...closed,
        executorAttempted: false,
        cleanup: {
          ...closed.cleanup,
          executorClosed: false,
          nativeTeardownVerified: false,
          hostDesktopsReleased: false,
        },
      },
      expected: true,
    },
  ];
  for (const [field, values] of Object.entries({
    schemaVersion: [1, "2", null],
    classification: ["historical-personal-proof", null],
    sourceRevision: ["b".repeat(40), null],
    runtime: ["C:\\NemoClawHermesProbe-ffffffffffff", null],
    executorAttempted: ["false", 0, null],
    rootsRetainedForUnclosedExecutor: [true, "false", 0, null],
  })) {
    for (const value of [...values, undefined]) {
      cases.push({
        name: `${field}=${String(value)}`,
        receipt: { ...closed, [field]: value },
        expected: false,
      });
    }
  }
  for (const field of Object.keys(closed.cleanup)) {
    for (const value of [false, "true", 1, null, undefined]) {
      cases.push({
        name: `cleanup.${field}=${String(value)}`,
        receipt: { ...closed, cleanup: { ...closed.cleanup, [field]: value } },
        expected: false,
      });
    }
  }
  cases.push({
    name: "missing cleanup",
    receipt: { ...closed, cleanup: undefined },
    expected: false,
  });
  const script = String.raw`
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:NEMOCLAW_PERSONAL_WRAPPER_PATH,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Personal wrapper parsing failed.'}
$functions=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Test-PersonalRuntimeRemoval'},$true))
if($functions.Count -ne 1){throw 'Personal cleanup owner is missing or ambiguous.'}
# Load only the actual deterministic production function, not the guarded live controller.
Invoke-Expression $functions[0].Extent.Text
$cases=ConvertFrom-Json $env:NEMOCLAW_PERSONAL_REMOVAL_CASES
$results=@(foreach($case in $cases){Test-PersonalRuntimeRemoval $case.receipt '${browserRuntime}' '${source}'})
$finish=($ast.EndBlock.Statements | Select-Object -Last 2 | ForEach-Object {$_.Extent.Text}) -join [Environment]::NewLine
$completion=@(foreach($status in @('pass','failed')) {
 $primary=$null;$receipt=@{status=$status}
 try {Invoke-Expression $finish; @{status=$status;accepted=$true}}
 catch {@{status=$status;accepted=$false;error=$_.Exception.Message}}
})
ConvertTo-Json -InputObject @{removal=$results;completion=$completion} -Depth 4 -Compress
`;
  const child = spawnSync(
    process.env.NEMOCLAW_TEST_PWSH ?? "pwsh",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      encoding: "utf8",
      timeout: 20_000,
      env: {
        ...process.env,
        NEMOCLAW_PERSONAL_WRAPPER_PATH: fileURLToPath(
          new URL("./probe-personal-candidate.ps1", import.meta.url),
        ),
        NEMOCLAW_PERSONAL_REMOVAL_CASES: JSON.stringify(cases),
      },
    },
  );
  assert.equal(child.status, 0, child.stderr || String(child.error));
  const results = JSON.parse(child.stdout);
  assert.equal(results.removal.length, cases.length);
  cases.forEach((row, index) => assert.equal(results.removal[index], row.expected, row.name));
  assert.equal(results.completion[0].status, "pass");
  assert.equal(results.completion[0].accepted, true);
  assert.equal(results.completion[1].status, "failed");
  assert.equal(results.completion[1].accepted, false);
  assert.match(results.completion[1].error, /production or cleanup did not pass/u);
});

test("Reused runtime cleanup requires current typed build closure evidence", () => {
  const source = "a".repeat(40);
  const closed = {
    schemaVersion: 1,
    classification: "ci-targeted-pywinpty-conpty-rebuild",
    sourceRevision: source,
    runtimeRoot: browserRuntime,
    allOwnedProcessesClosed: true,
  };
  const cases: { name: string; receipt: Record<string, unknown>; expected: boolean }[] = [
    { name: "closed build", receipt: closed, expected: true },
    {
      name: "failed build with confirmed closure",
      receipt: { ...closed, status: "failed" },
      expected: true,
    },
  ];
  for (const [field, values] of Object.entries({
    schemaVersion: ["1", true, 2, null],
    classification: ["other-build", null],
    sourceRevision: ["b".repeat(40), null],
    runtimeRoot: ["C:\\NemoClawHermesProbe-ffffffffffff", null],
    allOwnedProcessesClosed: [false, "True", "true", 1, null],
  })) {
    for (const value of [...values, undefined]) {
      cases.push({
        name: `${field}=${String(value)}`,
        receipt: { ...closed, [field]: value },
        expected: false,
      });
    }
  }
  const script = String.raw`
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:NEMOCLAW_REUSE_PATH,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Runtime reuse wrapper parsing failed.'}
$blocks=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.IfStatementAst] -and $node.Extent.Text.StartsWith('if($receipt.wheelAttempted)')},$true))
if($blocks.Count -ne 1){throw 'Build closure block is missing or ambiguous.'}
$build=[IO.Path]::GetTempPath()
$RuntimeRoot='${browserRuntime}'
$ControllerSource='${source}'
function Get-Content {param($LiteralPath,[switch]$Raw) return $script:wheelJson}
$results=@(foreach($case in (ConvertFrom-Json $env:NEMOCLAW_REUSE_CASES)) {
 foreach($hadPrimary in @($false,$true)) {
  $script:wheelJson=ConvertTo-Json -InputObject $case.receipt -Depth 4 -Compress
  $receipt=@{wheelAttempted=$true;buildProcessesClosed=$false;status='candidate-bytes-exported-unqualified'}
  $original=if($hadPrimary){[InvalidOperationException]::new('original build failure')}else{$null}
  $primary=$original
  Invoke-Expression $blocks[0].Extent.Text
  @{closed=$receipt.buildProcessesClosed;status=$receipt.status;primaryPresent=($null -ne $primary);primaryPreserved=(!$hadPrimary -or [object]::ReferenceEquals($primary,$original))}
 }
})
ConvertTo-Json -InputObject $results -Compress
`;
  const child = spawnSync(
    process.env.NEMOCLAW_TEST_PWSH ?? "pwsh",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      encoding: "utf8",
      timeout: 20_000,
      env: {
        ...process.env,
        NEMOCLAW_REUSE_PATH: fileURLToPath(
          new URL("./prepare-reused-runtime.ps1", import.meta.url),
        ),
        NEMOCLAW_REUSE_CASES: JSON.stringify(cases),
      },
    },
  );
  assert.equal(child.status, 0, child.stderr || String(child.error));
  const results = JSON.parse(child.stdout);
  assert.equal(results.length, cases.length * 2);
  cases.forEach((row, index) => {
    for (let primary = 0; primary < 2; primary++) {
      const result = results[index * 2 + primary];
      assert.equal(result.closed, row.expected, row.name);
      assert.equal(
        result.status,
        row.expected ? "candidate-bytes-exported-unqualified" : "failed",
        row.name,
      );
      assert.equal(result.primaryPresent, Boolean(primary) || !row.expected, row.name);
      assert.equal(result.primaryPreserved, true, row.name);
    }
  });
});

function nativeCompatibilityFixture() {
  const source = "a".repeat(40),
    patch = "b".repeat(64),
    digest = "c".repeat(64);
  const build = {
    schemaVersion: 1,
    classification: "mxc-msys-compatibility-prototype-build",
    status: "built",
    sourceRevision: source,
    runtimeExecuted: false,
    qualified: false,
    cleanupErrors: [],
    files: [
      ["NemoClawMsysLauncher.exe", "arm64"],
      ["NemoClawMsysCompat-arm64.dll", "arm64"],
      ["NemoClawMsysCompat-x64.dll", "x64"],
    ].map(([file, machine]) => ({ file, machine, bytes: 123, sha256: digest })),
    license: { file: "DETOURS-LICENSE.txt", bytes: 123, sha256: digest },
    sourceFiles: [
      "compat-launcher.cpp",
      "process-propagation.cpp",
      "process-propagation.h",
      "namespace-compat.cpp",
      "namespace-path.h",
      "namespace-security.h",
      "namespace-controls.cpp",
      "namespace-adapter-controls.cpp",
      "compat.def",
    ].map((path) => ({ path, sha256: digest })),
  };
  const mxc = {
    schemaVersion: 2,
    classification: "mxc-native-owned-token-inspection-build",
    status: "built",
    candidateRevision: source,
    patchSha256: patch,
    nativeOwnerIdentity: "held-primary-appcontainer-token",
    tokenQueryRepairSupported: true,
    tokenAccessMode: "owned-child-query-only",
    sourceCommit: "7cd00d1ee6af9208322c924ef64e5113f6704639",
    sourceSha256: "9467669fda03a7ad0000a7bc9e0b0d1cab44b1979ee437dd96e8b93646e18029",
    sourceBytes: 6545666,
    target: "aarch64-pc-windows-msvc",
    runtimeExecuted: false,
    qualified: false,
    compilerClosed: true,
    compilerForced: false,
    compilerExitCode: 0,
    compilerCleanupErrors: [],
    files: [{ file: "wxc-exec.exe", machine: 0xaa64, bytes: 123, sha256: digest }],
  };
  // Synthetic status records test intake. Windows produces the real signature evidence.
  const derivation = {
    classification: "ci-derived-canonical-msys-dynamic-base",
    sourceRevision: source,
    adaptation: "msys-dll-and-unsigned-bash-sh-dynamic-base",
    untouchedOfficialBytes: false,
    originalsPreserved: true,
    allOtherFilesUnchanged: true,
    arm64WrapperUnchanged: true,
    arm64ShWrapperUnchanged: true,
    derivedBashExplicitlyUnsigned: true,
    derivedShExplicitlyUnsigned: true,
    nativeChecksumVerified: true,
    derivedBashUnsignedVerified: true,
    derivedShUnsignedVerified: true,
    qualified: false,
    upstream: {
      nousCommit: "2237be355906fbe6065ce1815711eee52b2d646e",
      sha256: "f8e92cd3359fcbb96998cfd606a536ccc6dbfb23c04e12b29042f9ba45b6b0c7",
    },
    files: Object.entries(originals).map(([name, pin]) => ({
      path: name,
      beforeSha256: pin.sha256,
      afterSha256: binaryPins[name as keyof typeof binaryPins],
      beforeFlags: pin.flags,
      afterFlags: pin.flags | 0x40,
      onlyMetadataChanged: true,
      certificateDirectoryAbsent: true,
      derivedNotSigned: true,
      certificateTableRemoved: Boolean(pin.certificate),
      beforeBytes: pin.bytes,
      bytes: pin.certificate?.offset ?? pin.bytes,
      originalCertificate: pin.certificate
        ? { ...pin.certificate, authenticodeStatus: "Valid" }
        : null,
    })),
    nativeSignatures: [
      ["original-bash.exe", originalBinaryPins["usr/bin/bash.exe"], "Valid"],
      ["derived-bash.exe", binaryPins["usr/bin/bash.exe"], "NotSigned"],
      ["original-arm64-wrapper.exe", originalBinaryPins["bin/bash.exe"], "NotSigned"],
      ["original-sh.exe", originalBinaryPins["usr/bin/sh.exe"], "Valid"],
      ["derived-sh.exe", binaryPins["usr/bin/sh.exe"], "NotSigned"],
      ["original-arm64-sh-wrapper.exe", originalBinaryPins["bin/sh.exe"], "NotSigned"],
    ].map(([file, sha256, status]) => ({ file, sha256, status })),
  };
  const nonce = "0123456789abcdef01234567";
  const ids = ["base", "start", "d", "a", "b"].map(
    (role) => "nm-" + nonce.slice(0, 12) + "-" + role,
  );
  const proof = {
    schemaVersion: 2,
    classification: "small-msys-native-basecontainer-compatibility-proof",
    sourceRevision: source,
    imageVariant: "ci-derived-unsigned-msys-dll-bash-and-sh-dynamic-base",
    passed: true,
    normalCleanup: true,
    phase: "two-container-isolation",
    nonce,
    startedExecutors: 5,
    hostProcessesClosed: true,
    hostProcessesNormal: true,
    nativeExecutions: Object.fromEntries(
      ids.map((id, index) => [
        id,
        {
          logSha256: digest,
          uiMarker: id.endsWith("-d") ? nativeMarkerFixture(1234 + index) : null,
          policy: {
            event: "mxc.NetworkPolicyApplied",
            backend: "processcontainer",
            identity: "redacted",
            tier: "base-container",
            enforcement_mode: "capabilities",
            default_policy: "block",
            proxy_port: 0,
            firewall_rules_created: 0,
            firewall_applied: false,
            status: "success",
          },
          jobTeardown: {
            schemaVersion: 1,
            classification: "owned-native-MXC-job-teardown",
            stage: "before-primary-handle-release",
            clock: "GetTickCount64",
            tickMilliseconds: 5678,
            rootPid: 1234 + index,
            jobAccountingQueried: true,
            jobAccountingKnown: true,
            jobAccountingBytes: 48,
            jobAccountingExpectedBytes: 48,
            jobAccountingError: 0,
            activeProcesses: 0,
            totalProcesses: 4,
            terminatedProcesses: 0,
            rootWaitStatus: 0,
            rootSignaled: true,
            rootWaitError: 0,
          },
          uiPolicy: {
            schemaVersion: 1,
            classification: "native-MXC-ui-policy-assignment",
            stage: "before-primary-thread-resume",
            policyOrigin: "serialized-process-security-environment",
            securityEnvironmentAttached: true,
            rootPid: 1234 + index,
            uiRestrictions: 0x3ff,
            disallowWin32k: false,
            policyMutated: false,
            enforcementReadback: false,
          },
        },
      ]),
    ),
    cleanup: Object.fromEntries(
      ids.map((id) => [
        id,
        {
          nativeTeardownVerified: true,
          nativeTeardownError: null,
          shareRemoved: true,
          executor: { closed: true, forced: false, exitCode: 0, error: null, stderr: "" },
        },
      ]),
    ),
    inputs: {
      compatibility: build,
      mxcBuild: mxc,
      mxcSha256: digest,
      gitDerivation: derivation,
      git: binaryPins,
    },
  };
  return { proof, build, mxc, patch, source };
}

test("Personal native intake binds the controller, build, images and complete source set", () => {
  const f = nativeCompatibilityFixture();
  const result = validatePersonalCompatibility(f.proof, f.build, f.mxc, f.patch, f.source);
  assert.equal(result.mxcFile, f.mxc.files[0]);
  assert.deepEqual(result.gitPins, binaryPins);
  assert.equal(result.sourceRevision, f.source);
  for (const source of ["main", "d".repeat(40)])
    assert.throws(() => validatePersonalCompatibility(f.proof, f.build, f.mxc, f.patch, source));
});

test("Personal native intake rejects historical labels, mixed builds and incomplete controls", () => {
  const mutations = [
    (f: any) => {
      f.proof.schemaVersion = 1;
    },
    (f: any) => {
      f.proof.classification = "small-msys-appcontainer-compatibility-proof";
    },
    (f: any) => {
      f.proof.imageVariant = "original";
    },
    (f: any) => {
      f.proof.normalCleanup = false;
    },
    (f: any) => {
      f.proof.passed = false;
    },
    (f: any) => {
      f.build.runtimeExecuted = true;
    },
    (f: any) => {
      f.build.qualified = true;
    },
    (f: any) => {
      f.build.cleanupErrors = ["open child"];
    },
    (f: any) => {
      f.build.sourceFiles.pop();
    },
    (f: any) => {
      f.build.sourceFiles[0] = f.build.sourceFiles[1];
    },
    (f: any) => {
      f.mxc.nativeOwnerIdentity = "supplied-profile-sid";
    },
    (f: any) => {
      f.mxc.patchSha256 = "0".repeat(64);
    },
    (f: any) => {
      f.proof.inputs.mxcBuild = { ...f.mxc, compilerForced: true };
    },
    (f: any) => {
      f.proof.inputs.gitDerivation.files[0].afterSha256 = "0".repeat(64);
    },
  ];
  for (const mutate of mutations) {
    const f = nativeCompatibilityFixture();
    mutate(f);
    assert.throws(() => validatePersonalCompatibility(f.proof, f.build, f.mxc, f.patch, f.source));
  }
});

test("Personal native intake requires all five executions and their owned cleanup", () => {
  const mutateProof = [
    (p: any) => {
      delete p.nativeExecutions;
    },
    (p: any) => {
      delete p.cleanup;
    },
    (p: any) => {
      p.startedExecutors = 4;
    },
    (p: any) => {
      p.nonce = "f".repeat(24);
    },
    (p: any) => {
      p.hostProcessesClosed = false;
    },
    (p: any) => {
      p.hostProcessesNormal = false;
    },
    (p: any) => {
      p.nativeExecutions.extra = Object.values(p.nativeExecutions)[0];
    },
    (p: any) => {
      p.cleanup.extra = Object.values(p.cleanup)[0];
    },
  ];
  const validate = (f: ReturnType<typeof nativeCompatibilityFixture>) =>
    validatePersonalCompatibility(f.proof, f.build, f.mxc, f.patch, f.source);
  for (const mutate of mutateProof) {
    const f = nativeCompatibilityFixture();
    mutate(f.proof);
    assert.throws(() => validate(f));
  }
  for (const id of Object.keys(nativeCompatibilityFixture().proof.nativeExecutions)) {
    const mutations = [
      (p: any) => {
        delete p.nativeExecutions[id];
      },
      (p: any) => {
        delete p.cleanup[id];
      },
      (p: any) => {
        p.nativeExecutions[id].logSha256 = "missing";
      },
      (p: any) => {
        delete p.nativeExecutions[id].uiPolicy;
      },
      (p: any) => {
        p.nativeExecutions[id].uiPolicy.uiRestrictions = 0x3bf;
      },
      (p: any) => {
        p.nativeExecutions[id].uiPolicy.rootPid = 99;
      },
      (p: any) => {
        p.nativeExecutions[id].policy.tier = "appcontainer-dacl";
      },
      (p: any) => {
        p.nativeExecutions[id].policy.default_policy = "allow";
      },
      (p: any) => {
        p.nativeExecutions[id].policy.firewall_applied = 0;
      },
      (p: any) => {
        p.nativeExecutions[id].jobTeardown.activeProcesses = 1;
      },
      (p: any) => {
        p.nativeExecutions[id].jobTeardown.rootSignaled = false;
      },
      (p: any) => {
        p.nativeExecutions[id].jobTeardown.jobAccountingKnown = false;
      },
      (p: any) => {
        p.nativeExecutions[id].jobTeardown.jobAccountingBytes = 0;
      },
      (p: any) => {
        p.nativeExecutions[id].jobTeardown.rootPid = true;
      },
      (p: any) => {
        p.nativeExecutions[id].jobTeardown.terminatedProcesses = 5;
      },
      (p: any) => {
        p.cleanup[id].nativeTeardownVerified = 1;
      },
      (p: any) => {
        p.cleanup[id].nativeTeardownError = "failed query";
      },
      (p: any) => {
        delete p.cleanup[id].nativeTeardownError;
      },
      (p: any) => {
        p.cleanup[id].shareRemoved = false;
      },
      (p: any) => {
        p.cleanup[id].executor.closed = 1;
      },
      (p: any) => {
        p.cleanup[id].executor.forced = true;
      },
      (p: any) => {
        p.cleanup[id].executor.exitCode = false;
      },
      (p: any) => {
        p.cleanup[id].executor.error = "failed process";
      },
      (p: any) => {
        p.cleanup[id].executor.stderr = 'NEMOCLAW_MSYS_FAILED_CHILD={"closed":false}\n';
      },
    ];
    for (const mutate of mutations) {
      const f = nativeCompatibilityFixture();
      mutate(f.proof);
      assert.throws(() => validate(f), id);
    }
  }
});

function currentBaseDerivation() {
  return {
    base: {
      artifactId: 11995339173,
      runId: 38778013068,
      sourceRevision: "8f54e647a1cda1c3c879ad4e350700a13bb8fc2e",
      zipSha256: "bd59f69d7bba8177239f3d0028de493c55be814c0ee206fff796db08ab941390",
      inventorySha256: "c6255066a9d6ab620c6d6627bb97b2f96f74430c034f8b2016ecc02aa530af70",
      candidateReceiptSha256: "f6bf562bf88379049328f3eb2224558becf0bb26e2dc6766acd27ed22dd1a334",
      buildReceiptSha256: "828181ba43a2ee417794b383f3a835c44d60aa4f607c0e4fa26df91c63e2470d",
    },
    metadataRelocation: {
      schemaVersion: 1,
      classification: "current-adapter-metadata-relocation",
      baseCandidateSource: "8f54e647a1cda1c3c879ad4e350700a13bb8fc2e",
      previousMarkerSha256: "89d27c95b5c4f7e5a90f25bcb587e7f67291b1c64359d847168f110a0b29c0d7",
      startupAdapterSha256: "d8e8b5524ca783dccc0024a1eed61a4c0955cf73b7d45157093787070dc8ed16",
      hookPaths: [
        "hermes-agent/.hermes-runtime/python/cpython-3.11.16-windows-aarch64-none/Lib/site-packages/nemoclaw_native_windows.py",
        "hermes-agent/venv/Lib/site-packages/nemoclaw_native_windows.py",
        "tools/browser-use/Lib/site-packages/nemoclaw_native_windows.py",
      ],
    },
  };
}

test("current complete base accepts relocation without an adapter upgrade", () => {
  const input = currentBaseDerivation();
  validatePersonalBase(input, input.metadataRelocation.startupAdapterSha256);
});

test("current complete base rejects mixed artifact and receipt identities", () => {
  const valid = currentBaseDerivation();
  for (const key of Object.keys(valid.base)) {
    const input: any = structuredClone(valid);
    input.base[key] = typeof input.base[key] === "number" ? 1 : "0".repeat(64);
    assert.throws(() => validatePersonalBase(input, valid.metadataRelocation.startupAdapterSha256));
  }
});

test("current complete base rejects invented upgrades and changed relocation lineage", () => {
  const valid = currentBaseDerivation();
  for (const mutate of [
    (input: any) => {
      input.adapterUpgrade = {};
    },
    (input: any) => {
      delete input.metadataRelocation;
    },
    (input: any) => {
      input.metadataRelocation.previousMarkerSha256 = "0".repeat(64);
    },
    (input: any) => {
      input.metadataRelocation.hookPaths.pop();
    },
  ]) {
    const input: any = structuredClone(valid);
    mutate(input);
    assert.throws(() => validatePersonalBase(input, valid.metadataRelocation.startupAdapterSha256));
  }
});

test("historical adapter evidence cannot qualify the current complete base", () => {
  const input = currentBaseDerivation();
  assert.throws(() => validatePersonalBase(input, completedPersonalReplayPin.startupAdapterSha256));
  assert.throws(() =>
    validatePersonalBase(input, input.metadataRelocation.startupAdapterSha256, true),
  );
});

test("historical base remains restricted to explicit immutable replay", () => {
  const input = {
    base: {
      artifactId: 10181796438,
      runId: 34551706967,
      sourceRevision: "47d890728482cca05e840edd27e33e3d495aeabf",
      zipSha256: "b6e3683f4248b62e6ba3594d8ecab11d6958a23f161b526a1d11ec07d146d6ed",
      inventorySha256: "777f6a6fcbefa3790130e795b611aff086775f23682ae109c16cac2f1ff1acd0",
    },
    adapterUpgrade: {
      baseCandidateSource: "47d890728482cca05e840edd27e33e3d495aeabf",
      afterSha256: completedPersonalReplayPin.startupAdapterSha256,
      hookPaths: currentBaseDerivation().metadataRelocation.hookPaths,
    },
  };
  validatePersonalBase(input, completedPersonalReplayPin.startupAdapterSha256, true);
  assert.throws(() => validatePersonalBase(input, completedPersonalReplayPin.startupAdapterSha256));
});

test("postmortem may pair with startup recording while incompatible modes remain excluded", () => {
  const ordinary = {
    postmortem: false,
    wer: false,
    coldJob: false,
    rendererContext: false,
    recordStartup: false,
  };
  validatePersonalDiagnosticModes(ordinary);
  validatePersonalDiagnosticModes({ ...ordinary, browserFirst: true });
  for (const incompatible of [
    "postmortem",
    "wer",
    "coldJob",
    "rendererContext",
    "recordStartup",
  ] as const)
    assert.throws(() =>
      validatePersonalDiagnosticModes({ ...ordinary, browserFirst: true, [incompatible]: true }),
    );
  validatePersonalDiagnosticModes({ ...ordinary, recordStartup: true });
  for (const recordStartup of [false, true]) {
    const postmortem = { ...ordinary, postmortem: true, recordStartup };
    validatePersonalDiagnosticModes(postmortem);
    for (const incompatible of ["wer", "coldJob", "rendererContext"] as const)
      assert.throws(() => validatePersonalDiagnosticModes({ ...postmortem, [incompatible]: true }));
  }
  for (const incompatible of ["wer", "coldJob"] as const)
    assert.throws(() =>
      validatePersonalDiagnosticModes({ ...ordinary, recordStartup: true, [incompatible]: true }),
    );
});

test("Browser Use launch binds current helper bytes and the packaged module command", () => {
  const source = {
    path: path.win32.join(browserController, "nemoclaw_browser_use.py"),
    bytes: 123,
    sha256: "a".repeat(64),
    peMachine: null,
    architecture: "non-PE-or-unknown",
  };
  const observed = {
    classification: "owned-browser-use-module-launch",
    source: { path: source.path, bytes: source.bytes, sha256: source.sha256 },
    command: [
      path.win32.join(browserRuntime, "tools/browser-use/Scripts/python.exe"),
      "-I",
      "-B",
      "-m",
      "browser_use.cli",
    ],
    modulePath: path.win32.join(
      browserRuntime,
      "tools/browser-use/Lib/site-packages/browser_use/cli.py",
    ),
    moduleSha256: "9a52306f028230fa471b0887e81b0ab4eccc15dc26be4b0b152bb001ba2977ef",
    entryPointsSha256: "444f604c01aadb261d692bf944e9ebc2e39398ef77dcf0a32d550eb25e32e0e1",
    trampolineBypassed: true,
    runtimeBytesModified: false,
  };
  assert.equal(validateBrowserUseLaunch(observed, source, browserRuntime), observed);
  assert.throws(() =>
    validateBrowserUseLaunch(
      { ...observed, source: { ...observed.source, sha256: "b".repeat(64) } },
      source,
      browserRuntime,
    ),
  );
  assert.throws(() =>
    validateBrowserUseLaunch(
      { ...observed, command: ["C:\\host\\python.exe", ...observed.command.slice(1)] },
      source,
      browserRuntime,
    ),
  );
  assert.throws(() =>
    validateBrowserUseLaunch({ ...observed, runtimeBytesModified: true }, source, browserRuntime),
  );
});

const desktopOwnerBinding = {
  executable: "C:\\native\\wxc-exec.exe",
  policyFile: "C:\\owned\\personal-request.json",
  requestSha256: "a".repeat(64),
  containerId: "nm-0123456789ab-start",
};
const desktopOwnerSid = "S-1-15-2-123-456-789";
const desktopOwnerLine = (row: any) => "NEMOCLAW_HERMES_DESKTOP=" + JSON.stringify(row) + "\n";
function desktopOwnerRows(): any[] {
  const prepared = ["default", "low"].map((labelVariant) => ({
    schemaVersion: 1,
    classification: "owned-Hermes-desktop",
    stage: "prepared",
    rootPid: 400,
    appContainerSid: desktopOwnerSid,
    actualJobAndAppContainerBound: true,
    hostSession: 2,
    stationName: "WinSta0",
    hostUserSid: "S-1-5-21-123-456-789-500",
    hostDesktopSelected: false,
    existingObjectSecurityChanged: false,
    desktopName: `NemoClawHermesDesktop-${desktopOwnerSid}-${labelVariant}`,
    labelVariant,
    requestedAccess: 0xe0083,
    inheritHandle: false,
    createAttempted: true,
    openedOrCreated: true,
  }));
  return [
    ...prepared,
    ...prepared.map(({ desktopName }) => ({
      schemaVersion: 1,
      classification: "owned-Hermes-desktop",
      stage: "owner-close",
      clock: "GetTickCount64",
      absenceCheckedTickMilliseconds: 100,
      desktopName,
      closed: true,
      closeError: 0,
      absentAfterOwnerClose: true,
      absenceError: 2,
      presenceHandleClosed: true,
      hostDesktopSelected: false,
    })),
  ];
}
function desktopOwnerExecution(
  rows = desktopOwnerRows(),
): Awaited<ReturnType<typeof personalCommand>> {
  return {
    executable: desktopOwnerBinding.executable,
    args: [desktopOwnerBinding.policyFile, "--log-file", "C:\\owned\\mxc.log"],
    pid: 42,
    exitCode: 0,
    signal: null,
    childClosed: true,
    timedOut: false,
    outputExceeded: false,
    stdout: "",
    stderr: rows.map(desktopOwnerLine).join(""),
    elapsedMs: 1,
    error: null,
    nativeStderr:
      "NEMOCLAW_MSYS_HOST_TOKEN_INSPECTION=" +
      JSON.stringify({
        exactJobAndGenerationsBound: true,
        rootPid: 400,
        appContainerSid: desktopOwnerSid,
      }) +
      "\n",
    nativeStderrBytes: 0,
    nativeStderrSha256: "",
    nativeRecordCount: 1,
    nativeOutputExceeded: false,
    nativeParseErrors: [],
  };
}

test("closed-executor desktop cleanup binds both constructor variants and actual token identity", () => {
  const execution = desktopOwnerExecution();
  const result = inspectHermesDesktopCleanup(execution, desktopOwnerBinding);
  assert.equal(result.passed, true);
  assert.equal(result.ownedNames.length, 2);
  assert.equal(result.rootIdentityCrossChecked, true);
  assert.equal(result.binding.executorPid, 42);
  // Primary-debug retains the token rows in its combined stderr instead.
  const debug = {
    ...execution,
    stderr: execution.stderr + execution.nativeStderr,
    nativeStderr: "",
  };
  assert.equal(inspectHermesDesktopCleanup(debug, desktopOwnerBinding).passed, true);
  assert.equal(
    inspectHermesDesktopCleanup(
      { ...debug, nativeStderr: execution.nativeStderr },
      desktopOwnerBinding,
    ).passed,
    true,
  );
  for (const changed of [
    { childClosed: false },
    { pid: null },
    { executable: "C:\\other\\wxc-exec.exe" },
    { args: ["C:\\unrelated\\request.json", "--log-file", "C:\\owned\\mxc.log"] },
    { outputExceeded: true },
    { nativeOutputExceeded: true },
    { nativeStderr: execution.nativeStderr.replace('"rootPid":400', '"rootPid":401') },
    { nativeStderr: execution.nativeStderr.replace(desktopOwnerSid, "S-1-15-2-999") },
  ])
    assert.equal(
      inspectHermesDesktopCleanup({ ...execution, ...changed }, desktopOwnerBinding).passed,
      false,
    );
  assert.equal(
    inspectHermesDesktopCleanup({ ...execution, childClosed: false }, desktopOwnerBinding).rows
      .length,
    0,
  );
});

test("desktop close and observed absence are mandatory for every prepared handle", () => {
  for (const change of [
    { closed: false, closeError: 5 },
    { closeError: 5 },
    { presenceHandleClosed: false },
    { absentAfterOwnerClose: false },
    { absenceError: 5 },
    { absenceError: null },
    { desktopName: "NemoClawHermesDesktop-S-1-15-2-999-default" },
  ]) {
    const rows = desktopOwnerRows();
    rows[2] = { ...rows[2], ...change };
    const result = inspectHermesDesktopCleanup(desktopOwnerExecution(rows), desktopOwnerBinding);
    assert.equal(result.passed, false);
    assert.equal(result.rows.length, 4);
    assert(result.error);
  }
  for (const rows of [
    desktopOwnerRows().slice(0, 3),
    [...desktopOwnerRows().slice(0, 3), desktopOwnerRows()[2]],
    [],
  ])
    assert.equal(
      inspectHermesDesktopCleanup(desktopOwnerExecution(rows), desktopOwnerBinding).passed,
      false,
    );
});

test("failed desktop constructors need no close while partial and global preparation stay explicit", () => {
  const rows = desktopOwnerRows();
  rows[1] = {
    ...rows[1],
    stage: "prepare-failed",
    openedOrCreated: false,
    error: "CreateDesktopW: Win32 5",
  };
  rows.pop();
  const result = inspectHermesDesktopCleanup(desktopOwnerExecution(rows), desktopOwnerBinding);
  assert.equal(result.passed, true);
  assert.deepEqual(result.ownedNames, [rows[0].desktopName]);
  const failed = rows
    .slice(0, 2)
    .map((row) => ({ ...row, stage: "prepare-failed", openedOrCreated: false }));
  const none = inspectHermesDesktopCleanup(desktopOwnerExecution(failed), desktopOwnerBinding);
  assert.equal(none.passed, true);
  assert.equal(none.provisioning, "constructors-failed-without-handles");
  assert.equal(
    inspectHermesDesktopCleanup(
      desktopOwnerExecution([{ ...failed[0], stage: "host-context", openedOrCreated: false }]),
      desktopOwnerBinding,
    ).passed,
    true,
  );
  failed[0].preexistingOpened = true;
  failed[0].preexistingHandleClosed = false;
  assert.equal(
    inspectHermesDesktopCleanup(desktopOwnerExecution(failed), desktopOwnerBinding).passed,
    false,
  );
  const lateFailure = desktopOwnerRows();
  lateFailure[0].stage = "prepare-failed";
  assert.equal(
    inspectHermesDesktopCleanup(desktopOwnerExecution(lateFailure), desktopOwnerBinding).passed,
    true,
  );
  assert.equal(
    inspectHermesDesktopCleanup(desktopOwnerExecution(lateFailure.slice(0, 2)), desktopOwnerBinding)
      .passed,
    false,
  );
});

test("desktop and token parser bounds accommodate actual source rows and reject ambiguous ownership", () => {
  const rows = desktopOwnerRows();
  rows[0].baselineDaclHex = "aa".repeat(20_000);
  assert.equal(
    inspectHermesDesktopCleanup(desktopOwnerExecution(rows), desktopOwnerBinding).passed,
    true,
  );
  rows[0].baselineDaclHex = "a".repeat(64 * 1024);
  assert.equal(
    inspectHermesDesktopCleanup(desktopOwnerExecution(rows), desktopOwnerBinding).passed,
    false,
  );
  assert.equal(
    inspectHermesDesktopCleanup(
      desktopOwnerExecution([...desktopOwnerRows(), desktopOwnerRows()[0]]),
      desktopOwnerBinding,
    ).passed,
    false,
  );
  const mismatched = desktopOwnerRows();
  mismatched[1].appContainerSid = "S-1-15-2-999";
  assert.equal(
    inspectHermesDesktopCleanup(desktopOwnerExecution(mismatched), desktopOwnerBinding).passed,
    false,
  );
  const execution = desktopOwnerExecution();
  const token = {
    exactJobAndGenerationsBound: true,
    rootPid: 400,
    appContainerSid: desktopOwnerSid,
    padding: "",
  };
  token.padding = "x".repeat(16 * 1024 - Buffer.byteLength(JSON.stringify(token)));
  execution.nativeStderr = "NEMOCLAW_MSYS_HOST_TOKEN_INSPECTION=" + JSON.stringify(token) + "\n";
  assert.equal(inspectHermesDesktopCleanup(execution, desktopOwnerBinding).passed, true);
});

test("a desktop cleanup failure remains secondary in the published component failure receipt", () => {
  const rows = desktopOwnerRows();
  rows[2].absenceError = 5;
  rows[2].absentAfterOwnerClose = false;
  const primary = new Error("original browser component failure");
  const execution = {
    ...desktopOwnerExecution(rows),
    exitCode: 1,
    error: { message: primary.message },
  };
  const cleanup = inspectHermesDesktopCleanup(execution, desktopOwnerBinding);
  assert.equal(cleanup.passed, false);
  assert.equal(execution.error.message, primary.message);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-cleanup-receipt-"));
  try {
    const file = path.join(root, "receipt.json");
    const reports: unknown[] = [];
    const receipt = {
      error: primary.message,
      hostDesktopCleanup: cleanup,
      cleanupErrors: [{ hostDesktopCleanup: cleanup.error }],
      feasibilityPassed: false,
    };
    assert.equal(
      publishPersonalReceipt(file, receipt, primary, (row) => reports.push(row)),
      true,
    );
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).error, primary.message);
    assert.match(JSON.stringify(reports[0]), /original browser component failure/u);
    assert.equal(receipt.cleanupErrors.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("primary debugger keeps current native bytes and four-component command while rebinding only owned controller/state", () => {
  const native = "C:\\NemoClawPersonalCompat-001122334455";
  const primary = personalRequest(
    path.win32.join(browserController, "node.exe"),
    path.win32.join(browserController, "probe-personal-workload.mts"),
    browserRuntime,
    "C:\\NemoClawMsysProof-001122334455-state-start",
    browserOriginalNonce,
    "C:\\Windows",
    native,
  );
  const before = structuredClone(primary);
  const plan = primaryDebugRequest(
    primary,
    browserRuntime,
    path.win32.join(browserController, "probe-personal-python.py"),
    browserNewNonce,
  );
  assert.deepEqual(primary, before);
  assert.equal(plan.nativeRoot, native);
  assert.equal(plan.originalNonce, browserOriginalNonce);
  assert.equal(plan.controller, "C:\\NemoClawPersonalNode-ffeeddccbbaa");
  assert.deepEqual(plan.request.filesystem.readonlyPaths, [
    browserRuntime,
    plan.controller,
    native,
  ]);
  assert.deepEqual(plan.request.filesystem.readwritePaths, [
    "C:\\NemoClawMsysProof-ffeeddccbbaa-state-start",
  ]);
  assert(
    plan.request.process.commandLine.startsWith(
      `"${native}\\NemoClawMsysLauncher.exe" "--" "${plan.controller}\\node.exe"`,
    ),
  );
  assert(
    plan.request.process.commandLine.includes(`"${plan.controller}\\probe-personal-workload.mts"`),
  );
  assert.equal(plan.request.process.timeout, primary.process.timeout);
  for (const key of ["network", "ui", "processContainer", "lifecycle"] as const)
    assert.deepEqual(plan.request[key], primary[key]);
  assert.throws(() =>
    primaryDebugRequest(
      {
        ...primary,
        process: {
          ...primary.process,
          commandLine: primary.process.commandLine.replace('"--no-warnings"', '"--eval"'),
        },
      },
      browserRuntime,
      path.win32.join(browserController, "probe-personal-python.py"),
      browserNewNonce,
    ),
  );
});
const browserProbe = path.win32.join(browserController, "probe-personal-python.py");
const browserShare = "C:\\NemoClawMsysProof-ffeeddccbbaa-state-start";
function browserPrimary() {
  return personalRequest(
    path.win32.join(browserController, "node.exe"),
    path.win32.join(browserController, "probe-personal-workload.mts"),
    browserRuntime,
    "C:\\NemoClawMsysProof-001122334455-state-start",
    browserOriginalNonce,
    "C:\\Windows",
    "C:\\NemoClawPersonalCompat-001122334455",
  );
}

test("renderer WER diagnostic adds only its owned read path and browser selection", () => {
  const primary = browserPrimary();
  const before = structuredClone(primary);
  const cloneRoot = "C:\\NemoClawRendererWer-001122334455";
  const owner = {
    schemaVersion: 1,
    classification: "renderer-wer-clone-owner",
    status: "prepared",
    ready: true,
    nonce: browserOriginalNonce,
    cloneRoot,
    chromePath: path.win32.join(cloneRoot, "chrome-win64/chrome.exe"),
    reportRoot: path.win32.join(cloneRoot, "reports"),
  };
  const result = rendererWerRequest(primary, browserRuntime, browserOriginalNonce, owner);
  assert.deepEqual(primary, before);
  const expected = structuredClone(primary);
  expected.filesystem.readonlyPaths.push(cloneRoot);
  expected.process.env.push(`NEMOCLAW_HERMES_WER_CHROME=${owner.chromePath}`);
  assert.deepEqual(result, expected);
  assert.equal(result.process.timeout, 120_000);
  for (const changed of [
    { ready: false },
    { status: "failed" },
    { nonce: browserNewNonce },
    { cloneRoot: "C:\\Windows" },
    { chromePath: owner.chromePath.replace("001122334455", "ffeeddccbbaa") },
    { reportRoot: "C:\\Users" },
  ])
    assert.throws(() =>
      rendererWerRequest(primary, browserRuntime, browserOriginalNonce, { ...owner, ...changed }),
    );
});

test("postmortem admission preserves the exact original Personal request", () => {
  const primary = browserPrimary();
  const before = structuredClone(primary);
  const owner = {
    schemaVersion: 1,
    classification: "renderer-postmortem-owner",
    status: "prepared",
    ready: true,
    nonce: browserOriginalNonce,
    root: "C:\\NemoClawRendererPostmortem-001122334455",
    appContainerName: primary.containerId,
    derivedAppContainerSid: "S-1-15-2-1-2-3-4-5-6-7",
    chromeIdentity: {
      path: path.win32.join(browserRuntime, "browsers/chromium-1234/chrome-win64/chrome.exe"),
      bytes: 4024832,
      sha256: "409805a16d6416087e6b2f778df1cf8f7bbb267d6b99f6b5bb0a618eace234f2",
    },
  };
  assert.equal(
    validateRendererPostmortemOwner(primary, browserRuntime, browserOriginalNonce, owner),
    primary,
  );
  assert.deepEqual(primary, before);
  for (const changed of [
    { ready: false },
    { nonce: browserNewNonce },
    { root: "C:\\Users" },
    { appContainerName: "another-container" },
    { derivedAppContainerSid: "S-1-5-18" },
    { chromeIdentity: { ...owner.chromeIdentity, sha256: "a".repeat(64) } },
  ])
    assert.throws(() =>
      validateRendererPostmortemOwner(primary, browserRuntime, browserOriginalNonce, {
        ...owner,
        ...changed,
      }),
    );
});

test("external capture cleanup preserves report failure and still closes its owner", async () => {
  const errors: unknown[] = [];
  const calls: { mode: string; args: string[] }[] = [];
  const cleanup = { hostDiagnosticChildrenClosed: true };
  await finishRendererCaptureOwner({
    owner: "owner.json",
    ownerSha256: "a".repeat(64),
    output: "evidence",
    postmortem: true,
    attempted: false,
    allClosed: true,
    cleanup,
    errors,
    run: async (mode, args, document) => {
      calls.push({ mode, args });
      if (mode === "readreports") throw new Error("original report-read failure");
      return {
        path: document,
        bytes: 1,
        sha256: "b".repeat(64),
        value: {
          cleanupComplete: true,
          registryRestored: true,
          hostsClosed: true,
          rootRemoved: true,
        },
      };
    },
  });
  assert.deepEqual(
    calls.map((row) => row.mode),
    ["readreports", "cleanup"],
  );
  assert(calls[1]!.args.includes("--executor-not-started"));
  assert(!calls[1]!.args.includes("--executor-closed"));
  assert.equal(errors.length, 1);
  assert.match(JSON.stringify(errors), /original report-read failure/u);
  assert.equal(cleanup.hostDiagnosticChildrenClosed, true);
});

test("external capture never starts another helper while prior ownership is unknown", async () => {
  const errors: unknown[] = [];
  const cleanup = { hostDiagnosticChildrenClosed: false };
  await finishRendererCaptureOwner({
    owner: "owner.json",
    ownerSha256: "a".repeat(64),
    output: "evidence",
    postmortem: true,
    attempted: true,
    allClosed: false,
    cleanup,
    errors,
    run: async () => {
      throw new Error("must not start another helper");
    },
  });
  assert.equal(cleanup.hostDiagnosticChildrenClosed, false);
  assert.equal(errors.length, 1);
  assert.match(JSON.stringify(errors), /retained/u);
  assert.doesNotMatch(JSON.stringify(errors), /must not start/u);
});

test("direct browser comparison preserves policy and environment except fresh owned state and command", () => {
  const primary = browserPrimary();
  const before = structuredClone(primary);
  const diagnostic = directBrowserRequest(primary, browserRuntime, browserProbe, browserNewNonce);
  assert.deepEqual(primary, before);
  assert.equal(diagnostic.process.cwd, browserShare);
  assert.deepEqual(diagnostic.filesystem.readwritePaths, [browserShare]);
  assert.equal(
    diagnostic.process.commandLine,
    `"${browserRuntime}\\hermes-agent\\venv\\Scripts\\python.exe" "-I" "-B" "${browserProbe}" "browser" "${browserRuntime}" "${browserNewNonce}"`,
  );
  assert.deepEqual(diagnostic.filesystem.readonlyPaths, primary.filesystem.readonlyPaths);
  assert.equal(diagnostic.process.timeout, 120_000);
  for (const entry of primary.process.env) {
    const key = entry.slice(0, entry.indexOf("="));
    if (
      ![
        "HOME",
        "HERMES_HOME",
        "NEMOCLAW_AGENT_HOME",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "TEMP",
        "TMP",
      ].includes(key)
    )
      assert(diagnostic.process.env.includes(entry));
  }
  const restored = structuredClone(diagnostic);
  restored.containerId = primary.containerId;
  restored.process = primary.process;
  restored.filesystem.readwritePaths = primary.filesystem.readwritePaths;
  assert.deepEqual(restored, primary);
  assert.throws(() =>
    directBrowserRequest(primary, browserRuntime, browserProbe, browserOriginalNonce),
  );
});

test("stock MXC browser comparison removes both host opt-ins and requires the exact ARM64 executor", () => {
  const original = {
    GITHUB_ACTIONS: "true",
    PATH: "C:\\Windows\\System32",
    NEMOCLAW_MSYS_TOKEN_INSPECTION: "repair-query",
    NEMOCLAW_HERMES_PRIVATE_DESKTOP: "1",
  };
  assert.deepEqual(stockBrowserEnvironment(original), {
    GITHUB_ACTIONS: "true",
    PATH: "C:\\Windows\\System32",
  });
  assert.equal(original.NEMOCLAW_MSYS_TOKEN_INSPECTION, "repair-query");
  assert.equal(original.NEMOCLAW_HERMES_PRIVATE_DESKTOP, "1");
  const identity = {
    path: "C:\\stock\\wxc-exec.exe",
    bytes: 1,
    sha256: "dde1c592270e9a659b01dccad70362da7b99fec114885fa4d625507aa775a503",
    peMachine: 0xaa64,
    architecture: "arm64",
  };
  assert.equal(validateStockBrowserExecutor(identity), identity);
  assert.throws(() => validateStockBrowserExecutor({ ...identity, sha256: "0".repeat(64) }));
  assert.throws(() => validateStockBrowserExecutor({ ...identity, peMachine: 0x8664 }));
});

test("host browser receipt requires actual job zero, capture and handles closed in addition to supervisor closure", () => {
  const request = {
    nonce: browserNewNonce,
    runtimeRoot: browserRuntime,
    stateRoot: "C:\\NemoClawBrowserHost-ffeeddccbbaa",
  };
  const record = {
    schemaVersion: 1,
    classification: "canonical-host-browser-diagnostic",
    diagnosticOnly: true,
    canonicalQualification: false,
    installedAcceptance: false,
    ...request,
    processCreated: true,
    childrenClosed: true,
    cleanupComplete: true,
    execution: { childClosed: true },
    result: { schemaVersion: 1, component: "browser", nonce: browserNewNonce, passed: false },
    job: {
      created: true,
      limitFlags: 8192,
      assignedBeforeResume: true,
      rootMembershipVerified: true,
      activeAfterCleanup: 0,
    },
    cleanup: {
      captureClosed: true,
      processHandleClosed: true,
      threadHandleClosed: true,
      jobHandleClosed: true,
      stateRemoved: true,
      errors: [],
    },
  };
  assert.deepEqual(hostBrowserCompletion(record, request, true), {
    childrenClosed: true,
    cleanupComplete: true,
  });
  assert.deepEqual(hostBrowserCompletion(record, request, false), {
    childrenClosed: false,
    cleanupComplete: false,
  });
  for (const mutate of [
    (r: any) => {
      r.job.activeAfterCleanup = 1;
    },
    (r: any) => {
      r.job.assignedBeforeResume = false;
    },
    (r: any) => {
      r.execution.childClosed = false;
    },
    (r: any) => {
      r.cleanup.captureClosed = false;
    },
  ]) {
    const changed = structuredClone(record);
    mutate(changed);
    assert.deepEqual(hostBrowserCompletion(changed, request, true), {
      childrenClosed: false,
      cleanupComplete: false,
    });
  }
  for (const key of [
    "processHandleClosed",
    "threadHandleClosed",
    "jobHandleClosed",
    "stateRemoved",
  ]) {
    const changed: any = structuredClone(record);
    changed.cleanup[key] = false;
    assert.equal(hostBrowserCompletion(changed, request, true).cleanupComplete, false);
  }
  assert.throws(() =>
    hostBrowserCompletion({ ...record, nonce: browserOriginalNonce }, request, true),
  );
  assert.throws(() =>
    hostBrowserCompletion({ ...record, canonicalQualification: true }, request, true),
  );
});

test("stock debugger completion requires exact request and executor identity plus drained debug exits", () => {
  const request = { nonce: browserNewNonce, policySha256: "a".repeat(64) };
  const record = {
    schemaVersion: 1,
    classification: "stock-MXC-browser-debug-result",
    diagnosticOnly: true,
    canonicalQualification: false,
    ...request,
    executorIdentityAfter: {
      sha256: "dde1c592270e9a659b01dccad70362da7b99fec114885fa4d625507aa775a503",
    },
    childrenClosed: true,
    cleanupComplete: true,
    remainingDebugProcesses: [],
    cleanup: { captureClosed: true, handlesClosed: true, activeProcesses: 0, errors: [] },
  };
  assert.equal(stockDebugCompletion(record, request, true), true);
  const primaryRequest = {
    ...request,
    classification: "personal-MXC-browser-debug-request",
    executorIdentity: { sha256: "c".repeat(64) },
    nativeProof: { sha256: "d".repeat(64) },
  };
  const primaryRecord = {
    ...record,
    classification: "personal-MXC-browser-debug-result",
    executorIdentityAfter: primaryRequest.executorIdentity,
    nativeProofSha256: primaryRequest.nativeProof.sha256,
  };
  assert.equal(stockDebugCompletion(primaryRecord, primaryRequest, true), true);
  const jobRequest = { ...primaryRequest, mode: "personal-job-only" };
  const jobRecord = {
    ...primaryRecord,
    remainingDebugProcesses: undefined,
    classification: "owned-Personal-job-only-diagnostic",
    mode: "personal-job-only",
    debuggerMayChangeBehavior: false,
    debugEventsCollected: false,
  };
  assert.equal(stockDebugCompletion(jobRecord, jobRequest, true), true);
  assert.equal(stockDebugCompletion(jobRecord, jobRequest, false), false);
  assert.equal(
    stockDebugCompletion(
      { ...jobRecord, cleanup: { ...jobRecord.cleanup, activeProcesses: 1 } },
      jobRequest,
      true,
    ),
    false,
  );
  assert.throws(() =>
    stockDebugCompletion({ ...jobRecord, debugEventsCollected: true }, jobRequest, true),
  );
  const ownedJob = {
    creationFlags: 0x08000004,
    queryOnly: true,
    uiRestrictions: {
      informationClass: 4,
      querySucceeded: true,
      complete: true,
      win32Error: 0,
      flags: 0,
    },
    extendedLimits: {
      informationClass: 9,
      querySucceeded: true,
      complete: true,
      win32Error: 0,
      flags: 0x2000,
    },
  };
  assert.equal(validateJobOnlyConfiguration(ownedJob), ownedJob);
  assert.throws(() => validateJobOnlyConfiguration({ ...ownedJob, creationFlags: 0x08000005 }));
  assert.throws(() =>
    validateJobOnlyConfiguration({
      ...ownedJob,
      uiRestrictions: { ...ownedJob.uiRestrictions, querySucceeded: false, flags: null },
    }),
  );
  assert.throws(() =>
    stockDebugCompletion(
      { ...primaryRecord, executorIdentityAfter: record.executorIdentityAfter },
      primaryRequest,
      true,
    ),
  );
  assert.throws(() =>
    stockDebugCompletion(
      { ...primaryRecord, nativeProofSha256: "e".repeat(64) },
      primaryRequest,
      true,
    ),
  );
  assert.equal(stockDebugCompletion(record, request, false), false);
  assert.equal(
    stockDebugCompletion({ ...record, remainingDebugProcesses: [42] }, request, true),
    false,
  );
  assert.equal(
    stockDebugCompletion(
      { ...record, cleanup: { ...record.cleanup, activeProcesses: 1 } },
      request,
      true,
    ),
    false,
  );
  assert.equal(
    stockDebugCompletion(
      { ...record, cleanup: { ...record.cleanup, captureClosed: false } },
      request,
      true,
    ),
    false,
  );
  assert.throws(() =>
    stockDebugCompletion({ ...record, policySha256: "b".repeat(64) }, request, true),
  );
  assert.throws(() =>
    stockDebugCompletion(
      { ...record, executorIdentityAfter: { sha256: "0".repeat(64) } },
      request,
      true,
    ),
  );
});

test("ordinary warm and job-only comparisons label additional launch dimensions without qualification", () => {
  const warm = primaryComparisonMetadata("patched-primary-warm");
  const job = primaryComparisonMetadata("patched-primary-job");
  assert.equal(warm.classification, "canonical-Personal-primary-workload-ordinary-warm-diagnostic");
  assert(!warm.changedDimensions.some((value) => value.includes("Job")));
  assert(job.changedDimensions.some((value) => value.includes("DEBUG_PROCESS absent")));
  for (const metadata of [warm, job]) {
    assert(
      metadata.changedDimensions.some((value) =>
        value.includes("cache state are not independently measured"),
      ),
    );
    assert(
      metadata.comparisonLimits.some((value) =>
        value.includes("original ordinary primary verdict remains authoritative"),
      ),
    );
  }
});

function nativeMarkerFixture(rootPid: number) {
  return {
    prepared: {
      schemaVersion: 1,
      classification: "native-Hermes-ui-owner",
      stage: "prepare",
      rootPid,
      appContainerSid: "S-1-15-2-123-456",
      sessionId: 2,
      exclusiveCreation: true,
      mediumNoWriteUp: true,
      guestAccess: 0x120001,
      descriptorMatched: true,
      policyAssignment: "PSEC-0x3ff-Win32k-false",
      enforcementReadback: false,
    },
    closed: {
      schemaVersion: 1,
      classification: "native-Hermes-ui-owner",
      stage: "owner-close",
      rootPid,
      closed: true,
      absentAfterOwnerClose: true,
      presenceHandleClosed: true,
      absenceStatus: 0xc0000034,
    },
  };
}
function nativePersonalLog() {
  const proof = nativeCompatibilityFixture().proof;
  const observed = Object.values(proof.nativeExecutions)[0] as any;
  const pid = observed.jobTeardown.rootPid;
  const marker = nativeMarkerFixture(pid);
  const event = (row: unknown) => "[1791848997] " + JSON.stringify(row) + "\n";
  return (
    event(observed.policy) +
    "[1791848995] NEMOCLAW_NATIVE_UI_OWNER=" +
    JSON.stringify(marker.prepared) +
    "\n" +
    "[1791848996] NEMOCLAW_NATIVE_MXC_UI_POLICY=" +
    JSON.stringify(observed.uiPolicy) +
    "\n" +
    event({
      event: "mxc.ProcessExited",
      backend: "processcontainer",
      tier: "base-container",
      pid,
      exit_code: 0,
    }) +
    event({
      event: "mxc.SandboxTornDown",
      backend: "processcontainer",
      identity: "redacted",
      tier: "base-container",
      pid,
      status: "success",
      firewall_rules_removed: 0,
      firewall_removal_ok: true,
      bfs_removed: false,
      proxy_stopped: false,
      preserve_policy: false,
      container_released: false,
    }) +
    "[1791848998] NEMOCLAW_NATIVE_MXC_TEARDOWN=" +
    JSON.stringify(observed.jobTeardown) +
    "\n" +
    "[1791848999] NEMOCLAW_NATIVE_UI_OWNER=" +
    JSON.stringify(marker.closed) +
    "\n"
  );
}

test("native Personal cleanup binds full UI policy and empty job to the closed executor", () => {
  const policyFile = "/owned/request.json";
  const execution: any = {
    executable: "native-executor",
    args: [policyFile, "--log-file", "/owned/mxc-native.log"],
    pid: 42,
    childClosed: true,
    timedOut: false,
    outputExceeded: false,
    nativeOutputExceeded: false,
    error: null,
    exitCode: 0,
    signal: null,
    stderr: "",
    nativeStderr: "",
  };
  const binding = { executable: execution.executable, policyFile, requestSha256: "a".repeat(64) };
  const log = nativePersonalLog();
  const observed = inspectPersonalNativeExecution(execution, binding, log);
  assert.equal(observed.classification, "native-Personal-execution-cleanup");
  assert.equal(observed.binding.executorPid, 42);
  assert.equal(observed.uiPolicy.uiRestrictions, 0x3ff);
  assert.equal(observed.uiPolicy.enforcementReadback, false);
  assert.equal(observed.policy.default_policy, "block");
  assert.equal(observed.policy.proxy_port, 0);
  assert.equal(observed.jobTeardown.activeProcesses, 0);
  assert.equal(observed.logSha256, createHash("sha256").update(log).digest("hex"));
  for (const [key, value] of Object.entries({
    childClosed: false,
    timedOut: true,
    outputExceeded: true,
    nativeOutputExceeded: true,
    error: "failed",
    exitCode: 1,
    signal: "SIGKILL",
    executable: "foreign",
    pid: 0,
    args: ["/other/request.json", "--log-file", "/owned/mxc-native.log"],
    stderr: "NEMOCLAW_HERMES_DESKTOP_MASK={}",
    nativeStderr: "NEMOCLAW_HERMES_DESKTOP_MASK={}",
  }))
    assert.throws(
      () => inspectPersonalNativeExecution({ ...execution, [key]: value }, binding, log),
      key,
    );
  for (const invalid of [
    "",
    log.replace('"activeProcesses":0', '"activeProcesses":1'),
    log.replace('"default_policy":"block"', '"default_policy":"allow"'),
    log.replace('"proxy_port":0', '"proxy_port":1234'),
    log.replace(/^.*mxc.NetworkPolicyApplied.*\n/mu, ""),
    log.replace('"uiRestrictions":1023', '"uiRestrictions":959'),
    log.replaceAll('"tier":"base-container"', '"tier":"appcontainer-dacl"'),
    log.replace(/^.*NEMOCLAW_NATIVE_UI_OWNER=.*\n/gmu, ""),
    log.replace('"absentAfterOwnerClose":true', '"absentAfterOwnerClose":false'),
    log + "NEMOCLAW_HERMES_DESKTOP_MASK={}\n",
  ])
    assert.throws(() => inspectPersonalNativeExecution(execution, binding, invalid));
});

function browserControl(
  t: TestContext,
  mode:
    | "success"
    | "browser-failure"
    | "parse-failure"
    | "unclosed"
    | "native-log-failure"
    | "existing"
    | "stock-mismatch",
) {
  const primary = browserPrimary();
  const files = new Map<string, Buffer>();
  const directories = new Set<string>();
  const events: string[] = [];
  const opened = new Map<number, { file: string; bytes: Buffer; offset: number }>();
  let nextDescriptor = 100;
  t.mock.method(fs, "openSync", (file: any, flags: any) => {
    assert.equal(flags, "r");
    const bytes = files.get(String(file));
    assert(bytes, "unknown open " + file);
    const descriptor = nextDescriptor++;
    opened.set(descriptor, { file: String(file), bytes, offset: 0 });
    return descriptor;
  });
  t.mock.method(fs, "fstatSync", (descriptor: number) => {
    const entry = opened.get(descriptor);
    assert(entry);
    return { isFile: () => true, size: entry.bytes.length, dev: 1, ino: entry.file };
  });
  t.mock.method(
    fs,
    "readSync",
    (descriptor: number, buffer: Buffer, offset: number, length: number, position: any) => {
      assert.equal(position, null);
      const entry = opened.get(descriptor);
      assert(entry);
      const count = entry.bytes.copy(buffer, offset, entry.offset, entry.offset + length);
      entry.offset += count;
      return count;
    },
  );
  t.mock.method(fs, "closeSync", (descriptor: number) => assert(opened.delete(descriptor)));
  const pe = Buffer.alloc(256);
  pe.write("MZ");
  pe.writeUInt32LE(128, 60);
  pe.write("PE\0\0", 128);
  pe.writeUInt16LE(0xaa64, 132);
  const python = path.win32.join(browserRuntime, "hermes-agent/venv/Scripts/python.exe");
  const executor = "C:\\verified\\wxc-exec.exe";
  files.set(python, pe);
  files.set(executor, pe);
  files.set(browserProbe, Buffer.from("fixed controller"));
  if (mode === "existing") directories.add(browserShare);
  t.mock.method(fs, "mkdirSync", (file: any) => {
    const name = String(file);
    if (directories.has(name)) throw Object.assign(new Error("already exists"), { code: "EEXIST" });
    directories.add(name);
  });
  t.mock.method(fs, "readFileSync", (file: any, encoding?: any) => {
    const value = files.get(String(file));
    assert(value, "unknown read " + file);
    return encoding === "utf8" ? value.toString("utf8") : value;
  });
  t.mock.method(fs, "lstatSync", (file: any) => {
    const value = files.get(String(file));
    assert(value, "unknown stat " + file);
    return {
      isFile: () => true,
      isSymbolicLink: () => false,
      size: value.length,
      dev: 1,
      ino: String(file),
    };
  });
  t.mock.method(fs, "writeFileSync", (file: any, value: any, options: any) => {
    assert.equal(options.flag, "wx");
    assert(!files.has(String(file)));
    files.set(String(file), Buffer.from(value));
  });
  t.mock.method(
    fs,
    "existsSync",
    (file: any) => directories.has(String(file)) || files.has(String(file)),
  );
  t.mock.method(fs, "rmSync", (file: any) => {
    assert.equal(String(file), browserShare);
    events.push("remove-owned-root");
    for (const directory of directories)
      if (directory.startsWith(browserShare)) directories.delete(directory);
  });
  const patchedEnvironment = {
    GITHUB_ACTIONS: "true",
    NEMOCLAW_MSYS_TOKEN_INSPECTION: "repair-query",
    NEMOCLAW_HERMES_PRIVATE_DESKTOP: "1",
  };
  const environment =
    mode === "stock-mismatch" ? stockBrowserEnvironment(patchedEnvironment) : patchedEnvironment;
  const command: typeof personalCommand = async (exe, args, env, cwd, timeout) => {
    assert.equal(exe, executor);
    assert.equal(env, environment);
    const deletion = args[0] === "--delete";
    assert.equal(deletion, false, "A native diagnostic must not delete an AppContainer profile");
    events.push(deletion ? "delete-profile" : "execute-direct-python");
    if (deletion) {
      assert.equal(cwd, "C:\\");
      assert.deepEqual(args, ["--delete", "--containername", "nm-ffeeddccbbaa-start"]);
    } else {
      assert.equal(timeout, 120_000);
      assert.equal(cwd, browserShare);
      assert(
        JSON.parse(files.get(args[0]!)!.toString()).process.commandLine.startsWith(`"${python}"`),
      );
    }
    const result = {
      schemaVersion: 1,
      component: "browser",
      nonce: browserNewNonce,
      passed: mode !== "browser-failure",
      error: mode === "browser-failure" ? "original Chrome failure" : null,
    };
    files.set(
      args[2]!,
      Buffer.from(mode === "native-log-failure" ? "incomplete native log" : nativePersonalLog()),
    );
    return {
      executable: exe,
      args,
      pid: 42,
      exitCode: !deletion && mode === "browser-failure" ? 1 : 0,
      signal: null,
      timedOut: !deletion && mode === "unclosed",
      outputExceeded: false,
      stdout: deletion
        ? ""
        : mode === "parse-failure"
          ? "missing result\n"
          : "NEMOCLAW_PERSONAL_RESULT=" + JSON.stringify(result) + "\n",
      stderr: deletion ? "" : "ordinary Chrome stderr",
      error: null,
      childClosed: deletion || mode !== "unclosed",
      elapsedMs: 1,
      nativeStderr: "",
      nativeStderrBytes: 0,
      nativeStderrSha256: "",
      nativeRecordCount: 0,
      nativeOutputExceeded: false,
      nativeParseErrors: [],
    };
  };
  return {
    primary,
    events,
    directories,
    run: () =>
      directBrowserDiagnostic(
        primary,
        browserRuntime,
        browserProbe,
        executor,
        environment,
        "/owned-evidence/browser-direct",
        browserNewNonce,
        { bytes: pe.length, sha256: createHash("sha256").update(pe).digest("hex") },
        command,
        mode === "stock-mismatch" ? "stock" : "patched",
      ),
  };
}

test("native direct browser retains its result and verifies job teardown before root cleanup", async (t) => {
  const control = browserControl(t, "success");
  const original = structuredClone(control.primary);
  const result = await control.run();
  assert.equal(result.operationSucceeded, true);
  assert.equal(result.cleanupComplete, true);
  assert.equal(result.result.passed, true);
  assert.equal(result.diagnosticOnly, true);
  assert.equal(result.canonicalQualification, false);
  assert.equal(result.dllAbsenceIndependentlyVerified, false);
  assert.equal(result.cleanup.nativeTeardownVerified, true);
  assert.equal(result.cleanup.profileDeleted, undefined);
  assert.equal(result.profileDeletion, undefined);
  assert.deepEqual(control.events, ["execute-direct-python", "remove-owned-root"]);
  assert.deepEqual(control.primary, original);
});

for (const mode of [
  "browser-failure",
  "parse-failure",
  "unclosed",
  "native-log-failure",
  "existing",
  "stock-mismatch",
] as const) {
  test(`direct browser ${mode} preserves result and exact resource ownership`, async (t) => {
    const control = browserControl(t, mode);
    const result = await control.run();
    if (mode === "browser-failure") {
      assert.equal(result.operationSucceeded, false);
      assert.equal(result.result.error, "original Chrome failure");
      assert.equal(result.execution.stderr, "ordinary Chrome stderr");
      assert.equal(result.cleanupComplete, false);
      assert(control.directories.has(browserShare));
      assert(result.nativeExecutionError);
    } else if (mode === "parse-failure") {
      assert.equal(result.operationSucceeded, false);
      assert.equal(result.execution.stdout, "missing result\n");
      assert(result.error);
      assert.equal(result.cleanupComplete, true);
    } else if (mode === "unclosed") {
      assert.equal(result.childrenClosed, false);
      assert.equal(result.cleanupComplete, false);
      assert(control.directories.has(browserShare));
      assert.deepEqual(control.events, ["execute-direct-python"]);
    } else if (mode === "native-log-failure") {
      assert.equal(result.cleanupComplete, false);
      assert.equal(result.cleanup.nativeTeardownVerified, false);
      assert.equal(result.cleanup.profileDeleted, undefined);
      assert(control.directories.has(browserShare));
      assert.deepEqual(control.events, ["execute-direct-python"]);
      assert.equal(result.cleanupErrors.length, 1);
    } else if (mode === "existing") {
      assert.equal(result.attempted, false);
      assert(result.error);
      assert(control.directories.has(browserShare));
      assert.deepEqual(control.events, []);
    } else {
      assert.equal(result.attempted, false);
      assert.equal(result.executorVariant, "stock");
      assert(result.error);
      assert.deepEqual(control.events, []);
      assert(!control.directories.has(browserShare));
    }
  });
}

test("Personal capture keeps native diagnostics separate from primary Python output", async () => {
  const result = await personalCommand(
    process.execPath,
    [
      "-e",
      `for(let i=0;i<100;i++)process.stderr.write('NEMOCLAW_MSYS_CONTEXT='+JSON.stringify({pid:process.pid,data:'x'.repeat(1000)})+'\\n');process.stdout.write('RESULT\\n');process.stderr.write('primary failure detail\\n');`,
    ],
    process.env,
    process.cwd(),
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.childClosed, true);
  assert.equal(result.error, null);
  assert.equal(result.stdout, "RESULT\n");
  assert.equal(result.stderr, "primary failure detail\n");
  assert.equal(result.nativeRecordCount, 100);
  assert(result.nativeStderrBytes > 64 * 1024);
  assert.equal(result.outputExceeded, false);
  assert.equal(result.nativeOutputExceeded, false);
  assert(Number.isSafeInteger(result.pid) && result.pid! > 0);
});

test("Personal capture retains the primary 64 KiB bound and rejects malformed native evidence", async () => {
  const large = await personalCommand(
    process.execPath,
    ["-e", "process.stderr.write('x'.repeat(70000))"],
    process.env,
    process.cwd(),
  );
  assert.equal(large.outputExceeded, true);
  assert.equal(Buffer.byteLength(large.stderr), 64 * 1024);
  const malformed = await personalCommand(
    process.execPath,
    ["-e", "process.stderr.write('NEMOCLAW_MSYS_CONTEXT={bad}\\n')"],
    process.env,
    process.cwd(),
  );
  assert.equal(malformed.nativeParseErrors.length, 1);
  assert(malformed.error);
  assert.equal(malformed.nativeStderr, "NEMOCLAW_MSYS_CONTEXT={bad}\n");
});

test("Personal capture preserves an actual failure exit and reaps a timed out owned child", async () => {
  const failed = await personalCommand(
    process.execPath,
    ["-e", "process.stderr.write('actual exception\\n');process.exitCode=23"],
    process.env,
    process.cwd(),
  );
  assert.equal(failed.exitCode, 23);
  assert.equal(failed.childClosed, true);
  assert.equal(failed.stderr, "actual exception\n");
  const timed = await personalCommand(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    process.env,
    process.cwd(),
    50,
  );
  assert.equal(timed.timedOut, true);
  assert.equal(timed.childClosed, true);
});

const verifier = fileURLToPath(new URL("./verify-personal-candidate.py", import.meta.url));
const control = String.raw`
import hashlib,importlib.util,io,json,pathlib,sys,tarfile,traceback,zipfile
spec=importlib.util.spec_from_file_location('verifier',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=pathlib.Path(sys.argv[2]);mode=sys.argv[3]
sha=lambda b:hashlib.sha256(b).hexdigest()
hooks=['hermes-agent/venv/Lib/site-packages/nemoclaw_native_windows.py','hermes-agent/.hermes-runtime/python/cpython-3.11.16-windows-aarch64-none/Lib/site-packages/nemoclaw_native_windows.py','tools/browser-use/Lib/site-packages/nemoclaw_native_windows.py']
data=pathlib.Path(sys.argv[1]).with_name('nemoclaw_native_windows.py').read_bytes()
# This fixture's adapter bytes follow the current source; the production
# verifier keeps its immutable pin for the actual historical base artifact.
m.ADAPTER=sha(data)
files={name:data for name in hooks};files['asset.dat']=b'correct payload'
dirs=sorted({p.as_posix() for n in files for p in pathlib.PurePosixPath(n).parents if str(p)!='.'}|{'empty'},key=lambda n:(n.count('/'),n))
rows=[{'path':name,'bytes':len(value),'sha256':sha(value)} for name,value in files.items()]
rows.append({'path':'resource-link','linkTarget':'asset.dat'})
if mode=='outside':rows[-1]['linkTarget']='../outside'
if mode=='cycle':rows[-1]['linkTarget']='resource-link'
if mode=='parent-link':rows.append({'path':'resource-link/unlisted','bytes':0,'sha256':sha(b'')})
inventory={'files':rows,'directories':dirs}
adapt={'files':[row for row in rows if row['path'] in hooks]}
build={'status':'runtime-provisioned','sourceUnchanged':True,'fallbacks':[]}
encoded=lambda value:json.dumps(value).encode()
raw=io.BytesIO()
with tarfile.open(fileobj=raw,mode='w:gz') as tar:
 for directory in dirs:
  item=tarfile.TarInfo('runtime/'+directory);item.type=tarfile.DIRTYPE;tar.addfile(item)
 for name,value in files.items():
  if mode=='hash-drift' and name=='asset.dat':value=b'changed payload'
  item=tarfile.TarInfo('runtime/'+name);item.size=len(value);tar.addfile(item,io.BytesIO(value))
 item=tarfile.TarInfo('runtime/resource-link');item.type=tarfile.SYMTYPE;item.linkname=rows[-1].get('linkTarget','asset.dat');tar.addfile(item)
 if mode=='unlisted':
  item=tarfile.TarInfo('runtime/extra');item.size=1;tar.addfile(item,io.BytesIO(b'x'))
 if mode=='duplicate':
  item=tarfile.TarInfo('runtime/asset.dat');item.size=0;tar.addfile(item,io.BytesIO())
tarbytes=raw.getvalue()
candidate={'controllerSource':m.HEAD,'upstreamCommit':m.UPSTREAM,'status':'candidate-bytes-exported','completeByteInventory':True,'runtimeExecutionQualified':False,'installedAcceptance':False,'activationAllowed':False,'sourceFilesVerified':1,'inventorySha256':sha(encoded(inventory)),'buildReceiptSha256':sha(encoded(build)),'adaptationReceiptSha256':sha(encoded(adapt)),'startupAdapterSha256':m.ADAPTER,'archive':{'file':'candidate.tar.gz','bytes':len(tarbytes),'sha256':sha(tarbytes)}}
if mode=='wrong-source':candidate['controllerSource']='0'*40
if mode=='wrong-adapter':candidate['startupAdapterSha256']='0'*64
if mode=='false-qualified':candidate['runtimeExecutionQualified']=True
zipfile_path=root/'artifact.zip'
with zipfile.ZipFile(zipfile_path,'w') as z:
 for name,value in [('runtime-candidate.json',candidate),('payload-inventory.json',inventory),('official-runtime-build.json',build),('native-adaptation.json',adapt)]:z.writestr('evidence/'+name,encoded(value))
 z.writestr('evidence/candidate.tar.gz',tarbytes)
expected_size=zipfile_path.stat().st_size;expected_hash=m.digest(zipfile_path)
if mode=='zip-hash':
 rawzip=bytearray(zipfile_path.read_bytes());rawzip[-1]^=1;zipfile_path.write_bytes(rawzip)
if mode=='zip-size':expected_size+=1
evidence=root/'evidence';evidence.mkdir()
if mode=='owned-existing':
 (root/'runtime').mkdir();(root/'runtime/sentinel').write_bytes(b'existing user data')
if mode=='owned-ownership-conflict':(evidence/'runtime-ownership.json').write_bytes(b'existing evidence')
try:
 m.verify_zip(zipfile_path,expected_size,expected_hash)
 with zipfile.ZipFile(zipfile_path) as z:
  details=m.documents(z);size=m.verify_members(z,details)
  if mode.startswith('owned'):
   # Exercise the real extraction/ownership boundary; source validation has its own controls.
   def source_control(runtime,source_archive):
    if mode=='owned-source-failure':raise ValueError('source verification failed')
    return 1
   m.verify_original_source=source_control
   m.stage_verified(z,details,root/'runtime',evidence,root/'source.tar.gz','a'*40)
  else:m.extract_verified(z,details,root/'runtime')
 result={'ok':True,'bytes':size,'regular':(root/'runtime/asset.dat').read_bytes().decode(),'link':(root/'runtime/resource-link').read_bytes().decode(),'empty':(root/'runtime/empty').is_dir()}
except BaseException as error:result={'ok':False,'error':str(error),'traceback':traceback.format_exc()[-12000:],'extracted':(root/'runtime').exists()}
if mode.startswith('owned'):
 result['sentinel']=(root/'runtime/sentinel').read_text() if (root/'runtime/sentinel').exists() else None
 result['ownership']=(evidence/'runtime-ownership.json').read_text() if (evidence/'runtime-ownership.json').exists() else None
 result['extraction']=(evidence/'extraction.json').read_text() if (evidence/'extraction.json').exists() else None
print(json.dumps(result))
`;

function run(mode: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "personal-candidate-"));
  try {
    const child = spawnSync(
      process.env.NEMOCLAW_TEST_PYTHON ?? "python3",
      ["-I", "-c", control, verifier, root, mode],
      { encoding: "utf8", timeout: 20_000 },
    );
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    const evidence = process.env.NEMOCLAW_PERSONAL_CONTROL_EVIDENCE;
    if (evidence)
      fs.writeFileSync(
        path.join(evidence, mode + ".json"),
        JSON.stringify(result, null, 2) + "\n",
        { flag: "wx" },
      );
    return result;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("verified nested bytes retain regular data, a safe link and an empty directory", () => {
  const result = run("valid");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.regular, "correct payload");
  assert.equal(result.link, "correct payload");
  assert.equal(result.empty, true);
});
test("current base extraction records this controller and its fresh root without replay claims", () => {
  const result = run("owned");
  assert.equal(result.ok, true, JSON.stringify(result));
  const ownership = JSON.parse(result.ownership);
  const extraction = JSON.parse(result.extraction);
  assert.equal(ownership.classification, "verified-current-Hermes-base-extraction");
  assert.equal(ownership.controllerSource, "a".repeat(40));
  assert.equal(ownership.createdByExtraction, true);
  assert.equal(ownership.createdByReplay, undefined);
  assert.equal(ownership.runtimeRoot, extraction.runtimeRoot);
  assert.equal(extraction.originalBuildRoot, "C:\\NemoClawHermesProbe-5804d8b1dcca");
  assert.equal(extraction.allFilesRehashed, true);
  assert.equal(extraction.allLinksContained, true);
  assert.equal(extraction.runtimeExecuted, false);
});
for (const mode of ["owned-existing", "owned-source-failure", "owned-ownership-conflict"]) {
  test(`${mode} preserves existing data and removes only a failed fresh extraction`, () => {
    const result = run(mode);
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.extracted, mode === "owned-existing");
    assert.equal(result.sentinel, mode === "owned-existing" ? "existing user data" : null);
    assert.equal(result.extraction, null);
    if (mode === "owned-existing") {
      assert.equal(result.ownership, null);
      assert.match(result.error, /must be fresh/u);
    } else if (mode === "owned-ownership-conflict") {
      assert.equal(result.ownership, "existing evidence");
      assert.match(result.error, /File exists/u);
    } else {
      assert.equal(JSON.parse(result.ownership).createdByExtraction, true);
      assert.match(result.error, /source verification failed/u);
    }
  });
}
for (const [mode, expected] of [
  ["zip-hash", /ZIP hash\/size mismatch/u],
  ["zip-size", /ZIP hash\/size mismatch/u],
  ["hash-drift", /file hash mismatch/u],
  ["outside", /leaves or misses/u],
  ["cycle", /Cyclic/u],
  ["parent-link", /traverses a link parent/u],
  ["unlisted", /size\/type/u],
  ["duplicate", /Duplicate nested/u],
  ["wrong-source", /unexpected identity/u],
  ["wrong-adapter", /wrong reviewed/u],
  ["false-qualified", /qualification claim/u],
] as const) {
  test(`${mode} refuses the candidate before runtime extraction`, () => {
    const result = run(mode);
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.match(result.error, expected);
    assert.equal(result.extracted, false);
  });
}

test("native Personal request denies external networking and preserves owned filesystem grants", () => {
  const request = personalRequest(
    "C:\\node\\node.exe",
    "C:\\node\\worker.mts",
    "C:\\runtime",
    "C:\\NemoClawMsysProof-1234567890ab-state-start",
    "1234567890abcdef12345678",
    "C:\\Windows",
  );
  assert.equal(request.version, "1.0.0");
  assert.deepEqual(request.fallback, { allowDaclMutation: false });
  assert.equal(request.process.inheritDefaultEnv, false);
  assert.deepEqual(request.telemetry, { enabled: false });
  assert.deepEqual(request.processContainer, {
    leastPrivilege: false,
    capabilities: [],
  });
  assert.deepEqual(request.network, {
    egress: { default: "deny" },
    ingress: { default: "deny", hostLoopback: "deny" },
  });
  assert.deepEqual(request.filesystem, {
    readonlyPaths: ["C:\\runtime", "C:\\node"],
    readwritePaths: ["C:\\NemoClawMsysProof-1234567890ab-state-start"],
  });
  assert.deepEqual(request.ui, { disable: false, clipboard: "none", injection: false });
  assert.equal(request.containerId, "nm-1234567890ab-start");
  assert(
    request.process.commandLine.startsWith(
      '"C:\\runtime\\mxc-compat\\NemoClawMsysLauncher.exe" "--" "C:\\node\\node.exe"',
    ),
  );
  assert.equal(request.process.timeout, 120_000);
  assert(
    !request.process.env.some(
      (value) => value.startsWith("GH_TOKEN=") || value.startsWith("NVIDIA_API_KEY="),
    ),
  );
  assert(request.process.env.includes("HERMES_DISABLE_LAZY_INSTALLS=1"));
  assert(
    request.process.env.includes(
      "NEMOCLAW_AGENT_HOME=C:\\NemoClawMsysProof-1234567890ab-state-start",
    ),
  );
  assert(request.process.env.includes("TEMP=C:\\NemoClawMsysProof-1234567890ab-state-start\\temp"));
  assert(request.process.env.includes("HERMES_GIT_BASH_PATH=C:\\runtime\\git\\bin\\bash.exe"));
  assert(request.process.env.includes("NEMOCLAW_MSYS_TOKEN_INSPECTION_HOLD=repair-query"));
  assert(request.process.env.includes("NEMOCLAW_MSYS_DIAGNOSTICS=0"));
  assert(request.process.env.includes("AGENT_BROWSER_ARGS=--enable-logging=stderr"));
  assert(!request.process.env.some((entry) => entry.startsWith("NEMOCLAW_MSYS_TOKEN_INSPECTION=")));
  assert(
    !request.process.env.some((entry) => entry.startsWith("NEMOCLAW_HERMES_PRIVATE_DESKTOP=")),
  );
});
test("the fixed request rejects a command-line quote or invalid nonce", () => {
  assert.throws(
    () =>
      personalRequest(
        'C:\\bad"\\node.exe',
        "C:\\worker",
        "C:\\runtime",
        "C:\\share",
        "1234567890abcdef12345678",
        "C:\\Windows",
      ),
    /Invalid/u,
  );
  assert.throws(
    () =>
      personalRequest(
        "C:\\node.exe",
        "C:\\worker",
        "C:\\runtime",
        "C:\\share",
        "wrong",
        "C:\\Windows",
      ),
    /Invalid/u,
  );
});
test("component evidence requires one exact nonce and operation result", () => {
  const line =
    "NEMOCLAW_PERSONAL_RESULT=" +
    JSON.stringify({ schemaVersion: 1, component: "bash", nonce: "one", passed: false });
  assert.equal(parseComponent(line, "bash", "one").passed, false);
  const crashpad = 'NEMOCLAW_CRASHPAD_RESULT={"diagnosticOnly":true,"rawDumpRetained":false}';
  assert.deepEqual(
    parseComponent(crashpad + "\n" + line, "bash", "one"),
    parseComponent(line, "bash", "one"),
  );
  assert.throws(() => parseComponent(line, "browser", "one"), /identity/u);
  assert.throws(() => parseComponent(line, "bash", "two"), /identity/u);
  assert.throws(() => parseComponent(line + "\n" + line, "bash", "one"), /exactly one/u);
});

test("an unclosed executor retains its files until confirmed closure", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "personal-owner-"));
  const file = path.join(root, "owned.txt");
  try {
    fs.writeFileSync(file, "owned");
    assert.equal(removePersonalRoots([root], true, false).removed, false);
    assert.equal(fs.readFileSync(file, "utf8"), "owned");
    assert.deepEqual(removePersonalRoots([root], true, true), { removed: true, errors: [] });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a real receipt write failure preserves the primary error and reports its own failure separately", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "personal-receipt-"));
  try {
    const reports: unknown[] = [];
    assert.equal(
      publishPersonalReceipt(root, {}, new Error("original operation"), (value) =>
        reports.push(value),
      ),
      false,
    );
    assert.match(JSON.stringify(reports[0]), /original operation/u);
    assert.match(JSON.stringify(reports[1]), /receiptWriteError/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("browser probe retains error-only responses and requires the complete success envelope", () => {
  const check = String.raw`
import ast,importlib.util,json,pathlib,sys,traceback
source=pathlib.Path(sys.argv[1]);tree=ast.parse(source.read_text())
spec=importlib.util.spec_from_file_location('native_paths',source.with_name('nemoclaw_native_windows.py'))
native_paths=importlib.util.module_from_spec(spec);spec.loader.exec_module(native_paths)
function=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='browser_check')
operation=next(n for n in function.body if isinstance(n,ast.Try))
# Execute the exact response/assertion/handler slice only. No native browser,
# localhost server or cleanup process is executed by this portable control.
body=operation.body[1:]
assert isinstance(body[0],ast.Assign) and body[0].targets[0].id=='raw'
trial=ast.Try(body=body,handlers=operation.handlers,orelse=[],finalbody=[])
module=ast.fix_missing_locations(ast.Module(body=[trial],type_ignores=[]))
code=compile(module,str(source),'exec')
normal={'success':True,'exit_code':0,'output':'BROWSER_PERSONAL_OK'}
responses=[normal,{'error':'controlled exact upstream error-only response'},
 {'success':True,'output':'BROWSER_PERSONAL_OK'},
 {'success':True,'exit_code':False,'output':'BROWSER_PERSONAL_OK'},
 {'success':True,'exit_code':1,'output':'BROWSER_PERSONAL_OK'},
 {'success':True,'exit_code':0,'output':123},
 {'success':True,'exit_code':0,'output':'BROWSER_PERSONAL_OK','error':'failed'},
 {'success':False,'exit_code':0,'output':'BROWSER_PERSONAL_OK'},
 {'success':True,'exit_code':0,'output':'missing marker'}, ['not-an-envelope']]
for index,value in enumerate(responses):
 raw=json.dumps(value);context={'json':json,'native_paths':native_paths,'browser_exec':lambda *a,**k:raw,'code':'not executed','session':'fixture','task':'fixture','result':None,'raw':None,'primary':None}
 exec(code,context)
 if index==0:assert context['primary']is None
 else:
  failure=context['primary'];assert isinstance(failure,AssertionError),type(failure)
  assert failure.__notes__==['Browser Use raw response: '+repr(raw)]
  assert raw in ''.join(traceback.format_exception(failure))
context={'json':json,'native_paths':native_paths,'browser_exec':lambda *a,**k:'not json','code':'not executed','session':'fixture','task':'fixture','result':None,'raw':None,'primary':None}
exec(code,context);assert isinstance(context['primary'],json.JSONDecodeError);assert 'not json' in context['primary'].__notes__[0]
refusal=native_paths.NativeStartupRefusal('controlled startup refusal')
def refuse(*args,**kwargs):raise refusal
context.update(browser_exec=refuse,raw=None,primary=None)
exec(code,context);assert context['primary']is refusal;assert refusal.__notes__==['Browser Use raw response: None']
print(json.dumps({'responseCases':11,'startupRefusalPreserved':True,'nativeBrowserExecuted':False,'errorOnlyResponsePreserved':True}))
`;
  const result = spawnSync(
    process.env.NEMOCLAW_TEST_PYTHON ?? "python3",
    [
      "-I",
      "-B",
      "-c",
      check,
      fileURLToPath(new URL("./probe-personal-python.py", import.meta.url)),
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.responseCases, 11);
  assert.equal(evidence.startupRefusalPreserved, true);
});

test("completed replay binds a historical immutable base to the current controller", () => {
  const pin = completedPersonalReplayPin;
  const candidate = {
    controllerSource: pin.sourceRevision,
    inventorySha256: pin.inventorySha256,
    fileCount: 1,
    logicalBytes: 3,
  };
  const identity = { sha256: pin.candidateReceiptSha256 };
  const replay = {
    schemaVersion: 1,
    classification: "immutable-canonical-hermes-personal-replay",
    base: pin,
    controllerSource: "c".repeat(40),
    runtimeRoot: pin.runtimeRoot,
    completeZipVerified: true,
    completeNestedArchiveVerified: true,
    sourceBuildProvenanceVerified: true,
    runtimeRebuilt: false,
    runtimeRelocated: false,
    runtimeExported: false,
    runtimeExecutionQualified: false,
    installedAcceptance: false,
    before: {
      allFilesAndDirectoriesVerified: true,
      inventorySha256: pin.inventorySha256,
      files: 1,
      logicalBytes: 3,
    },
  };
  validatePersonalReplayInput(replay, candidate, identity, pin.runtimeRoot, "c".repeat(40));
  for (const changes of [
    { runtimeRebuilt: true },
    { controllerSource: "d".repeat(40) },
    { base: { ...pin, artifactId: 1 } },
    { before: { ...replay.before, inventorySha256: "0".repeat(64) } },
  ])
    assert.throws(() =>
      validatePersonalReplayInput(
        { ...replay, ...changes },
        candidate,
        identity,
        pin.runtimeRoot,
        "c".repeat(40),
      ),
    );
});

test("replay launches only the separately admitted readonly native component", () => {
  const nonce = "1234567890abcdef12345678";
  const args = [
    "C:\\node\\node.exe",
    "C:\\node\\worker.mts",
    "C:\\runtime",
    "C:\\NemoClawMsysProof-1234567890ab-state-start",
    nonce,
    "C:\\Windows",
  ] as const;
  const native = "C:\\NemoClawPersonalCompat-1234567890ab";
  const request = personalRequest(...args, native);
  assert(request.process.commandLine.startsWith('"' + native + '\\NemoClawMsysLauncher.exe"'));
  assert.deepEqual(request.filesystem.readonlyPaths, [args[2], "C:\\node", native]);
  assert.deepEqual(request.filesystem.readwritePaths, [args[3]]);
  assert.equal(request.process.timeout, 120000);
  assert.throws(() => personalRequest(...args, "C:\\outside"));
});

test("full Personal runtime inventory rejects changed, missing, and additional bytes", async () => {
  const { createHash } = await import("node:crypto");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "full-replay-inventory-"));
  try {
    fs.mkdirSync(path.join(root, "lib"));
    const file = path.join(root, "lib", "module.py");
    fs.writeFileSync(file, "abc");
    const expected = {
      directories: ["lib"],
      files: [
        {
          path: "lib/module.py",
          bytes: 3,
          sha256: createHash("sha256").update("abc").digest("hex"),
        },
      ],
    };
    const before = verifyPersonalRuntimeInventory(root, expected, "a".repeat(64));
    assert.equal(before.files, 1);
    assert.equal(before.directories, 1);
    assert.equal(before.logicalBytes, 3);
    assert.equal(before.inventorySha256, "a".repeat(64));
    assert.equal(before.allFilesAndDirectoriesVerified, true);
    fs.writeFileSync(file, "abd");
    assert.throws(() => verifyPersonalRuntimeInventory(root, expected, "a".repeat(64)));
    fs.unlinkSync(file);
    assert.throws(() => verifyPersonalRuntimeInventory(root, expected, "a".repeat(64)));
    fs.writeFileSync(file, "abc");
    fs.mkdirSync(path.join(root, "unexpected"));
    assert.throws(() => verifyPersonalRuntimeInventory(root, expected, "a".repeat(64)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function postDesktopObservation(initial: any) {
  const request = desktopAbsenceRequest(initial);
  return {
    attempted: true,
    request,
    requestIdentity: { sha256: "b".repeat(64) },
    error: null,
    execution: {
      childClosed: true,
      timedOut: false,
      outputExceeded: false,
      exitCode: 0,
      error: null,
    },
    receipt: {
      value: {
        schemaVersion: 1,
        classification: "post-executor-desktop-absence",
        requestSha256: "b".repeat(64),
        binding: initial.binding,
        appContainerSid: initial.appContainerSid,
        contextMatched: true,
        context: {
          hostSession: 2,
          stationName: "WinSta0",
          hostUserSid: request.hostUserSid,
          tokenHandleClosed: true,
          sidBufferFreed: true,
        },
        clock: "GetTickCount64",
        startedTick: 120,
        completedTick: 122,
        rows: initial.ownedNames.map((name: string) => ({
          name,
          requestedAccess: 0x20000,
          openFlags: 0,
          inheritRequested: false,
          present: false,
          absent: true,
          openError: 2,
          lookupHandleClosed: true,
          closeError: 0,
          startedTick: 120,
          completedTick: 121,
        })),
        attemptsPerName: 1,
        selectionAttempted: false,
        mutationAttempted: false,
        enumerationAttempted: false,
        error: null,
        passed: true,
      },
    },
  };
}

test("post-executor desktop absence preserves Drop failure and requires exact later readback", () => {
  const rows = desktopOwnerRows();
  rows[2].absentAfterOwnerClose = false;
  rows[2].absenceError = null;
  const execution = desktopOwnerExecution(rows),
    initial = inspectHermesDesktopCleanup(execution, desktopOwnerBinding);
  assert.equal(initial.passed, false);
  assert.equal(initial.identityAndCloseVerified, true);
  const post = postDesktopObservation(initial);
  const accepted = inspectHermesDesktopCleanup(execution, desktopOwnerBinding, post);
  assert.equal(accepted.passed, true);
  assert.equal(accepted.immediateDropAbsencePassed, false);
  assert.match(accepted.immediateDropAbsenceError.message, /absence/u);
  assert.equal(accepted.observerClosed, true);
  for (const change of [
    (x: any) => (x.receipt.value.rows[0].present = true),
    (x: any) => (x.receipt.value.rows[0].openError = 5),
    (x: any) => (x.receipt.value.rows[0].lookupHandleClosed = false),
    (x: any) => (x.receipt.value.rows[0].name = "Default"),
    (x: any) => (x.receipt.value.context.hostSession = 3),
    (x: any) => (x.receipt.value.startedTick = 99),
    (x: any) => (x.receipt.value.binding.executorPid = 999),
    (x: any) => (x.receipt.value.requestSha256 = "c".repeat(64)),
    (x: any) => (x.execution.exitCode = 1),
    (x: any) => (x.execution.outputExceeded = true),
  ]) {
    const bad = structuredClone(post);
    change(bad);
    assert.equal(inspectHermesDesktopCleanup(execution, desktopOwnerBinding, bad).passed, false);
  }
  for (const execution of [{ ...post.execution, childClosed: false }, null]) {
    const unclosed = { ...post, execution, error: { message: "unconfirmed observer" } };
    const value = inspectHermesDesktopCleanup(
      desktopOwnerExecution(rows),
      desktopOwnerBinding,
      unclosed,
    );
    assert.equal(value.passed, false);
    assert.equal(value.observerClosed, false);
  }
  rows[3].closed = false;
  assert.equal(
    inspectHermesDesktopCleanup(desktopOwnerExecution(rows), desktopOwnerBinding, post).passed,
    false,
  );
});

test("fixed desktop observer rejects unowned names/context and never accepts present or inaccessible lookups", () => {
  const helper = fileURLToPath(new URL("./probe-desktop-absence.py", import.meta.url));
  const program = String.raw`
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('desktop',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
r=json.loads(sys.argv[2])
class API:
 def __init__(self,error=2,present=False,closed=True,session=2):self.error=error;self.present=present;self.closed=closed;self.session=session;self.names=[]
 def tick(self):return 120
 def context(self):return {'hostSession':self.session,'stationName':'WinSta0','hostUserSid':r['hostUserSid'],'tokenHandleClosed':True,'sidBufferFreed':True}
 def observe(self,name):
  self.names.append(name)
  return {'name':name,'absent':not self.present and self.error in (2,3),'lookupHandleClosed':self.closed,'closeError':0 if self.closed else 5}
for error,present,closed,passed in [(2,False,True,True),(3,False,True,True),(5,False,True,False),(0,True,True,False),(0,True,False,False)]:
 api=API(error,present,closed);value=m.observe(r,api);assert value['passed']==passed and api.names==r['names']
for bad in [dict(r,names=['Default']),dict(r,executorClosed=False),dict(r,afterDropTick=121)]:
 try:m.observe(bad,API());raise AssertionError('unexpected acceptance')
 except ValueError:pass
api=API(session=3)
try:m.observe(r,api);raise AssertionError('unexpected context acceptance')
except ValueError:assert not api.names
print('9 bounded desktop observer controls passed; no Windows execution')
`;
  const request = desktopAbsenceRequest(
    inspectHermesDesktopCleanup(desktopOwnerExecution(), desktopOwnerBinding),
  );
  const result = spawnSync(
    process.env.NEMOCLAW_TEST_PYTHON ?? "python3",
    ["-B", "-c", program, helper, JSON.stringify(request)],
    {
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("renderer context admission binds current source, AMD64 bytes and unexecuted build", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "renderer-context-"));
  try {
    const identity = (file: string) => {
      const bytes = fs.readFileSync(file);
      return {
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    };
    const source = (relative: string) => ({
      path: relative,
      ...identity(fileURLToPath(new URL("../../../" + relative, import.meta.url))),
    });
    const files = [
      ["context-helper", "NemoClawRendererContext-x64.exe"],
      ["creation-sentinel", "creation-sentinel-x64.exe"],
    ].map(([role, relativePath]) => {
      const data = Buffer.alloc(128);
      data.write("MZ");
      data.writeUInt32LE(64, 60);
      data.write("PE\0\0", 64);
      data.writeUInt16LE(0x8664, 68);
      const file = path.join(directory, relativePath!);
      fs.writeFileSync(file, data);
      return { role, relativePath, ...identity(file), machine: 0x8664, executed: false };
    });
    const build = {
      schemaVersion: 1,
      classification: "renderer-context-helper-build",
      status: "built",
      sourceRevision: "a".repeat(40),
      executed: false,
      validation: { status: "not-run" },
      compatibilityReceipt: { sourceRevision: "c830cd3ef8315ff46a7ebfcd3c0b2afefd152a4a" },
      source: source("packaging/windows/hermes/renderer-context-helper.cpp"),
      sentinelSource: source("packaging/windows/mxc-bash/creation-sentinel.cpp"),
      files,
    };
    const receipt = path.join(directory, "build-receipt.json");
    const save = () => fs.writeFileSync(receipt, JSON.stringify(build));
    save();
    assert.equal(rendererContextBuild(receipt, "a".repeat(40)).helper.sha256, files[0]!.sha256);
    assert.throws(() => rendererContextBuild(receipt, "b".repeat(40)));
    build.status = "failed";
    save();
    assert.throws(() => rendererContextBuild(receipt, "a".repeat(40)));
    build.status = "built";
    files[0]!.executed = true;
    save();
    assert.throws(() => rendererContextBuild(receipt, "a".repeat(40)));
    files[0]!.executed = false;
    files[0]!.relativePath = "../escape.exe";
    save();
    assert.throws(() => rendererContextBuild(receipt, "a".repeat(40)));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("host comparison starts only after every prior owner closes", async () => {
  const options = {
    browserFirst: true,
    failure: new Error("primary browser failure"),
    attempted: true,
    cleanup: {
      executorClosed: true,
      nativeTeardownVerified: true,
      hostDesktopsReleased: true,
      hostDiagnosticChildrenClosed: true,
      browserDiagnosticComplete: true,
    },
    browserDiagnosticChildrenClosed: false,
    request: {} as any,
    receipt: {} as Record<string, unknown>,
    runtime: "C:\\runtime",
    launcher: "C:\\launcher",
    hostControllerPython: "C:\\python.exe",
    environment: {},
    output: "C:\\output",
    errors: [] as unknown[],
  };
  let calls = 0;
  await completeBrowserFirstHostControl(options, async () => {
    calls++;
    return {} as any;
  });
  assert.equal(calls, 0);
  assert.equal(options.cleanup.hostDiagnosticChildrenClosed, true);
  assert.equal(options.errors.length, 0);
  options.browserDiagnosticChildrenClosed = true;
  options.cleanup.nativeTeardownVerified = false;
  await completeBrowserFirstHostControl(options, async () => {
    calls++;
    return {} as any;
  });
  assert.equal(calls, 0, "Executor closure alone must not authorize a successor");
  options.cleanup.nativeTeardownVerified = true;
  options.cleanup.hostDesktopsReleased = false;
  await completeBrowserFirstHostControl(options, async () => {
    calls++;
    return {} as any;
  });
  assert.equal(calls, 0, "An unconfirmed desktop must not authorize a successor");
});

test("uncertain host control retains ownership and the original browser error", async () => {
  const failure = new Error("original contained browser failure");
  const options = {
    browserFirst: true,
    failure,
    attempted: true,
    cleanup: {
      executorClosed: true,
      nativeTeardownVerified: true,
      hostDesktopsReleased: true,
      hostDiagnosticChildrenClosed: true,
      browserDiagnosticComplete: true,
    },
    browserDiagnosticChildrenClosed: true,
    request: {} as any,
    receipt: {
      derivedRuntime: {
        criticalFiles: [
          { path: "hermes-agent/venv/Scripts/python.exe", bytes: 1, sha256: "a".repeat(64) },
        ],
      },
    } as Record<string, unknown>,
    runtime: "C:\\runtime",
    launcher: "C:\\launcher",
    hostControllerPython: "C:\\python.exe",
    environment: {},
    output: "C:\\output",
    errors: [] as unknown[],
  };
  await completeBrowserFirstHostControl(options, async () => {
    assert.equal(options.cleanup.hostDiagnosticChildrenClosed, false);
    throw new Error("host control receipt unavailable");
  });
  assert.equal(options.failure, failure);
  assert.equal(options.cleanup.hostDiagnosticChildrenClosed, false);
  assert.equal(options.errors.length, 1);
});
