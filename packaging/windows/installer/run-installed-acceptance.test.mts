// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  verifyInstalledHistory,
  readHistoryFixtureFile,
  type HistoryFixture,
} from "./verify-installed-openclaw-history.mts";
import { privateDirectoryLibraryIdentity } from "../app/sqlite-private-directory-build.mts";
import { createHash } from "node:crypto";
import {
  nativeAgentConfigurationRecord,
  normalizeOnboardingConfiguration,
} from "../runtime/native-setup-configuration.mts";
import { nativeCredentialBinding } from "../runtime/native-security.mts";
import { resolveNativeInferenceAddresses } from "../runtime/native-inference-endpoint.mts";

const WINDOWS_POWERSHELL_ENVIRONMENT =
  /^(APPDATA|COMSPEC|HOMEDRIVE|HOMEPATH|LOCALAPPDATA|OS|PATH|PATHEXT|PROCESSOR_ARCHITECTURE|PROCESSOR_ARCHITEW6432|SystemRoot|TEMP|TMP|USERPROFILE|WINDIR)$/iu;

test("migration Save accepts reordered settings but rejects changed values and an unbound baseline", () => {
  const configuration = normalizeOnboardingConfiguration(
    {
      agent: "openclaw",
      inference: "local",
      options: {
        endpoint: "http://127.0.0.1:17193/canary-fixture/v1",
        model: "qualification/migration-canary",
        credential: "fixture-key",
      },
    },
    false,
  );
  // Field order from the pinned 0.1.4 writer, before nativeConfigurationChoices existed.
  const original =
    JSON.stringify(
      {
        schemaVersion: 1,
        classification: "nemoclaw-native-windows-agent-configuration",
        agent: configuration.agent,
        inference: configuration.inference,
        endpoint: configuration.endpoint,
        model: configuration.model,
        credentialStored: true,
        profile: "personal",
        options: {},
      },
      null,
      2,
    ) + "\n";
  const saved = nativeAgentConfigurationRecord(configuration);
  const text = JSON.stringify(saved, null, 2) + "\n";
  assert.notEqual(text, original);
  const cases = [
    { name: "current serializer", text, pass: true },
    { name: "unchanged serializer", text: original, pass: true },
    ...Object.entries({
      agent: "hermes",
      inference: "compatible",
      endpoint: "http://127.0.0.1:18000/v1",
      model: "other-model",
      credentialStored: false,
      profile: "other",
      schemaVersion: "1",
      options: { search: { provider: "brave" } },
      credential: "unexpected-key",
      classification: "other",
    }).map(([name, value]) => ({
      name,
      text: JSON.stringify({ ...saved, [name]: value }),
      pass: false,
    })),
    {
      name: "duplicate field",
      text: text.replace('"schemaVersion": 1,', '"schemaVersion": 1, "schemaVersion": 1,'),
      pass: false,
    },
    { name: "wrong baseline", text, pass: false },
  ];
  const script = String.raw`
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:MIGRATION_SOURCE,[ref]$tokens,[ref]$errors)
if ($errors.Count) {throw 'Migration source does not parse.'}
$owner=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Assert-MigrationSavedConfiguration'},$true)
if ($null -eq $owner) {throw 'Missing configuration transition owner.'}
. ([scriptblock]::Create($owner.Extent.Text))
$payload=[Console]::In.ReadToEnd() | ConvertFrom-Json
foreach ($case in $payload.cases) {
    $hash=if ($case.name -ceq 'wrong baseline') {'0' * 64} else {$payload.originalSha256}
    $failed=$false;$receipt=$null
    try {$receipt=Assert-MigrationSavedConfiguration $payload.original $case.text $hash} catch {$failed=$true}
    if ($failed -eq $case.pass) {throw ('Configuration transition verdict differs: '+$case.name)}
    if ($case.pass) {
        $expected=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($case.text))).ToLowerInvariant()
        if (-not $receipt.settingsPreserved -or $receipt.originalSha256 -cne $hash -or $receipt.savedSha256 -cne $expected -or
            $receipt.serializationChanged -ne ($case.name -ceq 'current serializer')) {throw 'Configuration transition evidence differs.'}
    } elseif ($null -ne $receipt) {throw 'Rejected transition emitted success evidence.'}
}
Write-Output $payload.cases.Count
`;
  const result = spawnSync(
    process.platform === "win32" ? "pwsh.exe" : "pwsh",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      env: powershellEnvironment({
        MIGRATION_SOURCE: fileURLToPath(new URL("run-preview-migration.ps1", import.meta.url)),
      }),
      input: JSON.stringify({
        original,
        originalSha256: createHash("sha256").update(original).digest("hex"),
        cases,
      }),
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(Number(result.stdout.trim()), cases.length);
});

for (const agent of ["openclaw", "hermes"]) {
  for (const endpoint of [
    "http://127.0.0.1:17193/canary-fixture/v1",
    "https://127.0.0.1:17193/tester-fixture/v1",
    "https://127.0.0.1:443/nemoclaw-fixture-a/v1/",
  ]) {
    test(`${agent} local canary retains an optional credential at ${endpoint}`, async () => {
      const options = {
        endpoint,
        model: "qualification/migration-canary",
        credential: "fixture-key",
      };
      const configuration = normalizeOnboardingConfiguration(
        { agent, inference: "local", options },
        false,
      );
      assert.equal(configuration.credential, "fixture-key");
      assert.equal(configuration.localModel, undefined);
      const identity = { agent, inference: "local", endpoint: configuration.endpoint! };
      const destination = new URL("models", endpoint.replace(/\/$/u, "") + "/").href;
      // The pinned 0.1.4 launcher uses this same provider/agent/destination binding.
      assert.equal(
        nativeCredentialBinding(identity),
        createHash("sha256")
          .update(JSON.stringify(["nemoclaw-native-credential-v1", agent, "local", destination]))
          .digest("hex"),
      );
      assert.notEqual(
        nativeCredentialBinding(identity),
        nativeCredentialBinding({
          ...identity,
          agent: agent === "openclaw" ? "hermes" : "openclaw",
        }),
      );
      assert.notEqual(
        nativeCredentialBinding(identity),
        nativeCredentialBinding({
          ...identity,
          endpoint: identity.endpoint + "/other",
        }),
      );
      assert.deepEqual(
        await resolveNativeInferenceAddresses(new URL(endpoint), "local", async () => {
          throw new Error("The local canary must not consult DNS.");
        }),
        [{ address: "127.0.0.1", family: 4 }],
      );
      assert.throws(() =>
        normalizeOnboardingConfiguration({ agent, inference: "compatible", options }, false),
      );
      assert.throws(() =>
        normalizeOnboardingConfiguration(
          {
            agent,
            inference: "local",
            options: { ...options, endpoint: "https://example.com/v1" },
          },
          false,
        ),
      );
    });
  }
}

test("migration inference canary detects held and disconnected clients and releases its listener", () => {
  const script = String.raw`
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
. $env:CANARY_SOURCE
foreach ($scenario in @('quiet','held','disconnected')) {
    $canary=Start-PreviewInferenceCanary -Nonce ('a' * 32)
    $endpoint=[uri]$canary.endpoint
    $client=$null
    try {
        if ($scenario -cne 'quiet') {
            $client=[Net.Sockets.TcpClient]::new()
            $client.Connect($endpoint.Host,$endpoint.Port)
            if ([Threading.Tasks.Task]::WaitAny([Threading.Tasks.Task[]]@($canary.accept),5000) -lt 0) {throw 'Fixture connection not accepted.'}
            if ($scenario -ceq 'disconnected') {$client.Dispose();$client=$null}
        }
        $failure=$null;$receipt=$null
        try {$receipt=Stop-PreviewInferenceCanary -Canary $canary} catch {$failure=$_.Exception.Message}
        if ($scenario -ceq 'quiet') {
            if ($null -ne $failure -or $receipt.connectionsObserved -ne 0 -or -not $receipt.closed) {throw 'Quiet listener failed.'}
        } elseif ($failure -cne 'The migration fixture attempted an inference connection.' -or $null -ne $receipt) {
            throw 'An inference connection was reported as quiet.'
        }
        if (-not $canary.closed -or -not $canary.accept.IsCompleted -or $canary.listener.Server.IsBound) {throw 'Listener or accept remained live.'}
        $repeated=$false
        try {$null=Stop-PreviewInferenceCanary -Canary $canary} catch {$repeated=$_.Exception.Message -ceq 'The inference canary was already closed.'}
        if (-not $repeated) {throw 'Repeated closure manufactured a quiet receipt.'}
    } finally {
        if ($null -ne $client) {$client.Dispose()}
        if (-not $canary.closed) {try {$null=Stop-PreviewInferenceCanary -Canary $canary} catch {}}
    }
}
Write-Output 'CANARY_3_PASS'
`;
  const result = spawnSync(
    process.platform === "win32" ? "pwsh.exe" : "pwsh",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      env: powershellEnvironment({
        CANARY_SOURCE: fileURLToPath(new URL("preview-inference-canary.ps1", import.meta.url)),
      }),
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout.trim(), "CANARY_3_PASS");
});

test(
  "native provider selection rejects missing, disabled and duplicate choices",
  { skip: process.platform !== "win32" },
  () => {
    const script = String.raw`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:QUALIFIER_SOURCE,[ref]$tokens,[ref]$errors)
if ($errors.Count) {throw 'Package qualifier does not parse.'}
$owner=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Invoke-NativeSetupSelection'},$true)
foreach ($name in @('$providerName','$listCondition')) {
    $assignment=@($owner.FindAll({param($node) $node -is [Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -ceq $name},$true))
    if ($assignment.Count -ne 1) {throw 'Provider selector assignment is ambiguous.'}
    Set-Variable -Name $(if ($name -ceq '$providerName') {'nameAssignment'} else {'conditionAssignment'}) -Value ([scriptblock]::Create($assignment[0].Extent.Text))
}
$guard=@($owner.FindAll({param($node) $node -is [Management.Automation.Language.IfStatementAst] -and $node.Extent.Text.Contains('The requested native inference provider is missing, disabled, or ambiguous.')},$true))
if ($guard.Count -ne 1) {throw 'Missing provider admission guard.'}
$admit=[scriptblock]::Create($guard[0].Extent.Text)
function Fail-PackageQualification {param($message) throw $message}
foreach ($Inference in @('local','compatible')) {
    . $nameAssignment; . $conditionAssignment
    $conditions=$listCondition.GetConditions()
    if ($conditions.Count -ne 2 -or $conditions[0].Property -ne [Windows.Automation.AutomationElement]::ControlTypeProperty -or
        $conditions[0].Value -ne [Windows.Automation.ControlType]::ListItem.Id -or
        $conditions[1].Property -ne [Windows.Automation.AutomationElement]::NameProperty -or
        $conditions[1].Value -cne $(if ($Inference -ceq 'local') {'Local endpoint · experimental'} else {'Compatible HTTPS endpoint'})) {throw 'Wrong provider selection condition.'}
    foreach ($scenario in @('single','missing','duplicate','disabled')) {
        $providers=@(@{Current=@{IsEnabled=$true}})
        if ($scenario -ceq 'missing') {$providers=@()}
        if ($scenario -ceq 'duplicate') {$providers+=@{Current=@{IsEnabled=$true}}}
        if ($scenario -ceq 'disabled') {$providers[0].Current.IsEnabled=$false}
        $failed=$false
        try {. $admit} catch {$failed=$true}
        if ($failed -ne ($scenario -cne 'single')) {throw 'Provider admission verdict differs.'}
    }
}
Write-Output 'PROVIDER_8_PASS'
`;
    const result = spawnSync(
      "pwsh.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        env: powershellEnvironment({
          QUALIFIER_SOURCE: fileURLToPath(
            new URL(
              "../../../scripts/checks/run-windows-native-package-qualification.ps1",
              import.meta.url,
            ),
          ),
        }),
        encoding: "utf8",
        windowsHide: true,
        timeout: 30000,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout.trim(), "PROVIDER_8_PASS");
  },
);

