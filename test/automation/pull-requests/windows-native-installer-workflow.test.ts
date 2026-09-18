// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  readRepoText,
  readYaml,
  type Workflow,
  type WorkflowJob,
  type WorkflowStep,
} from "../../helpers/e2e-workflow-contract";

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

function requiredJob(workflow: Workflow, name: string): WorkflowJob {
  const job = workflow.jobs[name];
  expect(job, `missing Windows installer job '${name}'`).toBeDefined();
  return job!;
}

function requiredStep(job: WorkflowJob, name: string): WorkflowStep {
  const step = job.steps?.find((candidate) => candidate.name === name);
  expect(step, `missing step '${name}'`).toBeDefined();
  return step!;
}

function jobNeeds(job: WorkflowJob): string[] {
  return typeof job.needs === "string" ? [job.needs] : (job.needs ?? []);
}

const workflow = readYaml<WindowsInstallerWorkflow>(
  ".github/workflows/windows-native-installer-v2.yaml",
);
const trusted = readYaml<TrustedWorkflow>(
  ".github/workflows/windows-native-installer-trusted.yaml",
);
const workflowSource = readRepoText(".github/workflows/windows-native-installer-v2.yaml");
const trustedSource = readRepoText(".github/workflows/windows-native-installer-trusted.yaml");
const transferSource = readRepoText("scripts/checks/windows-native-transfer.ps1");
const evidenceSource = readRepoText("scripts/checks/stage-windows-native-evidence.ps1");
const acceptanceSource = readRepoText("packaging/windows/installer/run-installed-acceptance.ps1");
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("native Windows installer pull request acceptance", () => {
  // source-shape-contract: security -- Exact PR code may build and start only without credentials; executable handoffs stay in exact same-run caches until trusted qualification publishes them
  it.each([
    "windows-finished-request",
    "windows-compiled-application",
    "windows-finished-installer",
    "windows-finished-installed-startup",
    "windows-runtime-controls",
  ])(
    "runs the exact OpenClaw compile-to-installed-startup graph without secrets for %s (#8178)",
    (prJobName) => {
      const request = requiredJob(workflow, "windows-finished-request");
      const compiled = requiredJob(workflow, "windows-compiled-application");
      const installer = requiredJob(workflow, "windows-finished-installer");
      const startup = requiredJob(workflow, "windows-finished-installed-startup");
      const prJob = requiredJob(workflow, prJobName);

      expect(workflow.on.pull_request).toEqual({
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
      expect(workflowSource).toContain("name: CI / Native Windows Installer Candidate v2");
      expect(workflow.permissions).toEqual({ actions: "read", contents: "read" });
      expect(workflow.concurrency["cancel-in-progress"]).toBe(
        "${{ github.event_name == 'pull_request' }}",
      );
      expect(request.outputs).toMatchObject({
        candidate_repository: expect.stringContaining("steps.pull_request.outputs"),
        candidate_sha: expect.stringContaining("steps.pull_request.outputs"),
        credential_authorized: expect.stringContaining("steps.pull_request.outputs"),
      });
      const prAdmission = requiredStep(
        request,
        "Admit the exact pull request head without credentials",
      );
      expect(prAdmission.run).toContain("agent=openclaw");
      expect(prAdmission.run).toContain("validation_scope=startup-only");
      expect(prAdmission.run).toContain("credential_authorized=false");

      expect(jobNeeds(compiled)).toContain("windows-finished-request");
      expect(jobNeeds(installer)).toEqual(
        expect.arrayContaining(["windows-finished-request", "windows-compiled-application"]),
      );
      expect(jobNeeds(startup)).toEqual(
        expect.arrayContaining([
          "windows-finished-request",
          "windows-compiled-application",
          "windows-finished-installer",
        ]),
      );
      expect(startup.if).toContain("request_kind == 'pull-request'");
      expect(startup.if).toContain("agent == 'openclaw'");
      expect(startup.if).toContain("validation_scope == 'startup-only'");
      expect(
        requiredStep(
          startup,
          "Exercise installed OpenClaw startup and owned cleanup without credentials",
        ).run,
      ).toContain("-ValidationScope startup-only");
      expect(JSON.stringify(prJob)).not.toContain("secrets.");
      expect(prJob.environment).toBeUndefined();
      expect(workflowSource).not.toContain("secrets.");
    },
  );

  // source-shape-contract: compatibility -- Early dual-Node ordering makes controller regressions fail before expensive Windows compilation
  it("runs Node 22 and Node 24 controller checks before expensive Windows builds", () => {
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

    expect(compiledController.run).toContain(requiredControllerTest);
    expect(compiled.steps!.indexOf(compiledController)).toBeLessThan(
      compiled.steps!.findIndex(
        (step) => step.name === "Restore immutable application build inputs",
      ),
    );
    expect(runtimeNode.with?.["node-version"]).toBe("24.18.1");
    expect(runtimeController.run).toContain(requiredControllerTest);
    expect(runtime.steps!.indexOf(runtimeController)).toBeLessThan(
      runtime.steps!.indexOf(runtimeRust),
    );
  });

  // source-shape-contract: security -- Exact cache keys and producer manifests prevent stale or substituted executable handoffs from reaching acceptance
  it.each([
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
      caseName: "compiled application save and startup application restore",
      saveJobName: "windows-compiled-application",
      restoreJobName: "windows-finished-installed-startup",
      restoreStepName: "Restore exact same-run compiled application cache",
    },
  ])(
    "uses exact same-run caches with producer manifests instead of runnable artifacts for $caseName",
    ({ saveJobName, restoreJobName, restoreStepName }) => {
      const compiled = requiredJob(workflow, "windows-compiled-application");
      const installer = requiredJob(workflow, "windows-finished-installer");
      const bashReuse = requiredJob(workflow, "windows-bash-compatibility-reuse");
      const saveJob = requiredJob(workflow, saveJobName);
      const restoreJob = requiredJob(workflow, restoreJobName);

      expect(compiled.outputs).toEqual({
        application_cache_key: "${{ steps.transfer_manifest.outputs.cache_key }}",
        application_manifest_sha256: "${{ steps.transfer_manifest.outputs.manifest_sha256 }}",
      });
      expect(installer.outputs).toEqual({
        installer_cache_key: "${{ steps.product_manifest.outputs.cache_key }}",
        installer_manifest_sha256: "${{ steps.product_manifest.outputs.manifest_sha256 }}",
      });
      expect(bashReuse.outputs).toEqual({
        compatibility_cache_key: "${{ steps.compatibility_manifest.outputs.cache_key }}",
        compatibility_manifest_sha256:
          "${{ steps.compatibility_manifest.outputs.manifest_sha256 }}",
      });

      const saves = saveJob.steps?.filter((step) => step.uses?.startsWith("actions/cache/save@"));
      expect(saves).toHaveLength(1);
      expect(saves?.[0].with).not.toHaveProperty("restore-keys");
      const restores = restoreJob.steps?.filter((step) =>
        step.uses?.startsWith("actions/cache/restore@"),
      );
      expect(restores).toHaveLength(2);
      const restore = requiredStep(restoreJob, restoreStepName);
      expect(restore.uses).toMatch(/^actions\/cache\/restore@/u);
      expect(restore.with?.["fail-on-cache-miss"]).toBe(true);
      expect(restore.with).not.toHaveProperty("restore-keys");
      expect(JSON.stringify(restoreJob)).toContain("windows-native-transfer.ps1");
      expect(JSON.stringify(restoreJob)).toContain("ExpectedManifestSha256");
      const compiledUploadPaths = (compiled.steps ?? [])
        .filter((step) => step.uses?.startsWith("actions/upload-artifact@"))
        .map((step) => String(step.with?.path ?? ""))
        .join("\n");
      expect(compiledUploadPaths).not.toMatch(/\.exe|\.msi/u);
      expect(JSON.stringify(installer)).not.toContain("finished-windows-preview-${{");
      expect(JSON.stringify(installer)).not.toContain("package/*.exe");
      expect(JSON.stringify(installer)).not.toContain("package/*.msi");
      expect(workflowSource).not.toContain("migration_inputs_id");
      expect(workflowSource).not.toContain("application_id");
      expect(workflowSource).not.toContain("runtime_id");

      expect(transferSource).toContain("same-run-private-executable-transfer");
      expect(transferSource).toContain("workflowRunId");
      expect(transferSource).toContain("workflowRunAttempt");
      expect(transferSource).toContain("ReparsePoint");
      expect(transferSource).toContain("A transfer cache entry differs from its manifest.");

      const transferWorkflows = `${workflowSource}\n${trustedSource}`;
      expect(transferWorkflows.match(/^.*windows-native-transfer\.ps1.*$/gmu)).toHaveLength(11);
      expect(
        transferWorkflows.match(/^.*= @\(& .*windows-native-transfer\.ps1.*$/gmu),
      ).toHaveLength(11);
      expect(transferWorkflows).not.toMatch(/\$LASTEXITCODE[^\n]*transfer/iu);

      const evidenceRun =
        requiredStep(compiled, "Stage only non-runnable application diagnostics").run ?? "";
      expect(evidenceRun).toContain("$work\\controls\\compiled-openclaw\\compiled-controls.json");
      expect(evidenceRun).toContain("$work\\gateway-control\\gateway-control.json");
      expect(evidenceRun).toContain("$work\\build\\diagnostics\\local-model-tools\\result.json");
      expect(evidenceRun).toContain("$choiceRoot\\result.json");
      expect(evidenceRun).not.toContain('"$work\\controls",');
      expect(evidenceRun).not.toContain('"$work\\gateway-control",');
      expect(evidenceRun).not.toContain('"$work\\build\\diagnostics",');
    },
  );

  it.skipIf(process.platform !== "win32")(
    "rejects a manifest-valid extra publication executable",
    () => {
      const root = mkdtempSync(join(tmpdir(), "windows-native-transfer-"));
      const packageDirectory = join(root, "package");
      const revision = "a".repeat(40);
      const expectedNames = [
        "NemoClaw-0.1.10-windows-arm64.msi",
        "NemoClawSetup-0.1.10-windows-arm64.exe",
      ];
      const allNames = [...expectedNames, "unaccepted-extra.exe"];
      const transferScript = join(repoRoot, "scripts/checks/windows-native-transfer.ps1");
      try {
        mkdirSync(packageDirectory, { recursive: true });
        const files = allNames.map((name, index) => {
          const bytes = Buffer.from(`publication-fixture-${index}`, "utf8");
          writeFileSync(join(packageDirectory, name), bytes);
          return {
            file: name,
            bytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          };
        });
        writeFileSync(
          join(packageDirectory, "immutable-package-build.json"),
          JSON.stringify({
            sourceRevision: revision,
            status: "candidate-built-for-installed-qualification",
            files,
          }),
        );
        const create = spawnSync(
          "pwsh.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-File",
            transferScript,
            "-Mode",
            "Create",
            "-Root",
            root,
            "-Kind",
            "finished-installer",
            "-SourceRevision",
            revision,
            "-Agent",
            "openclaw",
            "-RunId",
            "123",
            "-RunAttempt",
            "1",
          ],
          { encoding: "utf8", windowsHide: true },
        );
        expect(create.status, create.stderr).toBe(0);
        const manifestSha256 = create.stdout.trim();
        const verify = spawnSync(
          "pwsh.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            String.raw`& $env:TRANSFER_SCRIPT -Mode Verify -Root $env:TRANSFER_ROOT -Kind finished-installer -SourceRevision $env:SOURCE_REVISION -Agent openclaw -RunId 123 -RunAttempt 1 -ExpectedManifestSha256 $env:MANIFEST_SHA256 -ExpectedPackageRunnables @('NemoClaw-0.1.10-windows-arm64.msi','NemoClawSetup-0.1.10-windows-arm64.exe')`,
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              MANIFEST_SHA256: manifestSha256,
              SOURCE_REVISION: revision,
              TRANSFER_ROOT: root,
              TRANSFER_SCRIPT: transferScript,
            },
            windowsHide: true,
          },
        );
        expect(verify.status).not.toBe(0);
        expect(verify.stdout + verify.stderr).toContain(
          "package runnable inventory differs from the qualified publication allowlist",
        );
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    },
  );

  it.skipIf(process.platform !== "win32")(
    "rejects PE content disguised as allowlisted evidence",
    () => {
      const root = mkdtempSync(join(tmpdir(), "windows-native-evidence-"));
      const input = join(root, "candidate-evidence.json");
      const output = join(root, "staged");
      const evidenceScript = join(repoRoot, "scripts/checks/stage-windows-native-evidence.ps1");
      try {
        writeFileSync(input, Buffer.from([0x4d, 0x5a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
        const result = spawnSync(
          "pwsh.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-File",
            evidenceScript,
            "-SourceBase",
            root,
            "-InputPath",
            input,
            "-OutputRoot",
            output,
          ],
          { encoding: "utf8", windowsHide: true },
        );
        expect(result.status).not.toBe(0);
        expect(result.stdout + result.stderr).toContain(
          "Evidence input contains PE or MSI/OLE runnable content",
        );
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    },
  );
});

describe("trusted Windows installer authorization and publication", () => {
  // source-shape-contract: security -- Secret-bearing acceptance executes only in a reusable main controller with exact PR reauthorization and protected environments
  it.each([
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
  ])(
    "reauthorizes main, workflow, PR, organization and both dispatch principals for $caseName",
    ({ sourceWorkflow, jobName, stepName }) => {
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

      expect(authorization.run).toContain("NVIDIA/NemoClaw");
      expect(authorization.run).toContain(".base.ref");
      expect(authorization.run).toContain("'main'");
      expect(authorization.run).toContain(".base.sha");
      expect(authorization.run).toContain(".head.sha");
      expect(authorization.run).toContain(".head.repo.owner.login");
      expect(authorization.run).toContain(".head.repo.owner.type");
      expect(authorization.run).toContain("Organization");
      expect(authorization.run).toContain("$ACTOR");
      expect(authorization.run).toContain("$TRIGGERING_ACTOR");
      expect(authorization.run).toContain("admin|maintain|write");
      expect(authorize.run).toContain("$EVENT_WORKFLOW_SHA");
      expect(authorize.run).toContain('"$BASE_SHA" == "$EXPECTED_WORKFLOW_SHA"');
      expect(authorize.run).toContain("compare/$EXPECTED_WORKFLOW_SHA...$CANDIDATE_SHA");
      expect(authorize.run).toContain(".merge_base_commit.sha");
      expect(authorize.run).toContain(".behind_by");
      expect(trustedAuthorization.run).toContain("git/ref/heads/main");
      expect(trustedAuthorization.run).toContain('"$BASE_SHA" == "$WORKFLOW_SHA"');
      expect(trustedAuthorization.run).toContain("compare/$WORKFLOW_SHA...$CANDIDATE_SHA");
      expect(trustedAuthorization.run).toContain(".merge_base_commit.sha");
      expect(trustedAuthorization.run).toContain(".behind_by");
      expect(trustedAuthorize.outputs).toEqual({
        trusted_main: "${{ steps.authorization.outputs.trusted_main }}",
        exact_workflow: "${{ steps.authorization.outputs.exact_workflow }}",
        exact_pr: "${{ steps.authorization.outputs.exact_pr }}",
        credential_authorized: "${{ steps.authorization.outputs.credential_authorized }}",
      });
    },
  );

  // source-shape-contract: security -- Same-commit reuse plus protected environment gates keeps feature-branch workflow text from becoming a credential trust boundary
  it("bootstraps through the exact same commit and isolates every secret to protected jobs", () => {
    const call = requiredJob(workflow, "windows-finished-trusted-qualification");
    const full = requiredJob(trusted, "full-installed-acceptance");
    const publication = requiredJob(trusted, "publish-qualified-installer");
    const legacy = requiredJob(workflow, "windows-native-package-diagnostic");
    const secretJobs = Object.entries(trusted.jobs)
      .filter(([, job]) => JSON.stringify(job).includes("secrets."))
      .map(([name]) => name)
      .sort();

    expect(call.uses).toBe("./.github/workflows/windows-native-installer-trusted.yaml");
    expect(call.if).toContain("github.ref == 'refs/heads/main'");
    expect(call.if).toContain("trusted_main == 'true'");
    expect(call.if).toContain("exact_workflow == 'true'");
    expect(call.if).toContain("exact_pr == 'true'");
    expect(call.if).toContain("credential_authorized == 'true'");
    expect(trusted.on).toHaveProperty("workflow_call");
    expect(trusted.on as Record<string, unknown>).not.toHaveProperty("workflow_dispatch");
    expect(full.environment).toBe("windows-native-installer-qualification");
    expect(publication.environment).toBe("windows-native-installer-publication");
    expect(secretJobs).toEqual(["full-installed-acceptance", "publish-qualified-installer"]);
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
    expect(gateIndex).toBe(0);
    expect([gateIndex, verifyIndex, rebuildIndex, inferenceIndex]).toEqual(
      [...[gateIndex, verifyIndex, rebuildIndex, inferenceIndex]].sort(
        (left, right) => left - right,
      ),
    );
    expect(verifyInputs.run).toContain(
      "97cce5301a815d2dce07ac5bfd1e6039eae88185ec1d10ae4f8cb712f1732878",
    );
    expect(verifyInputs.run).toContain("The trusted controller Node directory must be fresh");
    expect(verifyInputs.run).toContain("$trustedNodeFiles.Count -ne 1");
    expect(verifyInputs.run).toContain("Copy-Item -LiteralPath $transferredNode.FullName");
    expect(rebuildProof.run).toContain("& $env:TRUSTED_CONTROLLER_NODE");
    expect(inference.run).toContain("-ControllerNodePath $env:TRUSTED_CONTROLLER_NODE");
    expect(JSON.stringify(full.steps!.slice(0, inferenceIndex))).not.toContain(
      '& "$work\\application\\node\\node.exe"',
    );
    expect(JSON.stringify(full.steps!.slice(0, inferenceIndex))).not.toContain("NVIDIA_API_KEY");
    expect(acceptanceSource).toContain(
      "Full acceptance requires an isolated controller-owned Node executable.",
    );
    expect(acceptanceSource).toContain("& $ciNode --experimental-strip-types");
    expect(qualificationGate.run).toContain("reviewed-main-v1");
    expect(
      requiredStep(publication, "Require configured protected publication environment").run,
    ).toContain("reviewed-main-v1");
    expect(legacy.if).toBe("${{ false }}");
    expect(JSON.stringify(legacy)).not.toContain("secrets.");
    expect(trustedSource).toContain("main-only deployment branches");
    expect(trustedSource).toContain("required reviewers");
    expect(trustedSource).toContain("prevent-self-review");
    expect(trustedSource).toContain("rotate any qualification key previously exposed");
    expect(trustedSource).toContain("WINDOWS_NATIVE_INSTALLER_NVIDIA_API_KEY");
    expect(trustedSource).toContain("WINDOWS_NATIVE_INSTALLER_NVIDIA_INFERENCE_API_KEY");
    expect(trustedSource).toContain("generic repository-key fallback");
    expect(workflowSource).toContain("legacy Actions workflow ID 350766812");
    expect(trustedSource).toContain("legacy Actions workflow ID 350766812");
    expect(trustedSource).toContain("until both workflow files land on main");
  });

  // source-shape-contract: security -- Exact job dependencies and upload paths ensure only the exercised setup executable can become a qualified artifact
  it("publishes runnable bytes only after full acceptance and migration succeed", () => {
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

    expect(jobNeeds(full)).toEqual(["authorize"]);
    expect(jobNeeds(migration)).toEqual(["authorize", "full-installed-acceptance"]);
    expect(migration.if).toContain("needs.full-installed-acceptance.result == 'success'");
    expect(jobNeeds(publication)).toEqual(["authorize", "full-installed-acceptance", "migration"]);
    expect(publication.if).toContain("needs.full-installed-acceptance.result == 'success'");
    expect(publication.if).toContain("needs.migration.result == 'success'");
    expect(runnableUploads).toHaveLength(1);
    expect(runnableUploads[0].jobName).toBe("publish-qualified-installer");
    expect(runnableUploads[0].step.name).toBe("Publish fully qualified runnable installer");
    expect(runnableUploads[0].step.with?.name).toContain("inputs.candidate_sha");
    const uploadPath = String(runnableUploads[0].step.with?.path);
    expect(uploadPath).toContain(
      "package/NemoClawSetup-${{ inputs.product_version }}-windows-arm64.exe",
    );
    expect(uploadPath).not.toMatch(/\.msi(?:\s|$)/u);
    expect(uploadPath).not.toMatch(/\*\.(?:exe|msi)/u);
    const publicationVerifier = requiredStep(publication, "Verify exact accepted installer bytes");
    expect(publicationVerifier.run).toContain("-ExpectedPackageRunnables");
    expect(transferSource).toContain(
      "The package runnable inventory differs from the qualified publication allowlist.",
    );
    expect(transferSource).toContain(
      "The immutable package receipt does not identify the exact publication inventory.",
    );
    expect(publication.outputs).toEqual({
      preview_id: "${{ steps.preview.outputs.artifact-id }}",
      preview_digest: "${{ steps.preview.outputs.artifact-digest }}",
    });
  });

  it.each([
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
  ])(
    "applies accidental-runnable hygiene to $caseName prequalification evidence",
    ({ sourceWorkflow, jobName }) => {
      const job = requiredJob(sourceWorkflow, jobName);
      const stages = (job.steps ?? []).filter((step) =>
        step.run?.includes("stage-windows-native-evidence.ps1"),
      );
      const uploads = (job.steps ?? []).filter((step) =>
        step.uses?.startsWith("actions/upload-artifact@"),
      );
      expect(stages).toHaveLength(1);
      expect(stages[0].if).toContain("always()");
      expect(uploads).toHaveLength(1);
      expect(uploads[0].if).toContain(".outcome == 'success'");
      expect(String(uploads[0].with?.path)).toMatch(/-evidence\/$/u);
    },
  );

  it("applies accidental-runnable hygiene in the evidence stager", () => {
    expect(evidenceSource).toContain("The evidence staging root must be fresh.");
    expect(evidenceSource).toContain("Evidence input contains PE or MSI/OLE runnable content");
    expect(evidenceSource).toContain("Evidence input has a non-allowlisted extension");
    expect(evidenceSource).toContain("ConvertFrom-Json");
    expect(evidenceSource).toContain("[IO.FileShare]::Read");
    expect(evidenceSource).toContain("[IO.FileMode]::CreateNew");
    expect(evidenceSource).toContain("evidence-manifest.json");
    expect(evidenceSource).toContain("The staged evidence inventory changed before upload.");
    expect(evidenceSource).toContain("deliberately hostile same-user process");
  });
});
