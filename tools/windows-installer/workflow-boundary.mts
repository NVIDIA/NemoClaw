// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
export type WorkflowStep = {
  name?: string;
  run?: string;
  uses?: string;
  if?: string;
  with?: Record<string, unknown>;
};
export type WorkflowJob = {
  steps?: WorkflowStep[];
  needs?: string | string[];
  if?: string;
  uses?: string;
  environment?: unknown;
  outputs?: Record<string, string>;
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
  for (const scenario of [
    "windows-finished-request",
    "windows-compiled-application",
    "windows-finished-installer",
    "windows-finished-installed-startup",
    "windows-runtime-controls",
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
          "test/security/windows-native-*.test.ts",
          "test/support/windows-native-*.ts",
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
        11,
      );
      assert.strictEqual(
        transferWorkflows.match(/^.*= @\(& .*windows-native-transfer\.ps1.*$/gmu)?.length,
        11,
      );
      assert.doesNotMatch(transferWorkflows, /\$LASTEXITCODE[^\n]*transfer/iu);
      const evidenceRun =
        requiredStep(compiled, "Stage only non-runnable application diagnostics").run ?? "";
      assert.ok(
        evidenceRun?.includes("$work\\controls\\compiled-openclaw\\compiled-controls.json"),
      );
      assert.ok(evidenceRun?.includes("$work\\gateway-control\\gateway-control.json"));
      assert.ok(evidenceRun?.includes("$work\\build\\diagnostics\\local-model-tools\\result.json"));
      assert.ok(evidenceRun?.includes("$choiceRoot\\result.json"));
      assert.ok(!evidenceRun?.includes('"$work\\controls",'));
      assert.ok(!evidenceRun?.includes('"$work\\gateway-control",'));
      assert.ok(!evidenceRun?.includes('"$work\\build\\diagnostics",'));
    })(scenario);
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
    ]);
    const verifyInputs = requiredStep(full, "Verify and materialize exact qualified inputs");
    const rebuildProof = requiredStep(
      full,
      "Rebuild acceptance-controller proof from trusted main",
    );
    const qualificationGate = requiredStep(
      full,
      "Require configured protected qualification environment",
    );
    const inference = requiredStep(
      full,
      "Exercise installed preview, real inference and owned cleanup",
    );
    const verifyIndex = full.steps!.indexOf(verifyInputs);
    const rebuildIndex = full.steps!.indexOf(rebuildProof);
    const gateIndex = full.steps!.indexOf(qualificationGate);
    const inferenceIndex = full.steps!.indexOf(inference);
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
    assert.deepStrictEqual(jobNeeds(full), ["authorize"]);
    assert.deepStrictEqual(jobNeeds(migration), ["authorize", "full-installed-acceptance"]);
    assert.ok(migration.if?.includes("needs.full-installed-acceptance.result == 'success'"));
    assert.deepStrictEqual(jobNeeds(publication), [
      "authorize",
      "full-installed-acceptance",
      "migration",
    ]);
    assert.ok(publication.if?.includes("needs.full-installed-acceptance.result == 'success'"));
    assert.ok(publication.if?.includes("needs.migration.result == 'success'"));
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
  ]) {
    (({ sourceWorkflow, jobName }) => {
      const job = requiredJob(sourceWorkflow, jobName);
      const stages = (job.steps ?? []).filter((step) =>
        step.run?.includes("stage-windows-native-evidence.ps1"),
      );
      const uploads = (job.steps ?? []).filter((step) =>
        step.uses?.startsWith("actions/upload-artifact@"),
      );
      assert.strictEqual(stages?.length, 1);
      assert.ok(stages[0].if?.includes("always()"));
      assert.strictEqual(uploads?.length, 1);
      assert.ok(uploads[0].if?.includes(".outcome == 'success'"));
      assert.match(String(uploads[0].with?.path), /-evidence\/$/u);
    })(scenario);
  }
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
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertWindowsInstallerWorkflow(
    readWindowsInstallerWorkflowSources(resolve(import.meta.dirname, "../..")),
  );
}