for (const agent of ["openclaw", "hermes"])
  test(`${agent} source capture rejects incomplete provenance before installation`, () => {
    const script = String.raw`
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:ACCEPTANCE_SOURCE,[ref]$tokens,[ref]$errors)
if ($errors.Count) {throw 'Acceptance script does not parse.'}
$capture=$ast.Find({param($node)
  $node -is [Management.Automation.Language.IfStatementAst] -and
  $node.Clauses[0].Item1.Extent.Text -ceq '$sourceBoundAcceptance' -and
  $node.Extent.Text.Contains('--capture-artifact-source')
},$true)
if ($null -eq $capture) {throw 'Missing pre-install source capture.'}
$install=$ast.Find({param($node)
  $node -is [Management.Automation.Language.CommandAst] -and
  $node.Extent.Text.StartsWith("Invoke-OwnedSetup '-install'")
},$true)
if ($null -eq $install -or $capture.Extent.EndOffset -ge $install.Extent.StartOffset) {throw 'Source capture follows installation.'}
$execute=[scriptblock]::Create($capture.Extent.Text.Replace('& $ciNode','& Invoke-CaptureFixture'))
$Agent=$env:TEST_AGENT;$sourceBoundAcceptance=$true;$openClawRestart=$Agent -ceq 'openclaw';$SourceRoot='trusted-source';$ArtifactSourceRevision='a' * 40;$controllerSource='b' * 40
$work='work-fixture';$env:GITHUB_RUN_ID='123';$env:GITHUB_RUN_ATTEMPT='1'
function Invoke-CaptureFixture {
  $script:calls++
  if ($args[2] -cne "$SourceRoot\packaging\windows\installer\qualify-installed-$Agent.mts") {throw 'Candidate code selected for capture.'}
  foreach ($name in @('--capture-artifact-source','--artifact-source-root','--controller-source-root','--artifact-source-revision','--controller-source-revision','--controller-run','--output')) {
    if ($args -notcontains $name) {throw 'Missing candidate capture input.'}
  }
  if ($args[[array]::IndexOf($args,'--artifact-source-root')+1] -cne $ArtifactSourceRoot -or
      $args[[array]::IndexOf($args,'--controller-source-root')+1] -cne $SourceRoot) {throw 'Controller/candidate root confusion.'}
  $global:LASTEXITCODE=if ($scenario -ceq 'failed') {1} else {0}
  if ($scenario -ceq 'bad-hash') {return 'bad'}
  if ($scenario -ceq 'extra-output') {return @('c' * 64,'d' * 64)}
  return 'c' * 64
}
function Get-Content {param($LiteralPath,[switch]$Raw)
  if ($LiteralPath -ceq "$work\assembled\runtime-identity.json") {return '{}'}
  if ($LiteralPath -ceq "$work\package\launcher-build-inputs.json") {return '{"retainedLauncher":{"sha256":"fixture"}}'}
  throw 'Unexpected content read.'
}
function Get-FileHash {param($LiteralPath,$Algorithm)
  if ($Algorithm -cne 'SHA256') {throw 'Wrong hash algorithm.'}
  if ($LiteralPath -ceq "$work\package\immutable-package-build.json") {return @{Hash='e' * 64}}
  if ($LiteralPath -cne (Join-Path $work "$Agent-artifact-source.json")) {throw 'Wrong snapshot identity.'}
  return @{Hash=$(if ($scenario -ceq 'changed') {'d' * 64} else {'c' * 64})}
}
foreach ($scenario in @('pass','missing-root','failed','bad-hash','extra-output','changed')) {
  $ArtifactSourceRoot=if ($scenario -ceq 'missing-root') {''} else {'candidate-source'}
  $script:calls=0;$failed=$false
  try {. $execute} catch {if ($scenario -ceq 'pass') {throw};$failed=$true}
  if ($failed -ne ($scenario -cne 'pass')) {throw 'Incorrect source-capture verdict.'}
  if ($script:calls -ne $(if ($scenario -ceq 'missing-root') {0} else {1})) {throw 'Capture began with missing provenance.'}
  if (-not $failed -and $artifactSourceSnapshotSha256 -cne ('c' * 64)) {throw 'Caller did not retain the pre-install hash.'}
}
$sourceBoundAcceptance=$false;$script:calls=0;. $execute
if ($script:calls -ne 0) {throw 'Other acceptance routes invoked candidate capture.'}
Write-Output '6'
`;
    const result = spawnSync(
      process.platform === "win32" ? "pwsh.exe" : "pwsh",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        env: powershellEnvironment({
          ACCEPTANCE_SOURCE: fileURLToPath(
            new URL("run-installed-acceptance.ps1", import.meta.url),
          ),
          TEST_AGENT: agent,
        }),
        encoding: "utf8",
        windowsHide: true,
        timeout: 30000,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout.trim(), "6");
  });

test("OpenClaw acceptance routes retained restart and keeps recovery custody after incomplete evidence", () => {
  const script = String.raw`
$ErrorActionPreference='Stop'
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:ACCEPTANCE_SOURCE,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw 'Acceptance controller does not parse.' }
$validator=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Assert-OpenClawRestartReceipt'},$true)
. ([scriptblock]::Create($validator.Extent.Text))
$cleanupValidator=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Test-OpenClawOwnedCleanupReceipt'},$true)
. ([scriptblock]::Create($cleanupValidator.Extent.Text))
$owner=@($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.TryStatementAst] -and $null -ne $_.Finally })[0]
$branch=@($owner.Body.Statements | Where-Object { $_ -is [Management.Automation.Language.IfStatementAst] })[0]
$execute=[scriptblock]::Create($branch.Extent.Text.Replace('& $ciNode','& Invoke-TestAgent'))
$cleanup=@($owner.Finally.Statements | Where-Object { $_ -is [Management.Automation.Language.TryStatementAst] })[-1]
$uninstall=[scriptblock]::Create($cleanup.Body.Statements[0].Extent.Text)
$Agent='openclaw'; $Mode='current-build'; $ValidationScope='full-acceptance'; $openClawRestart=$true
$SourceRoot='source-fixture'; $work='work-fixture'; $installation='install-fixture'; $restartHandoff='a' * 64
$artifactSourceSnapshot='snapshot-fixture'; $artifactSourceSnapshotSha256='7' * 64; $controllerSource='8' * 40
$env:GITHUB_RUN_ID='123'; $env:GITHUB_RUN_ATTEMPT='1'
$expectedOpenClawLauncher='b' * 64; $expectedOpenClawPackageBuild='c' * 64
$expectedOpenClawRuntime=@{runtimeId=('d' * 64);manifestSha256=('e' * 64);sourceRevision=('f' * 40);nodeSha256=('1' * 64);nodeVersion='22.23.2'}
function Invoke-TestAgent {
  if ($args -contains "$SourceRoot\packaging\windows\installer\qualify-finished-package.mts") {
    $calls.Add(@($args)); $global:LASTEXITCODE=0; return
  }
  if ($args -notcontains $qualification) { throw 'Wrong OpenClaw qualifier.' }
  $first=$calls.Count -eq 0
  if (($args -contains '--preserve-configuration') -ne $first -or ($args -contains '--reuse-configuration') -eq $first) { throw 'Incorrect cold/warm routing.' }
  foreach ($name in @('--restart-handoff','--package-root','--artifact-source-snapshot','--artifact-source-snapshot-sha256')) {
    $position=[array]::IndexOf($args,$name)
    if ($position -lt 0) { throw 'Missing restart admission input.' }
    $expected=switch ($name) { '--restart-handoff' {$restartHandoff} '--package-root' {"$work\package"} '--artifact-source-snapshot' {$artifactSourceSnapshot} '--artifact-source-snapshot-sha256' {$artifactSourceSnapshotSha256} }
    if ($args[$position+1] -cne $expected) { throw 'Wrong restart admission input.' }
  }
  $previous=[array]::IndexOf($args,'--previous-acceptance')
  if (($previous -ge 0) -ne (-not $first)) { throw 'Incorrect prior receipt routing.' }
  if ($previous -ge 0 -and $args[$previous+1] -cne "$work\installed-acceptance\installed-openclaw-acceptance.json") { throw 'Wrong cold receipt.' }
  if (-not $restartCustodyUnresolved) { throw 'Mutation began without recovery custody.' }
  $calls.Add(@($args))
  $global:LASTEXITCODE=if ($scenario -ceq 'cold-exit' -or ($scenario -ceq 'warm-exit' -and -not $first)) { 1 } else { 0 }
}
function Get-Content {
  param($LiteralPath,[switch]$Raw)
  $warm=$calls.Count -eq 2
  $directory=if ($warm) {'installed-acceptance-warm'} else {'installed-acceptance'}
  if ($LiteralPath -cne "$work\$directory\installed-openclaw-acceptance.json") { throw 'Wrong OpenClaw receipt path.' }
  if ($scenario -ceq 'missing-receipt' -and $warm) { throw 'Missing fixture receipt.' }
  $receipt=@{schemaVersion=2;classification='installed-compiled-openclaw-acceptance';verdict='pass';cleanupErrors=@();cleanupErrorDetails=@();primaryFailure=$null;
    runtime=$expectedOpenClawRuntime.Clone();results=@{response=@{provider='nvidia';model='nvidia/test';deterministicModel=$false;visibleReply=('NEMOCLAW_NVIDIA_' + $(if ($warm) {'3' * 24} else {'2' * 24}))}};
    restart=@{schemaVersion=1;mode=$(if ($warm) {'warm-reused'} else {'cold-preserved'});controllerRun='123:1';handoff=$restartHandoff;installation=$installation;
      configurationReused=$warm;configurationPreserved=(-not $warm);processesStopped=$true;backendCleanupConfirmed=$true;stateOwnerReleased=$true;mutationUnconfirmed=$false;
      credentialMutationConfirmed=$true;cleanupScope=$(if ($warm) {'owned-configuration-state-and-credential'} else {$null});
      cleanupDisposition=$(if ($warm) {'removed-owned-state'} else {'retained-for-warm-run'});provider='nvidia';endpoint='https://integrate.api.nvidia.com/v1';model='nvidia/test';
      launcherSha256=$expectedOpenClawLauncher;packageBuildSha256=$expectedOpenClawPackageBuild;configurationSha256=('4' * 64);
      artifactSourceSnapshotSha256=$artifactSourceSnapshotSha256;controllerSourceRevision=$controllerSource;
      ownedState=@{stateRoot='C:\NemoClawState-S-1-5-21-1-openclaw';device='4';inode='55'};
      retainedConversation=@{sessionKey='agent:main:main';messageCount=$(if ($warm) {4} else {2});sha256=$(if ($warm) {'6' * 64} else {'5' * 64})}}}
  if ($warm) {
    $receipt.restart.restoredConversation=@{sessionKey='agent:main:main';messageCount=2;sha256=('5' * 64)}
    switch ($scenario) {
      'legacy' {$receipt.schemaVersion=1}
      'stale-run' {$receipt.restart.controllerRun='122:1'}
      'foreign-handoff' {$receipt.restart.handoff='9' * 64}
      'changed-config' {$receipt.restart.configurationSha256='9' * 64}
      'changed-state' {$receipt.restart.ownedState.inode='56'}
      'changed-runtime' {$receipt.runtime.runtimeId='9' * 64}
      'changed-package' {$receipt.restart.packageBuildSha256='9' * 64}
      'changed-launcher' {$receipt.restart.launcherSha256='9' * 64}
      'missing-prior-chat' {$receipt.restart.restoredConversation.sha256='9' * 64}
      'no-new-reply' {$receipt.results.response.visibleReply='NEMOCLAW_NVIDIA_' + ('2' * 24)}
      'no-new-messages' {$receipt.restart.retainedConversation.messageCount=2}
      'retained-unknown' {$receipt.restart.cleanupDisposition='retain-unconfirmed'}
      'not-stopped' {$receipt.restart.processesStopped=$false}
      'string-stop' {$receipt.restart.processesStopped='true'}
      'backend-unknown' {$receipt.restart.backendCleanupConfirmed=$false}
      'lease-unknown' {$receipt.restart.stateOwnerReleased=$false}
      'mutation-unknown' {$receipt.restart.mutationUnconfirmed=$true}
      'mock-model' {$receipt.results.response.deterministicModel=$true}
      'cleanup-failure' {$receipt.cleanupErrors=@('failed cleanup')}
      'warm-failed-cleaned' {$receipt.verdict='fail'}
      'missing-credential-proof' {$receipt.restart.credentialMutationConfirmed=$null}
      'missing-cleanup-scope' {$receipt.restart.cleanupScope=$null}
      'wrong-cleanup-scope' {$receipt.restart.cleanupScope='fresh-private-root-only-no-credentials-touched'}
      'warm-root-only' {$receipt.restart.credentialMutationConfirmed=$false;$receipt.restart.cleanupScope='fresh-private-root-only-no-credentials-touched';$receipt.restart.configurationSha256=$null}
    }
  }
  if ($scenario -ceq 'cold-failed-cleaned') {
    $receipt.verdict='fail'; $receipt.restart.cleanupDisposition='removed-owned-state'; $receipt.restart.configurationPreserved=$false
    $receipt.restart.cleanupScope='owned-configuration-state-and-credential'
  }
  if ($scenario -cin @('cold-failed-root-only','cold-root-with-config')) {
    $receipt.verdict='fail'; $receipt.restart.cleanupDisposition='removed-owned-state'; $receipt.restart.configurationPreserved=$false
    $receipt.restart.credentialMutationConfirmed=$false;$receipt.restart.cleanupScope='fresh-private-root-only-no-credentials-touched'
    if ($scenario -ceq 'cold-failed-root-only') {$receipt.restart.configurationSha256=$null}
  }
  return ($receipt | ConvertTo-Json -Depth 10)
}
$scenarios=@('pass','cold-exit','warm-exit','missing-receipt','legacy','stale-run','foreign-handoff','changed-config','changed-state','changed-runtime','changed-package','changed-launcher','missing-prior-chat','no-new-reply','no-new-messages','retained-unknown','not-stopped','string-stop','backend-unknown','lease-unknown','mutation-unknown','mock-model','cleanup-failure','warm-failed-cleaned','cold-failed-cleaned','missing-credential-proof','missing-cleanup-scope','wrong-cleanup-scope','cold-failed-root-only','cold-root-with-config','warm-root-only')
$retained=@('cold-exit','missing-receipt','legacy','stale-run','foreign-handoff','changed-state','changed-runtime','changed-package','changed-launcher','retained-unknown','not-stopped','string-stop','backend-unknown','lease-unknown','mutation-unknown','cleanup-failure','missing-credential-proof','missing-cleanup-scope','wrong-cleanup-scope','cold-root-with-config','warm-root-only')
foreach ($scenario in $scenarios) {
  $calls=[Collections.Generic.List[object]]::new(); $timings=@{startupComparisonAvailable=$false}; $restartCustodyUnresolved=$false; $failed=$false
  try {. $execute} catch {if ($scenario -ceq 'pass') {throw}; $failed=$true}
  if ($failed -ne ($scenario -cne 'pass')) {throw ('Incorrect restart verdict: ' + $scenario)}
  if ($restartCustodyUnresolved -ne ($scenario -cin $retained)) {throw ('Incorrect recovery custody: ' + $scenario)}
  if ($timings.startupComparisonAvailable -eq $failed) {throw 'Incorrect startup comparison claim.'}
  if ($failed -and $timings.ContainsKey('restartPersistence')) {throw 'Incomplete restart claimed persistence.'}
  if (-not $failed -and ($calls.Count -ne 3 -or $timings.restartPersistence.qualified -ne $true)) {throw 'Successful restart did not complete the smoke route.'}
  $denied=$false
  try {. $uninstall} catch {$denied=$true}
  if ($denied -ne ($scenario -cin $retained)) {throw 'Uninstall lost the retained-state recovery guard.'}
}
Write-Output $scenarios.Count
`;
  const result = spawnSync(
    process.platform === "win32" ? "pwsh.exe" : "pwsh",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      env: powershellEnvironment({
        ACCEPTANCE_SOURCE: fileURLToPath(new URL("run-installed-acceptance.ps1", import.meta.url)),
      }),
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout.trim(), "31");
});

