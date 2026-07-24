// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  scanDirectChildProcessSource,
  scanLiveSourceGraph,
  semanticPhaseCoverageModules,
  validateCollectedSemanticPhaseModule,
  validateTestScopedPhaseCalls,
} from "../../../tools/e2e/check-semantic-phases.mts";
import { REPO_ROOT } from "../fixtures/paths.ts";

const INVALID_SOURCE_FIXTURE = path.join(
  REPO_ROOT,
  "test/e2e/support/fixtures/semantic-phase-invalid.fixture.ts",
);
const CHILD_PROCESS_SOURCE_FIXTURE = path.join(
  REPO_ROOT,
  "test/e2e/support/fixtures/semantic-phase-child-process.fixture.ts",
);
const OBSERVED_CHILD_PROCESS_SOURCE = path.join(
  REPO_ROOT,
  "test/e2e/fixtures/observed-child-process.ts",
);
const TEST_PROGRESS_SOURCE = path.join(REPO_ROOT, "test/e2e/fixtures/progress.ts");
const FAKE_OPENAI_SOURCE = path.join(REPO_ROOT, "test/e2e/fixtures/fake-openai-compatible.ts");

describe("semantic E2E phase checker", () => {
  test("derives coverage from registry, free-standing, shared, and forwarding workflow paths", () => {
    const modules = semanticPhaseCoverageModules(
      {
        matrix: [{}],
        testMatrix: [
          {
            id: "docs-validation",
            file: "test/e2e/live/docs-validation.test.ts",
            project: "e2e-live",
          },
          {
            id: "gateway-drift-preflight",
            file: "test/gateway-drift-preflight.test.ts",
            project: "integration",
          },
        ],
      },
      {
        liveTestToJobs: new Map([
          ["test/e2e/live/bootstrap-install-smoke.test.ts", ["bootstrap-install-smoke"]],
          ["test/e2e/live/docs-validation.test.ts", ["docs-validation"]],
          ["test/gateway-drift-preflight.test.ts", ["gateway-drift-preflight"]],
        ]),
      },
      [
        "test/e2e/live/bootstrap-install-smoke.test.ts",
        "test/e2e/live/docs-validation.test.ts",
        "test/e2e/live/unselected-regression.test.ts",
      ],
    );

    expect(modules).toEqual([
      {
        file: "test/e2e/live/bootstrap-install-smoke.test.ts",
        project: "e2e-live",
      },
      { file: "test/e2e/live/docs-validation.test.ts", project: "e2e-live" },
      { file: "test/e2e/live/launchable-smoke.test.ts", project: "e2e-live" },
      { file: "test/e2e/live/registry-targets.test.ts", project: "e2e-live" },
      { file: "test/e2e/live/unselected-regression.test.ts", project: "e2e-live" },
      { file: "test/gateway-drift-preflight.test.ts", project: "integration" },
    ]);
  });

  test("requires workflow-selected integration tests to use the progress fixture", () => {
    const module = {
      relativeModuleId: "test/workflow-selected.test.ts",
      project: "integration" as const,
      errors: [],
      tests: [
        {
          fullName: "covers a workflow-selected integration path",
          phases: ["prepare integration behavior", "verify integration behavior"],
        },
      ],
      source: {
        importsDirectTest: false,
        importsSharedTest: false,
        phaseCalls: [
          {
            file: "test/workflow-selected.test.ts",
            line: 12,
            label: "verify integration behavior",
          },
        ],
        testPhaseBodies: [],
      },
    };

    expect(validateCollectedSemanticPhaseModule(module)).toEqual([
      "test/workflow-selected.test.ts: workflow-selected integration E2E tests must import test from the workflow-e2e-test fixture",
    ]);
    expect(
      validateCollectedSemanticPhaseModule({
        ...module,
        source: { ...module.source, importsWorkflowTest: true },
      }),
    ).toEqual([]);
  });

  test("rejects missing metadata and invalid phase transitions from a collected module", () => {
    const failures = validateCollectedSemanticPhaseModule({
      relativeModuleId: "test/e2e/live/invalid-semantic-phase.test.ts",
      errors: [],
      tests: [
        { fullName: "missing semantic phase metadata" },
        {
          fullName: "invalid semantic phase transitions",
          phases: ["prepare fixture behavior", "exercise fixture behavior"],
        },
      ],
      source: scanLiveSourceGraph(INVALID_SOURCE_FIXTURE),
    });

    expect(failures).toHaveLength(3);
    expect(failures).toEqual(
      expect.arrayContaining([
        "test/e2e/live/invalid-semantic-phase.test.ts > missing semantic phase metadata: missing e2ePhases metadata",
        expect.stringMatching(/semantic phase transitions must use literals/u),
        expect.stringMatching(/undeclared semantic phase: undeclared fixture behavior/u),
      ]),
    );
  });

  test("accepts only the exact bootstrap forwarding alias", () => {
    const forwardingModule = {
      relativeModuleId: "test/e2e/live/bootstrap-install-smoke.test.ts",
      errors: [],
      tests: [],
      source: {
        importsDirectTest: false,
        importsSharedTest: false,
        phaseCalls: [],
        testPhaseBodies: [],
      },
    };

    expect(
      validateCollectedSemanticPhaseModule({
        ...forwardingModule,
        source: {
          ...forwardingModule.source,
          forwardedTestModules: ["test/e2e/live/launchable-smoke.test.ts"],
        },
      }),
    ).toEqual([]);
    expect(
      validateCollectedSemanticPhaseModule({
        ...forwardingModule,
        source: {
          ...forwardingModule.source,
          directChildProcessCalls: [
            {
              api: "spawnSync",
              boundary: "forwardedSetup",
              file: "test/e2e/live/bootstrap-install-smoke.test.ts",
              hasBoundedTimeout: false,
              hasHardKillSignal: true,
              line: 8,
              observesOutput: false,
              outputIgnored: false,
              tracksActivity: false,
              tracksLifecycle: false,
            },
          ],
          forwardedTestModules: ["test/e2e/live/launchable-smoke.test.ts"],
        },
      }),
    ).toEqual([
      expect.stringMatching(
        /blocking child-process call spawnSync must declare a positive timeout/u,
      ),
    ]);
    const expectedFailure =
      "test/e2e/live/bootstrap-install-smoke.test.ts: forwarding module must import exactly test/e2e/live/launchable-smoke.test.ts";
    for (const forwardedTestModules of [
      [],
      ["test/e2e/live/other.test.ts"],
      ["test/e2e/live/launchable-smoke.test.ts", "test/e2e/live/other.test.ts"],
    ]) {
      expect(
        validateCollectedSemanticPhaseModule({
          ...forwardingModule,
          source: { ...forwardingModule.source, forwardedTestModules },
        }),
      ).toEqual([expectedFailure]);
    }

    const forwardingSource = scanLiveSourceGraph(
      path.join(REPO_ROOT, "test/e2e/live/bootstrap-install-smoke.test.ts"),
    );
    expect(forwardingSource.phaseCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: "test/e2e/live/launchable-smoke.test.ts" }),
      ]),
    );
  });

  test("rejects each direct child-process boundary that can hide a heartbeat", () => {
    const source = scanLiveSourceGraph(CHILD_PROCESS_SOURCE_FIXTURE);
    const failures = validateCollectedSemanticPhaseModule({
      relativeModuleId: "test/e2e/live/direct-child-process-audit.test.ts",
      errors: [],
      tests: [
        {
          fullName: "audits child processes",
          phases: ["prepare child-process audit", "audit child processes"],
        },
      ],
      source: {
        ...source,
        importsSharedTest: true,
        phaseCalls: [
          {
            file: "test/e2e/live/direct-child-process-audit.test.ts",
            line: 10,
            label: "audit child processes",
          },
        ],
      },
    });

    const directCalls = source.directChildProcessCalls ?? [];
    expect(directCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ api: "spawn", boundary: "reassignedNamespaceAsyncChild" }),
        expect.objectContaining({ api: "spawn", boundary: "namespaceDestructuredAsyncChild" }),
        expect.objectContaining({ api: "spawn", boundary: "assignmentAliasAsyncChild" }),
        expect.objectContaining({ api: "execFile", boundary: "assignmentAliasAsyncChild" }),
        expect.objectContaining({ api: "execFile", boundary: "nestedRequiredAsyncChild" }),
        expect.objectContaining({ api: "fork", boundary: "directNestedRequiredAsyncChild" }),
        expect.objectContaining({ api: "spawn", boundary: "boundAsyncChild" }),
        expect.objectContaining({ api: "execFile", boundary: "inlineBoundAsyncChild" }),
        expect.objectContaining({ api: "exec", boundary: "promisedAsyncChildren" }),
        expect.objectContaining({ api: "execFile", boundary: "promisedAsyncChildren" }),
        expect.objectContaining({ api: "spawn", boundary: "aliasedLoaderAsyncChildren" }),
        expect.objectContaining({ api: "spawn", boundary: "extractedBindAsyncChild" }),
        expect.objectContaining({
          api: "spawnSync",
          boundary: "boundedSyncChild",
          hasBoundedTimeout: true,
          hasHardKillSignal: true,
        }),
        expect.objectContaining({
          api: "spawnSync",
          boundary: "otherBoundedSyncChildren",
          hasBoundedTimeout: false,
          hasHardKillSignal: false,
        }),
        expect.objectContaining({
          api: "spawnSync",
          boundary: "decoyAndPreappliedSyncOptions",
          hasBoundedTimeout: false,
          hasHardKillSignal: false,
        }),
        expect.objectContaining({
          api: "spawnSync",
          boundary: "conflictingReassignmentSyncOptions",
          hasBoundedTimeout: false,
          hasHardKillSignal: false,
        }),
        expect.objectContaining({
          api: "execFileSync",
          boundary: "decoyAndPreappliedSyncOptions",
          hasBoundedTimeout: false,
          hasHardKillSignal: false,
        }),
        expect.objectContaining({
          api: "spawnSync",
          boundary: "decoyAndPreappliedSyncOptions",
          hasBoundedTimeout: false,
          hasHardKillSignal: false,
        }),
        expect.objectContaining({
          api: "spawnSync",
          boundary: "spreadSyncOptions",
          hasBoundedTimeout: true,
          hasHardKillSignal: true,
        }),
      ]),
    );
    expect(
      failures.filter((failure) =>
        /asynchronous child-process call (?:exec|execFile|fork|spawn) must use an audited/u.test(
          failure,
        ),
      ),
    ).toHaveLength(21);
    expect(
      failures.filter((failure) =>
        /blocking child-process call spawnSync must declare a positive timeout/u.test(failure),
      ),
    ).toHaveLength(10);
    expect(
      failures.filter((failure) =>
        /blocking child-process call spawnSync must declare killSignal: "SIGKILL"/u.test(failure),
      ),
    ).toHaveLength(10);
    expect(source.childProcessAuditFailures).toHaveLength(8);
    expect(source.childProcessAuditFailures).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/namespace access must use a statically known audited API/u),
        expect.stringMatching(/must not be passed to an unaudited higher-order function/u),
        expect.stringMatching(/must not be stored in object properties/u),
        expect.stringMatching(/must not be spread into object properties/u),
        expect.stringMatching(/must not be stored in array elements/u),
        expect.stringMatching(/unsupported child-process namespace member/u),
      ]),
    );
    expect(
      directCalls.filter((call) => call.boundary === "decoyAndPreappliedSyncOptions"),
    ).toHaveLength(4);
  });

  test("rejects wildcard re-exports and process built-in child-process loaders", () => {
    const exportScan = scanDirectChildProcessSource(
      path.join(REPO_ROOT, "test/e2e/live/child-process-export.fixture.ts"),
      'export * from "child_process";\nexport * from "node:child_process";\n',
    );
    expect(exportScan.calls).toEqual([]);
    expect(exportScan.auditFailures).toHaveLength(2);
    expect(exportScan.auditFailures).toEqual([
      expect.stringMatching(/child-process APIs must not be re-exported/u),
      expect.stringMatching(/child-process APIs must not be re-exported/u),
    ]);

    const builtinFile = path.join(REPO_ROOT, "test/e2e/live/process-builtin-child.fixture.ts");
    const builtinScan = scanDirectChildProcessSource(
      builtinFile,
      `
const getBuiltinModule = process.getBuiltinModule;
process.getBuiltinModule("node:child_process").spawn("node-prefixed-child", [], { stdio: "ignore" });
getBuiltinModule("child_process").spawn("bare-child", [], { stdio: "ignore" });
`,
    );
    expect(builtinScan.auditFailures).toEqual([]);
    expect(builtinScan.calls).toEqual([
      expect.objectContaining({ api: "spawn", outputIgnored: true }),
      expect.objectContaining({ api: "spawn", outputIgnored: true }),
    ]);
    const failures = validateCollectedSemanticPhaseModule({
      relativeModuleId: "test/e2e/live/process-builtin-child.fixture.ts",
      errors: [],
      tests: [{ fullName: "audits process built-ins", phases: ["prepare", "verify"] }],
      source: {
        childProcessAuditFailures: builtinScan.auditFailures,
        directChildProcessCalls: builtinScan.calls,
        importsDirectTest: false,
        importsSharedTest: true,
        phaseCalls: [
          {
            file: "test/e2e/live/process-builtin-child.fixture.ts",
            label: "verify",
            line: 1,
          },
        ],
        testPhaseBodies: [],
      },
    });
    expect(
      failures.filter((failure) =>
        /asynchronous child-process call spawn must use an audited/u.test(failure),
      ),
    ).toHaveLength(2);
  });

  test("tracks createRequire aliases without adding an executable CommonJS test seam", () => {
    const sourceText = [
      'import { createRequire as makeLoader } from "node:module";',
      "const load = makeLoader(import.meta.url);",
      'const childProcess = load("node:child_process");',
      "export function invoke() {",
      '  childProcess.spawn("created-require-child", [], { stdio: "ignore" });',
      "}",
    ].join("\n");
    const result = scanDirectChildProcessSource(
      "test/e2e/support/fixtures/create-require-source.fixture.ts",
      sourceText,
    );

    expect(result.auditFailures).toEqual([]);
    expect(result.calls).toEqual([expect.objectContaining({ api: "spawn", boundary: "invoke" })]);
  });

  test("ties the audited async boundary to the same child's lifecycle and exact output events", () => {
    const canonicalSource = fs.readFileSync(OBSERVED_CHILD_PROCESS_SOURCE, "utf8");
    const canonical = scanDirectChildProcessSource(OBSERVED_CHILD_PROCESS_SOURCE, canonicalSource);
    expect(canonical.auditFailures).toEqual([]);
    expect(canonical.calls).toEqual([
      expect.objectContaining({
        api: "spawn",
        boundary: "spawnObservedChild",
        observesOutput: true,
        tracksActivity: true,
        tracksLifecycle: true,
      }),
    ]);

    const unrelatedActivity = scanDirectChildProcessSource(
      OBSERVED_CHILD_PROCESS_SOURCE,
      canonicalSource.replace("options.progress.activity(", "unrelated.activity("),
    );
    expect(unrelatedActivity.calls[0]).toEqual(expect.objectContaining({ tracksActivity: false }));

    const deadActivity = scanDirectChildProcessSource(
      OBSERVED_CHILD_PROCESS_SOURCE,
      canonicalSource.replace(
        "options.progress.activity(options.activityLabel)",
        "false ? options.progress.activity(options.activityLabel) : undefined",
      ),
    );
    expect(deadActivity.calls[0]).toEqual(expect.objectContaining({ tracksActivity: false }));

    const siblingLifecycle = scanDirectChildProcessSource(
      OBSERVED_CHILD_PROCESS_SOURCE,
      canonicalSource.replace('child.once("close"', 'sibling.once("close"'),
    );
    expect(siblingLifecycle.calls[0]).toEqual(expect.objectContaining({ tracksActivity: false }));

    const reassignedChild = scanDirectChildProcessSource(
      OBSERVED_CHILD_PROCESS_SOURCE,
      canonicalSource.replace(
        "child = spawn(command, [...args], options.spawn);",
        "child = spawn(command, [...args], options.spawn);\n    child = sibling;",
      ),
    );
    expect(reassignedChild.calls[0]).toEqual(
      expect.objectContaining({ observesOutput: false, tracksActivity: false }),
    );

    const reassignedActivity = scanDirectChildProcessSource(
      OBSERVED_CHILD_PROCESS_SOURCE,
      canonicalSource.replace(
        "child = spawn(command, [...args], options.spawn);",
        "child = spawn(command, [...args], options.spawn);\n    finishActivity = () => undefined;",
      ),
    );
    expect(reassignedActivity.calls[0]).toEqual(expect.objectContaining({ tracksActivity: false }));

    const siblingOutput = scanDirectChildProcessSource(
      OBSERVED_CHILD_PROCESS_SOURCE,
      canonicalSource.replace('child.stderr?.on("data"', 'sibling.stderr?.on("data"'),
    );
    expect(siblingOutput.calls[0]).toEqual(expect.objectContaining({ observesOutput: false }));

    const conditionalLifecycle = scanDirectChildProcessSource(
      OBSERVED_CHILD_PROCESS_SOURCE,
      canonicalSource.replace(
        'child.once("close", (code, signal) => {\n    try {\n      finishActivity();',
        'child.once("close", (code, signal) => {\n    try {\n      if (false) finishActivity();',
      ),
    );
    expect(conditionalLifecycle.calls[0]).toEqual(
      expect.objectContaining({ tracksActivity: false }),
    );

    const missingLifecycleStart = scanDirectChildProcessSource(
      OBSERVED_CHILD_PROCESS_SOURCE,
      canonicalSource.replace(
        "finishChildLifecycle = options.progress.beginChildLifecycle();",
        "finishChildLifecycle = NOOP_CHILD_LIFECYCLE_REPORTER;",
      ),
    );
    expect(missingLifecycleStart.calls[0]).toEqual(
      expect.objectContaining({ tracksLifecycle: false }),
    );

    const unconditionalLaunchFailure = scanDirectChildProcessSource(
      OBSERVED_CHILD_PROCESS_SOURCE,
      canonicalSource.replace(
        "if (!childSpawned) childLaunchFailed = true;",
        "childLaunchFailed = true;",
      ),
    );
    expect(unconditionalLaunchFailure.calls[0]).toEqual(
      expect.objectContaining({ tracksLifecycle: false }),
    );

    const preconfirmedLaunch = scanDirectChildProcessSource(
      OBSERVED_CHILD_PROCESS_SOURCE,
      canonicalSource.replace("let childSpawned = false;", "let childSpawned = true;"),
    );
    expect(preconfirmedLaunch.calls[0]).toEqual(
      expect.objectContaining({ tracksLifecycle: false }),
    );

    const payloadBearingTerminal = scanDirectChildProcessSource(
      OBSERVED_CHILD_PROCESS_SOURCE,
      canonicalSource.replace(': "exited-nonzero",', ": `exited-nonzero-${String(code)}`,"),
    );
    expect(payloadBearingTerminal.calls[0]).toEqual(
      expect.objectContaining({ tracksLifecycle: false }),
    );

    const missingLifecycleFailures = validateCollectedSemanticPhaseModule({
      relativeModuleId: "test/e2e/live/observed-child-lifecycle-contract.test.ts",
      errors: [],
      tests: [{ fullName: "audits child lifecycle checkpoints", phases: ["prepare", "verify"] }],
      source: {
        directChildProcessCalls: missingLifecycleStart.calls,
        importsDirectTest: false,
        importsSharedTest: true,
        phaseCalls: [
          {
            file: "test/e2e/live/observed-child-lifecycle-contract.test.ts",
            label: "verify",
            line: 1,
          },
        ],
        testPhaseBodies: [],
      },
    });
    expect(missingLifecycleFailures).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/must emit canonical content-free lifecycle checkpoints/u),
      ]),
    );

    const conditionalOutput = scanDirectChildProcessSource(
      OBSERVED_CHILD_PROCESS_SOURCE,
      canonicalSource.replace(
        'options.progress.onOutput({ stream: "stdout", atMs: Date.now() });',
        'if (false) options.progress.onOutput({ stream: "stdout", atMs: Date.now() });',
      ),
    );
    expect(conditionalOutput.calls[0]).toEqual(expect.objectContaining({ observesOutput: false }));

    const payloadBearingOutput = scanDirectChildProcessSource(
      OBSERVED_CHILD_PROCESS_SOURCE,
      canonicalSource.replace(
        '{ stream: "stdout", atMs: Date.now() }',
        '{ stream: "stdout", atMs: Date.now(), rawChunk }',
      ),
    );
    expect(payloadBearingOutput.calls[0]).toEqual(
      expect.objectContaining({ observesOutput: false }),
    );

    const payloadBearingSibling = scanDirectChildProcessSource(
      OBSERVED_CHILD_PROCESS_SOURCE,
      canonicalSource.replace(
        'child.stdout?.on("data", () => {',
        'child.stdout?.on("data", (rawChunk) => {\n    console.log(rawChunk);',
      ),
    );
    expect(payloadBearingSibling.calls[0]).toEqual(
      expect.objectContaining({ observesOutput: false }),
    );

    const payloadBearingCatch = scanDirectChildProcessSource(
      OBSERVED_CHILD_PROCESS_SOURCE,
      canonicalSource
        .replace('child.stdout?.on("data", () => {', 'child.stdout?.on("data", (rawChunk) => {')
        .replace(
          'options.progress.onOutput({ stream: "stdout", atMs: Date.now() });\n    } catch {',
          'options.progress.onOutput({ stream: "stdout", atMs: Date.now() });\n    } catch {\n      console.log(rawChunk);',
        ),
    );
    expect(payloadBearingCatch.calls[0]).toEqual(
      expect.objectContaining({ observesOutput: false }),
    );

    const extraPayloadListener = scanDirectChildProcessSource(
      OBSERVED_CHILD_PROCESS_SOURCE,
      canonicalSource.replace(
        'child.stderr?.on("data", () => {',
        'child.stdout?.on("data", (rawChunk) => console.log(rawChunk));\n  child.stderr?.on("data", () => {',
      ),
    );
    expect(extraPayloadListener.calls[0]).toEqual(
      expect.objectContaining({ observesOutput: false }),
    );

    const pipedPayload = scanDirectChildProcessSource(
      OBSERVED_CHILD_PROCESS_SOURCE,
      canonicalSource.replace(
        'child.stderr?.on("data", () => {',
        'child.stdout?.pipe(process.stdout);\n  child.stderr?.on("data", () => {',
      ),
    );
    expect(pipedPayload.calls[0]).toEqual(expect.objectContaining({ observesOutput: false }));

    const extraChild = scanDirectChildProcessSource(
      OBSERVED_CHILD_PROCESS_SOURCE,
      canonicalSource.replace(
        "child = spawn(command, [...args], options.spawn);",
        "child = spawn(command, [...args], options.spawn);\n    spawn(command, [...args], options.spawn);",
      ),
    );
    expect(extraChild.calls).toHaveLength(2);
    const failures = validateCollectedSemanticPhaseModule({
      relativeModuleId: "test/e2e/live/observed-child-contract.test.ts",
      errors: [],
      tests: [{ fullName: "audits the observed child", phases: ["prepare", "verify"] }],
      source: {
        directChildProcessCalls: extraChild.calls,
        importsDirectTest: false,
        importsSharedTest: true,
        phaseCalls: [
          {
            file: "test/e2e/live/observed-child-contract.test.ts",
            label: "verify",
            line: 1,
          },
        ],
        testPhaseBodies: [],
      },
    });
    expect(failures).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/audited boundary must contain exactly one direct asynchronous/u),
      ]),
    );
  });

  test("rejects unreviewed or structurally forged observed-child progress", () => {
    const canonicalSource = fs.readFileSync(FAKE_OPENAI_SOURCE, "utf8");
    expect(scanDirectChildProcessSource(FAKE_OPENAI_SOURCE, canonicalSource).auditFailures).toEqual(
      [],
    );

    const forgedProgress = scanDirectChildProcessSource(
      FAKE_OPENAI_SOURCE,
      canonicalSource.replace(
        "progress: options.progress,",
        "progress: { activity: () => () => undefined, onOutput: () => undefined },",
      ),
    );
    expect(forgedProgress.auditFailures).toEqual([
      expect.stringMatching(/progress must retain the reviewed TestProgress capability/u),
    ]);

    const unreviewedCallsite = scanDirectChildProcessSource(
      FAKE_OPENAI_SOURCE,
      `${canonicalSource}\nexport function unreviewed(options: FakeOpenAiCompatibleServerOptions) {\n  return spawnObservedChild("x", [], { activityLabel: "x", progress: options.progress, spawn: {} });\n}\n`,
    );
    expect(unreviewedCallsite.auditFailures).toEqual([
      expect.stringMatching(/must use a reviewed progress-capability callsite/u),
    ]);

    const lifecycleCapabilityCallsite = scanDirectChildProcessSource(
      FAKE_OPENAI_SOURCE,
      `${canonicalSource}\nexport function bypassObservedChild(options: FakeOpenAiCompatibleServerOptions) {\n  options.progress.beginChildLifecycle();\n}\n`,
    );
    expect(lifecycleCapabilityCallsite.auditFailures).toEqual([
      expect.stringMatching(/reserved for the canonical observed-child boundary/u),
    ]);

    const supportLifecycleProbe = scanDirectChildProcessSource(
      path.join(REPO_ROOT, "test/e2e/support/lifecycle-probe.fixture.ts"),
      "export function probe(progress: { beginChildLifecycle(): () => void }) { progress.beginChildLifecycle(); }",
    );
    expect(supportLifecycleProbe.auditFailures).toEqual([]);

    const escapedWrapper = scanDirectChildProcessSource(
      FAKE_OPENAI_SOURCE,
      `${canonicalSource}\nconst wrapperBag = { spawnObservedChild };\nconst wrapperList = [spawnObservedChild];\nexport { spawnObservedChild };\nvoid [wrapperBag, wrapperList];\n`,
    );
    expect(escapedWrapper.auditFailures).toHaveLength(3);
    expect(escapedWrapper.auditFailures).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/must not be stored in object properties/u),
        expect.stringMatching(/must not be stored in array elements/u),
        expect.stringMatching(/must not be exported/u),
      ]),
    );

    const indirectWrapper = scanDirectChildProcessSource(
      FAKE_OPENAI_SOURCE,
      `${canonicalSource}\nexport function indirect(options: FakeOpenAiCompatibleServerOptions) {\n  return spawnObservedChild.call(null, "x", [], { activityLabel: "x", progress: options.progress, spawn: {} });\n}\n`,
    );
    expect(indirectWrapper.auditFailures).toEqual([
      expect.stringMatching(/must be invoked directly without member indirection/u),
    ]);

    const namespaceAliasSource = canonicalSource
      .replace(
        'import { spawnObservedChild } from "./observed-child-process.ts";',
        'import * as observedChild from "./observed-child-process.ts";\nconst observedAlias = observedChild;',
      )
      .replace("child = spawnObservedChild(", "child = observedAlias.spawnObservedChild(");
    expect(
      scanDirectChildProcessSource(FAKE_OPENAI_SOURCE, namespaceAliasSource).auditFailures,
    ).toEqual([]);
    expect(
      scanDirectChildProcessSource(
        FAKE_OPENAI_SOURCE,
        namespaceAliasSource.replace(
          "progress: options.progress,",
          "progress: { activity: () => () => undefined, onOutput: () => undefined },",
        ),
      ).auditFailures,
    ).toEqual([
      expect.stringMatching(/progress must retain the reviewed TestProgress capability/u),
    ]);
  });

  test("rejects removal or weakening of the private progress capability", () => {
    const progressSource = fs.readFileSync(TEST_PROGRESS_SOURCE, "utf8");
    expect(
      scanDirectChildProcessSource(TEST_PROGRESS_SOURCE, progressSource).auditFailures,
    ).toEqual([]);
    expect(
      scanDirectChildProcessSource(
        TEST_PROGRESS_SOURCE,
        progressSource.replace(
          "const TEST_PROGRESS_CAPABILITY: unique symbol",
          "export const TEST_PROGRESS_CAPABILITY: unique symbol",
        ),
      ).auditFailures,
    ).toEqual([expect.stringMatching(/module-private unique symbol/u)]);
    expect(
      scanDirectChildProcessSource(
        TEST_PROGRESS_SOURCE,
        progressSource.replace("new WeakSet<object>()", "new Set<object>()"),
      ).auditFailures,
    ).toEqual([expect.stringMatching(/module-private WeakSet/u)]);
    expect(
      scanDirectChildProcessSource(
        TEST_PROGRESS_SOURCE,
        progressSource.replace("descriptor.enumerable === false", "descriptor.enumerable === true"),
      ).auditFailures,
    ).toEqual([expect.stringMatching(/exactly validate the private registry/u)]);
    expect(
      scanDirectChildProcessSource(
        TEST_PROGRESS_SOURCE,
        progressSource.replace("    enumerable: false,", "    enumerable: true,"),
      ).auditFailures,
    ).toEqual([expect.stringMatching(/privately brand, register, and freeze/u)]);
    expect(
      scanDirectChildProcessSource(
        TEST_PROGRESS_SOURCE,
        progressSource.replace("return Object.freeze(progress);", "return progress;"),
      ).auditFailures,
    ).toEqual([expect.stringMatching(/privately brand, register, and freeze/u)]);
    expect(
      scanDirectChildProcessSource(
        TEST_PROGRESS_SOURCE,
        progressSource.replace(
          "  beginChildLifecycle: () => ChildLifecycleTerminalReporter;\n",
          "",
        ),
      ).auditFailures,
    ).toEqual([expect.stringMatching(/zero-argument child lifecycle capability/u)]);
    expect(
      scanDirectChildProcessSource(
        TEST_PROGRESS_SOURCE,
        progressSource.replace(
          "    beginChildLifecycle() {",
          "    beginChildLifecycle(_label: string) {",
        ),
      ).auditFailures,
    ).toEqual([expect.stringMatching(/synchronously start and freeze idempotent/u)]);
    expect(
      scanDirectChildProcessSource(
        TEST_PROGRESS_SOURCE,
        progressSource.replace(
          "      return Object.freeze(reportTerminal);",
          "      return reportTerminal;",
        ),
      ).auditFailures,
    ).toEqual([expect.stringMatching(/synchronously start and freeze idempotent/u)]);
    expect(
      scanDirectChildProcessSource(
        TEST_PROGRESS_SOURCE,
        progressSource.replace("        if (terminalReported) return;\n", ""),
      ).auditFailures,
    ).toEqual([expect.stringMatching(/synchronously start and freeze idempotent/u)]);
    expect(
      scanDirectChildProcessSource(
        TEST_PROGRESS_SOURCE,
        progressSource.replace("        terminalReported = true;\n", ""),
      ).auditFailures,
    ).toEqual([expect.stringMatching(/synchronously start and freeze idempotent/u)]);
    expect(
      scanDirectChildProcessSource(
        TEST_PROGRESS_SOURCE,
        progressSource.replace('  | "closed-unknown";', '  | "raw-exit-code";'),
      ).auditFailures,
    ).toEqual([expect.stringMatching(/fixed content-free terminal vocabulary/u)]);

    const observedSource = fs.readFileSync(OBSERVED_CHILD_PROCESS_SOURCE, "utf8");
    expect(
      scanDirectChildProcessSource(
        OBSERVED_CHILD_PROCESS_SOURCE,
        observedSource.replace(
          "export interface ChildProcessProgress extends TestProgressCapability",
          "export interface ChildProcessProgress",
        ),
      ).auditFailures,
    ).toEqual([expect.stringMatching(/must require the private TestProgress capability/u)]);
    expect(
      scanDirectChildProcessSource(
        OBSERVED_CHILD_PROCESS_SOURCE,
        observedSource.replace("  onOutput(event:", "  onOutput?(event:"),
      ).auditFailures,
    ).toEqual([expect.stringMatching(/must require timestamp-only output observation/u)]);
    expect(
      scanDirectChildProcessSource(
        OBSERVED_CHILD_PROCESS_SOURCE,
        observedSource.replace(
          "if (!isTestProgressCapability(options.progress))",
          "if (false && !isTestProgressCapability(options.progress))",
        ),
      ).auditFailures,
    ).toEqual([expect.stringMatching(/must reject non-canonical progress before spawning/u)]);
  });

  test("rejects phase transitions that belong to sibling tests", () => {
    const failures = validateTestScopedPhaseCalls(
      [
        { name: "GitHub download", phases: ["prepare GitHub", "download with GitHub"] },
        { name: "curl fallback", phases: ["prepare curl", "download with curl"] },
      ],
      [
        {
          file: "test/e2e/live/example.test.ts",
          line: 10,
          phaseCalls: [
            { file: "test/e2e/live/example.test.ts", line: 12, label: "download with curl" },
          ],
        },
        {
          file: "test/e2e/live/example.test.ts",
          line: 20,
          phaseCalls: [
            { file: "test/e2e/live/example.test.ts", line: 22, label: "download with GitHub" },
          ],
        },
      ],
    );

    expect(failures).toEqual([
      "test/e2e/live/example.test.ts:12: semantic phase is not declared by its test (GitHub download): download with curl",
      "test/e2e/live/example.test.ts:10: semantic phase is never entered by its test (GitHub download): download with GitHub",
      "test/e2e/live/example.test.ts:22: semantic phase is not declared by its test (curl fallback): download with GitHub",
      "test/e2e/live/example.test.ts:20: semantic phase is never entered by its test (curl fallback): download with curl",
    ]);
  });

  test("rejects a same-plan sibling that omits its final phase", () => {
    const phases = ["prepare shared fixture", "verify shared fixture"] as const;
    const failures = validateCollectedSemanticPhaseModule({
      relativeModuleId: "test/e2e/live/same-plan-siblings.test.ts",
      errors: [],
      tests: [
        { fullName: "complete sibling", phases },
        { fullName: "incomplete sibling", phases },
      ],
      source: {
        importsDirectTest: false,
        importsSharedTest: true,
        phaseCalls: [
          {
            file: "test/e2e/live/same-plan-siblings.test.ts",
            line: 12,
            label: "verify shared fixture",
          },
        ],
        testPhaseBodies: [
          {
            file: "test/e2e/live/same-plan-siblings.test.ts",
            line: 10,
            phaseCalls: [
              {
                file: "test/e2e/live/same-plan-siblings.test.ts",
                line: 12,
                label: "verify shared fixture",
              },
            ],
          },
          {
            file: "test/e2e/live/same-plan-siblings.test.ts",
            line: 20,
            phaseCalls: [],
          },
        ],
      },
    });

    expect(failures).toEqual([
      "test/e2e/live/same-plan-siblings.test.ts:20: semantic phase is never entered by its test (incomplete sibling): verify shared fixture",
    ]);
  });

  test("validates expanded same-plan registrations and ignores unconditional skips", () => {
    const phases = ["prepare shared fixture", "verify shared fixture"] as const;
    const failures = validateCollectedSemanticPhaseModule({
      relativeModuleId: "test/e2e/live/expanded-same-plan.test.ts",
      errors: [],
      tests: [
        { fullName: "skipped case", phases },
        { fullName: "expanded case one", phases },
        { fullName: "expanded case two", phases },
      ],
      source: {
        importsDirectTest: false,
        importsSharedTest: true,
        phaseCalls: [
          {
            file: "test/e2e/live/expanded-same-plan.test.ts",
            line: 22,
            label: "verify shared fixture",
          },
        ],
        testPhaseBodies: [
          {
            file: "test/e2e/live/expanded-same-plan.test.ts",
            line: 10,
            phaseCalls: [],
            skipped: true,
          },
          {
            file: "test/e2e/live/expanded-same-plan.test.ts",
            line: 20,
            phaseCalls: [
              {
                file: "test/e2e/live/expanded-same-plan.test.ts",
                line: 22,
                label: "verify shared fixture",
              },
            ],
          },
        ],
      },
    });

    expect(failures).toEqual([]);
  });

  test("accepts transitions declared by their own tests", () => {
    expect(
      validateTestScopedPhaseCalls(
        [
          { name: "GitHub download", phases: ["prepare GitHub", "download with GitHub"] },
          { name: "curl fallback", phases: ["prepare curl", "download with curl"] },
        ],
        [
          {
            file: "test/e2e/live/example.test.ts",
            line: 10,
            phaseCalls: [
              { file: "test/e2e/live/example.test.ts", line: 12, label: "download with GitHub" },
            ],
          },
          {
            file: "test/e2e/live/example.test.ts",
            line: 20,
            phaseCalls: [
              { file: "test/e2e/live/example.test.ts", line: 22, label: "download with curl" },
            ],
          },
        ],
      ),
    ).toEqual([]);
  });
});
