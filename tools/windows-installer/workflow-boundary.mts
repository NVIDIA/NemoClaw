// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
export type WorkflowStep = {
  id?: string;
  shell?: string;
  name?: string;
  run?: string;
  uses?: string;
  if?: string;
  "continue-on-error"?: boolean | string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};
export type WorkflowJob = {
  steps?: WorkflowStep[];
  env?: Record<string, string>;
  needs?: string | string[];
  if?: string;
  uses?: string;
  environment?: unknown;
  outputs?: Record<string, string>;
  permissions?: Record<string, string>;
  with?: Record<string, unknown>;
  strategy?: { "fail-fast"?: boolean; matrix?: { node?: string[] } };
  "runs-on"?: string;
  "timeout-minutes"?: number;
};
export type Workflow = { jobs: Record<string, WorkflowJob> };
type WindowsInstallerWorkflow = Workflow & {
  concurrency: { "cancel-in-progress": string; group: string };
  on: {
    pull_request: { paths: string[]; types: string[] };
    workflow_dispatch: { inputs: Record<string, unknown> };
  };
  permissions: Record<string, string>;
};
type TrustedWorkflow = Workflow & {
  on: { workflow_call: { inputs: Record<string, unknown>; outputs: Record<string, unknown> } };
  permissions: Record<string, string>;
};
export type WindowsInstallerWorkflowSources = {
  workflow: WindowsInstallerWorkflow;
  trusted: TrustedWorkflow;
  workflowSource: string;
  trustedSource: string;
  transferSource: string;
  evidenceSource: string;
  acceptanceSource: string;
};
export function readWindowsInstallerWorkflowSources(root: string): WindowsInstallerWorkflowSources {
  const read = (name: string) => readFileSync(resolve(root, name), "utf8");
  const workflowSource = read(".github/workflows/windows-native-installer-v2.yaml");
  const trustedSource = read(".github/workflows/windows-native-installer-trusted.yaml");
  return {
    workflow: YAML.parse(workflowSource),
    trusted: YAML.parse(trustedSource),
    workflowSource,
    trustedSource,
    transferSource: read("scripts/checks/windows-native-transfer.ps1"),
    evidenceSource: read("scripts/checks/stage-windows-native-evidence.ps1"),
    acceptanceSource: read("packaging/windows/installer/run-installed-acceptance.ps1"),
  };
}
function containingText(fragment: string): (value: unknown) => boolean {
  return (value) => typeof value === "string" && value.includes(fragment);
}
function containsItems(actual: unknown, expected: unknown[]): boolean {
  return (
    Array.isArray(actual) &&
    expected.every((value) => actual.some((item) => isDeepStrictEqual(item, value)))
  );
}
function matchesFields(actual: unknown, expected: Record<string, unknown>): boolean {
  if (!actual || typeof actual !== "object") return false;
  return Object.entries(expected).every(([key, value]) =>
    typeof value === "function"
      ? value((actual as Record<string, unknown>)[key])
      : isDeepStrictEqual((actual as Record<string, unknown>)[key], value),
  );
}
function requiredJob(workflow: Workflow, name: string): WorkflowJob {
  const job = workflow.jobs[name];
  assert.ok(job !== undefined);
  return job!;
}
function requiredStep(job: WorkflowJob, name: string): WorkflowStep {
  const step = job.steps?.find((candidate) => candidate.name === name);
  assert.ok(step !== undefined);
  return step!;
}
function jobNeeds(job: WorkflowJob): string[] {
  return typeof job.needs === "string" ? [job.needs] : (job.needs ?? []);
}
// The CI boundary checker rejects unsafe workflow edits before Windows qualification.
// It does not grant environment approval or replace installed-runtime acceptance.
export function assertWindowsInstallerWorkflow(input: WindowsInstallerWorkflowSources): void {
  const {
    workflow,
    trusted,
    workflowSource,
    trustedSource,
    transferSource,
    evidenceSource,
    acceptanceSource,
  } = input;
  {
    const personal = requiredJob(workflow, "official-hermes-personal-candidate");
    assert.equal(personal["runs-on"], "windows-11-vs2026-arm");
    assert.equal(personal["timeout-minutes"], 60);
    assert.deepEqual(personal.permissions, { contents: "read", actions: "read" });
    const helper = requiredStep(personal, "Build the fixed-purpose system-drive metadata helper");
    const rust = requiredStep(personal, "Prepare pinned native Rust for Personal compatibility");
    const native = requiredStep(personal, "Build and qualify current Personal native inputs");
    const prepare = requiredStep(
      personal,
      "Prepare the complete candidate and test canonical Personal components",
    );
    const upload = requiredStep(personal, "Preserve current native Personal runtime inputs");
    const selected = "${{ inputs.official_hermes_phase == 'personal-candidate' }}";
    for (const required of [rust, native]) {
      assert.equal(required.if, selected);
      assert.equal(required["continue-on-error"], undefined);
    }
    assert.deepEqual(rust.with, {
      toolchain: "1.93.0",
      target: "aarch64-pc-windows-msvc",
      override: false,
      cache: false,
    });
    assert.equal(prepare.if, undefined);
    assert.equal(prepare["continue-on-error"], undefined);
    assert.ok(personal.steps!.indexOf(helper) < personal.steps!.indexOf(native));
    assert.ok(personal.steps!.indexOf(rust) < personal.steps!.indexOf(native));
    assert.ok(personal.steps!.indexOf(native) < personal.steps!.indexOf(prepare));
    assert.ok(personal.steps!.indexOf(prepare) < personal.steps!.indexOf(upload));
    for (const text of [
      "git rev-parse HEAD",
      "$head -cne $env:GITHUB_SHA",
      "packaging/windows/mxc-bash/run-bash-compat.ps1 -SourceRoot $env:GITHUB_WORKSPACE",
      '-ArtifactDirectory "$env:RUNNER_TEMP\\personal-native-inputs"',
      '-HelperDirectory "$env:RUNNER_TEMP\\personal-helper"',
    ])
      assert.ok(native.run?.includes(text), text);
    for (const text of [
      "\"${{ inputs.official_hermes_phase }}\" -ceq 'personal-candidate'",
      "rustup which --toolchain 1.95.0 rustc",
      'NativeCompatibilityDirectory = "$env:RUNNER_TEMP\\personal-native-inputs"',
      "RustBinDirectory = (Split-Path -Parent $rustc)",
      "packaging/windows/hermes/probe-personal-candidate.ps1",
      "@native",
    ])
      assert.ok(prepare.run?.includes(text), text);
    assert.equal(
      upload.if,
      "${{ success() && inputs.official_hermes_phase == 'personal-candidate' }}",
    );
    assert.equal(upload.with?.["if-no-files-found"], "error");
    assert.ok(
      String(upload.with?.path).includes(
        "official-hermes-personal/official-hermes-runtime-candidate/",
      ),
    );
    assert.ok(String(upload.with?.path).includes("official-hermes-personal/personal-mxc/"));
    assert.ok(String(upload.with?.path).includes("personal-native-inputs/"));
  }
  (() => {
    const finished = requiredJob(workflow, "windows-finished-installer");
    const restored = requiredStep(
      finished,
      "Verify and materialize exact same-run compatibility proof",
    );
    const bootstrap = requiredStep(
      finished,
      "Prepare pinned interpreters for the finished Hermes producer",
    );
    const produce = requiredStep(
      finished,
      "Produce and test Hermes with the same-run native binaries",
    );
    const admit = requiredStep(
      finished,
      "Admit the same-run Personal-passing complete Hermes candidate",
    );
    const assemble = requiredStep(
      finished,
      "Seal only Hermes with current-source native compatibility and precompiled workers",
    );
    let previous = -1;
    for (const step of [restored, bootstrap, produce, admit, assemble]) {
      assert.strictEqual(
        step.if,
        "${{ needs.windows-finished-request.outputs.agent == 'hermes' }}",
      );
      assert.strictEqual(step["continue-on-error"], undefined);
      const index = finished.steps!.indexOf(step);
      assert.ok(index > previous);
      previous = index;
    }
    assert.ok(bootstrap.run?.includes("test-official-runtime-export.ps1"));
    assert.strictEqual(produce.env?.GH_TOKEN, "${{ github.token }}");
    for (const expected of [
      "$env:GITHUB_SHA = $env:CANDIDATE_SHA",
      "$revision -cne $env:CANDIDATE_SHA",
      "--toolchain 1.95.0-aarch64-pc-windows-msvc",
      "probe-personal-candidate.ps1",
      '-ArtifactDirectory "$work\\personal-production"',
      '-BootstrapDirectory "$work\\personal-bootstrap"',
      '-NativeCompatibilityDirectory "$work\\native-proof\\bash-compat-evidence"',
      '-HelperDirectory "$work\\system-drive-helper"',
    ])
      assert.ok(produce.run?.includes(expected));
    assert.ok(admit.run?.includes('--same-run-personal-directory "$work\\personal-production"'));
    assert.ok(
      admit.run?.includes('--native-proof-directory "$work\\native-proof\\bash-compat-evidence"'),
    );
    assert.strictEqual(admit.env?.GH_TOKEN, undefined);
    const evidence = requiredStep(finished, "Stage only non-runnable finished build evidence");
    assert.strictEqual(evidence.if, "${{ always() }}");
    for (const expected of [
      "$work\\personal-production\\*.json",
      "$work\\personal-production\\personal-mxc\\*.log",
      "$work\\hermes-input\\mxc-native.log",
      "stage-windows-native-evidence.ps1",
    ])
      assert.ok(evidence.run?.includes(expected));
  })();
  (() => {
    const request = requiredJob(workflow, "windows-finished-request");
    const admission = requiredStep(request, "Admit an exact credential-free candidate build");
    assert.strictEqual(admission.id, "candidate_build");
    assert.strictEqual(
      admission.if,
      "${{ github.event_name == 'workflow_dispatch' && inputs.build_windows_native_candidate }}",
    );
    assert.strictEqual(admission["continue-on-error"], undefined);
    assert.strictEqual(admission.shell, "bash");
    assert.ok(
      matchesFields(workflow.on.workflow_dispatch.inputs.build_windows_native_candidate, {
        required: false,
        default: false,
        type: "boolean",
      }),
    );
    for (const field of [
      "request_kind",
      "candidate_repository",
      "candidate_sha",
      "base_sha",
      "pr_number",
      "workflow_sha",
      "agent",
      "product_version",
      "validation_scope",
      "build_allowed",
      "trusted_main",
      "exact_workflow",
      "exact_pr",
      "credential_authorized",
    ])
      assert.ok(request.outputs?.[field]?.includes(`steps.candidate_build.outputs.${field}`));
    assert.strictEqual(admission.env?.GH_TOKEN, "${{ github.token }}");
    for (const field of ["CANDIDATE_SHA", "BASE_SHA", "PR_NUMBER", "EXPECTED_WORKFLOW_SHA"])
      assert.ok(admission.env?.[field]?.startsWith("${{ inputs.finished_windows_"));
    for (const line of [
      "request_kind=candidate-build",
      "validation_scope=build-only",
      "build_allowed=true",
      "trusted_main=false",
      "exact_workflow=false",
      "credential_authorized=false",
    ])
      assert.ok(admission.run?.includes(`echo '${line}'`));
    for (const name of [
      "Resolve a credential-free diagnostic dispatch",
      "Authorize exact internal PR from the exact main controller",
    ])
      assert.ok(requiredStep(request, name).if?.includes("!inputs.build_windows_native_candidate"));
    assert.ok(
      requiredJob(workflow, "windows-finished-candidate-migration").if?.includes(
        "request_kind != 'candidate-build'",
      ),
    );
  })();
  for (const name of [
    "windows-finished-installer",
    "windows-finished-installed-startup",
    "windows-finished-runtime-qualification",
    "windows-finished-reviewed-installer",
    "windows-finished-candidate-migration",
    "windows-finished-trusted-qualification",
    "windows-compiled-application",
  ])
    assert.ok(requiredJob(workflow, name).if?.startsWith("${{ always() && !cancelled() && "));
  for (const scenario of [
    "windows-finished-request",
    "windows-compiled-application",
    "windows-finished-installer",
    "windows-finished-installed-startup",
    "windows-finished-candidate-migration",
    "windows-runtime-controls",
    "windows-runtime-preflight",
  ]) {
    ((prJobName) => {
      const request = requiredJob(workflow, "windows-finished-request");
      const compiled = requiredJob(workflow, "windows-compiled-application");
      const installer = requiredJob(workflow, "windows-finished-installer");
      const startup = requiredJob(workflow, "windows-finished-installed-startup");
      const prJob = requiredJob(workflow, prJobName);
      assert.deepStrictEqual(workflow.on.pull_request, {
        types: ["opened", "synchronize", "reopened"],
        paths: [
          ".github/actions/setup-reviewed-npm/**",
          ".github/workflows/windows-native-installer-v2.yaml",
          ".github/workflows/windows-native-installer-trusted.yaml",
          "bin/nemoclaw.js",
          "ci/reviewed-npm-audit.json",
          "packaging/windows/**",
          "scripts/checks/*windows-native*",
          "scripts/install-windows-native.ps1",
          "src/lib/onboard/runtime-provider/**",
          "test/automation/pull-requests/windows-native-installer-workflow.test.ts",
          "test/automation/pull-requests/windows-native-installer-bootstrap.test.ts",
          "test/automation/pull-requests/windows-native-installer-review.test.ts",
          "test/automation/pull-requests/windows-native-installer-process.test.ts",
          "test/automation/pull-requests/windows-native-installer-process.support.ts",
          "test/security/windows-native-*.test.ts",
          "test/support/windows-native-*.ts",
          "tools/windows-installer/**",
        ],
      });
      assert.ok(workflowSource?.includes("name: CI / Native Windows Installer Candidate v2"));
      assert.deepStrictEqual(workflow.permissions, { actions: "read", contents: "read" });
      assert.strictEqual(
        workflow.concurrency["cancel-in-progress"],
        "${{ github.event_name == 'pull_request' }}",
      );
      assert.ok(
        matchesFields(request.outputs, {
          candidate_repository: containingText("steps.pull_request.outputs"),
          candidate_sha: containingText("steps.pull_request.outputs"),
          credential_authorized: containingText("steps.pull_request.outputs"),
        }),
      );
      const prAdmission = requiredStep(
        request,
        "Admit the exact pull request head without credentials",
      );
      assert.ok(prAdmission.run?.includes("agent=openclaw"));
      assert.ok(prAdmission.run?.includes("validation_scope=startup-only"));
      assert.ok(prAdmission.run?.includes("credential_authorized=false"));
      assert.ok(jobNeeds(compiled)?.includes("windows-finished-request"));
      assert.ok(
        containsItems(jobNeeds(installer), [
          "windows-finished-request",
          "windows-compiled-application",
        ]),
      );
      assert.ok(
        containsItems(jobNeeds(startup), [
          "windows-finished-request",
          "windows-compiled-application",
          "windows-finished-installer",
        ]),
      );
      assert.ok(startup.if?.includes("request_kind == 'pull-request'"));
      assert.ok(startup.if?.includes("agent == 'openclaw'"));
      assert.ok(startup.if?.includes("validation_scope == 'startup-only'"));
      assert.ok(
        requiredStep(
          startup,
          "Exercise installed OpenClaw startup and owned cleanup without credentials",
        ).run?.includes("-ValidationScope startup-only"),
      );
      assert.ok(!JSON.stringify(prJob)?.includes("secrets."));
      assert.ok(prJob.environment === undefined);
      assert.ok(!workflowSource?.includes("secrets."));
    })(scenario);
  }
  (() => {
    const compiled = requiredJob(workflow, "windows-compiled-application");
    const runtime = requiredJob(workflow, "windows-runtime-controls");
    const preflight = requiredJob(workflow, "windows-runtime-preflight");
    assert.deepStrictEqual(jobNeeds(preflight), ["windows-finished-request"]);
    assert.deepStrictEqual(preflight.permissions, { contents: "read" });
    assert.strictEqual(preflight["runs-on"], "windows-11-vs2026-arm");
    assert.deepStrictEqual(preflight.strategy, {
      "fail-fast": false,
      matrix: { node: ["22.23.2", "24.18.1"] },
    });
    assert.strictEqual(
      preflight.if,
      "${{ needs.windows-finished-request.result == 'success' && (needs.windows-finished-request.outputs.build_allowed == 'true' || (github.event_name == 'workflow_dispatch' && (inputs.test_native_windows_runtime || (inputs.probe_official_hermes_components && inputs.official_hermes_phase == 'application')))) }}",
    );
    const checkout = requiredStep(preflight, "Check out the exact candidate preflight");
    assert.deepStrictEqual(checkout.with, {
      repository: "${{ needs.windows-finished-request.outputs.candidate_repository }}",
      ref: "${{ needs.windows-finished-request.outputs.candidate_sha }}",
      "persist-credentials": false,
    });
    const preflightNode = requiredStep(preflight, "Set up pinned ARM64 preflight Node");
    assert.deepStrictEqual(preflightNode.with, {
      "node-version": "${{ matrix.node }}",
      architecture: "arm64",
    });
    const preflightTests = requiredStep(
      preflight,
      "Verify observer shutdown and qualification cleanup before building",
    );
    assert.strictEqual(preflightTests.if, undefined);
    assert.strictEqual(preflightTests["continue-on-error"], undefined);
    for (const name of [
      "control-installed-openclaw-input.test.mts",
      "build-immutable-package-cleanup.test.mts",
      "qualify-installed-openclaw.test.mts",
      "review-hermes-availability.test.mts",
      "native-turn-cleanup.test.mts",
      "native-hermes-turn-cleanup.test.mts",
      "runtime-published-resources.test.mts",
    ])
      assert.ok(preflightTests.run?.includes(name));
    assert.ok(preflight.steps!.indexOf(checkout) < preflight.steps!.indexOf(preflightNode));
    assert.ok(preflight.steps!.indexOf(preflightNode) < preflight.steps!.indexOf(preflightTests));
    assert.ok(preflightTests.run?.includes("$identity.version -cne $env:PREFLIGHT_NODE_VERSION"));
    assert.ok(preflightTests.run?.includes("if ($result -ne 0) { throw"));
    assert.ok(jobNeeds(compiled).includes("windows-runtime-preflight"));
    assert.ok(compiled.if?.includes("needs.windows-runtime-preflight.result == 'success'"));
    assert.deepStrictEqual(jobNeeds(runtime), ["windows-runtime-preflight"]);
    assert.strictEqual(
      runtime.if,
      "${{ github.event_name == 'pull_request' || (github.event_name == 'workflow_dispatch' && !inputs.run_windows_native_installer && inputs.test_native_windows_runtime) }}",
    );
    const preflightUpload = requiredStep(
      preflight,
      "Retain preflight results for each Node version",
    );
    assert.strictEqual(preflightUpload.if, "always()");
    assert.ok(String(preflightUpload.with?.name).includes("${{ matrix.node }}"));
    assert.ok(
      String(preflightUpload.with?.name).includes(
        "${{ needs.windows-finished-request.outputs.candidate_sha }}",
      ),
    );
    const compiledController = requiredStep(
      compiled,
      "Verify installed acceptance controller Windows compatibility",
    );
    const runtimeController = requiredStep(
      runtime,
      "Exercise installed acceptance controller compatibility",
    );
    const runtimeNode = requiredStep(
      runtime,
      "Set up actual ARM64 Node for controller preflight and shared-file fixtures",
    );
    const runtimeRust = requiredStep(
      runtime,
      "Set up pinned Rust for the native ownership controls",
    );
    const requiredControllerTest = "control-installed-openclaw-input.test.mts";
    assert.ok(compiledController.run?.includes(requiredControllerTest));
    assert.ok(compiledController.run?.includes("qualify-installed-openclaw.test.mts"));
    assert.ok(
      compiled.steps!.indexOf(compiledController) <
        compiled.steps!.findIndex(
          (step) => step.name === "Restore immutable application build inputs",
        ),
    );
    assert.strictEqual(runtimeNode.with?.["node-version"], "24.18.1");
    assert.ok(runtimeController.run?.includes(requiredControllerTest));
    assert.ok(runtime.steps!.indexOf(runtimeController) < runtime.steps!.indexOf(runtimeRust));
  })();
  (() => {
    const native = requiredJob(workflow, "windows-bash-compatibility-reuse");
    assert.deepStrictEqual(jobNeeds(native), ["windows-finished-request"]);
    assert.strictEqual(native["runs-on"], "windows-11-vs2026-arm");
    assert.strictEqual(native["timeout-minutes"], 25);
    assert.deepStrictEqual(native.permissions, { contents: "read" });
    assert.strictEqual(native.environment, undefined);
    assert.strictEqual(
      native.if,
      "${{ needs.windows-finished-request.outputs.build_allowed == 'true' && needs.windows-finished-request.outputs.agent == 'hermes' }}",
    );
    const checkout = requiredStep(native, "Check out current Bash qualification inputs");
    assert.deepStrictEqual(checkout.with, {
      repository: "${{ needs.windows-finished-request.outputs.candidate_repository }}",
      ref: "${{ needs.windows-finished-request.outputs.candidate_sha }}",
      path: "current",
      "persist-credentials": false,
    });
    const identity = requiredStep(native, "Verify exact native producer source");
    const helper = requiredStep(
      native,
      "Build the existing fixed-purpose system-drive metadata helper",
    );
    const produce = requiredStep(native, "Build and qualify exact current native compatibility");
    const seal = requiredStep(native, "Seal same-run exact-input Bash evidence");
    let previous = -1;
    for (const step of [checkout, identity, helper, produce, seal]) {
      assert.strictEqual(step.if, undefined);
      assert.strictEqual(step["continue-on-error"], undefined);
      const index = native.steps!.indexOf(step);
      assert.ok(index > previous);
      previous = index;
    }
    for (const step of [identity, helper, produce, seal]) {
      assert.strictEqual(
        step.env?.CANDIDATE_SHA,
        "${{ needs.windows-finished-request.outputs.candidate_sha }}",
      );
    }
    assert.ok(identity.run?.includes("$revision -cne $env:CANDIDATE_SHA"));
    assert.ok(helper.run?.includes("current/packaging/windows/host-preparation/build-helper.ps1"));
    assert.ok(produce.run?.includes("$env:GITHUB_SHA = $env:CANDIDATE_SHA"));
    assert.ok(produce.run?.includes("current/packaging/windows/mxc-bash/run-bash-compat.ps1"));
    assert.ok(produce.run?.includes('-SourceRoot "$env:GITHUB_WORKSPACE\\current"'));
    for (const predicate of [
      "$proof.schemaVersion -ne 2",
      "$proof.classification -cne 'small-msys-native-basecontainer-compatibility-proof'",
      "$proof.sourceRevision -cne $env:CANDIDATE_SHA",
      "$proof.passed -cne $true",
      "$proof.normalCleanup -cne $true",
      "$runner.sourceRevision -cne $env:CANDIDATE_SHA",
      "$runner.status -cne 'pass'",
      "$runner.cleanup.workRootRemoved -cne $true",
      "$runner.cleanup.workRetainedForUnconfirmedExecutor -cne $false",
      "native-proof/bash-compat-evidence",
      "windows-finished-bash-v2-$env:GITHUB_RUN_ID-$env:GITHUB_RUN_ATTEMPT-$env:CANDIDATE_SHA-hermes",
    ])
      assert.ok(seal.run?.includes(predicate));
    assert.ok(!JSON.stringify(native).includes("reuse-qualified-proof.py"));
    assert.ok(!native.steps?.some((step) => step.uses?.startsWith("actions/download-artifact@")));
    const records = requiredStep(
      native,
      "Preserve current native Bash diagnostic records without executables",
    );
    assert.strictEqual(records.if, "always()");
    const included = String(records.with?.path)
      .split("\n")
      .filter((line) => line && !line.startsWith("!"));
    assert.deepStrictEqual(included, [
      "${{ runner.temp }}/finished-bash-evidence/**/*.json",
      "${{ runner.temp }}/finished-bash-evidence/**/*.log",
    ]);
  })();
  for (const scenario of [
    {
      caseName: "compiled application save and installer compiled-unit restore",
      saveJobName: "windows-compiled-application",
      restoreJobName: "windows-finished-installer",
      restoreStepName: "Restore exact compiled units from the same-run cache",
    },
    {
      caseName: "installer save and installer compatibility restore",
      saveJobName: "windows-finished-installer",
      restoreJobName: "windows-finished-installer",
      restoreStepName: "Restore the exact same-run compatibility component and proof",
    },
    {
      caseName: "compatibility save and startup installer restore",
      saveJobName: "windows-bash-compatibility-reuse",
      restoreJobName: "windows-finished-installed-startup",
      restoreStepName: "Restore exact same-run installer cache",
    },
    {
      caseName: "compiled application save and nested startup application restore",
      saveJobName: "windows-compiled-application",
      restoreJobName: "windows-finished-installed-startup",
      restoreStepName: "Restore exact same-run installer cache",
    },
  ]) {
    (({ saveJobName, restoreJobName, restoreStepName }) => {
      const compiled = requiredJob(workflow, "windows-compiled-application");
      const installer = requiredJob(workflow, "windows-finished-installer");
      const bashReuse = requiredJob(workflow, "windows-bash-compatibility-reuse");
      const saveJob = requiredJob(workflow, saveJobName);
      const restoreJob = requiredJob(workflow, restoreJobName);
      assert.deepStrictEqual(compiled.outputs, {
        application_cache_key: "${{ steps.transfer_manifest.outputs.cache_key }}",
        application_manifest_sha256: "${{ steps.transfer_manifest.outputs.manifest_sha256 }}",
      });
      assert.deepStrictEqual(installer.outputs, {
        installer_cache_key: "${{ steps.product_manifest.outputs.cache_key }}",
        installer_manifest_sha256: "${{ steps.product_manifest.outputs.manifest_sha256 }}",
      });
      assert.deepStrictEqual(bashReuse.outputs, {
        compatibility_cache_key: "${{ steps.compatibility_manifest.outputs.cache_key }}",
        compatibility_manifest_sha256:
          "${{ steps.compatibility_manifest.outputs.manifest_sha256 }}",
      });
      const saves = saveJob.steps?.filter((step) => step.uses?.startsWith("actions/cache/save@"));
      assert.strictEqual(saves?.length, 1);
      assert.ok(!Object.hasOwn(saves?.[0].with ?? {}, "restore-keys"));
      const restores = restoreJob.steps?.filter((step) =>
        step.uses?.startsWith("actions/cache/restore@"),
      );
      assert.strictEqual(
        restores?.length,
        restoreJobName === "windows-finished-installed-startup" ? 1 : 2,
      );
      const restore = requiredStep(restoreJob, restoreStepName);
      assert.ok(typeof restore.uses === "string");
      assert.match(restore.uses, /^actions\/cache\/restore@/u);
      assert.strictEqual(restore.with?.["fail-on-cache-miss"], true);
      assert.ok(!Object.hasOwn(restore.with ?? {}, "restore-keys"));
      assert.ok(JSON.stringify(restoreJob)?.includes("windows-native-transfer.ps1"));
      assert.ok(JSON.stringify(restoreJob)?.includes("ExpectedManifestSha256"));
      assert.ok(
        requiredStep(
          installer,
          "Seal the installer for same-run private qualification",
        ).run?.includes('-Destination "$transfer\\compiled-application" -Recurse'),
      );
      const startupInputs = requiredStep(
        requiredJob(workflow, "windows-finished-installed-startup"),
        "Verify and materialize exact same-run startup inputs",
      ).run;
      const trustedInputs = requiredStep(
        requiredJob(trusted, "full-installed-acceptance"),
        "Verify and materialize exact qualified inputs",
      ).run;
      assert.ok(startupInputs?.includes('$application = "$product\\compiled-application"'));
      assert.ok(startupInputs?.includes("-Root $application"));
      assert.ok(startupInputs?.includes("-ExpectedManifestSha256 $env:APPLICATION_MANIFEST"));
      assert.ok(trustedInputs?.includes('$application = "$product\\compiled-application"'));
      assert.ok(trustedInputs?.includes("-Root $application"));
      assert.ok(trustedInputs?.includes("-ExpectedManifestSha256 $env:APPLICATION_MANIFEST"));
      const compiledUploadPaths = (compiled.steps ?? [])
        .filter((step) => step.uses?.startsWith("actions/upload-artifact@"))
        .map((step) => String(step.with?.path ?? ""))
        .join("\n");
      assert.doesNotMatch(compiledUploadPaths, /\.exe|\.msi/u);
      assert.ok(!JSON.stringify(installer)?.includes("finished-windows-preview-${{"));
      assert.ok(!JSON.stringify(installer)?.includes("package/*.exe"));
      assert.ok(!JSON.stringify(installer)?.includes("package/*.msi"));
      assert.ok(!workflowSource?.includes("migration_inputs_id"));
      assert.ok(!workflowSource?.includes("application_id"));
      assert.ok(!workflowSource?.includes("runtime_id"));
      assert.ok(transferSource?.includes("same-run-private-executable-transfer"));
      assert.ok(transferSource?.includes("workflowRunId"));
      assert.ok(transferSource?.includes("workflowRunAttempt"));
      assert.ok(transferSource?.includes("ReparsePoint"));
      assert.ok(transferSource?.includes("A transfer cache entry differs from its manifest."));
      const transferWorkflows = `${workflowSource}\n${trustedSource}`;
      assert.strictEqual(
        transferWorkflows.match(/^.*windows-native-transfer\.ps1.*$/gmu)?.length,
        16,
      );
      assert.strictEqual(
        transferWorkflows.match(/^.*= @\(& .*windows-native-transfer\.ps1.*$/gmu)?.length,
        16,
      );
      assert.doesNotMatch(transferWorkflows, /\$LASTEXITCODE[^\n]*transfer/iu);
      const evidenceRun =
        requiredStep(compiled, "Stage only non-runnable application diagnostics").run ?? "";
      assert.ok(
        evidenceRun?.includes("$work\\controls\\compiled-openclaw\\compiled-controls.json"),
      );
      for (const directory of ["first-run-consent-control", "gateway-control"]) {
        for (const file of ["gateway-control.json", "stdout.log", "stderr.log"]) {
          assert.ok(evidenceRun.includes(`"$work\\${directory}\\${file}"`));
        }
        assert.ok(!evidenceRun.includes(`"$work\\${directory}",`));
      }
      assert.ok(evidenceRun?.includes("$work\\build\\diagnostics\\local-model-tools\\result.json"));
      assert.ok(evidenceRun?.includes("$choiceRoot\\result.json"));
      assert.ok(!evidenceRun?.includes('"$work\\controls",'));
      assert.ok(!evidenceRun?.includes('"$work\\build\\diagnostics",'));
    })(scenario);
  }
  for (const agent of ["openclaw", "hermes"] as const) {
    const installer = requiredJob(workflow, "windows-finished-installer");
    const displayName = agent === "hermes" ? "Hermes" : "OpenClaw";
    const previewId = agent === "hermes" ? "unqualified_hermes_preview" : "unqualified_preview";
    const verify = requiredStep(
      installer,
      `Verify and label the unqualified ${displayName} preview`,
    );
    const upload = requiredStep(
      installer,
      `Publish the unqualified ${displayName} preview download`,
    );
    assert.strictEqual(verify.id, previewId);
    assert.strictEqual(
      verify.if,
      agent === "hermes"
        ? "${{ success() && github.event_name == 'workflow_dispatch' && inputs.build_windows_native_candidate && needs.windows-finished-request.outputs.request_kind == 'candidate-build' && needs.windows-finished-request.outputs.candidate_repository == github.repository && needs.windows-finished-request.outputs.agent == 'hermes' && needs.windows-finished-request.outputs.validation_scope == 'build-only' && needs.windows-finished-request.outputs.credential_authorized == 'false' }}"
        : "${{ success() && github.event_name == 'pull_request' && needs.windows-finished-request.outputs.request_kind == 'pull-request' && needs.windows-finished-request.outputs.candidate_repository == github.repository && needs.windows-finished-request.outputs.agent == 'openclaw' && needs.windows-finished-request.outputs.credential_authorized == 'false' }}",
    );
    assert.strictEqual(verify.shell, "pwsh");
    assert.strictEqual(verify["continue-on-error"], undefined);
    assert.deepStrictEqual(verify.env, {
      INSTALLER_MANIFEST: "${{ steps.product_manifest.outputs.manifest_sha256 }}",
    });
    for (const fragment of [
      'windows-native-transfer.ps1" -Mode Verify',
      `-Kind finished-installer -SourceRevision $env:CANDIDATE_SHA -Agent ${agent}`,
      "-RunId $env:GITHUB_RUN_ID -RunAttempt $env:GITHUB_RUN_ATTEMPT",
      "-ExpectedManifestSha256 $env:INSTALLER_MANIFEST",
      "-ExpectedPackageRunnables @($expectedMsi, $expectedSetup)",
      "$verifiedManifest.Count -ne 1",
      "[string]$verifiedManifest[0] -cne $env:INSTALLER_MANIFEST",
      `classification = 'unqualified-${agent}-installer-preview'`,
      `agent = '${agent}'`,
      "installedAcceptance = $false",
      "windowsQualified = $false",
      "release = $false",
    ])
      assert.ok(verify.run?.includes(fragment));
    assert.strictEqual(upload.if, `\${{ success() && steps.${previewId}.outcome == 'success' }}`);
    assert.strictEqual(upload["continue-on-error"], undefined);
    assert.strictEqual(
      upload.uses,
      "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    );
    assert.deepStrictEqual(upload.with, {
      name: `unqualified-${agent}-preview-\${{ needs.windows-finished-request.outputs.candidate_sha }}-\${{ github.run_id }}-\${{ github.run_attempt }}`,
      path: [
        "${{ runner.temp }}/finished-windows-product-transfer/package/NemoClawSetup-${{ needs.windows-finished-request.outputs.product_version }}-windows-arm64.exe",
        ...(agent === "hermes"
          ? [
              "${{ runner.temp }}/finished-windows-product-transfer/package/NemoClaw-${{ needs.windows-finished-request.outputs.product_version }}-windows-arm64.msi",
            ]
          : []),
        "${{ runner.temp }}/finished-windows-product-transfer/package/immutable-package-build.json",
        "${{ runner.temp }}/finished-windows-product-transfer/package/compiled-msi.json",
        "${{ runner.temp }}/finished-windows-product-transfer/assembled/runtime-identity.json",
        "${{ runner.temp }}/finished-windows-product-transfer/transfer-manifest.json",
        `\${{ runner.temp }}/unqualified-${agent}-preview.json`,
        "",
      ].join("\n"),
      "if-no-files-found": "error",
      "retention-days": 14,
    });
    const seal = requiredStep(installer, "Seal the installer for same-run private qualification");
    assert.ok(installer.steps!.indexOf(seal) < installer.steps!.indexOf(verify));
    assert.ok(installer.steps!.indexOf(verify) < installer.steps!.indexOf(upload));
  }
  for (const scenario of [
    {
      caseName: "candidate workflow authorization",
      sourceWorkflow: workflow,
      jobName: "windows-finished-request",
      stepName: "Authorize exact internal PR from the exact main controller",
    },
    {
      caseName: "trusted workflow authorization",
      sourceWorkflow: trusted,
      jobName: "authorize",
      stepName: "Require current main controller and exact internal PR identity",
    },
  ]) {
    (({ sourceWorkflow, jobName, stepName }) => {
      const request = requiredJob(workflow, "windows-finished-request");
      const authorize = requiredStep(
        request,
        "Authorize exact internal PR from the exact main controller",
      );
      const trustedAuthorize = requiredJob(trusted, "authorize");
      const trustedAuthorization = requiredStep(
        trustedAuthorize,
        "Require current main controller and exact internal PR identity",
      );
      const authorization = requiredStep(requiredJob(sourceWorkflow, jobName), stepName);
      assert.ok(authorization.run?.includes("NVIDIA/NemoClaw"));
      assert.ok(authorization.run?.includes(".base.ref"));
      assert.ok(authorization.run?.includes("'main'"));
      assert.ok(authorization.run?.includes(".base.sha"));
      assert.ok(authorization.run?.includes(".head.sha"));
      assert.ok(authorization.run?.includes(".head.repo.owner.login"));
      assert.ok(authorization.run?.includes(".head.repo.owner.type"));
      assert.ok(authorization.run?.includes("Organization"));
      assert.ok(authorization.run?.includes("$ACTOR"));
      assert.ok(authorization.run?.includes("$TRIGGERING_ACTOR"));
      assert.ok(authorization.run?.includes("admin|maintain|write"));
      assert.ok(authorize.run?.includes("$EVENT_WORKFLOW_SHA"));
      assert.ok(authorize.run?.includes('"$BASE_SHA" == "$EXPECTED_WORKFLOW_SHA"'));
      assert.ok(authorize.run?.includes("compare/$EXPECTED_WORKFLOW_SHA...$CANDIDATE_SHA"));
      assert.ok(authorize.run?.includes(".merge_base_commit.sha"));
      assert.ok(authorize.run?.includes(".behind_by"));
      assert.ok(trustedAuthorization.run?.includes("git/ref/heads/main"));
      assert.ok(trustedAuthorization.run?.includes('"$BASE_SHA" == "$WORKFLOW_SHA"'));
      assert.ok(trustedAuthorization.run?.includes("compare/$WORKFLOW_SHA...$CANDIDATE_SHA"));
      assert.ok(trustedAuthorization.run?.includes(".merge_base_commit.sha"));
      assert.ok(trustedAuthorization.run?.includes(".behind_by"));
      assert.deepStrictEqual(trustedAuthorize.outputs, {
        trusted_main: "${{ steps.authorization.outputs.trusted_main }}",
        exact_workflow: "${{ steps.authorization.outputs.exact_workflow }}",
        exact_pr: "${{ steps.authorization.outputs.exact_pr }}",
        credential_authorized: "${{ steps.authorization.outputs.credential_authorized }}",
      });
    })(scenario);
  }
  (() => {
    const call = requiredJob(workflow, "windows-finished-trusted-qualification");
    const full = requiredJob(trusted, "full-installed-acceptance");
    const protectedEvidence = requiredStep(
      full,
      "Stage only non-runnable full acceptance evidence",
    );
    assert.deepStrictEqual(protectedEvidence.env, {
      NVIDIA_API_KEY: "${{ secrets.WINDOWS_NATIVE_INSTALLER_NVIDIA_API_KEY }}",
      NVIDIA_INFERENCE_API_KEY: "${{ secrets.WINDOWS_NATIVE_INSTALLER_NVIDIA_INFERENCE_API_KEY }}",
    });
    assert.ok(protectedEvidence.run?.includes("-RequireProtectedCredential"));
    assert.strictEqual(
      requiredStep(full, "Preserve full installed acceptance evidence").if,
      "${{ always() && steps.full_evidence.outcome == 'success' }}",
    );
    const publication = requiredJob(trusted, "publish-qualified-installer");
    const legacy = requiredJob(workflow, "windows-native-package-diagnostic");
    const secretJobs = Object.entries(trusted.jobs)
      .filter(([, job]) => JSON.stringify(job).includes("secrets."))
      .map(([name]) => name)
      .sort();
    assert.strictEqual(call.uses, "./.github/workflows/windows-native-installer-trusted.yaml");
    assert.ok(call.if?.includes("github.ref == 'refs/heads/main'"));
    assert.ok(call.if?.includes("trusted_main == 'true'"));
    assert.ok(call.if?.includes("exact_workflow == 'true'"));
    assert.ok(call.if?.includes("exact_pr == 'true'"));
    assert.ok(call.if?.includes("credential_authorized == 'true'"));
    assert.ok(Object.hasOwn(trusted.on ?? {}, "workflow_call"));
    assert.ok(!Object.hasOwn((trusted.on as Record<string, unknown>) ?? {}, "workflow_dispatch"));
    assert.strictEqual(full.environment, "windows-native-installer-qualification");
    assert.strictEqual(publication.environment, "windows-native-installer-publication");
    assert.deepStrictEqual(secretJobs, [
      "full-installed-acceptance",
      "publish-qualified-installer",
      "review-runtime-availability",
    ]);
    const bootstrap = requiredJob(workflow, "windows-finished-runtime-qualification");
    const rebuilt = requiredJob(workflow, "windows-finished-reviewed-installer");
    const initial = requiredJob(workflow, "windows-finished-installer");
    const image = requiredStep(
      initial,
      "Build the selected runtime as one finished application image",
    );
    assert.strictEqual(image.if, undefined);
    assert.ok(image.run?.includes("build-finished-runtime-image.ps1"));
    assert.ok(
      image.run?.includes('-RuntimeRoot "$work\\assembled\\runtimes\\$($identity.runtimeId)"'),
    );
    const initialBuild = requiredStep(
      initial,
      "Build the finished WPF, guarded launcher, transactional MSI and Burn preview",
    );
    assert.ok(
      initialBuild.run?.includes(
        'RuntimeImage = "$work\\runtime-image\\$($identity.runtimeId).vhdx"',
      ),
    );
    assert.ok(
      initialBuild.run?.includes(
        'RuntimeImageReceipt = "$work\\runtime-image\\runtime-image.json"',
      ),
    );
    assert.ok(initialBuild.run?.includes("@imageArguments"));
    assert.ok(!initialBuild.run?.includes("$env:SELECTED_AGENT -ceq 'hermes'"));
    assert.strictEqual(bootstrap.uses, call.uses);
    assert.deepStrictEqual(jobNeeds(bootstrap), [
      "windows-finished-request",
      "windows-finished-installer",
      "windows-compiled-application",
    ]);
    assert.strictEqual(bootstrap.with?.qualification_phase, "runtime-bootstrap");
    assert.strictEqual(
      bootstrap.with?.agent,
      "${{ needs.windows-finished-request.outputs.agent }}",
    );
    assert.strictEqual(bootstrap.with?.candidate_migration_evidence_id, undefined);
    assert.strictEqual(bootstrap.with?.candidate_migration_proof_sha256, undefined);
    assert.strictEqual(call.with?.qualification_phase, "final");
    for (const gate of [
      "github.event_name == 'workflow_dispatch'",
      "github.ref == 'refs/heads/main'",
      'contains(fromJSON(\'["openclaw","hermes"]\'), needs.windows-finished-request.outputs.agent)',
      "trusted_main == 'true'",
      "exact_workflow == 'true'",
      "exact_pr == 'true'",
      "credential_authorized == 'true'",
      "validation_scope == 'full-acceptance'",
      "needs.windows-finished-installer.result == 'success'",
      "needs.windows-compiled-application.result == 'success'",
    ])
      assert.ok(bootstrap.if?.includes(gate), "Missing bootstrap gate: " + gate);
    assert.ok(!bootstrap.if?.includes("||"));
    assert.deepStrictEqual(jobNeeds(rebuilt), [
      "windows-finished-request",
      "windows-finished-installer",
      "windows-finished-runtime-qualification",
    ]);
    assert.strictEqual(
      rebuilt.if,
      "${{ always() && !cancelled() && github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && needs.windows-finished-request.result == 'success' && contains(fromJSON('[\"openclaw\",\"hermes\"]'), needs.windows-finished-request.outputs.agent) && needs.windows-finished-installer.result == 'success' && needs.windows-finished-runtime-qualification.result == 'success' }}",
    );
    assert.strictEqual(rebuilt.environment, undefined);
    assert.strictEqual(
      rebuilt.env?.SELECTED_AGENT,
      "${{ needs.windows-finished-request.outputs.agent }}",
    );
    assert.ok(!JSON.stringify(rebuilt).includes("secrets."));
    assert.deepStrictEqual(rebuilt.permissions, { actions: "read", contents: "read" });
    assert.deepStrictEqual(
      requiredStep(rebuilt, "Download independently reviewed runtime availability").with,
      {
        "artifact-ids":
          "${{ needs.windows-finished-runtime-qualification.outputs.availability_id }}",
        path: "${{ runner.temp }}/reviewed-runtime-availability",
        "merge-multiple": true,
      },
    );
    const rebuildInputs = requiredStep(
      rebuilt,
      "Verify original package and exact reviewed decision before executable use",
    );
    assert.deepStrictEqual(rebuildInputs.env, {
      INSTALLER_MANIFEST:
        "${{ needs.windows-finished-installer.outputs.installer_manifest_sha256 }}",
      AVAILABILITY_SHA256:
        "${{ needs.windows-finished-runtime-qualification.outputs.availability_sha256 }}",
    });
    for (const token of [
      "-ExpectedManifestSha256 $env:INSTALLER_MANIFEST",
      "-Kind finished-installer -SourceRevision $env:CANDIDATE_SHA -Agent $env:SELECTED_AGENT",
      "$verified.Count -ne 1",
      "$decision.Attributes -band [IO.FileAttributes]::ReparsePoint",
      "$decision.Length -gt 65536",
      "-cne $env:AVAILABILITY_SHA256",
      "$env:GITHUB_WORKSPACE\\controller\\scripts\\checks\\windows-native-transfer.ps1",
    ])
      assert.ok(
        rebuildInputs.run?.includes(token),
        "Missing reviewed packaging input check: " + token,
      );
    const rebuild = requiredStep(
      rebuilt,
      "Rebuild native UI MSI and Burn without rebuilding the qualified runtime",
    );
    for (const token of [
      "-UnqualifiedPackageDirectory",
      "-ReviewedAvailability",
      "-SystemDriveProofDirectory",
      "build-immutable-package.ps1",
      "migration-inputs.json",
    ])
      assert.ok(rebuild.run?.includes(token));
    const seal = requiredStep(
      rebuilt,
      "Seal the rebuilt installer under a distinct same-run identity",
    );
    assert.ok(
      seal.run?.includes(
        "windows-finished-reviewed-installer-v1-$env:GITHUB_RUN_ID-$env:GITHUB_RUN_ATTEMPT-$env:CANDIDATE_SHA-$env:SELECTED_AGENT",
      ),
    );
    assert.ok(seal.run?.includes("$manifest.Count -ne 1"));
    const productCachePath = "${{ runner.temp }}/finished-windows-product-transfer";
    assert.strictEqual(
      requiredStep(rebuilt, "Retain rebuilt executables only in the same-run private cache").with
        ?.path,
      productCachePath,
    );
    for (const job of [
      requiredJob(workflow, "windows-finished-candidate-migration"),
      requiredJob(trusted, "full-installed-acceptance"),
      requiredJob(trusted, "migration"),
      requiredJob(trusted, "publish-qualified-installer"),
    ]) {
      const restores =
        job.steps?.filter((step) => step.uses?.startsWith("actions/cache/restore@")) ?? [];
      assert.strictEqual(restores.length, 1);
      assert.strictEqual(restores[0].with?.path, productCachePath);
    }
    for (const token of [
      "Move-Item -LiteralPath $product -Destination $original",
      "Move-Item -LiteralPath $transfer -Destination $product",
      "StartsWith($cacheRoot, [StringComparison]::OrdinalIgnoreCase)",
    ])
      assert.ok(seal.run?.includes(token));
    assert.ok(
      seal.run?.includes(
        "-Kind finished-installer -SourceRevision $env:CANDIDATE_SHA -Agent $env:SELECTED_AGENT",
      ),
    );
    assert.ok(
      (rebuilt.steps ?? []).indexOf(rebuildInputs) < (rebuilt.steps ?? []).indexOf(rebuild),
    );
    for (const name of ["installer_cache_key", "installer_manifest_sha256"]) {
      const selected = `\${{ needs.windows-finished-reviewed-installer.outputs.${name} }}`;
      assert.strictEqual(call.with?.[name], selected);
      if (name === "installer_manifest_sha256")
        assert.strictEqual(
          requiredJob(workflow, "windows-finished-candidate-migration").env?.INSTALLER_MANIFEST,
          selected,
        );
    }
    assert.ok(jobNeeds(call).includes("windows-finished-reviewed-installer"));
    const review = requiredJob(trusted, "review-runtime-availability");
    assert.deepStrictEqual(jobNeeds(review), ["authorize", "full-installed-acceptance"]);
    assert.strictEqual(review.environment, "windows-native-installer-availability");
    assert.strictEqual(
      review.if,
      "${{ inputs.qualification_phase == 'runtime-bootstrap' && contains(fromJSON('[\"openclaw\",\"hermes\"]'), inputs.agent) && needs.authorize.outputs.credential_authorized == 'true' && needs.full-installed-acceptance.result == 'success' }}",
    );
    assert.deepStrictEqual(
      [...JSON.stringify(review).matchAll(/secrets\.([A-Z_]+)/gu)].map((match) => match[1]),
      ["WINDOWS_NATIVE_INSTALLER_AVAILABILITY_READY"],
    );
    const reviewReady = requiredStep(
      review,
      "Require independently reviewed availability environment",
    );
    assert.ok(reviewReady.run?.includes("[[ \"$ENVIRONMENT_READY\" == 'reviewed-main-v1' ]]"));
    const reviewCheckout = requiredStep(review, "Check out exact trusted availability controller");
    assert.deepStrictEqual(reviewCheckout.with, {
      repository: "NVIDIA/NemoClaw",
      ref: "${{ inputs.workflow_sha }}",
      "persist-credentials": false,
    });
    assert.deepStrictEqual(requiredStep(review, "Prepare pinned review Node").with, {
      "node-version": "22.23.2",
    });
    assert.deepStrictEqual(
      requiredStep(review, "Download this controller's completed runtime evidence").with,
      {
        "artifact-ids": "${{ needs.full-installed-acceptance.outputs.evidence_id }}",
        path: "${{ runner.temp }}/runtime-availability-evidence",
        "merge-multiple": true,
      },
    );
    assert.deepStrictEqual(full.outputs, {
      evidence_id: "${{ steps.full_artifact.outputs.artifact-id }}",
      evidence_manifest_sha256: "${{ steps.full_evidence.outputs.manifest_sha256 }}",
    });
    assert.strictEqual(
      requiredStep(full, "Preserve full installed acceptance evidence").id,
      "full_artifact",
    );
    assert.ok(
      protectedEvidence.run?.includes(
        'finished-windows-full-evidence\\evidence-manifest.json" -Algorithm SHA256',
      ),
    );
    const decision = requiredStep(
      review,
      "Bind reviewed availability to exact successful runtime evidence",
    );
    assert.deepStrictEqual(decision.env, {
      EVIDENCE_SHA256: "${{ needs.full-installed-acceptance.outputs.evidence_manifest_sha256 }}",
      CANDIDATE_SHA: "${{ inputs.candidate_sha }}",
      CONTROLLER_SHA: "${{ inputs.workflow_sha }}",
      SELECTED_AGENT: "${{ inputs.agent }}",
    });
    for (const token of [
      '[[ "$(git rev-parse HEAD)" == "$CONTROLLER_SHA" ]]',
      'case "$SELECTED_AGENT" in',
      "controls=packaging/windows/installer/qualify-installed-openclaw.test.mts",
      "reviewer=packaging/windows/installer/review-openclaw-availability.mts",
      "controls=packaging/windows/installer/review-hermes-availability.test.mts",
      "reviewer=packaging/windows/installer/review-hermes-availability.mts",
      "*) echo 'Unsupported runtime availability agent.' >&2; exit 1 ;;",
      'node --experimental-strip-types --no-warnings --test "$controls"',
      'node --experimental-strip-types --no-warnings "$reviewer"',
      '--evidence-manifest-sha256 "$EVIDENCE_SHA256"',
      '--source-revision "$CANDIDATE_SHA"',
      '--controller-source-revision "$CONTROLLER_SHA"',
      '--controller-run "$GITHUB_RUN_ID:$GITHUB_RUN_ATTEMPT"',
    ])
      assert.ok(decision.run?.includes(token), "Missing reviewed evidence binding: " + token);
    assert.strictEqual(
      requiredStep(review, "Preserve reviewed availability decision only").with?.path,
      "${{ runner.temp }}/reviewed-availability.json",
    );
    assert.strictEqual(
      requiredStep(review, "Preserve reviewed availability decision only").with?.name,
      "reviewed-${{ inputs.agent }}-availability-${{ inputs.candidate_sha }}-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    for (const reviewStep of review.steps ?? []) {
      assert.strictEqual(reviewStep.if, undefined);
      assert.strictEqual(reviewStep["continue-on-error"], undefined);
    }
    assert.strictEqual(
      requiredJob(trusted, "candidate-migration-proof").if,
      "${{ inputs.qualification_phase == 'final' }}",
    );
    assert.strictEqual(
      full.if,
      "${{ always() && !cancelled() && needs.authorize.result == 'success' && needs.authorize.outputs.trusted_main == 'true' && needs.authorize.outputs.exact_workflow == 'true' && needs.authorize.outputs.exact_pr == 'true' && needs.authorize.outputs.credential_authorized == 'true' && ((inputs.qualification_phase == 'runtime-bootstrap' && contains(fromJSON('[\"openclaw\",\"hermes\"]'), inputs.agent)) || (inputs.qualification_phase == 'final' && needs.candidate-migration-proof.result == 'success')) }}",
    );
    for (const job of [requiredJob(trusted, "migration"), publication]) {
      assert.ok(job.if?.startsWith("${{ inputs.qualification_phase == 'final' && "));
      assert.ok(!job.if?.includes("||"));
    }
    const verifyInputs = requiredStep(full, "Verify and materialize exact qualified inputs");
    const rebuildProof = requiredStep(
      full,
      "Rebuild acceptance-controller proof from trusted main",
    );
    const restartControls = requiredStep(
      full,
      "Verify retained-state qualifier controls from trusted main",
    );
    assert.strictEqual(restartControls.if, undefined);
    assert.strictEqual(restartControls["continue-on-error"], undefined);
    assert.strictEqual(restartControls.env, undefined);
    assert.ok(
      restartControls.run?.includes(
        "& $env:TRUSTED_CONTROLLER_NODE --experimental-strip-types --no-warnings --test",
      ),
    );
    for (const token of [
      "$relative = switch -CaseSensitive ($env:SELECTED_AGENT)",
      "'openclaw' { 'packaging/windows/installer/qualify-installed-openclaw.test.mts' }",
      "'hermes' { 'packaging/windows/installer/qualify-installed-hermes.test.mts' }",
      "default { throw 'Unsupported retained-state qualifier agent.' }",
      '$controls = Join-Path "$env:GITHUB_WORKSPACE/controller" $relative',
    ])
      assert.ok(restartControls.run?.includes(token));
    assert.match(restartControls.run ?? "", /--test\s*`\r?\n\s+\$controls\r?\n/u);
    assert.ok(restartControls.run?.includes("if ($LASTEXITCODE -ne 0) { throw"));
    const qualificationGate = requiredStep(
      full,
      "Require configured protected qualification environment",
    );
    const inference = requiredStep(
      full,
      "Exercise installed preview, real inference and owned cleanup",
    );
    const artifactSource = requiredStep(
      full,
      "Check out selected-agent candidate source as comparison data",
    );
    assert.strictEqual(artifactSource.if, undefined);
    assert.strictEqual(
      artifactSource.uses,
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    );
    assert.deepStrictEqual(artifactSource.with, {
      repository: "NVIDIA/NemoClaw",
      ref: "${{ inputs.candidate_sha }}",
      path: "artifact-source",
      "persist-credentials": false,
      submodules: false,
      lfs: false,
    });
    assert.strictEqual(artifactSource.run, undefined);
    assert.strictEqual(artifactSource.env, undefined);
    assert.strictEqual(artifactSource["continue-on-error"], undefined);
    assert.ok(full.steps!.indexOf(qualificationGate) < full.steps!.indexOf(artifactSource));
    assert.ok(full.steps!.indexOf(artifactSource) < full.steps!.indexOf(inference));
    assert.ok(
      inference.run?.includes('-ArtifactSourceRoot "$env:GITHUB_WORKSPACE\\artifact-source"'),
    );
    assert.ok(inference.run?.includes('-SourceRoot "$env:GITHUB_WORKSPACE\\controller"'));
    assert.strictEqual(full.env?.QUALIFICATION_PHASE, "${{ inputs.qualification_phase }}");
    assert.ok(
      inference.run?.includes(
        "-RuntimeBootstrap:($env:SELECTED_AGENT -ceq 'hermes' -and $env:QUALIFICATION_PHASE -ceq 'runtime-bootstrap')",
      ),
    );
    const verifyIndex = full.steps!.indexOf(verifyInputs);
    const rebuildIndex = full.steps!.indexOf(rebuildProof);
    const gateIndex = full.steps!.indexOf(qualificationGate);
    const inferenceIndex = full.steps!.indexOf(inference);
    assert.ok(rebuildIndex < full.steps!.indexOf(restartControls));
    assert.ok(full.steps!.indexOf(restartControls) < inferenceIndex);
    assert.strictEqual(gateIndex, 0);
    assert.deepStrictEqual(
      [gateIndex, verifyIndex, rebuildIndex, inferenceIndex],
      [...[gateIndex, verifyIndex, rebuildIndex, inferenceIndex]].sort(
        (left, right) => left - right,
      ),
    );
    assert.ok(
      verifyInputs.run?.includes(
        "97cce5301a815d2dce07ac5bfd1e6039eae88185ec1d10ae4f8cb712f1732878",
      ),
    );
    assert.ok(verifyInputs.run?.includes("The trusted controller Node directory must be fresh"));
    assert.ok(verifyInputs.run?.includes("$trustedNodeFiles.Count -ne 1"));
    assert.ok(verifyInputs.run?.includes("Copy-Item -LiteralPath $transferredNode.FullName"));
    assert.ok(rebuildProof.run?.includes("& $env:TRUSTED_CONTROLLER_NODE"));
    assert.ok(inference.run?.includes("-ControllerNodePath $env:TRUSTED_CONTROLLER_NODE"));
    assert.ok(
      !JSON.stringify(full.steps!.slice(0, inferenceIndex))?.includes(
        '& "$work\\application\\node\\node.exe"',
      ),
    );
    assert.ok(!JSON.stringify(full.steps!.slice(0, inferenceIndex))?.includes("NVIDIA_API_KEY"));
    assert.ok(
      acceptanceSource?.includes(
        "Full acceptance requires an isolated controller-owned Node executable.",
      ),
    );
    assert.ok(acceptanceSource?.includes("& $ciNode --experimental-strip-types"));
    assert.ok(qualificationGate.run?.includes("reviewed-main-v1"));
    assert.ok(
      requiredStep(
        publication,
        "Require configured protected publication environment",
      ).run?.includes("reviewed-main-v1"),
    );
    assert.strictEqual(legacy.if, "${{ false }}");
    assert.ok(!JSON.stringify(legacy)?.includes("secrets."));
    assert.ok(trustedSource?.includes("main-only deployment branches"));
    assert.ok(trustedSource?.includes("required reviewers"));
    assert.ok(trustedSource?.includes("prevent-self-review"));
    assert.ok(trustedSource?.includes("rotate any qualification key previously exposed"));
    assert.ok(trustedSource?.includes("WINDOWS_NATIVE_INSTALLER_NVIDIA_API_KEY"));
    assert.ok(trustedSource?.includes("WINDOWS_NATIVE_INSTALLER_NVIDIA_INFERENCE_API_KEY"));
    assert.ok(trustedSource?.includes("generic repository-key fallback"));
    assert.ok(workflowSource?.includes("legacy Actions workflow ID 350766812"));
    assert.ok(trustedSource?.includes("legacy Actions workflow ID 350766812"));
    assert.ok(trustedSource?.includes("until both workflow files land on main"));
  })();
  (() => {
    const full = requiredJob(trusted, "full-installed-acceptance");
    const migration = requiredJob(trusted, "migration");
    const publication = requiredJob(trusted, "publish-qualified-installer");
    const runnableUploads = Object.entries(trusted.jobs).flatMap(([jobName, job]) =>
      (job.steps ?? [])
        .filter(
          (step) =>
            step.uses?.startsWith("actions/upload-artifact@") &&
            String(step.with?.path ?? "")
              .split("\n")
              .some(
                (line) => !line.trimStart().startsWith("!") && /\.(?:exe|msi)(?:\s|$)/u.test(line),
              ),
        )
        .map((step) => ({ jobName, step })),
    );
    assert.deepStrictEqual(jobNeeds(full), ["authorize", "candidate-migration-proof"]);
    assert.deepStrictEqual(jobNeeds(migration), ["authorize", "full-installed-acceptance"]);
    assert.ok(migration.if?.includes("needs.full-installed-acceptance.result == 'success'"));
    assert.deepStrictEqual(jobNeeds(publication), [
      "authorize",
      "candidate-migration-proof",
      "full-installed-acceptance",
      "migration",
    ]);
    assert.ok(publication.if?.includes("needs.full-installed-acceptance.result == 'success'"));
    assert.ok(publication.if?.includes("needs.migration.result == 'success'"));
    assert.ok(publication.if?.includes("needs.candidate-migration-proof.result == 'success'"));
    assert.strictEqual(runnableUploads?.length, 1);
    assert.strictEqual(runnableUploads[0].jobName, "publish-qualified-installer");
    assert.strictEqual(runnableUploads[0].step.name, "Publish fully qualified runnable installer");
    const artifactName = runnableUploads[0].step.with?.name;
    assert.ok(typeof artifactName === "string" && artifactName.includes("inputs.candidate_sha"));
    const uploadPath = String(runnableUploads[0].step.with?.path);
    assert.ok(
      uploadPath?.includes("package/NemoClawSetup-${{ inputs.product_version }}-windows-arm64.exe"),
    );
    assert.doesNotMatch(uploadPath, /\.msi(?:\s|$)/u);
    assert.doesNotMatch(uploadPath, /\*\.(?:exe|msi)/u);
    const publicationVerifier = requiredStep(publication, "Verify exact accepted installer bytes");
    assert.ok(publicationVerifier.run?.includes("-ExpectedPackageRunnables"));
    assert.ok(
      transferSource?.includes(
        "The package runnable inventory differs from the qualified publication allowlist.",
      ),
    );
    assert.ok(
      transferSource?.includes(
        "The immutable package receipt does not identify the exact publication inventory.",
      ),
    );
    assert.deepStrictEqual(publication.outputs, {
      preview_id: "${{ steps.preview.outputs.artifact-id }}",
      preview_digest: "${{ steps.preview.outputs.artifact-digest }}",
    });
  })();
  for (const scenario of [
    {
      caseName: "compiled application",
      sourceWorkflow: workflow,
      jobName: "windows-compiled-application",
    },
    {
      caseName: "installer build",
      sourceWorkflow: workflow,
      jobName: "windows-finished-installer",
    },
    {
      caseName: "installed startup",
      sourceWorkflow: workflow,
      jobName: "windows-finished-installed-startup",
    },
    {
      caseName: "full installed acceptance",
      sourceWorkflow: trusted,
      jobName: "full-installed-acceptance",
    },
    { caseName: "migration", sourceWorkflow: trusted, jobName: "migration" },
    {
      caseName: "candidate migration",
      sourceWorkflow: workflow,
      jobName: "windows-finished-candidate-migration",
    },
  ]) {
    (({ sourceWorkflow, jobName }) => {
      const job = requiredJob(sourceWorkflow, jobName);
      const stages = (job.steps ?? []).filter((step) =>
        step.run?.includes("stage-windows-native-evidence.ps1"),
      );
      const uploads = (job.steps ?? []).filter(
        (step) =>
          step.uses?.startsWith("actions/upload-artifact@") &&
          !(
            jobName === "windows-finished-installer" &&
            (step === requiredStep(job, "Publish the unqualified OpenClaw preview download") ||
              step === requiredStep(job, "Publish the unqualified Hermes preview download"))
          ),
      );
      assert.strictEqual(stages?.length, 1);
      assert.ok(stages[0].if?.includes("always()"));
      assert.strictEqual(uploads?.length, 1);
      assert.ok(uploads[0].if?.includes(".outcome == 'success'"));
      assert.match(String(uploads[0].with?.path), /-evidence\/$/u);
    })(scenario);
  }
  (() => {
    const candidate = requiredJob(workflow, "windows-finished-candidate-migration");
    const call = requiredJob(workflow, "windows-finished-trusted-qualification");
    const proof = requiredJob(trusted, "candidate-migration-proof");
    assert.deepStrictEqual(jobNeeds(candidate), [
      "windows-finished-request",
      "windows-finished-installer",
      "windows-finished-reviewed-installer",
    ]);
    assert.strictEqual(
      candidate.if,
      "${{ always() && !cancelled() && needs.windows-finished-request.result == 'success' && needs.windows-finished-request.outputs.request_kind != 'candidate-build' && needs.windows-finished-installer.result == 'success' && needs.windows-finished-reviewed-installer.result == 'success' }}",
    );
    assert.deepStrictEqual(candidate.permissions, { actions: "read", contents: "read" });
    assert.strictEqual(candidate["runs-on"], "windows-11-vs2026-arm");
    assert.deepStrictEqual(candidate.outputs, {
      evidence_id: "${{ steps.migration_upload.outputs.artifact-id }}",
      proof_sha256: "${{ steps.migration_proof.outputs.sha256 }}",
    });
    assert.deepStrictEqual(
      requiredStep(candidate, "Check out the exact candidate migration controllers").with,
      {
        repository: "${{ needs.windows-finished-request.outputs.candidate_repository }}",
        ref: "${{ needs.windows-finished-request.outputs.candidate_sha }}",
        path: "candidate",
        "persist-credentials": false,
      },
    );
    const restore = requiredStep(candidate, "Restore exact same-run installer cache");
    assert.strictEqual(
      restore.with?.key,
      "${{ needs.windows-finished-reviewed-installer.outputs.installer_cache_key }}",
    );
    assert.strictEqual(restore.with?.["fail-on-cache-miss"], true);
    assert.ok(!Object.hasOwn(restore.with ?? {}, "restore-keys"));
    const inputs = requiredStep(candidate, "Verify and materialize candidate migration inputs");
    assert.ok(inputs.run?.includes("-ExpectedManifestSha256 $env:INSTALLER_MANIFEST"));
    const burn = requiredStep(candidate, "Exercise candidate Burn fixture and diagnostics");
    for (const fragment of [
      "build-burn-diagnostics-fixture.ps1",
      "test-burn-diagnostics.ps1",
      "$env:GITHUB_WORKSPACE\\candidate",
      "$env:GITHUB_SHA = $env:CANDIDATE_SHA",
    ])
      assert.ok(burn.run?.includes(fragment));
    const migration = requiredStep(
      candidate,
      "Exercise candidate preview migration and selective reset",
    );
    assert.ok(
      migration.run?.includes(
        '"$env:GITHUB_WORKSPACE\\candidate\\packaging\\windows\\installer\\run-preview-migration.ps1"',
      ),
    );
    const binding = requiredStep(
      candidate,
      "Bind candidate migration proof to controller and installer",
    );
    for (const fragment of [
      "controllerSourceRevision=$env:CANDIDATE_SHA",
      "artifactSourceRevision=$env:CANDIDATE_SHA",
      "installerManifestSha256=$env:INSTALLER_MANIFEST",
      "workflowRunId=$env:GITHUB_RUN_ID",
      "workflowRunAttempt=$env:GITHUB_RUN_ATTEMPT",
      "diff --exit-code $env:CANDIDATE_SHA",
      "$migration.status -cne 'pass'",
      "$burn.status -cne 'pass'",
    ])
      assert.ok(binding.run?.includes(fragment));
    const staging = requiredStep(candidate, "Stage only non-runnable candidate migration evidence");
    assert.ok(staging.run?.includes("candidate-migration-controller.json"));
    const upload = requiredStep(candidate, "Preserve candidate migration controller evidence");
    assert.strictEqual(upload.with?.["if-no-files-found"], "error");
    const execution = [inputs, burn, migration, binding];
    for (const step of execution) assert.strictEqual(step.if, undefined);
    const indices = [...execution, staging, upload].map((step) => candidate.steps!.indexOf(step));
    assert.deepStrictEqual(
      indices,
      [...indices].sort((a, b) => a - b),
    );
    assert.ok(!JSON.stringify(candidate).includes('"continue-on-error":true'));
    assert.ok(jobNeeds(call).includes("windows-finished-candidate-migration"));
    assert.ok(call.if?.includes("needs.windows-finished-candidate-migration.result == 'success'"));
    for (const [input, output] of [
      ["candidate_migration_evidence_id", "evidence_id"],
      ["candidate_migration_proof_sha256", "proof_sha256"],
    ]) {
      assert.strictEqual(
        call.with?.[input],
        `\${{ needs.windows-finished-candidate-migration.outputs.${output} }}`,
      );
      assert.deepStrictEqual(trusted.on.workflow_call.inputs[input], {
        required: false,
        default: "",
        type: "string",
      });
    }
    assert.ok(
      matchesFields(trusted.on.workflow_call.inputs.qualification_phase, {
        required: false,
        default: "final",
        type: "string",
      }),
    );
    const phaseAuthorization = requiredStep(
      requiredJob(trusted, "authorize"),
      "Require current main controller and exact internal PR identity",
    );
    assert.strictEqual(
      phaseAuthorization.env?.QUALIFICATION_PHASE,
      "${{ inputs.qualification_phase }}",
    );
    for (const token of [
      "if [[ \"$QUALIFICATION_PHASE\" == 'runtime-bootstrap' ]]; then",
      '[[ "$SELECTED_AGENT" =~ ^(openclaw|hermes)$ && -z "$CANDIDATE_MIGRATION_EVIDENCE_ID" && -z "$CANDIDATE_MIGRATION_PROOF_SHA256" ]]',
      '( "$QUALIFICATION_PHASE" == \'final\' && "$INSTALLER_CACHE_KEY" == "windows-finished-reviewed-installer-v1-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$CANDIDATE_SHA-$SELECTED_AGENT" )',
      "[[ \"$QUALIFICATION_PHASE\" == 'final' ]]",
      '[[ "$CANDIDATE_MIGRATION_EVIDENCE_ID" =~ ^[1-9][0-9]*$ && "$CANDIDATE_MIGRATION_PROOF_SHA256" =~ ^[a-f0-9]{64}$ ]]',
    ])
      assert.ok(phaseAuthorization.run?.includes(token), "Missing phase authorization: " + token);
    assert.deepStrictEqual(jobNeeds(proof), ["authorize"]);
    assert.ok(!JSON.stringify(proof).includes("secrets."));
    assert.strictEqual(proof.environment, undefined);
    assert.deepStrictEqual(
      requiredStep(proof, "Download candidate migration evidence from this run").with,
      {
        "artifact-ids": "${{ inputs.candidate_migration_evidence_id }}",
        path: "${{ runner.temp }}/candidate-migration-proof",
        "merge-multiple": true,
      },
    );
    const verify = requiredStep(proof, "Verify candidate controller and artifact identities");
    for (const fragment of [
      "hashlib.sha256(data).hexdigest() == digest",
      "object_pairs_hook=unique_object",
      "proof['controllerSourceRevision'] == os.environ['CANDIDATE_SHA']",
      "proof['artifactSourceRevision'] == os.environ['CANDIDATE_SHA']",
      "proof['installerManifestSha256'] == os.environ['INSTALLER_MANIFEST']",
      "proof['workflowRunId'] == os.environ['GITHUB_RUN_ID']",
      "proof['workflowRunAttempt'] == os.environ['GITHUB_RUN_ATTEMPT']",
      "proof['agent'] == os.environ['SELECTED_AGENT']",
      "[item['file'] for item in proof['files']] == expected",
      "burn['status'] == 'pass'",
      "migration['status'] == 'pass'",
      "migration['installationRootRemoved'] is True",
      "case['resetVerified'] is True",
    ])
      assert.ok(verify.run?.includes(fragment));
    assert.ok(
      requiredJob(trusted, "full-installed-acceptance").if?.includes(
        "needs.candidate-migration-proof.result == 'success'",
      ),
    );
    const trustedMigration = requiredJob(trusted, "migration");
    assert.ok(
      requiredStep(
        trustedMigration,
        "Exercise previous EXE migration and native selective reset",
      ).run?.includes(
        '"$env:GITHUB_WORKSPACE\\controller\\packaging\\windows\\installer\\run-preview-migration.ps1"',
      ),
    );
    const identity = requiredStep(
      trustedMigration,
      "Record trusted migration controller identity separately",
    );
    assert.ok(
      identity.run?.includes(
        "controllerSourceRevision=$env:CONTROLLER_SHA;artifactSourceRevision=$env:CANDIDATE_SHA",
      ),
    );
    assert.ok(
      requiredStep(
        trustedMigration,
        "Stage only non-runnable setup and migration evidence",
      ).run?.includes("trusted-migration-controller.json"),
    );
  })();
  (() => {
    assert.ok(evidenceSource?.includes("The evidence staging root must be fresh."));
    assert.ok(evidenceSource?.includes("Evidence input contains PE or MSI/OLE runnable content"));
    assert.ok(evidenceSource?.includes("Evidence input has a non-allowlisted extension"));
    assert.ok(evidenceSource?.includes("ConvertFrom-Json"));
    assert.ok(evidenceSource?.includes("[IO.FileShare]::Read"));
    assert.ok(evidenceSource?.includes("[IO.FileMode]::CreateNew"));
    assert.ok(evidenceSource?.includes("evidence-manifest.json"));
    assert.ok(evidenceSource?.includes("The staged evidence inventory changed before upload."));
    assert.ok(evidenceSource?.includes("deliberately hostile same-user process"));
  })();
  for (const [owner, job, stepName, sourceRoot] of [
    [
      workflow,
      "windows-finished-installer",
      "Build the finished WPF, guarded launcher, transactional MSI and Burn preview",
      "\\candidate",
    ],
    [
      workflow,
      "windows-finished-reviewed-installer",
      "Rebuild native UI MSI and Burn without rebuilding the qualified runtime",
      "\\candidate",
    ],
    [
      workflow,
      "windows-finished-candidate-migration",
      "Exercise candidate Burn fixture and diagnostics",
      "\\candidate",
    ],
    [
      workflow,
      "windows-runtime-controls",
      "Build and exercise actual isolated MSI transactions",
      "",
    ],
    [
      trusted,
      "migration",
      "Build actual Burn failure fixture from the same native UI",
      "\\controller",
    ],
  ] as const) {
    const install = requiredStep(requiredJob(owner, job), stepName);
    const invocation = `& "$env:GITHUB_WORKSPACE${sourceRoot}\\packaging\\windows\\installer\\install-pinned-wix.ps1" -ToolDirectory $tools`;
    assert.ok(install.run?.includes(invocation), "WiX must use its verified local package: " + job);
    assert.ok(
      !install.run?.includes("dotnet tool install"),
      "WiX cannot bypass package verification: " + job,
    );
    assert.ok(install.run!.indexOf(invocation) < install.run!.indexOf("-WixPath"));
    assert.notStrictEqual(install["continue-on-error"], true);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertWindowsInstallerWorkflow(
    readWindowsInstallerWorkflowSources(resolve(import.meta.dirname, "../..")),
  );
}