for (const [name, read] of [
  ["history", readHistoryFixtureFile],
  ["private-directory library", privateDirectoryLibraryIdentity],
] as const) {
  test(`${name} reads the checked handle and rejects changed paths and hard links`, (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "opened-fixture-controls-"));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, "input.bin");
    const content = Buffer.from([0, 255, 128, 13, 10]);
    fs.writeFileSync(file, content);
    const expected =
      name === "history"
        ? content
        : {
            sha256: createHash("sha256").update(content).digest("hex"),
            bytes: content.length,
          };
    assert.deepEqual(read(file), expected);
    const alias = path.join(root, "alias.bin");
    fs.linkSync(file, alias);
    assert.throws(() => read(file));
    fs.unlinkSync(alias);
    const originalOpen = fs.openSync;
    const originalStat = fs.lstatSync;
    let descriptor: number | undefined;
    const open = context.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
      descriptor = originalOpen(...args);
      return descriptor;
    });
    for (const kind of ["replaced", "symlink"] as const) {
      const stat = context.mock.method(
        fs,
        "lstatSync",
        (...args: Parameters<typeof fs.lstatSync>) => {
          const actual = originalStat(...args);
          return new Proxy(actual, {
            get(target, property) {
              if (property === "ino" && kind === "replaced") return BigInt(target.ino) + 1n;
              if (property === "isSymbolicLink" && kind === "symlink") return () => true;
              return Reflect.get(target, property);
            },
          });
        },
      );
      try {
        assert.throws(() => read(file));
      } finally {
        stat.mock.restore();
      }
      assert.notEqual(descriptor, undefined);
      assert.throws(() => fs.fstatSync(descriptor!), { code: "EBADF" });
    }
    const failedRead = context.mock.method(
      fs,
      name === "history" ? "readSync" : "readFileSync",
      () => {
        throw new Error("fixture read failure");
      },
    );
    try {
      assert.throws(() => read(file), /fixture read failure/);
    } finally {
      failedRead.mock.restore();
    }
    assert.throws(() => fs.fstatSync(descriptor!), { code: "EBADF" });
    open.mock.restore();
    assert.deepEqual(read(file), expected);
    const empty = path.join(root, "empty.bin");
    fs.writeFileSync(empty, "", { flag: "wx" });
    if (name === "private-directory library") assert.throws(() => read(empty));
    else assert.deepEqual(read(empty), Buffer.alloc(0));
  });
  test(`${name} distinguishes adjacent 64-bit file identities`, (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "large-identity-controls-"));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, "input.bin");
    fs.writeFileSync(file, "fixture");
    const identity = 2n ** 60n;
    const originalFstat = fs.fstatSync;
    const originalLstat = fs.lstatSync;
    for (const [method, original, ino] of [
      ["fstatSync", originalFstat, identity],
      ["lstatSync", originalLstat, identity + 1n],
    ] as const) {
      context.mock.method(fs, method, (...args: Parameters<typeof original>) => {
        const actual = Reflect.apply(original, fs, args);
        return new Proxy(actual, {
          get(target, property) {
            if (property === "ino") return typeof target.ino === "bigint" ? ino : Number(ino);
            return Reflect.get(target, property);
          },
        });
      });
    }
    assert.throws(() => read(file));
  });
}

test("history reads enforce their bound even when the opened file grows", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "growing-history-controls-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "input.json");
  const oversized = fs.openSync(file, "wx");
  try {
    fs.ftruncateSync(oversized, 16 * 1024 * 1024 + 1);
    assert.throws(() => readHistoryFixtureFile(file), /exceeds its bound/);
    fs.ftruncateSync(oversized, 0);
    fs.writeFileSync(oversized, "{}");
  } finally {
    fs.closeSync(oversized);
  }
  const originalStat = fs.fstatSync;
  let descriptor: number | undefined;
  context.mock.method(fs, "fstatSync", (...args: Parameters<typeof fs.fstatSync>) => {
    descriptor = args[0];
    return originalStat(...args);
  });
  let readBytes = 0;
  context.mock.method(
    fs,
    "readSync",
    (_fd: number, buffer: Buffer, offset: number, length: number) => {
      buffer.fill(120, offset, offset + length);
      readBytes += length;
      return length;
    },
  );
  assert.throws(() => readHistoryFixtureFile(file), /exceeds its bound/);
  assert.equal(readBytes, 16 * 1024 * 1024 + 1);
  assert.notEqual(descriptor, undefined);
  assert.throws(() => originalStat(descriptor!), { code: "EBADF" });
});

test("migration history controls require original archives and complete SQLite events", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "installed-history-controls-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixturePath = path.join(root, "fixture.json");
  const script = String.raw`
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
. $env:HISTORY_OWNER
$fixture=New-MigrationHistoryFixture $env:HISTORY_HOME ('a' * 32) $env:HISTORY_FIXTURE
Assert-MigrationHistoryPreserved $fixture
$failed=$false
try { New-MigrationHistoryFixture $env:HISTORY_HOME ('a' * 32) $env:HISTORY_FIXTURE } catch { $failed=$true }
if (-not $failed) { throw 'A second seed replaced existing history.' }
$original=[IO.File]::ReadAllBytes($fixture.store)
[IO.File]::WriteAllBytes($fixture.store,([byte[]](239,187,191)+$original))
$failed=$false
try { Assert-MigrationHistoryPreserved $fixture } catch { $failed=$true }
if (-not $failed) { throw 'A byte-changing history mutation was accepted.' }
[IO.File]::WriteAllBytes($fixture.store,$original)
Assert-MigrationHistoryPreserved $fixture
foreach ($size in @(0,8192,1100000)) {
  $stream=[IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes('x' * $size))
  $reader=[IO.StreamReader]::new($stream)
  try {
    $capture=New-MigrationOutputCapture 'fixture' $reader
    for ($poll=0; $poll -lt 100 -and -not $capture.done; $poll++) { Update-MigrationOutputCapture $capture }
    if (-not $capture.done -or $capture.failed -or $capture.text.Length -gt 1048576 -or
        $capture.overflow -ne ($size -gt 1048576)) { throw 'Migration output bounds failed.' }
    if ($size -le 1048576 -and $capture.text.Length -ne $size) { throw 'Bounded migration output lost data.' }
  } finally { $reader.Dispose(); $stream.Dispose() }
}
Write-Output 'pass'
`;
  const result = spawnSync(
    process.platform === "win32" ? "pwsh.exe" : "pwsh",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      env: powershellEnvironment({
        HISTORY_OWNER: fileURLToPath(new URL("./preview-history-controls.ps1", import.meta.url)),
        HISTORY_HOME: path.join(root, "home"),
        HISTORY_FIXTURE: fixturePath,
      }),
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
    },
  );
  if (process.platform !== "win32" && result.error?.code === "ENOENT") {
    context.skip("PowerShell is unavailable on this non-Windows host.");
    return;
  }
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout.trim(), "pass");
  const fixture: HistoryFixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  assert.throws(() => verifyInstalledHistory(fixture), "Unmigrated JSON must not qualify.");
  const archive = path.join(
    path.dirname(path.dirname(fixture.store)),
    "session-sqlite-import-archive",
  );
  fs.mkdirSync(archive);
  const storeArchive = path.join(archive, "legacy-store.sessions.json.imported-1");
  const transcriptArchive = path.join(archive, "transcript.imported-1.jsonl");
  fs.renameSync(fixture.store, storeArchive);
  fs.renameSync(fixture.transcript, transcriptArchive);
  assert.throws(() => verifyInstalledHistory(fixture), "Archives alone must not qualify.");
  const database = path.join(fixture.home, ".openclaw", "history.sqlite");
  const db = new DatabaseSync(database);
  try {
    db.exec(
      "CREATE TABLE session_nodes (session_key TEXT, current_session_id TEXT); CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT)",
    );
    db.prepare("INSERT INTO session_nodes VALUES (?, ?)").run(
      fixture.sessionKey,
      fixture.sessionId,
    );
    const events = fixture.transcriptText.trimEnd().split("\n");
    const insert = db.prepare("INSERT INTO transcript_events VALUES (?, ?, ?)");
    events.forEach((event, index) => insert.run(fixture.sessionId, index, event));
    const observed = verifyInstalledHistory(fixture);
    assert.equal(observed.importedEvents, 3);
    assert.equal(observed.archives.length, 2);
    assert.deepEqual(verifyInstalledHistory(fixture), observed);
    fs.appendFileSync(storeArchive, " ");
    assert.throws(() => verifyInstalledHistory(fixture));
    fs.writeFileSync(storeArchive, fixture.storeText);
    fs.appendFileSync(transcriptArchive, " ");
    assert.throws(() => verifyInstalledHistory(fixture));
    fs.writeFileSync(transcriptArchive, fixture.transcriptText);
    fs.copyFileSync(storeArchive, path.join(archive, "legacy-store.sessions.json.imported-2"));
    assert.throws(() => verifyInstalledHistory(fixture));
    fs.unlinkSync(path.join(archive, "legacy-store.sessions.json.imported-2"));
    db.prepare("DELETE FROM transcript_events WHERE seq = 2").run();
    assert.throws(() => verifyInstalledHistory(fixture));
    insert.run(fixture.sessionId, 2, events[2]);
    db.prepare("UPDATE session_nodes SET current_session_id = 'another-session'").run();
    assert.throws(() => verifyInstalledHistory(fixture));
    db.prepare("UPDATE session_nodes SET current_session_id = ?").run(fixture.sessionId);
    assert.deepEqual(verifyInstalledHistory(fixture), observed);
  } finally {
    db.close();
  }
});

test("migration launch controller requires owned observations, normal exit and cleanup receipt", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "migration-launch-controls-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const child = path.join(root, "child.cjs");
  // These child processes test controller ordering and result propagation only.
  // The actual installed UI observer and MXC cleanup remain Windows E2E contracts.
  fs.writeFileSync(
    child,
    String.raw`
const fs=require('node:fs'), path=require('node:path');
setTimeout(()=>process.exit(9),10000).unref();
const args=process.argv.slice(2);
const value=name=>args[args.indexOf(name)+1];
const stopped=()=>fs.readdirSync(process.env.HISTORY_EVIDENCE).some(name=>/^observer-stop-[a-f0-9]{64}\.sentinel$/.test(name));
if(args.includes('--configured')) {
  const session=value('--artifact-directory');
  fs.mkdirSync(session);
  const timer=setInterval(()=>{
    if(!stopped()) return;
    clearInterval(timer);
    if(process.env.HISTORY_SCENARIO!=='missing-receipt') {
      fs.writeFileSync(path.join(session,'native-windows-web-ui-abc.json'),JSON.stringify({
        verdict:'pass',runtimeIdentity:{runtimeId:process.env.HISTORY_RUNTIME,sourceRevision:process.env.GITHUB_SHA},
        backend:'process_container',sandboxDeleted:true,sandboxRegistryAbsent:true,gatewayStopped:true,qualificationRootsRemoved:true
      }));
    }
    process.exit(process.env.HISTORY_SCENARIO==='failed-guardian'?1:0);
  },20);
} else {
  const pid=Number(value('-RootProcessId'));
  console.log(JSON.stringify({kind:'observation',rootPid:process.env.HISTORY_SCENARIO==='wrong-owner'?pid+1:pid,
    hostPath:process.env.HISTORY_HOST,windowFound:true,openEnabled:true}));
  const timer=setInterval(()=>{
    if(!stopped()) return;
    clearInterval(timer);
    console.log(JSON.stringify({kind:'stop-invoked'}));
    console.log(JSON.stringify({kind:'closed',exitCode:0}));
  },20);
}
`,
    { flag: "wx" },
  );
  const script = String.raw`
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
. $env:HISTORY_OWNER
function New-PreviewProcess([string]$Executable, [string[]]$Arguments) {
  $info=[Diagnostics.ProcessStartInfo]::new()
  $info.FileName=$env:HISTORY_NODE; $info.UseShellExecute=$false
  $info.ArgumentList.Add($env:HISTORY_CHILD)
  foreach($argument in $Arguments) { $info.ArgumentList.Add($argument) }
  return $info
}
$env:HISTORY_HOST=Join-Path $env:HISTORY_INSTALL ('runtimes\'+$env:HISTORY_RUNTIME+'\app\NemoClaw.Runtime.exe')
$env:GITHUB_SHA='c'*40
if(-not $env:SystemRoot) { $env:SystemRoot=$env:HISTORY_INSTALL }
foreach($scenario in @('success','wrong-owner','missing-receipt','failed-guardian')) {
  $env:HISTORY_SCENARIO=$scenario
  $env:HISTORY_EVIDENCE=Join-Path $env:HISTORY_ROOT $scenario
  $script:MigrationSessionOpen=$false
  $failed=$false
  try { Invoke-MigrationHistorySession $env:HISTORY_INSTALL $env:HISTORY_RUNTIME $env:HISTORY_EVIDENCE }
  catch { $failed=$true }
  $receipt=Get-Content -LiteralPath (Join-Path $env:HISTORY_EVIDENCE 'history-session.json') -Raw | ConvertFrom-Json
  if($scenario -ceq 'success') {
    if($failed -or $script:MigrationSessionOpen -or -not $receipt.passed -or -not $receipt.stopInvoked) { throw 'Normal migration lifecycle was not accepted.' }
  } else {
    if(-not $failed -or -not $script:MigrationSessionOpen -or $receipt.passed) { throw 'Unconfirmed migration cleanup became success.' }
    if($receipt.ready -ne ($scenario -cne 'wrong-owner') -or
       $receipt.closed -ne ($scenario -cne 'wrong-owner')) { throw 'The fixture failed before its intended lifecycle boundary.' }
  }
}
Write-Output 'pass'
`;
  const result = spawnSync(
    process.platform === "win32" ? "pwsh.exe" : "pwsh",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      env: powershellEnvironment({
        HISTORY_OWNER: fileURLToPath(new URL("./preview-history-controls.ps1", import.meta.url)),
        HISTORY_ROOT: root,
        HISTORY_INSTALL: path.join(root, "installation"),
        HISTORY_NODE: process.execPath,
        HISTORY_CHILD: child,
        HISTORY_RUNTIME: "a".repeat(64),
        RUNNER_TEMP: root,
      }),
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
    },
  );
  if (process.platform !== "win32" && result.error?.code === "ENOENT") {
    context.skip("PowerShell is unavailable on this non-Windows host.");
    return;
  }
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout.trim(), "pass");
});

function powershellEnvironment(extra: NodeJS.ProcessEnv = {}) {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) => WINDOWS_POWERSHELL_ENVIRONMENT.test(name)),
    ),
    ...extra,
  };
}

test("setup transactions retain recovery custody after timeout or uncertain process status", () => {
  const script = String.raw`
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:ACCEPTANCE_SOURCE,[ref]$tokens,[ref]$errors)
if ($errors.Count) {throw 'Acceptance source does not parse.'}
$owner=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Invoke-OwnedSetup'},$true)
if ($null -eq $owner) {throw 'Setup process owner missing.'}
. ([scriptblock]::Create($owner.Extent.Text.Replace('[Diagnostics.Process]::Start($info)','(Start-Fixture $info)')))
$guard=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.IfStatementAst] -and $node.Clauses[0].Item1.Extent.Text -ceq '$restartCustodyUnresolved -or $script:SetupTransactionUnconfirmed'},$true))
if ($guard.Count -ne 1) {throw 'Uninstall custody guard is missing or ambiguous.'}
$cleanup=[scriptblock]::Create($guard[0].Extent.Text)
function Start-Fixture($info) {
    $script:starts++
    if ($scenario -ceq 'start-throws') {throw 'start-query-failed'}
    $child=[pscustomobject]@{}
    $child | Add-Member ScriptProperty Id {if ($scenario -ceq 'id-throws') {throw 'identity-query-failed'};return 123}
    $child | Add-Member ScriptProperty ExitCode {if ($scenario -ceq 'exit-query-throws') {throw 'exit-query-failed'};if ($scenario -ceq 'exit-fails') {return 17};return 0}
    $child | Add-Member ScriptMethod WaitForExit {
        param($milliseconds)
        if ($milliseconds -ne 1200000) {throw 'Setup deadline changed.'}
        if ($scenario -cin @('wait-throws','wait-dispose-throws')) {throw 'wait-query-failed'}
        return $scenario -cne 'timeout'
    }
    $child | Add-Member ScriptMethod Kill {$script:kills++;throw 'Installer must not be killed.'}
    $child | Add-Member ScriptMethod Dispose {
        $script:disposals++
        if ($scenario -cin @('dispose-throws','wait-dispose-throws')) {throw 'dispose-failed'}
    }
    return $child
}
$setup='inert-setup-fixture';$restartCustodyUnresolved=$false
foreach ($scenario in @('pass','exit-fails','timeout','start-throws','id-throws','wait-throws','exit-query-throws','dispose-throws','wait-dispose-throws')) {
    $timings=@{stages=@{}};$script:SetupTransactionUnconfirmed=$false;$script:starts=0;$script:kills=0;$script:disposals=0
    $caught=$null
    try {Invoke-OwnedSetup '-install' 'fixture.log'} catch {$caught=$_}
    if (($null -ne $caught) -ne ($scenario -cne 'pass')) {throw ('Setup verdict differs: '+$scenario)}
    $stopped=$scenario -cin @('pass','exit-fails','dispose-throws')
    if ($script:SetupTransactionUnconfirmed -eq $stopped -or $timings.stages['-install'].transactionStopped -ne $stopped) {throw ('Setup custody differs: '+$scenario)}
    if ($script:kills -ne 0 -or $script:starts -ne 1 -or $script:disposals -ne $(if ($scenario -ceq 'start-throws') {0} else {1})) {throw 'Unexpected process lifecycle.'}
    if ($scenario -ceq 'wait-dispose-throws' -and $caught.Exception.Message -notmatch 'wait-query-failed') {throw 'Disposal replaced the primary failure.'}
    $cleanupBlocked=$false
    try {. $cleanup} catch {$cleanupBlocked=$true}
    if ($cleanupBlocked -eq $stopped) {throw 'Cleanup crossed unresolved transaction custody.'}
    if (-not $stopped) {
        $blocked=$false
        try {Invoke-OwnedSetup '-uninstall' 'fixture.log'} catch {$blocked=$_.Exception.Message -ceq 'A prior setup transaction is unconfirmed; no overlapping installer was started.'}
        if (-not $blocked -or $script:starts -ne 1 -or -not $timings.uninstallDeferredForSetupTransaction) {throw 'An overlapping transaction was admitted.'}
    }
}
Write-Output 'SETUP_CUSTODY_9_PASS'
`;
  const result = spawnSync(
    process.platform === "win32" ? "pwsh.exe" : "pwsh",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      env: powershellEnvironment({
        ACCEPTANCE_SOURCE: fileURLToPath(new URL("run-installed-acceptance.ps1", import.meta.url)),
      }),
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /SETUP_CUSTODY_9_PASS/u);
});

test("native phase timings remain diagnostic, bounded and separate for install and Repair", (context) => {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($env:ACCEPTANCE_SOURCE, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Acceptance source does not parse.' }
$owner = $ast.Find({ param($node)
  $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Invoke-OwnedSetup'
}, $true)
$launch = '[Diagnostics.Process]::Start($info)'
if ($owner.Extent.Text.Split($launch).Count -ne 2) { throw 'Setup process boundary is ambiguous.' }
. ([scriptblock]::Create($owner.Extent.Text.Replace($launch, '(Start-Fixture)')))
$setup = 'owned-setup-fixture'
$timings = @{ stages = @{} }
$script:SetupTransactionUnconfirmed = $false
$script:reads = 0
$exitCode = 0
function Start-Fixture {
  $process = [pscustomobject]@{ ExitCode = $exitCode; Id = 123 }
  $process | Add-Member ScriptMethod WaitForExit { param($milliseconds) return $true }
  $process | Add-Member ScriptMethod Dispose {}
  return $process
}
function Get-ItemProperty {
  param($LiteralPath, $ErrorAction)
  $script:reads++
  if ($LiteralPath -cne 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\NVIDIA\NemoClaw\InstallDiagnostics' -or $ErrorAction -cne 'Stop') { throw 'Diagnostic owner changed.' }
  if ($denied) { throw [UnauthorizedAccessException]::new('fixture-denied') }
  return $retained
}
$denied = $false
$retained = [pscustomobject]@{ RuntimeImageHashMilliseconds = '123'; RuntimeImageAttachMilliseconds = '456'; RuntimeImageMountMilliseconds = '400'; RuntimeNodeHashMilliseconds = '0' }
Invoke-OwnedSetup '-install' 'fixture.log'
$installed = $timings.stages['-install'].nativePhaseTimings
if (-not $installed.diagnosticOnly -or -not $installed.available -or $installed.milliseconds.Count -ne 4 -or $installed.milliseconds.RuntimeImageHashMilliseconds -ne 123 -or $installed.milliseconds.RuntimeNodeHashMilliseconds -ne 0) { throw 'Complete phase timings were lost.' }
$retained = [pscustomobject]@{ RuntimeImageHashMilliseconds = '7' }
Invoke-OwnedSetup '-repair' 'fixture.log'
if ($timings.stages['-repair'].nativePhaseTimings.milliseconds.Count -ne 1 -or $timings.stages['-repair'].nativePhaseTimings.milliseconds.RuntimeImageHashMilliseconds -ne 7 -or $installed.milliseconds.RuntimeImageHashMilliseconds -ne 123) { throw 'Repair overwrote installation evidence.' }
foreach ($invalid in @('-1', '1.5', ' 1', '18446744073709551616', '999999999999999999999', 12, $null)) {
  $retained = [pscustomobject]@{ RuntimeImageHashMilliseconds = '9'; RuntimeNodeHashMilliseconds = $invalid }
  Invoke-OwnedSetup '-repair' 'fixture.log'
  $measurement = $timings.stages['-repair'].nativePhaseTimings
  if ($measurement.available -or $measurement.milliseconds.Count -ne 0) { throw 'Invalid or partial malformed timing was accepted.' }
}
$retained = [pscustomobject]@{}
Invoke-OwnedSetup '-repair' 'fixture.log'
if ($timings.stages['-repair'].nativePhaseTimings.available) { throw 'Missing observations were fabricated.' }
$denied = $true
Invoke-OwnedSetup '-repair' 'fixture.log'
if ($timings.stages['-repair'].nativePhaseTimings.available) { throw 'An inaccessible measurement was accepted.' }
$exitCode = 17
$caught = $null
try { Invoke-OwnedSetup '-repair' 'fixture.log' } catch { $caught = $_ }
if ($null -eq $caught -or $caught.Exception.Message -cne 'Finished preview -repair failed with status 17.') { throw 'Diagnostics changed the primary failure.' }
$before = $script:reads
$exitCode = 0
Invoke-OwnedSetup '-uninstall' 'fixture.log'
if ($script:reads -ne $before -or $timings.stages['-uninstall'].ContainsKey('nativePhaseTimings')) { throw 'Uninstall reused installation measurements.' }
Write-Output 'NATIVE_PHASE_TIMINGS_PASS'
`;
  const result = spawnSync(
    process.platform === "win32" ? "pwsh.exe" : "pwsh",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      env: powershellEnvironment({
        ACCEPTANCE_SOURCE: fileURLToPath(new URL("run-installed-acceptance.ps1", import.meta.url)),
      }),
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
    },
  );
  if (process.platform !== "win32" && result.error?.code === "ENOENT") {
    context.skip("PowerShell is unavailable on this non-Windows host.");
    return;
  }
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /NATIVE_PHASE_TIMINGS_PASS/u);
});

test("setup receives only installation environment while the controller retains credentials", (context) => {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($env:ACCEPTANCE_SOURCE, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Acceptance source does not parse.' }
$owner = $ast.Find({ param($node)
  $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Invoke-OwnedSetup'
}, $true)
if ($null -eq $owner) { throw 'Setup process owner is missing.' }
$launch = '[Diagnostics.Process]::Start($info)'
if ($owner.Extent.Text.Split($launch).Count -ne 2) { throw 'Setup process boundary is ambiguous.' }
. ([scriptblock]::Create($owner.Extent.Text.Replace($launch, '(Start-Fixture $info)')))
$setup = 'owned-setup-fixture'
$timings = @{ stages = @{} }
$allowed = @('SystemRoot','WINDIR','SystemDrive','COMSPEC','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA','ProgramData','ProgramFiles','ProgramFiles(x86)','CommonProgramFiles','CommonProgramFiles(x86)','PROCESSOR_ARCHITECTURE','PROCESSOR_ARCHITEW6432','NUMBER_OF_PROCESSORS','OS','PATH')
$script:starts = 0; $script:waits = 0; $script:disposals = 0; $script:SetupTransactionUnconfirmed=$false
function Start-Fixture($Info) {
  $script:starts++
  if ($Info.FileName -cne $setup -or $Info.UseShellExecute -or -not $Info.CreateNoWindow) { throw 'Setup process options changed.' }
  if (($Info.ArgumentList -join '|') -cne ($action + '|-quiet|-norestart|-log|fixture.log')) { throw 'Setup arguments changed.' }
  foreach ($name in $Info.Environment.Keys) {
    if ($name -notin $allowed) { throw 'Setup inherited an unapproved environment variable.' }
  }
  foreach ($name in @('NVIDIA_API_KEY','NVIDIA_INFERENCE_API_KEY','nvidia_api_key','GITHUB_TOKEN','NODE_OPTIONS','UNRELATED_SECRET')) {
    if ($Info.Environment.ContainsKey($name)) { throw 'Setup inherited a controller credential or override.' }
  }
  if ($Info.Environment['TEMP'] -cne $env:TEMP -or $Info.Environment['USERPROFILE'] -cne $env:USERPROFILE) { throw 'Required installation environment was lost.' }
  $expectedPath = [Environment]::SystemDirectory + ';' + [Environment]::GetEnvironmentVariable('SystemRoot')
  if ($Info.Environment['PATH'] -cne $expectedPath) { throw 'Setup inherited executable search paths.' }
  $process = [pscustomobject]@{ ExitCode = $exitCode; Id=123 }
  $process | Add-Member ScriptMethod WaitForExit { param($milliseconds) if ($milliseconds -ne 1200000) {throw 'Unexpected setup deadline.'}; $script:waits++; return $true }
  $process | Add-Member ScriptMethod Dispose { $script:disposals++ }
  return $process
}
foreach ($action in @('-install','-uninstall')) {
  foreach ($exitCode in @(0,17)) {
    $caught = $null
    try { Invoke-OwnedSetup $action 'fixture.log' } catch { $caught = $_ }
    if ($exitCode -eq 0 -and $null -ne $caught) { throw $caught }
    if ($exitCode -ne 0 -and ($null -eq $caught -or $caught.Exception.Message -cne "Finished preview $action failed with status $exitCode.")) { throw 'Setup process failure was lost.' }
    if ($timings.stages[$action].exitCode -ne $exitCode) { throw 'Setup evidence lost the process result.' }
    if ($env:NVIDIA_API_KEY -cne 'synthetic-api-canary' -or $env:NVIDIA_INFERENCE_API_KEY -cne 'synthetic-inference-canary') { throw 'Controller credentials were changed.' }
  }
}
if ($script:starts -ne 4 -or $script:waits -ne 4 -or $script:disposals -ne 4) { throw 'Setup process lifecycle changed.' }
Write-Output 'SETUP_ENVIRONMENT_4_PASS'
`;
  const result = spawnSync(
    process.platform === "win32" ? "pwsh.exe" : "pwsh",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      env: powershellEnvironment({
        ACCEPTANCE_SOURCE: fileURLToPath(new URL("run-installed-acceptance.ps1", import.meta.url)),
        NVIDIA_API_KEY: "synthetic-api-canary",
        NVIDIA_INFERENCE_API_KEY: "synthetic-inference-canary",
        GITHUB_TOKEN: "synthetic-github-canary",
        NODE_OPTIONS: "synthetic-override-canary",
        UNRELATED_SECRET: "synthetic-unrelated-canary",
        TEMP: process.env.TEMP ?? "/tmp",
        USERPROFILE: process.env.USERPROFILE ?? "/tmp",
      }),
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
    },
  );
  if (process.platform !== "win32" && result.error?.code === "ENOENT") {
    context.skip("PowerShell is unavailable on this non-Windows host.");
    return;
  }
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /SETUP_ENVIRONMENT_4_PASS/u);
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-.*-canary/u);
});

test("legacy reset claims fresh Hermes state before normal Hermes setup", (context) => {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($env:QUALIFIER_SOURCE, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Package qualifier does not parse.' }
$main = @($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.TryStatementAst] -and $null -ne $_.Finally })
if ($main.Count -ne 1) { throw 'The qualification lifecycle owner is ambiguous.' }
$loops = @($main[0].Body.Statements | Where-Object {
  $_ -is [Management.Automation.Language.ForEachStatementAst] -and
  $_.Condition.Extent.Text -ceq '$nativeAgentChoices'
})
if ($loops.Count -ne 1) { throw 'The setup selection owner is ambiguous.' }
$execute = [scriptblock]::Create($loops[0].Extent.Text)
function Invoke-NativeSetupSelection {
  param($Agent, $ChoiceId, [switch]$Maintenance, [switch]$ReplaceOwned)
  if ($Agent -ceq 'openclaw') {
    if ($Maintenance -or $ReplaceOwned -or $script:installed) { throw 'First install must not adopt existing data.' }
    $script:installed = $true
  } elseif ($Agent -ceq 'hermes') {
    if (-not $script:reset -or -not $Maintenance -or -not $ReplaceOwned) { throw 'Hermes must reuse only reset-owned configuration.' }
  } else { throw 'Retired agent selected.' }
  $script:operations.Add('setup-' + $Agent)
  return @{agent=$Agent;automationId=$ChoiceId}
}
function Invoke-NativeTesterResetQualification {
  if (-not $script:installed -or $script:reset) { throw 'Reset requires one installed candidate.' }
  if ($nativeSelections.Count -ne 1 -or $nativeSelections[0].agent -cne 'openclaw') { throw 'Hermes state was used before reset.' }
  $script:operations.Add('reset-hermes')
  if ($failReset) { throw 'fresh-state-denied' }
  $script:reset = $true
  return @{passed=$true}
}
foreach ($failReset in @($false,$true)) {
  $nativeAgentChoices = @(@{agent='openclaw';automationId='AgentOpenClaw'},@{agent='hermes';automationId='AgentHermes'})
  $nativeSelections = @(); $testerResetEvidence = $null
  $script:installed = $false; $script:reset = $false
  $script:operations = [Collections.Generic.List[string]]::new()
  $failed = $false
  try { . $execute } catch {
    if ($_.Exception.Message -cne 'fresh-state-denied') { throw }
    $failed = $true
  }
  if ($failed -ne $failReset) { throw 'Reset rejection was lost.' }
  $expected = if ($failReset) { 'setup-openclaw,reset-hermes' } else { 'setup-openclaw,reset-hermes,setup-hermes' }
  if (($script:operations -join ',') -cne $expected) { throw 'Setup and reset crossed their ownership order.' }
  if ($nativeSelections.Count -ne $(if ($failReset) { 1 } else { 2 })) { throw 'Selection receipts were replaced.' }
  if (($null -ne $testerResetEvidence) -eq $failReset) { throw 'Reset evidence does not match the outcome.' }
}
$resetAst = [Management.Automation.Language.Parser]::ParseFile($env:RESET_SOURCE, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Reset controller does not parse.' }
$save = @($resetAst.FindAll({ param($node)
  $node -is [Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -ceq '$selection'
}, $true))
if ($save.Count -ne 1) { throw 'Reset canary configuration owner is ambiguous.' }
function Invoke-NativeSetupSelection {
  param($Agent, $ChoiceId, [switch]$Standalone, [switch]$ReplaceOwned, $Inference, $Endpoint, $CredentialCanary, $EvidenceName)
  if ($Agent -cne 'hermes' -or $ChoiceId -cne 'AgentHermes' -or -not $Standalone -or $ReplaceOwned -or
      $Inference -cne 'local' -or $CredentialCanary -cne 'fixture-key') { throw 'Fresh reset configuration tried to adopt prior user settings.' }
  return @{agent=$Agent}
}
$endpoint = 'https://127.0.0.1:17193/fixture/v1'; $canary = 'fixture-key'
. ([scriptblock]::Create($save[0].Extent.Text))
if ($selection.agent -cne 'hermes') { throw 'Reset did not save its fresh selected-agent configuration.' }
Write-Output 'RESET_ORDER_3_PASS'
`;
  const result = spawnSync(
    process.platform === "win32" ? "pwsh.exe" : "pwsh",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      env: powershellEnvironment({
        QUALIFIER_SOURCE: fileURLToPath(
          new URL(
            "../../../scripts/checks/run-windows-native-package-qualification.ps1",
            import.meta.url,
          ),
        ),
        RESET_SOURCE: fileURLToPath(
          new URL(
            "../../../scripts/checks/qualify-windows-native-tester-reset.ps1",
            import.meta.url,
          ),
        ),
      }),
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    },
  );
  if (process.platform !== "win32" && result.error?.code === "ENOENT") {
    context.skip("PowerShell is unavailable on this non-Windows host.");
    return;
  }
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /RESET_ORDER_3_PASS/u);
});

test(
  "Burn fixture accepts MXC capability details but rejects ambiguous preparation decisions",
  { skip: process.platform !== "win32" },
  () => {
    const script = String.raw`
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($env:BURN_SOURCE, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Burn fixture source does not parse.' }
$owner = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Read-DiagnosticPreparationTier' }, $true)
if ($null -eq $owner) { throw 'Preparation decision owner missing.' }
. ([scriptblock]::Create($owner.Extent.Text))
foreach ($tier in @('base-container','appcontainer-dacl')) {
    $augment = $tier -ceq 'appcontainer-dacl'
    foreach ($extended in @($false,$true)) {
        $record = @{tier=$tier;needsDaclAugmentation=$augment}
        if ($extended) { $record.warnings=@();$record.probes=@{baseContainerApiPresent=(-not $augment);uiCapabilities=@{canBlockClipboardRead=$true}} }
        if ((Read-DiagnosticPreparationTier ($record|ConvertTo-Json -Depth 5)) -cne $tier) { throw 'Valid MXC capabilities rejected.' }
    }
}
$invalid = @(
    '{broken', '{}', '[]', (' ' * 8193),
    ('{"tier":"base-container","needsDaclAugmentation":false,"probes":' + ('[' * 9) + '0' + (']' * 9) + '}'),
    '{"tier":"base-container","needsDaclAugmentation":true}',
    '{"tier":"appcontainer-dacl","needsDaclAugmentation":false}',
    '{"tier":"base-container","needsDaclAugmentation":"false"}',
    '{"tier":"base-container","needsDaclAugmentation":null}',
    '{"tier":"base-container","needsDaclAugmentation":0}',
    '{"tier":"BASE-CONTAINER","needsDaclAugmentation":false}',
    '{"tier":"unknown","needsDaclAugmentation":false}',
    '{"tier":"base-container","tier":"appcontainer-dacl","needsDaclAugmentation":true}',
    '{"tier":"base-container","needsDaclAugmentation":true,"needsDaclAugmentation":false}',
    '{"tier":"base-container","needsDaclAugmentation":false,"warnings":[],"warnings":[]}'
)
foreach ($text in $invalid) {
    $rejected=$false
    try { $null=Read-DiagnosticPreparationTier $text } catch { $rejected=$true }
    if (-not $rejected) { throw 'Ambiguous or invalid MXC capabilities accepted.' }
}
Write-Output 'PREPARATION_SCHEMA_19_PASS'
`;
    const result = spawnSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: powershellEnvironment({
        BURN_SOURCE: fileURLToPath(new URL("test-burn-diagnostics.ps1", import.meta.url)),
      }),
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /PREPARATION_SCHEMA_19_PASS/u);
  },
);

test(
  "tester reset preserves primary failure and retains recovery for incomplete cleanup",
  {
    skip: process.platform !== "win32",
  },
  () => {
    const script = String.raw`
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($env:RESET_SOURCE, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Reset source does not parse.' }
$function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Invoke-NativeTesterResetQualification' }, $true)
$statements = @($function.Body.EndBlock.Statements)
$owner = @($statements | Where-Object { $_ -is [Management.Automation.Language.TryStatementAst] })[0]
$index = [array]::IndexOf($statements, $owner)
if ($statements[$index+1] -isnot [Management.Automation.Language.IfStatementAst] -or
    $statements[$index+2] -isnot [Management.Automation.Language.IfStatementAst]) { throw 'Reset outcome handling changed.' }
$body = 'try { if ($mainFailure) { throw "primary-fixture-failure" } } ' +
  ($owner.CatchClauses.Extent.Text -join ' ') + ' finally ' + $owner.Finally.Extent.Text +
  $statements[$index+1].Extent.Text + $statements[$index+2].Extent.Text
$execute = [scriptblock]::Create($body)
function Fail-PackageQualification($message) { throw $message }
function Invoke-NativeCredentialHelper {
  param($LauncherPath, $Arguments)
  $calls.Add($Arguments[0])
  switch ($Arguments[0]) {
    '--credential-read' {
      if ($testCase -ceq 'read-throws') { throw 'synthetic-sensitive-diagnostic' }
      return @{ exitCode = 0; stdout = $(if ($testCase -ceq 'identity-drift') { 'other-key' } else { $canary }) }
    }
    '--credential-delete' { return @{ exitCode = $(if ($testCase -cin @('key-fails','both-fail')) { 1 } else { 0 }) } }
    '--state-remove' { return @{ exitCode = $(if ($testCase -cin @('state-fails','both-fail')) { 1 } else { 0 }) } }
    default { throw 'Unexpected cleanup operation.' }
  }
}
$root = Join-Path ([IO.Path]::GetTempPath()) ('reset-cleanup-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root) | Out-Null
try {
  foreach ($mainFailure in @($false,$true)) {
    foreach ($testCase in @('pass','key-fails','state-fails','both-fail','read-throws','identity-drift','live','wait-throws')) {
      $helper = Join-Path $root 'helper.exe'; [IO.File]::WriteAllText($helper, 'inert-test-data')
      $helperHash = (Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash.ToLowerInvariant()
      $primary = $null; $cleanupErrors = [Collections.Generic.List[string]]::new()
      $calls = [Collections.Generic.List[string]]::new(); $ownsKey = $true; $ownsState = $true
      $binding = 'fixture-binding'; $canary = 'synthetic-private-key'; $window = $null
      $script:disposed = 0; $script:waits = 0; $script:OperationTimeoutMilliseconds = 1
      $process = [pscustomobject]@{ HasExited = $false }
      $process | Add-Member ScriptMethod WaitForExit {
        param($timeout)
        $script:waits++
        if ($testCase -ceq 'wait-throws') { throw 'query-failed' }
        return $testCase -cne 'live'
      }
      $process | Add-Member ScriptMethod Dispose { $script:disposed++ }
      $caught = $null
      try { . $execute -WarningAction SilentlyContinue } catch { $caught = $_ }
      $failedCleanup = $testCase -cne 'pass'
      if (($null -ne $caught) -ne ($mainFailure -or $failedCleanup)) { throw ('Wrong outcome: ' + $testCase) }
      if ($mainFailure -and $caught.Exception.Message -cne 'primary-fixture-failure') { throw 'Primary error replaced.' }
      if ($mainFailure -and $failedCleanup -and -not $caught.Exception.Data.Contains('NemoClawCleanupErrors')) { throw 'Secondary errors lost.' }
      if ($script:disposed -ne 1 -or $script:waits -ne 1) { throw 'Process was not observed and disposed.' }
      if ($testCase -cin @('live','wait-throws')) {
        if ($calls.Count -ne 0) { throw 'Cleanup overlapped a live or unconfirmed installer.' }
      } elseif ($calls -notcontains '--state-remove') { throw 'State cleanup was skipped after key failure.' }
      if ($testCase -cin @('identity-drift','read-throws') -and $calls -contains '--credential-delete') { throw 'Unowned key deleted.' }
      if ((Test-Path -LiteralPath $helper) -ne $failedCleanup) { throw 'Wrong recovery helper retention.' }
      if (($cleanupErrors -join ' ').Contains('synthetic-')) { throw 'Sensitive diagnostic leaked.' }
    }
  }
  Write-Output 'RESET_CLEANUP_16_PASS'
} finally { [IO.Directory]::Delete($root, $true) }
`;
    const result = spawnSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: powershellEnvironment({
        RESET_SOURCE: fileURLToPath(
          new URL(
            "../../../scripts/checks/qualify-windows-native-tester-reset.ps1",
            import.meta.url,
          ),
        ),
      }),
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /RESET_CLEANUP_16_PASS/u);
  },
);

test(
  "acceptance rejects unsupported scopes and credentials before installing",
  { skip: process.platform !== "win32" },
  () => {
    const source = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "run-installed-acceptance.ps1",
    );
    for (const [agent, scope, mode, secret, expected] of [
      ["pi", "full-acceptance", "current-build", "", "does not belong to the set"],
      ["nemocua", "full-acceptance", "current-build", "", "does not belong to the set"],
      [
        "langchain-deepagents-code",
        "full-acceptance",
        "current-build",
        "",
        "does not belong to the set",
      ],
      ["hermes", "startup-only", "built-0.1.3-replay", "", "Only OpenClaw"],
      ["hermes", "startup-only", "current-build", "", "Startup-only smoke supports"],
      ["openclaw", "startup-only", "built-0.1.3-replay", "", "Startup-only smoke supports"],
      [
        "openclaw",
        "startup-only",
        "current-build",
        "NVIDIA_API_KEY",
        "must not receive inference credentials",
      ],
      [
        "openclaw",
        "startup-only",
        "current-build",
        "NVIDIA_INFERENCE_API_KEY",
        "must not receive inference credentials",
      ],
      ["openclaw", "startup-only", "current-build", "", "requires explicit Windows CI identities"],
      [
        "openclaw",
        "full-acceptance",
        "current-build",
        "",
        "requires explicit Windows CI identities",
      ],
      ["hermes", "full-acceptance", "current-build", "", "requires explicit Windows CI identities"],
    ]) {
      const result = spawnSync(
        "pwsh.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `
      try {
        & $env:NEMOCLAW_ACCEPTANCE_SOURCE -SourceRoot . -WorkDirectory . -ProductVersion 0.1.9 -ArtifactSourceRevision invalid -Agent $env:TEST_AGENT -ValidationScope $env:TEST_SCOPE -Mode $env:TEST_MODE
        throw 'Unexpected acceptance success'
      } catch { Write-Output $_.Exception.Message; exit 0 }
    `,
        ],
        {
          env: powershellEnvironment({
            NEMOCLAW_ACCEPTANCE_SOURCE: source,
            TEST_AGENT: agent,
            TEST_SCOPE: scope,
            TEST_MODE: mode,
            ...(secret ? { [secret]: "synthetic-never-log-this-value" } : {}),
          }),
          encoding: "utf8",
          windowsHide: true,
          timeout: 30_000,
        },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes(expected), result.stdout);
      assert.ok(!(result.stdout + result.stderr).includes("synthetic-never-log-this-value"));
    }
  },
);

test(
  "acceptance consumes the four-file same-run controller proof",
  { skip: process.platform !== "win32" },
  () => {
    const source = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "run-installed-acceptance.ps1",
    );
    const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    const script = String.raw`
$ErrorActionPreference = 'Stop'
$work = Join-Path ([IO.Path]::GetTempPath()) ('installed-controller-proof-' + [guid]::NewGuid().ToString('N'))
$trustedNodeDirectory = "$work-controller-node"
try {
  $controls = Join-Path $work 'application\controls'
  $fakeNode = Join-Path $trustedNodeDirectory 'node.exe'
  [IO.Directory]::CreateDirectory($controls) | Out-Null
  [IO.Directory]::CreateDirectory((Split-Path -Parent $fakeNode)) | Out-Null
  [IO.File]::WriteAllBytes($fakeNode, [byte[]]@(0))
  $revision = (& git -C $env:NEMOCLAW_SOURCE_ROOT rev-parse HEAD | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $revision -cnotmatch '^[a-f0-9]{40}$') { throw 'Fixture source identity failed.' }
  $files = @(
    'packaging/windows/installer/control-installed-openclaw-input.test.mts',
    'packaging/windows/installer/run-installed-acceptance.test.mts',
    'packaging/windows/installer/qualify-finished-package.test.mts',
    'packaging/windows/runtime/native-ui-tunnel.test.mts'
  )
  $rows = @($files | ForEach-Object {
    $file = Join-Path $env:NEMOCLAW_SOURCE_ROOT $_
    @{ file = $_; bytes = (Get-Item -LiteralPath $file).Length; sha256 = (Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() }
  })
  [IO.File]::WriteAllText((Join-Path $controls 'installed-acceptance-controller.json'), (@{
    schemaVersion = 1
    classification = 'same-run-installed-acceptance-controller-controls'
    sourceRevision = $revision
    nodeSha256 = '97cce5301a815d2dce07ac5bfd1e6039eae88185ec1d10ae4f8cb712f1732878'
    passed = $true
    files = $rows
  } | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
  function Get-FileHash {
    param([string]$LiteralPath, [string]$Algorithm = 'SHA256')
    if ($LiteralPath -ceq $fakeNode) {
      return [pscustomobject]@{ Hash = '97cce5301a815d2dce07ac5bfd1e6039eae88185ec1d10ae4f8cb712f1732878' }
    }
    Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $LiteralPath -Algorithm $Algorithm
  }
  $env:GITHUB_ACTIONS = 'true'; $env:GITHUB_SHA = $revision; $env:OS = 'Windows_NT'
  try {
    & $env:NEMOCLAW_ACCEPTANCE_SOURCE -SourceRoot $env:NEMOCLAW_SOURCE_ROOT -WorkDirectory $work -ProductVersion 0.1.10 -ArtifactSourceRevision $revision -Agent openclaw -Mode current-build -ControllerNodePath $fakeNode
    throw 'Unexpected acceptance success.'
  } catch {
    if ($_.Exception.Message -notlike '*immutable-package-build.json*' -and
        $_.Exception.Message -cne 'Fresh preview acceptance requires no preexisting NemoClaw installation.') {
      throw
    }
  }
  Write-Output 'SAME_RUN_CONTROLLER_PROOF_PASS'
} finally {
  if (Test-Path -LiteralPath $work) { [IO.Directory]::Delete($work, $true) }
  if (Test-Path -LiteralPath $trustedNodeDirectory) { [IO.Directory]::Delete($trustedNodeDirectory, $true) }
}
`;
    const result = spawnSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: powershellEnvironment({
        NEMOCLAW_ACCEPTANCE_SOURCE: source,
        NEMOCLAW_SOURCE_ROOT: sourceRoot,
      }),
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /SAME_RUN_CONTROLLER_PROOF_PASS/u);
  },
);

test(
  "startup acceptance checks fresh and repaired startup without running live acceptance",
  { skip: process.platform !== "win32" },
  () => {
    const source = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "run-installed-acceptance.ps1",
    );
    const script = String.raw`
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($env:NEMOCLAW_ACCEPTANCE_SOURCE, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Acceptance source does not parse.' }
$owner = @($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.TryStatementAst] -and $null -ne $_.Finally })
$branch = @($owner[0].Body.Statements | Where-Object { $_ -is [Management.Automation.Language.IfStatementAst] })
$execute = [scriptblock]::Create($branch[0].Extent.Text)
$ValidationScope = 'startup-only'; $Agent = 'openclaw'; $SourceRoot = 'source-fixture'
$work = 'work-fixture'; $installation = 'install-fixture'; $ciNode = 'Invoke-TestSmoke'
function Invoke-TestSmoke {
  if ($args -contains '--browser-driver-root' -or $args -notcontains '--agent' -or $args -notcontains 'openclaw' -or
      $args -notcontains 'source-fixture\packaging\windows\installer\qualify-finished-package.mts') { throw 'Unexpected installed test route.' }
  $script:smokeCalls++
  $expectedDirectory = if ($script:smokeCalls -eq 1) { 'installed-smoke' } else { 'installed-smoke-after-repair' }
  if ($script:smokeCalls -gt 2 -or $args -notcontains "work-fixture\$expectedDirectory" -or
      $script:repairCalls -ne ($script:smokeCalls - 1)) { throw 'Startup and repair ordering differs.' }
  $global:LASTEXITCODE = if ($script:smokeCalls -eq $failurePhase) { $testExit } else { 0 }
}
function Invoke-OwnedSetup {
  param($Action, $Log)
  if ($Action -cne '-repair' -or $Log -cne 'work-fixture\repair.log' -or $script:smokeCalls -ne 1) { throw 'Unexpected maintenance route.' }
  $script:repairCalls++
  if ($scenario -ceq 'repair-exit') { throw 'Fixture repair failure.' }
}
function Get-Content {
  param($LiteralPath, [switch]$Raw)
  $directory = if ($script:smokeCalls -eq 1) { 'installed-smoke' } else { 'installed-smoke-after-repair' }
  if ($LiteralPath -cne "work-fixture\$directory\finished-package-smoke.json") { throw 'Unexpected receipt path.' }
  return $(if ($script:smokeCalls -eq $failurePhase) { $testReceipt } else { $validReceipt })
}
$count = 0
foreach ($scenario in @('pass','exit','receipt-fail','wrong-agent','wrong-scope','full-claim','truncated','missing','string-false',
    'repair-exit','after-exit','after-receipt-fail','after-wrong-agent','after-wrong-scope','after-full-claim','after-truncated','after-missing','after-string-false')) {
  $script:smokeCalls = 0; $script:repairCalls = 0
  $failurePhase = if ($scenario.StartsWith('after-')) { 2 } else { 1 }
  $variant = $scenario -creplace '^after-', ''
  $timings = @{}; $testExit = if ($variant -ceq 'exit') { 1 } else { 0 }
  $receipt = @{ verdict='pass'; agent='openclaw'; validationScope='startup-only'; fullInstalledQualification=$false }
  $validReceipt = $receipt | ConvertTo-Json -Compress
  switch ($variant) {
    'receipt-fail' { $receipt.verdict = 'fail' }
    'wrong-agent' { $receipt.agent = 'pi' }
    'wrong-scope' { $receipt.validationScope = 'full-acceptance' }
    'full-claim' { $receipt.fullInstalledQualification = $true }
    'missing' { $receipt.Remove('fullInstalledQualification') }
    'string-false' { $receipt.fullInstalledQualification = 'False' }
  }
  $testReceipt = if ($variant -ceq 'truncated') { '{' } else { $receipt | ConvertTo-Json -Compress }
  $failed = $false
  try { . $execute } catch { $failed = $true }
  if ($failed -ne ($scenario -cne 'pass')) { throw ('Unexpected startup result: ' + $scenario) }
  $initialPassed = $scenario -ceq 'pass' -or $scenario -ceq 'repair-exit' -or $failurePhase -eq 2
  if ($timings.ContainsKey('startupSmoke') -ne $initialPassed -or
      $timings.ContainsKey('repairStartupSmoke') -ne ($scenario -ceq 'pass')) { throw 'Failed smoke acquired a success receipt.' }
  if ($script:repairCalls -ne [int]$initialPassed) { throw 'Repair must run exactly once after initial startup passes.' }
  if ($scenario -ceq 'pass' -and ($timings.startupSmoke.deterministicLocalModel -ne $true -or
      $timings.repairStartupSmoke.deterministicLocalModel -ne $true -or $script:smokeCalls -ne 2)) { throw 'Missing fresh/repaired mock-model scope.' }
  $count++
}
Write-Output $count
`;
    const result = spawnSync(
      "pwsh.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        env: powershellEnvironment({
          NEMOCLAW_ACCEPTANCE_SOURCE: source,
        }),
        encoding: "utf8",
        windowsHide: true,
        timeout: 30_000,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout.trim(), "18");
  },
);

test("runtime bootstrap cannot claim final installation or enter another agent or scope", () => {
  const source = fileURLToPath(new URL("./run-installed-acceptance.ps1", import.meta.url));
  const script = String.raw`
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:NEMOCLAW_ACCEPTANCE_SOURCE,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw 'Acceptance source does not parse.' }
$guard=@($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.IfStatementAst] -and $_.Extent.Text.StartsWith('if ($RuntimeBootstrap -and') })
$claims=@($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.AssignmentStatementAst] -and $_.Left.Extent.Text -in @('$timings.runtimeQualified','$timings.fullInstalledQualification') })
if ($guard.Count -ne 1 -or $claims.Count -ne 2) { throw 'Expected one phase guard and two qualification assignments.' }
$check=[scriptblock]::Create($guard[0].Extent.Text)
$claim=[scriptblock]::Create(($claims.Extent.Text -join [Environment]::NewLine))
$count=0
foreach ($RuntimeBootstrap in @($false,$true)) {
  foreach ($Agent in @('openclaw','hermes')) {
    foreach ($Mode in @('current-build','built-0.1.3-replay')) {
      foreach ($ValidationScope in @('full-acceptance','startup-only')) {
        $failed=$false; try { . $check } catch { $failed=$true }
        $expected=$RuntimeBootstrap -and ($Agent -cne 'hermes' -or $Mode -cne 'current-build' -or $ValidationScope -cne 'full-acceptance')
        if ($failed -ne $expected) { throw 'Incorrect bootstrap admission.' }
        $count++
      }
    }
  }
  foreach ($ValidationScope in @('full-acceptance','startup-only')) {
    foreach ($primary in @($null,'retained failure')) {
      $timings=@{}; . $claim
      $runtimeExpected=$ValidationScope -ceq 'full-acceptance' -and $null -eq $primary
      if ($timings.runtimeQualified -ne $runtimeExpected -or
          $timings.fullInstalledQualification -ne ($runtimeExpected -and -not $RuntimeBootstrap)) { throw 'Incorrect qualification claim.' }
      $count++
    }
  }
}
Write-Output $count
`;
  const result = spawnSync(
    process.platform === "win32" ? "pwsh.exe" : "pwsh",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "& ([scriptblock]::Create([Console]::In.ReadToEnd()))",
    ],
    {
      input: script,
      env: powershellEnvironment({ NEMOCLAW_ACCEPTANCE_SOURCE: source }),
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout.trim(), "24");
});

for (const agent of ["hermes"])
  test(`${agent} installed acceptance retains recovery custody until current warm cleanup is proven`, () => {
    const source = fileURLToPath(new URL("./run-installed-acceptance.ps1", import.meta.url));
    const script = String.raw`
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($env:NEMOCLAW_ACCEPTANCE_SOURCE, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Acceptance source does not parse.' }
$owner = @($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.TryStatementAst] -and $null -ne $_.Finally })
$branch = @($owner[0].Body.Statements | Where-Object { $_ -is [Management.Automation.Language.IfStatementAst] })
# Replace only the external process boundary; execute the actual case loop,
# argument routing and evidence checks without installing or contacting inference.
$execute = [scriptblock]::Create($branch[0].Extent.Text.Replace('& $ciNode', '& Invoke-TestAgent'))
$validator=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Assert-HermesCaseReceipt'},$true)
if ($null -ne $validator) { . ([scriptblock]::Create($validator.Extent.Text)) }
$cleanup=@($owner[0].Finally.Statements | Where-Object { $_ -is [Management.Automation.Language.TryStatementAst] })[-1]
$uninstall=[scriptblock]::Create($cleanup.Body.Statements[0].Extent.Text)
$ValidationScope = 'full-acceptance'; $Agent = $env:TEST_AGENT; $SourceRoot = 'source-fixture'
$work = 'work-fixture'; $installation = 'install-fixture'; $openClawRestart=$false
$env:GITHUB_RUN_ID='123'; $env:GITHUB_RUN_ATTEMPT='1'
$expectedHermesRuntime=@{runtimeId=('a' * 64);manifestSha256=('b' * 64);sourceRevision=('c' * 40);nodeSha256=('d' * 64);nodeVersion='22.23.2'}
$expectedHermesLauncher='2' * 64;$expectedHermesPackageBuild='3' * 64
$artifactSourceSnapshot='snapshot-fixture';$artifactSourceSnapshotSha256='4' * 64;$controllerSource='5' * 40
function Invoke-TestAgent {
  if ($args -notcontains (Join-Path $SourceRoot "packaging\windows\installer\qualify-installed-$Agent.mts")) { throw 'Wrong agent controller.' }
  if (($args -contains '--runtime-bootstrap') -ne $RuntimeBootstrap) { throw 'Incorrect qualification phase routing.' }
  $first = $calls.Count -eq 0
  if (($args -contains '--preserve-configuration') -ne $first -or ($args -contains '--reuse-configuration') -eq $first) { throw ('Incorrect cold/warm configuration routing: ' + ($args -join ',') + '; first=' + $first) }
  $previous = [array]::IndexOf($args, '--previous-acceptance')
  if (($previous -ge 0) -ne (-not $first)) { throw 'Incorrect cold-run receipt routing.' }
  if ($previous -ge 0 -and $args[$previous+1] -cne "work-fixture\installed-acceptance\installed-$Agent-acceptance.json") { throw 'Wrong cold-run receipt.' }
  if (-not $restartCustodyUnresolved) { throw 'Hermes launch began without recovery custody.' }
  foreach ($name in @('--package-root','--artifact-source-snapshot','--artifact-source-snapshot-sha256')) {
    $position=[array]::IndexOf($args,$name)
    $expected=switch ($name) { '--package-root' {"$work\package"} '--artifact-source-snapshot' {$artifactSourceSnapshot} '--artifact-source-snapshot-sha256' {$artifactSourceSnapshotSha256} }
    if ($position -lt 0 -or $args[$position+1] -cne $expected) { throw 'Hermes source admission input is absent or different.' }
  }
  $calls.Add(@($args))
  $global:LASTEXITCODE = if ($scenario -ceq 'process-failure' -or ($scenario -ceq 'warm-process-failure' -and -not $first)) { 1 } else { 0 }
}
function Test-Path {
  param($LiteralPath)
  if ($LiteralPath -cnotmatch 'installed-acceptance(?:-warm)?[\\/]installed-hermes-acceptance.json$') { throw 'Unexpected prelaunch path.' }
  return $scenario -ceq 'stale-receipt'
}
function Get-Content {
  param($LiteralPath, [switch]$Raw)
  $directory = if ($calls.Count -eq 1) { 'installed-acceptance' } else { 'installed-acceptance-warm' }
  if ($LiteralPath -cne "work-fixture\$directory\installed-$Agent-acceptance.json") { throw 'Wrong agent receipt.' }
  if ($scenario -ceq 'missing-receipt') { throw 'Missing receipt.' }
  if ($scenario -ceq 'malformed-receipt') { return '{' }
  $warm=$calls.Count -eq 2
  $receipt = @{ schemaVersion=1; classification='installed-canonical-hermes-acceptance'; controllerRun='123:1';runtime=$expectedHermesRuntime.Clone();verdict='pass'; cleanupErrors=@();fullInstalledQualification=$false;results=@{
    configurationReused=$warm;configurationPreserved=(-not $warm)
    runtimeBootstrap=[bool]$RuntimeBootstrap;configuration=@{nativeOnboardingUsed=(-not $warm -and -not $RuntimeBootstrap)}
    launcherAdmission=@{launcherSha256=$expectedHermesLauncher;packageBuildSha256=$expectedHermesPackageBuild;artifactSourceSnapshotSha256=$artifactSourceSnapshotSha256;controllerSourceRevision=$controllerSource}
    stateRoot='C:\NemoClawState-S-1-5-21-1-hermes';configurationSha256=('e' * 64)
    retainedConversation=@{storedSessionId='saved-session';profileName='personal';messageCount=10;lastMessageId=20;transcriptSha256=('f' * 64)}
    custody=@{configurationMutationUnconfirmed=$false;nativeLaunchAttempted=$true;nativeCleanupConfirmed=$true;processesStopped=$true;uninstallSafe=$true;configurationRetainedForRecovery=$false}
    cleanup=@{schemaVersion=1;classification='native-hermes-dashboard-qualification';agent='hermes';sandboxDeleted=$true;gatewayStopped=$true;ephemeralRootsRemoved=$true;stateRetained=$true;leaseReleased=$true;cleanupSucceeded=$true;
      guardianClosed=$true;observerClosed=$true;runtimeLeaseOwnerClosedWithGuardian=$true;
      runtimeIdentity=@{runtimeId=$expectedHermesRuntime.runtimeId;manifestSha256=$expectedHermesRuntime.manifestSha256;sourceRevision=$expectedHermesRuntime.sourceRevision}}
  } }
  if ($warm) {
    $receipt.results.restoredConversation=$receipt.results.retainedConversation.Clone()
    $receipt.results.retainedConversation.messageCount=20
    $receipt.results.retainedConversation.lastMessageId=40
    $receipt.results.retainedConversation.transcriptSha256='1' * 64
  }
  switch ($scenario) {
    'wrong-phase' { $receipt.results.runtimeBootstrap=(-not $RuntimeBootstrap) }
    'string-phase' { $receipt.results.runtimeBootstrap=[string]$RuntimeBootstrap }
    'missing-phase' { $receipt.results.Remove('runtimeBootstrap') }
    'wrong-onboarding' { $receipt.results.configuration.nativeOnboardingUsed=$warm -or $RuntimeBootstrap }
    'warm-wrong-phase' { if ($warm) { $receipt.results.runtimeBootstrap=(-not $RuntimeBootstrap) } }
    'missing-admission' { $receipt.results.Remove('launcherAdmission') }
    'foreign-launcher' { $receipt.results.launcherAdmission.launcherSha256='9' * 64 }
    'foreign-build' { $receipt.results.launcherAdmission.packageBuildSha256='9' * 64 }
    'foreign-snapshot' { $receipt.results.launcherAdmission.artifactSourceSnapshotSha256='9' * 64 }
    'foreign-controller' { $receipt.results.launcherAdmission.controllerSourceRevision='9' * 40 }
    'warm-foreign-launcher' { if ($warm) { $receipt.results.launcherAdmission.launcherSha256='9' * 64 } }
    'failed-receipt' { $receipt.verdict='fail' }
    'cleanup-failure' { $receipt.cleanupErrors=@('retained process') }
    'missing-cleanup-errors' { $receipt.Remove('cleanupErrors') }
    'string-schema' { $receipt.schemaVersion='1' }
    'wrong-classification' { $receipt.classification='other' }
    'array-classification' { $receipt.classification=@('installed-canonical-hermes-acceptance') }
    'array-verdict' { $receipt.verdict=@('pass') }
    'array-run' { $receipt.controllerRun=@('123:1') }
    'wrong-run' { $receipt.controllerRun='122:1' }
    'wrong-runtime' { $receipt.runtime.runtimeId='9' * 64 }
    'wrong-source' { $receipt.runtime.sourceRevision='9' * 40 }
    'missing-custody' { $receipt.results.Remove('custody') }
    'no-launch' { $receipt.results.custody.nativeLaunchAttempted=$false }
    'native-unknown' { $receipt.results.custody.nativeCleanupConfirmed=$false }
    'string-native' { $receipt.results.custody.nativeCleanupConfirmed='true' }
    'process-unknown' { $receipt.results.custody.processesStopped=$false }
    'unsafe' { $receipt.results.custody.uninstallSafe=$false }
    'configuration-unconfirmed' { $receipt.results.custody.configurationMutationUnconfirmed=$true }
    'string-configuration-custody' { $receipt.results.custody.configurationMutationUnconfirmed='false' }
    'missing-configuration-custody' { $receipt.results.custody.Remove('configurationMutationUnconfirmed') }
    'warm-configuration-unconfirmed' { if ($warm) { $receipt.results.custody.configurationMutationUnconfirmed=$true } }
    'retained-recovery' { $receipt.results.custody.configurationRetainedForRecovery=$true }
    'string-retained' { $receipt.results.custody.configurationRetainedForRecovery='false' }
    'missing-backend' { $receipt.results.Remove('cleanup') }
    'backend-incomplete' { $receipt.results.cleanup.cleanupSucceeded=$false }
    'string-backend' { $receipt.results.cleanup.sandboxDeleted='true' }
    'wrong-backend-runtime' { $receipt.results.cleanup.runtimeIdentity.runtimeId='9' * 64 }
    'wrong-backend-agent' { $receipt.results.cleanup.agent='openclaw' }
    'wrong-backend-schema' { $receipt.results.cleanup.schemaVersion='1' }
    'wrong-case' { $receipt.results.configurationReused=(-not $warm) }
    'string-case' { $receipt.results.configurationReused=[string]$warm }
    'wrong-preservation' { $receipt.results.configurationPreserved=$warm }
    'unbound-state' { $receipt.results.stateRoot='C:\other' }
    'changed-warm-state' { if ($warm) { $receipt.results.stateRoot='C:\NemoClawState-S-1-5-21-2-hermes' } }
    'changed-warm-config' { if ($warm) { $receipt.results.configurationSha256='9' * 64 } }
    'full-claim' { $receipt.fullInstalledQualification=$true }
    'missing-retained' { $receipt.results.Remove('retainedConversation') }
    'retained-array' { $receipt.results.retainedConversation=@($receipt.results.retainedConversation) }
    'empty-session' { $receipt.results.retainedConversation.storedSessionId='' }
    'array-session' { $receipt.results.retainedConversation.storedSessionId=@('saved-session') }
    'long-session' { $receipt.results.retainedConversation.storedSessionId='s' * 129 }
    'empty-profile' { $receipt.results.retainedConversation.profileName='' }
    'long-profile' { $receipt.results.retainedConversation.profileName='p' * 129 }
    'string-count' { $receipt.results.retainedConversation.messageCount='10' }
    'single-count' { $receipt.results.retainedConversation.messageCount=1 }
    'limit-count' { $receipt.results.retainedConversation.messageCount=500 }
    'fraction-count' { $receipt.results.retainedConversation.messageCount=10.5 }
    'string-last' { $receipt.results.retainedConversation.lastMessageId='20' }
    'last-before-count' { $receipt.results.retainedConversation.lastMessageId=9 }
    'unsafe-last' { $receipt.results.retainedConversation.lastMessageId=[long]9007199254740992 }
    'invalid-hash' { $receipt.results.retainedConversation.transcriptSha256='not-a-digest' }
    'array-hash' { $receipt.results.retainedConversation.transcriptSha256=@('f' * 64) }
    'warm-missing-restored' { if ($warm) { $receipt.results.Remove('restoredConversation') } }
    'warm-array-restored' { if ($warm) { $receipt.results.restoredConversation=@($receipt.results.restoredConversation) } }
    'warm-restored-string-count' { if ($warm) { $receipt.results.restoredConversation.messageCount='10' } }
    'warm-restored-session' { if ($warm) { $receipt.results.restoredConversation.storedSessionId='other-session' } }
    'warm-restored-profile' { if ($warm) { $receipt.results.restoredConversation.profileName='other-profile' } }
    'warm-restored-count' { if ($warm) { $receipt.results.restoredConversation.messageCount=9 } }
    'warm-restored-last' { if ($warm) { $receipt.results.restoredConversation.lastMessageId=19 } }
    'warm-restored-hash' { if ($warm) { $receipt.results.restoredConversation.transcriptSha256='2' * 64 } }
    'warm-continued-session' { if ($warm) { $receipt.results.retainedConversation.storedSessionId='other-session' } }
    'warm-continued-profile' { if ($warm) { $receipt.results.retainedConversation.profileName='other-profile' } }
    'warm-continued-count' { if ($warm) { $receipt.results.retainedConversation.messageCount=10 } }
    'warm-continued-last' { if ($warm) { $receipt.results.retainedConversation.lastMessageId=20 } }
    'warm-continued-hash' { if ($warm) { $receipt.results.retainedConversation.transcriptSha256='f' * 64 } }
  }
  return ($receipt | ConvertTo-Json -Depth 10)
}
$count=0
$scenarios=@('pass','process-failure','warm-process-failure','failed-receipt','cleanup-failure','missing-cleanup-errors','string-schema','wrong-classification','array-classification','array-verdict','array-run','wrong-run','wrong-runtime','wrong-source','missing-custody','no-launch','native-unknown','string-native','process-unknown','unsafe','retained-recovery','string-retained','missing-backend','backend-incomplete','string-backend','wrong-backend-runtime','wrong-backend-agent','wrong-backend-schema','wrong-case','string-case','wrong-preservation','unbound-state','changed-warm-state','changed-warm-config','full-claim','stale-receipt','missing-receipt','malformed-receipt')
$scenarios+=@('configuration-unconfirmed','string-configuration-custody','missing-configuration-custody','warm-configuration-unconfirmed')
$scenarios+=@('missing-admission','foreign-launcher','foreign-build','foreign-snapshot','foreign-controller','warm-foreign-launcher')
$scenarios+=@('missing-retained','retained-array','empty-session','array-session','long-session','empty-profile','long-profile','string-count','single-count','limit-count','fraction-count','string-last','last-before-count','unsafe-last','invalid-hash','array-hash','warm-missing-restored','warm-array-restored','warm-restored-string-count','warm-restored-session','warm-restored-profile','warm-restored-count','warm-restored-last','warm-restored-hash','warm-continued-session','warm-continued-profile','warm-continued-count','warm-continued-last','warm-continued-hash')
$scenarios+=@('wrong-phase','string-phase','missing-phase','wrong-onboarding','warm-wrong-phase')
foreach ($RuntimeBootstrap in @($false,$true)) {
foreach ($scenario in $scenarios) {
  $calls=[Collections.Generic.List[object]]::new(); $timings=@{}; $failed=$false; $restartCustodyUnresolved=$false
  try { . $execute } catch { if ($scenario -ceq 'pass') { throw }; $failed=$true }
  if ($failed -ne ($scenario -cne 'pass')) { throw ('Unexpected Hermes acceptance result: '+$scenario) }
  if ($scenario -ceq 'pass' -and ($calls.Count -ne 2 -or $timings.startupComparisonAvailable -ne $true)) { throw 'Incorrect launch comparison result.' }
  if ($scenario -ceq 'pass') {
    foreach ($name in @('qualified','configurationUnchanged','sameConversation','sameStateRoot')) {
      if ($timings.restartPersistence[$name] -cne $true) { throw ('Missing Hermes restart evidence: ' + $name) }
    }
    if ($timings.restartPersistence.coldReceipt -cne 'installed-acceptance/installed-hermes-acceptance.json' -or
        $timings.restartPersistence.warmReceipt -cne 'installed-acceptance-warm/installed-hermes-acceptance.json' -or
        $timings.restartPersistence.ContainsKey('credentialRecreated')) { throw 'Incorrect Hermes restart evidence scope.' }
  }
  if ($failed -and $timings.ContainsKey('restartPersistence')) { throw 'A failed case claimed restart persistence.' }
  if ($scenario.StartsWith('warm-') -and $calls.Count -ne 2) { throw 'Warm rejection was not exercised after cold success.' }
  if ($failed -and $timings.startupComparisonAvailable -eq $true) { throw 'A failed case claimed a startup comparison.' }
  if ($restartCustodyUnresolved -ne $failed) { throw ('Hermes recovery custody differs: ' + $scenario) }
  $denied=$false; try { . $uninstall } catch { $denied=$true }
  if ($denied -ne $failed) { throw 'Uninstall ignored Hermes recovery custody.' }
  if ($scenario -ceq 'stale-receipt' -and $calls.Count -ne 0) { throw 'Stale receipt allowed a new launch.' }
  $count++
}
}
Write-Output $count
`;
    const result = spawnSync(
      process.platform === "win32" ? "pwsh.exe" : "pwsh",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "& ([scriptblock]::Create([Console]::In.ReadToEnd()))",
      ],
      {
        input: script,
        env: powershellEnvironment({ NEMOCLAW_ACCEPTANCE_SOURCE: source, TEST_AGENT: agent }),
        encoding: "utf8",
        windowsHide: true,
        timeout: 30_000,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout.trim(), "164");
  });

for (const shell of ["powershell.exe", "pwsh.exe"])
  test(
    `${shell} treats absent diagnostics as optional and preserves failures`,
    {
      skip: process.platform !== "win32",
    },
    () => {
      const source = path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "run-installed-acceptance.ps1",
      );
      const script = String.raw`
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($env:NEMOCLAW_ACCEPTANCE_SOURCE, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Acceptance source does not parse.' }
$owner = @($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.TryStatementAst] -and $null -ne $_.Finally })
if ($owner.Count -ne 1) { throw 'Expected one acceptance cleanup owner.' }
$root = 'Registry::HKEY_CURRENT_USER\Software\NemoClawAcceptanceTest-' + [guid]::NewGuid().ToString('N')
$productionPath = 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\NVIDIA\NemoClaw\InstallDiagnostics'
$body = $owner[0].Finally.Statements[0].Extent.Text
if (-not $body.Contains($productionPath)) { throw 'The diagnostic owner changed.' }
$collect = [scriptblock]::Create($body.Replace($productionPath, $root))
$results = [Collections.Generic.List[string]]::new()
function Check([string]$Name, [string]$Expected, [string]$Prior, [bool]$Denied = $false) {
  $timings = @{ nativeRuntimeFailure = $null }
  $primary = $null
  if ($Prior) { try { throw $Prior } catch { $primary = $_ } }
  if ($Denied) {
    function Get-ItemProperty { throw [UnauthorizedAccessException]::new('denied-test') }
    function Get-ItemPropertyValue { throw [UnauthorizedAccessException]::new('denied-test') }
  }
  . $collect
  $actual = if ($null -eq $primary) { '' } else { $primary.Exception.Message }
  $expectedError = if ($Prior) { $Prior } elseif ($Denied) { 'denied-test' } else { '' }
  if ($actual -cne $expectedError) { throw ('Unexpected primary failure: ' + $Name + ': ' + $actual) }
  $diagnostic = if ($null -eq $timings.nativeRuntimeFailure) { '' } else { $timings.nativeRuntimeFailure.retainedPrimary }
  if ($diagnostic -cne $Expected) { throw ('Unexpected diagnostic: ' + $Name) }
  $results.Add($Name)
}
try {
  Check 'missing key' '' ''
  New-Item -Path $root | Out-Null
  Check 'missing value' '' ''
  Check 'missing value preserves earlier failure' '' 'original-test'
  New-ItemProperty -LiteralPath $root -Name RuntimeMaintenancePrimary -Value 'retained-test' -PropertyType String | Out-Null
  Check 'retained value' 'retained-test' ''
  Check 'retained value preserves earlier failure' 'retained-test' 'original-test'
  Check 'access error remains failure' '' '' $true
  Check 'access error preserves earlier failure' '' 'original-test' $true
} finally {
  if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
  if (Test-Path -LiteralPath $root) { throw 'Owned registry fixture remains.' }
}
ConvertTo-Json -InputObject @($results) -Compress
`;
      const result = spawnSync(
        shell,
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        {
          env: powershellEnvironment({
            NEMOCLAW_ACCEPTANCE_SOURCE: source,
          }),
          encoding: "utf8",
          windowsHide: true,
          // Windows PowerShell 5.1 takes ~29.5s for the real registry matrix on
          // the ARM64 runner and crosses 30s when migration runs in parallel.
          timeout: shell === "powershell.exe" ? 45_000 : 30_000,
        },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const lastLine = result.stdout.trim().split(/\r?\n/u).at(-1)!;
      assert.equal(JSON.parse(lastLine).length, 7);
    },
  );

test(
  "migration accepts retained agents and only versions newer than its published baseline",
  { skip: process.platform !== "win32" },
  () => {
    const script = String.raw`
$ErrorActionPreference='Stop'
function Parse([string]$File) {
  $tokens=$null; $errors=$null
  $ast=[Management.Automation.Language.Parser]::ParseFile($File,[ref]$tokens,[ref]$errors)
  if ($errors.Count) { throw 'Migration controller does not parse.' }
  return $ast
}
$ast=Parse (Join-Path $env:TEST_OWNER 'run-preview-migration.ps1')
$guard=@($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.IfStatementAst] })[0]
$check=[scriptblock]::Create($ast.ParamBlock.Extent.Text + '; $parsedVersion=$null; ' + $guard.Extent.Text + '; return $NewAgent')
foreach ($agent in @('openclaw','hermes')) {
  foreach ($version in @('0.1.3','0.1.4','0.1.5','0.1.10','bad','0.1.10.1')) {
    $failed=$false
    try { $result=& $check -WorkDirectory 'unused-fixture' -ProductVersion $version -NewAgent $agent } catch { $failed=$true }
    if ($failed -ne ($version -notin @('0.1.5','0.1.10'))) { throw 'Incorrect migration version admission.' }
    if (-not $failed -and $result -cne $agent) { throw 'Incorrect migrated agent.' }
  }
}
$controls=Parse (Join-Path $env:TEST_OWNER 'preview-ui-controls.ps1')
$function=@($controls.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Set-PreviewCanaryConfiguration'},$true))[0]
$parameters=($function.Parameters | ForEach-Object { $_.Extent.Text }) -join ','
$choose=[scriptblock]::Create('param('+ $parameters + ') ' + $function.Body.EndBlock.Statements[0].Extent.Text + '; return $choiceId')
foreach ($entry in @{openclaw='AgentOpenClaw';hermes='AgentHermes'}.GetEnumerator()) {
  if ((& $choose -Window $null -Endpoint '' -Key '' -Agent $entry.Key) -cne $entry.Value) { throw 'Wrong native UI agent choice.' }
}
try { $null=& $choose -Window $null -Endpoint '' -Key '' -Agent 'unrecognized'; throw 'Unexpected agent accepted.' }
catch [System.Management.Automation.ParameterBindingException] { }
Write-Output 'pass'
`;
    const result = spawnSync(
      "pwsh.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        env: powershellEnvironment({ TEST_OWNER: fileURLToPath(new URL(".", import.meta.url)) }),
        encoding: "utf8",
        windowsHide: true,
        timeout: 30000,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout.trim(), "pass");
  },
);

test(
  "migration requires tier-specific native preparation evidence",
  { skip: process.platform !== "win32" },
  () => {
    const script = String.raw`
$ErrorActionPreference='Stop'
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:MIGRATION_SOURCE,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw 'Migration controller does not parse.' }
$function=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Assert-MigrationPreparationNoop'},$true)
if ($null -eq $function) { throw 'Migration preparation owner is missing.' }
. ([scriptblock]::Create($function.Extent.Text))
$root=Join-Path ([IO.Path]::GetTempPath()) ('migration-preparation-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root) | Out-Null
function Reject([scriptblock]$Fixture) {
  $failed=$false
  try { & $Fixture } catch { $failed=$true }
  if (-not $failed) { throw 'Invalid migration preparation evidence was accepted.' }
}
try {
  $base=Join-Path $root 'base.log'
  [IO.File]::WriteAllText($base,('prefix MXC preparation tier: base-container'+[Environment]::NewLine))
  $baseResult=Assert-MigrationPreparationNoop $base
  if ($baseResult.tier -cne 'base-container' -or $baseResult.helperSkipped -ne $true -or $baseResult.addedAces -ne 0 -or $baseResult.writeCalls -ne 0 -or $null -ne $baseResult.sidecarSha256) { throw 'BaseContainer preparation result is incomplete.' }

  $app=Join-Path $root 'app.log'; $attempt='a' * 32
  [IO.File]::WriteAllText($app,('prefix MXC preparation tier: appcontainer-dacl'+[Environment]::NewLine+'Applying execute package: MxcSystemDrivePreparation'+[Environment]::NewLine))
  $sidecar=$app + '.host-preparation-' + $attempt + '.json'
  @{classification='nemoclaw-host-preparation-diagnostic';operation='prepare-system-drive';status='succeeded';addedAces=0;writeCalls=0;elapsedMilliseconds=7;attemptId=$attempt} | ConvertTo-Json -Compress | Set-Content -LiteralPath $sidecar -NoNewline
  $appResult=Assert-MigrationPreparationNoop $app
  if ($appResult.tier -cne 'appcontainer-dacl' -or $appResult.helperSkipped -ne $false -or $appResult.addedAces -ne 0 -or $appResult.writeCalls -ne 0 -or $appResult.elapsedMilliseconds -ne 7 -or $appResult.sidecarSha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'AppContainer preparation result is incomplete.' }

  [IO.File]::WriteAllText((Join-Path $root 'bad-tier.log'),('MXC preparation tier: unsupported'+[Environment]::NewLine))
  Reject { Assert-MigrationPreparationNoop (Join-Path $root 'bad-tier.log') }
  [IO.File]::WriteAllText((Join-Path $root 'duplicate.log'),('MXC preparation tier: base-container'+[Environment]::NewLine+'MXC preparation tier: base-container'+[Environment]::NewLine))
  Reject { Assert-MigrationPreparationNoop (Join-Path $root 'duplicate.log') }
  [IO.File]::WriteAllText((Join-Path $root 'base-helper.log'),('MXC preparation tier: base-container'+[Environment]::NewLine+'Applying execute package: MxcSystemDrivePreparation'+[Environment]::NewLine))
  Reject { Assert-MigrationPreparationNoop (Join-Path $root 'base-helper.log') }
  [IO.File]::WriteAllText((Join-Path $root 'missing-sidecar.log'),('MXC preparation tier: appcontainer-dacl'+[Environment]::NewLine+'Applying execute package: MxcSystemDrivePreparation'+[Environment]::NewLine))
  Reject { Assert-MigrationPreparationNoop (Join-Path $root 'missing-sidecar.log') }
  [IO.File]::WriteAllText((Join-Path $root 'oversized.log'),('x' * 1048577))
  Reject { Assert-MigrationPreparationNoop (Join-Path $root 'oversized.log') }
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force
}
Write-Output 'pass'
`;
    const result = spawnSync(
      "pwsh.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        env: powershellEnvironment({
          MIGRATION_SOURCE: fileURLToPath(new URL("run-preview-migration.ps1", import.meta.url)),
        }),
        encoding: "utf8",
        windowsHide: true,
        timeout: 30_000,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout.trim(), "pass");
  },
);
