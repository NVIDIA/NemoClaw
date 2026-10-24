// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertWindowsInstallerWorkflow,
  readWindowsInstallerWorkflowSources,
  type WindowsInstallerWorkflowSources,
  type WorkflowJob,
  type WorkflowStep,
} from "../../../tools/windows-installer/workflow-boundary.mts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const evidencePowerShell = process.platform === "win32" ? "pwsh.exe" : "pwsh";
const skipEvidenceProcesses =
  process.platform !== "win32" &&
  spawnSync(evidencePowerShell, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], {
    timeout: 10_000,
  }).status !== 0;
function sources(): WindowsInstallerWorkflowSources {
  return readWindowsInstallerWorkflowSources(repoRoot);
}

function step(job: WorkflowJob, name: string): WorkflowStep {
  const found = job.steps?.find((item) => item.name === name);
  expect(found, "Missing fixture step: " + name).toBeDefined();
  return found!;
}
type Mutation = { name: string; mutate: (value: WindowsInstallerWorkflowSources) => void };
const mutations: Mutation[] = [
  ...(
    [
      [
        "workflow",
        "windows-finished-installer",
        "Build the finished WPF, guarded launcher, transactional MSI and Burn preview",
      ],
      [
        "workflow",
        "windows-finished-reviewed-installer",
        "Rebuild native UI MSI and Burn without rebuilding the qualified runtime",
      ],
      [
        "workflow",
        "windows-finished-candidate-migration",
        "Exercise candidate Burn fixture and diagnostics",
      ],
      [
        "workflow",
        "windows-runtime-controls",
        "Build and exercise actual isolated MSI transactions",
      ],
      ["trusted", "migration", "Build actual Burn failure fixture from the same native UI"],
    ] as const
  ).map(([owner, job, name]) => ({
    name: "WiX package verification missing from " + job,
    mutate: (value: WindowsInstallerWorkflowSources) => {
      const install = step(value[owner].jobs[job], name);
      install.run = install.run!.replace("install-pinned-wix.ps1", "unverified-wix.ps1");
    },
  })),
  ...[["  $controls\n", "  $untrustedControls\n"]].map(([before, after]) => ({
    name: "retained-state controls lose trusted input: " + before.trim(),
    mutate: (value: WindowsInstallerWorkflowSources) => {
      const control = step(
        value.trusted.jobs["full-installed-acceptance"],
        "Verify retained-state qualifier controls from trusted main",
      );
      control.run = control.run!.replace(before, after);
    },
  })),
  ...[
    "test/automation/pull-requests/windows-native-installer-process.test.ts",
    "test/automation/pull-requests/windows-native-installer-process.support.ts",
  ].map((path) => ({
    name: "missing candidate trigger for " + path,
    mutate: (value: WindowsInstallerWorkflowSources) => {
      value.workflow.on.pull_request.paths = value.workflow.on.pull_request.paths.filter(
        (entry: string) => entry !== path,
      );
    },
  })),
  ...[
    ["repository", "untrusted/repository"],
    ["ref", "main"],
    ["path", "controller"],
    ["persist-credentials", true],
    ["submodules", true],
    ["lfs", true],
  ].map(([field, value]) => ({
    name: "candidate source checkout changes " + String(field),
    mutate: (sources: WindowsInstallerWorkflowSources) => {
      step(
        sources.trusted.jobs["full-installed-acceptance"],
        "Check out selected-agent candidate source as comparison data",
      ).with![String(field)] = value;
    },
  })),
  {
    name: "candidate source checkout omits Hermes",
    mutate: (sources) => {
      step(
        sources.trusted.jobs["full-installed-acceptance"],
        "Check out selected-agent candidate source as comparison data",
      ).if = "${{ inputs.agent == 'openclaw' }}";
    },
  },
  {
    name: "candidate source checkout ignores failure",
    mutate: (sources) => {
      step(
        sources.trusted.jobs["full-installed-acceptance"],
        "Check out selected-agent candidate source as comparison data",
      )["continue-on-error"] = true;
    },
  },
  {
    name: "OpenClaw source admission uses controller source as artifact source",
    mutate: (sources) => {
      const acceptance = step(
        sources.trusted.jobs["full-installed-acceptance"],
        "Exercise installed preview, real inference and owned cleanup",
      );
      acceptance.run = acceptance.run!.replace(
        "GITHUB_WORKSPACE\\artifact-source",
        "GITHUB_WORKSPACE\\controller",
      );
    },
  },
  ...[
    "request_kind",
    "candidate_sha",
    "agent",
    "validation_scope",
    "build_allowed",
    "trusted_main",
    "exact_workflow",
    "credential_authorized",
  ].map((name) => ({
    name: "candidate build loses output routing " + name,
    mutate: (value: WindowsInstallerWorkflowSources) => {
      const outputs = value.workflow.jobs["windows-finished-request"].outputs!;
      outputs[name] = outputs[name].replace(`steps.candidate_build.outputs.${name} || `, "");
    },
  })),
  ...[
    "Resolve a credential-free diagnostic dispatch",
    "Authorize exact internal PR from the exact main controller",
  ].map((name) => ({
    name: "candidate build overlaps " + name,
    mutate: (value: WindowsInstallerWorkflowSources) => {
      const admission = step(value.workflow.jobs["windows-finished-request"], name);
      admission.if = admission.if!.replace("!inputs.build_windows_native_candidate && ", "");
    },
  })),
  ...["windows-finished-installer", "windows-finished-candidate-migration"].map((name) => ({
    name: "cancelled run starts " + name,
    mutate: (value: WindowsInstallerWorkflowSources) => {
      const job = value.workflow.jobs[name];
      job.if = job.if!.replace("!cancelled() && ", "");
    },
  })),
  {
    name: "build-only request starts installed migration",
    mutate: (value) => {
      const job = value.workflow.jobs["windows-finished-candidate-migration"];
      job.if = job.if!.replace(
        "needs.windows-finished-request.outputs.request_kind != 'candidate-build' && ",
        "",
      );
    },
  },
  ...[
    "Prepare pinned interpreters for the finished Hermes producer",
    "Produce and test Hermes with the same-run native binaries",
    "Admit the same-run Personal-passing complete Hermes candidate",
  ].flatMap((name) => [
    {
      name: "finished Hermes skips current production: " + name,
      mutate: (value: WindowsInstallerWorkflowSources) => {
        step(value.workflow.jobs["windows-finished-installer"], name).if = "${{ false }}";
      },
    },
    {
      name: "finished Hermes ignores production failure: " + name,
      mutate: (value: WindowsInstallerWorkflowSources) => {
        step(value.workflow.jobs["windows-finished-installer"], name)["continue-on-error"] = true;
      },
    },
  ]),
  ...[
    [
      "Produce and test Hermes with the same-run native binaries",
      "$revision -cne $env:CANDIDATE_SHA",
      "$false",
    ],
    [
      "Produce and test Hermes with the same-run native binaries",
      "--toolchain 1.95.0-aarch64-pc-windows-msvc",
      "--toolchain stable",
    ],
    [
      "Produce and test Hermes with the same-run native binaries",
      '-NativeCompatibilityDirectory "$work\\native-proof\\bash-compat-evidence"',
      "",
    ],
    [
      "Admit the same-run Personal-passing complete Hermes candidate",
      '--same-run-personal-directory "$work\\personal-production"',
      "",
    ],
  ].map(([name, before, after]) => ({
    name: "finished Hermes loses same-run binding: " + before,
    mutate: (value: WindowsInstallerWorkflowSources) => {
      const target = step(value.workflow.jobs["windows-finished-installer"], name);
      target.run = target.run!.replace(before, after);
    },
  })),
  ...[
    "Build and qualify current Personal native inputs",
    "Prepare the complete candidate and test canonical Personal components",
  ].map((name) => ({
    name: "Personal producer ignores failure: " + name,
    mutate: (value: WindowsInstallerWorkflowSources) => {
      step(value.workflow.jobs["official-hermes-personal-candidate"], name)["continue-on-error"] =
        true;
    },
  })),
  ...[
    [
      "Build and qualify current Personal native inputs",
      "run-bash-compat.ps1",
      "reuse-qualified-proof.py",
    ],
    ["Build and qualify current Personal native inputs", "$head -cne $env:GITHUB_SHA", "$false"],
    ["Prepare the complete candidate and test canonical Personal components", "@native", ""],
    [
      "Prepare the complete candidate and test canonical Personal components",
      "--toolchain 1.95.0",
      "--toolchain stable",
    ],
  ].map(([name, before, after]) => ({
    name: "Personal producer loses current input binding: " + before,
    mutate: (value: WindowsInstallerWorkflowSources) => {
      const target = step(value.workflow.jobs["official-hermes-personal-candidate"], name);
      target.run = target.run!.replace(before, after);
    },
  })),
  {
    name: "Personal native build is skipped for ordinary qualification",
    mutate: (value) => {
      step(
        value.workflow.jobs["official-hermes-personal-candidate"],
        "Build and qualify current Personal native inputs",
      ).if = "${{ false }}";
    },
  },
  {
    name: "failed Personal runtime promoted to finished inputs",
    mutate: (value) => {
      step(
        value.workflow.jobs["official-hermes-personal-candidate"],
        "Preserve current native Personal runtime inputs",
      ).if = "${{ always() }}";
    },
  },
  {
    name: "native Bash producer checked out from an old source",
    mutate: (value) => {
      step(
        value.workflow.jobs["windows-bash-compatibility-reuse"],
        "Check out current Bash qualification inputs",
      ).with!.ref = "old-source";
    },
  },
  {
    name: "expired historical Bash evidence substituted for current execution",
    mutate: (value) => {
      value.workflow.jobs["windows-bash-compatibility-reuse"].steps!.push({
        uses: "actions/download-artifact@old",
        with: { "run-id": 35207682561 },
      });
    },
  },
  {
    name: "current native Bash execution replaced with historical receipt rewriting",
    mutate: (value) => {
      step(
        value.workflow.jobs["windows-bash-compatibility-reuse"],
        "Build and qualify exact current native compatibility",
      ).run = "python reuse-qualified-proof.py";
    },
  },
  ...[
    "Verify exact native producer source",
    "Build and qualify exact current native compatibility",
    "Seal same-run exact-input Bash evidence",
  ].flatMap((name) => [
    {
      name: "skipped native Bash boundary: " + name,
      mutate: (value: WindowsInstallerWorkflowSources) => {
        step(value.workflow.jobs["windows-bash-compatibility-reuse"], name).if = "${{ false }}";
      },
    },
    {
      name: "ignored native Bash failure: " + name,
      mutate: (value: WindowsInstallerWorkflowSources) => {
        step(value.workflow.jobs["windows-bash-compatibility-reuse"], name)["continue-on-error"] =
          true;
      },
    },
  ]),
  ...[
    "$proof.normalCleanup -cne $true",
    "$runner.cleanup.workRootRemoved -cne $true",
    "$runner.sourceRevision -cne $env:CANDIDATE_SHA",
  ].map((predicate) => ({
    name: "native Bash transfer without " + predicate,
    mutate: (value: WindowsInstallerWorkflowSources) => {
      const seal = step(
        value.workflow.jobs["windows-bash-compatibility-reuse"],
        "Seal same-run exact-input Bash evidence",
      );
      seal.run = seal.run!.replace(predicate, "$false");
    },
  })),
  {
    name: "native Bash diagnostic upload includes executable payloads",
    mutate: (value) => {
      step(
        value.workflow.jobs["windows-bash-compatibility-reuse"],
        "Preserve current native Bash diagnostic records without executables",
      ).with!.path = "${{ runner.temp }}/finished-bash-evidence/**";
    },
  },
  ...[
    "tools/windows-installer/**",
    "test/automation/pull-requests/windows-native-installer-workflow.test.ts",
  ].map((path) => ({
    name: "missing Windows workflow trigger for " + path,
    mutate: (value: WindowsInstallerWorkflowSources) => {
      value.workflow.on.pull_request.paths = value.workflow.on.pull_request.paths.filter(
        (candidate) => candidate !== path,
      );
    },
  })),
  ...["NVIDIA_API_KEY", "NVIDIA_INFERENCE_API_KEY"].map((name) => ({
    name: "missing protected evidence comparison credential " + name,
    mutate: (value: WindowsInstallerWorkflowSources) => {
      delete step(
        value.trusted.jobs["full-installed-acceptance"],
        "Stage only non-runnable full acceptance evidence",
      ).env![name];
    },
  })),
  {
    name: "credentialed evidence without mandatory credential comparison",
    mutate: (value) => {
      const staging = step(
        value.trusted.jobs["full-installed-acceptance"],
        "Stage only non-runnable full acceptance evidence",
      );
      staging.run = staging.run!.replace("-RequireProtectedCredential", "");
    },
  },
  {
    name: "upload after credential evidence staging fails",
    mutate: (value) => {
      step(
        value.trusted.jobs["full-installed-acceptance"],
        "Preserve full installed acceptance evidence",
      ).if = "${{ always() }}";
    },
  },
  ...[
    "windows-finished-request",
    "windows-compiled-application",
    "windows-finished-installer",
    "windows-finished-installed-startup",
    "windows-finished-candidate-migration",
    "windows-runtime-controls",
    "windows-runtime-preflight",
  ].flatMap((name) => [
    {
      name: "a protected environment on " + name,
      mutate: (value: WindowsInstallerWorkflowSources) => {
        value.workflow.jobs[name].environment = "privileged";
      },
    },
    {
      name: "a secret in " + name,
      mutate: (value: WindowsInstallerWorkflowSources) => {
        value.workflow.jobs[name].steps!.push({ run: "${{ secrets.INFERENCE_KEY }}" });
      },
    },
  ]),
  {
    name: "write access in candidate jobs",
    mutate: (value) => {
      value.workflow.permissions.contents = "write";
    },
  },
  {
    name: "missing candidate migration qualification",
    mutate: (value) => {
      delete value.workflow.jobs["windows-finished-candidate-migration"];
    },
  },
  {
    name: "migration controllers checked out from main instead of the candidate",
    mutate: (value) => {
      step(
        value.workflow.jobs["windows-finished-candidate-migration"],
        "Check out the exact candidate migration controllers",
      ).with!.ref = "main";
    },
  },
  ...[
    "Exercise candidate Burn fixture and diagnostics",
    "Exercise candidate preview migration and selective reset",
    "Bind candidate migration proof to controller and installer",
  ].map((name) => ({
    name: "skipped " + name,
    mutate: (value: WindowsInstallerWorkflowSources) => {
      step(value.workflow.jobs["windows-finished-candidate-migration"], name).if = "${{ false }}";
    },
  })),
  ...["build-burn-diagnostics-fixture.ps1", "test-burn-diagnostics.ps1"].map((file) => ({
    name: "missing candidate " + file,
    mutate: (value: WindowsInstallerWorkflowSources) => {
      const control = step(
        value.workflow.jobs["windows-finished-candidate-migration"],
        "Exercise candidate Burn fixture and diagnostics",
      );
      control.run = control.run!.replaceAll(file, "unrelated.ps1");
    },
  })),
  {
    name: "candidate migration executing trusted-main scripts",
    mutate: (value) => {
      const control = step(
        value.workflow.jobs["windows-finished-candidate-migration"],
        "Exercise candidate preview migration and selective reset",
      );
      control.run = control.run!.replaceAll("\\candidate\\", "\\controller\\");
    },
  },
  {
    name: "trusted qualification without candidate migration dependency",
    mutate: (value) => {
      value.workflow.jobs["windows-finished-trusted-qualification"].needs = [
        "windows-finished-request",
        "windows-finished-installer",
        "windows-compiled-application",
      ];
    },
  },
  {
    name: "trusted qualification without successful candidate migration",
    mutate: (value) => {
      const call = value.workflow.jobs["windows-finished-trusted-qualification"];
      call.if = call.if!.replace(
        "needs.windows-finished-candidate-migration.result == 'success'",
        "true",
      );
    },
  },
  ...["candidate_migration_evidence_id", "candidate_migration_proof_sha256"].map((input) => ({
    name: "unbound " + input,
    mutate: (value: WindowsInstallerWorkflowSources) => {
      value.workflow.jobs["windows-finished-trusted-qualification"].with![input] = "unbound";
    },
  })),
  ...[
    "controllerSourceRevision",
    "artifactSourceRevision",
    "installerManifestSha256",
    "workflowRunId",
    "workflowRunAttempt",
    "hashlib.sha256(data).hexdigest() == digest",
    "case['resetVerified'] is True",
  ].map((fragment) => ({
    name: "missing candidate migration proof check " + fragment,
    mutate: (value: WindowsInstallerWorkflowSources) => {
      const verify = step(
        value.trusted.jobs["candidate-migration-proof"],
        "Verify candidate controller and artifact identities",
      );
      verify.run = verify.run!.replaceAll(fragment, "omitted");
    },
  })),
  {
    name: "candidate migration proof from another run",
    mutate: (value) => {
      step(
        value.trusted.jobs["candidate-migration-proof"],
        "Download candidate migration evidence from this run",
      ).with!["run-id"] = "older-run";
    },
  },
  {
    name: "publication without successful candidate migration proof",
    mutate: (value) => {
      const publish = value.trusted.jobs["publish-qualified-installer"];
      publish.if = publish.if!.replace(
        "needs.candidate-migration-proof.result == 'success'",
        "true",
      );
    },
  },
  {
    name: "trusted migration labeled as candidate controller code",
    mutate: (value) => {
      const identity = step(
        value.trusted.jobs.migration,
        "Record trusted migration controller identity separately",
      );
      identity.run = identity.run!.replace(
        "controllerSourceRevision=$env:CONTROLLER_SHA",
        "controllerSourceRevision=$env:CANDIDATE_SHA",
      );
    },
  },
  {
    name: "cancellation of manual evidence",
    mutate: (value) => {
      value.workflow.concurrency["cancel-in-progress"] = "${{ true }}";
    },
  },
  {
    name: "credentialed PR admission",
    mutate: (value) => {
      const entry = step(
        value.workflow.jobs["windows-finished-request"],
        "Admit the exact pull request head without credentials",
      );
      entry.run = entry.run!.replace("credential_authorized=false", "credential_authorized=true");
    },
  },
  ...[
    [
      "windows-compiled-application",
      "Verify installed acceptance controller Windows compatibility",
    ],
    ["windows-runtime-controls", "Exercise installed acceptance controller compatibility"],
  ].flatMap(([name, title]) => [
    {
      name: "late controller checks in " + name,
      mutate: (value: WindowsInstallerWorkflowSources) => {
        const job = value.workflow.jobs[name];
        const control = step(job, title);
        job.steps = job.steps!.filter((item) => item !== control);
        job.steps.push(control);
      },
    },
    {
      name: "missing sentinel regression in " + name,
      mutate: (value: WindowsInstallerWorkflowSources) => {
        const control = step(value.workflow.jobs[name], title);
        control.run = control.run!.replaceAll(
          "control-installed-openclaw-input.test.mts",
          "unrelated.test.mts",
        );
      },
    },
  ]),
  {
    name: "an unpinned controller Node",
    mutate: (value) => {
      step(
        value.workflow.jobs["windows-runtime-controls"],
        "Set up actual ARM64 Node for controller preflight and shared-file fixtures",
      ).with!["node-version"] = "latest";
    },
  },
  {
    name: "a missing preflight Node version",
    mutate: (value) => {
      value.workflow.jobs["windows-runtime-preflight"].strategy!.matrix!.node = ["24.18.1"];
    },
  },
  {
    name: "cancellation of the other preflight Node result",
    mutate: (value) => {
      value.workflow.jobs["windows-runtime-preflight"].strategy!["fail-fast"] = true;
    },
  },
  {
    name: "preflight of a different candidate commit",
    mutate: (value) => {
      step(
        value.workflow.jobs["windows-runtime-preflight"],
        "Check out the exact candidate preflight",
      ).with!.ref = "main";
    },
  },
  {
    name: "unpinned preflight Node",
    mutate: (value) => {
      step(
        value.workflow.jobs["windows-runtime-preflight"],
        "Set up pinned ARM64 preflight Node",
      ).with!["node-version"] = "latest";
    },
  },
  ...[
    "control-installed-openclaw-input.test.mts",
    "build-immutable-package-cleanup.test.mts",
    "qualify-installed-openclaw.test.mts",
    "native-turn-cleanup.test.mts",
    "native-hermes-turn-cleanup.test.mts",
    "runtime-published-resources.test.mts",
  ].map((file) => ({
    name: "missing early " + file,
    mutate: (value: WindowsInstallerWorkflowSources) => {
      const entry = step(
        value.workflow.jobs["windows-runtime-preflight"],
        "Verify observer shutdown and qualification cleanup before building",
      );
      entry.run = entry.run!.replaceAll(file, "unrelated.test.mts");
    },
  })),
  {
    name: "missing compiled OpenClaw restart controls",
    mutate: (value) => {
      const entry = step(
        value.workflow.jobs["windows-compiled-application"],
        "Verify installed acceptance controller Windows compatibility",
      );
      entry.run = entry.run!.replaceAll(
        "qualify-installed-openclaw.test.mts",
        "unrelated.test.mts",
      );
    },
  },
  ...[
    {
      name: "skipped",
      apply: (entry: WorkflowStep) => {
        entry.if = "${{ false }}";
      },
    },
    {
      name: "tolerated",
      apply: (entry: WorkflowStep) => {
        entry["continue-on-error"] = true;
      },
    },
  ].map(({ name, apply }) => ({
    name: "early cleanup preflight " + name,
    mutate: (value: WindowsInstallerWorkflowSources) => {
      apply(
        step(
          value.workflow.jobs["windows-runtime-preflight"],
          "Verify observer shutdown and qualification cleanup before building",
        ),
      );
    },
  })),
  ...[
    {
      name: "missing",
      apply: (job: WorkflowJob, entry: WorkflowStep) => {
        job.steps = job.steps!.filter((item) => item !== entry);
      },
    },
    {
      name: "skipped",
      apply: (_job: WorkflowJob, entry: WorkflowStep) => {
        entry.if = "${{ false }}";
      },
    },
    {
      name: "tolerated",
      apply: (_job: WorkflowJob, entry: WorkflowStep) => {
        entry["continue-on-error"] = true;
      },
    },
    {
      name: "late",
      apply: (job: WorkflowJob, entry: WorkflowStep) => {
        job.steps = job.steps!.filter((item) => item !== entry);
        job.steps.push(entry);
      },
    },
    {
      name: "candidate-source",
      apply: (_job: WorkflowJob, entry: WorkflowStep) => {
        entry.run = entry.run!.replaceAll(
          "GITHUB_WORKSPACE/controller",
          "GITHUB_WORKSPACE/candidate",
        );
      },
    },
    {
      name: "wrong-node",
      apply: (_job: WorkflowJob, entry: WorkflowStep) => {
        entry.run = entry.run!.replaceAll("$env:TRUSTED_CONTROLLER_NODE", "node");
      },
    },
    {
      name: "no-exit-check",
      apply: (_job: WorkflowJob, entry: WorkflowStep) => {
        entry.run = entry.run!.replaceAll(
          "if ($LASTEXITCODE -ne 0) { throw",
          "if ($false) { throw",
        );
      },
    },
  ].map(({ name, apply }) => ({
    name: "trusted restart controls " + name,
    mutate: (value: WindowsInstallerWorkflowSources) => {
      const job = value.trusted.jobs["full-installed-acceptance"];
      apply(job, step(job, "Verify retained-state qualifier controls from trusted main"));
    },
  })),
  ...["windows-compiled-application", "windows-runtime-controls"].map((name) => ({
    name: "missing preflight dependency in " + name,
    mutate: (value: WindowsInstallerWorkflowSources) => {
      value.workflow.jobs[name].needs = ["windows-finished-request"];
    },
  })),
  {
    name: "compilation without successful preflight",
    mutate: (value) => {
      const job = value.workflow.jobs["windows-compiled-application"];
      job.if = job.if!.replace("needs.windows-runtime-preflight.result == 'success'", "true");
    },
  },
  ...["windows-finished-installer", "windows-finished-installed-startup"].flatMap((name) => [
    {
      name: "a fallback executable cache in " + name,
      mutate: (value: WindowsInstallerWorkflowSources) => {
        value.workflow.jobs[name].steps!.find((item) =>
          item.uses?.startsWith("actions/cache/restore@"),
        )!.with!["restore-keys"] = "older-";
      },
    },
    {
      name: "a tolerated executable cache miss in " + name,
      mutate: (value: WindowsInstallerWorkflowSources) => {
        value.workflow.jobs[name].steps!.find((item) =>
          item.uses?.startsWith("actions/cache/restore@"),
        )!.with!["fail-on-cache-miss"] = false;
      },
    },
  ]),
  ...(["workflow", "trusted"] as const).map((owner) => ({
    name: "missing nested application verification in " + owner,
    mutate: (value: WindowsInstallerWorkflowSources) => {
      const job =
        value[owner].jobs[
          owner === "workflow" ? "windows-finished-installed-startup" : "full-installed-acceptance"
        ];
      const entry = job.steps!.find(
        (item) =>
          item.name?.startsWith("Verify and materialize exact") &&
          item.run?.includes("$application"),
      )!;
      entry.run = entry.run!.replaceAll("-ExpectedManifestSha256 $env:APPLICATION_MANIFEST", "");
    },
  })),
  {
    name: "public compiled executables",
    mutate: (value) => {
      value.workflow.jobs["windows-compiled-application"].steps!.find((item) =>
        item.uses?.startsWith("actions/upload-artifact@"),
      )!.with!.path = "unqualified.exe";
    },
  },
  ...["first-run-consent-control", "gateway-control"].flatMap((directory) => [
    ...["gateway-control.json", "stdout.log", "stderr.log"].map((file) => ({
      name: `missing ${directory}/${file} diagnostics`,
      mutate: (value: WindowsInstallerWorkflowSources) => {
        const staging = step(
          value.workflow.jobs["windows-compiled-application"],
          "Stage only non-runnable application diagnostics",
        );
        staging.run = staging.run!.replaceAll(`"$work\\${directory}\\${file}"`, '"omitted"');
      },
    })),
    {
      name: `unbounded ${directory} diagnostics`,
      mutate: (value: WindowsInstallerWorkflowSources) => {
        const staging = step(
          value.workflow.jobs["windows-compiled-application"],
          "Stage only non-runnable application diagnostics",
        );
        const report = `"$work\\${directory}\\gateway-control.json"`;
        staging.run = staging.run!.replace(report, `"$work\\${directory}", ${report}`);
      },
    },
  ]),
  ...(["workflow", "trusted"] as const).flatMap((owner) =>
    [
      ".head.sha",
      ".base.sha",
      ".base.ref",
      ".head.repo.owner.type",
      "$TRIGGERING_ACTOR",
      "$ACTOR",
      ".merge_base_commit.sha",
      ".behind_by",
      "admin|maintain|write",
    ].map((fragment) => ({
      name: "missing " + fragment + " authorization in " + owner,
      mutate: (value: WindowsInstallerWorkflowSources) => {
        const job =
          value[owner].jobs[owner === "workflow" ? "windows-finished-request" : "authorize"];
        const entry = job.steps!.find((item) =>
          item.name?.startsWith(
            owner === "workflow"
              ? "Authorize exact internal PR"
              : "Require current main controller",
          ),
        )!;
        entry.run = entry.run!.replaceAll(fragment, "removed-control");
      },
    })),
  ),
  {
    name: "a different trusted workflow revision",
    mutate: (value) => {
      value.workflow.jobs["windows-finished-trusted-qualification"].uses =
        "NVIDIA/NemoClaw/.github/workflows/windows-native-installer-trusted.yaml@main";
    },
  },
  ...["trusted_main", "exact_workflow", "exact_pr", "credential_authorized"].map((flag) => ({
    name: "an absent " + flag + " call gate",
    mutate: (value: WindowsInstallerWorkflowSources) => {
      const call = value.workflow.jobs["windows-finished-trusted-qualification"];
      call.if = call.if!.replaceAll(flag, "omitted");
    },
  })),
  ...["full-installed-acceptance", "publish-qualified-installer"].map((name) => ({
    name: "an absent protected environment on " + name,
    mutate: (value: WindowsInstallerWorkflowSources) => {
      delete value.trusted.jobs[name].environment;
    },
  })),
  {
    name: "a secret outside protected jobs",
    mutate: (value) => {
      value.trusted.jobs.authorize.steps!.push({ run: "${{ secrets.INFERENCE_KEY }}" });
    },
  },
  {
    name: "inference before controller proof",
    mutate: (value) => {
      const job = value.trusted.jobs["full-installed-acceptance"];
      const entry = step(job, "Exercise installed preview, real inference and owned cleanup");
      job.steps = [entry, ...job.steps!.filter((item) => item !== entry)];
    },
  },
  {
    name: "an unpinned trusted Node",
    mutate: (value) => {
      const entry = step(
        value.trusted.jobs["full-installed-acceptance"],
        "Verify and materialize exact qualified inputs",
      );
      entry.run = entry.run!.replace(
        "97cce5301a815d2dce07ac5bfd1e6039eae88185ec1d10ae4f8cb712f1732878",
        "0".repeat(64),
      );
    },
  },
  {
    name: "a revived legacy installer lane",
    mutate: (value) => {
      value.workflow.jobs["windows-native-package-diagnostic"].if = "${{ true }}";
    },
  },
  {
    name: "publication without migration dependency",
    mutate: (value) => {
      value.trusted.jobs["publish-qualified-installer"].needs = [
        "authorize",
        "full-installed-acceptance",
      ];
    },
  },
  ...[
    "needs.full-installed-acceptance.result == 'success'",
    "needs.migration.result == 'success'",
  ].map((condition) => ({
    name: "publication without " + condition,
    mutate: (value: WindowsInstallerWorkflowSources) => {
      const job = value.trusted.jobs["publish-qualified-installer"];
      job.if = job.if!.replaceAll(condition, "true");
    },
  })),
  {
    name: "wildcard runnable publication",
    mutate: (value) => {
      value.trusted.jobs["publish-qualified-installer"].steps!.find((item) =>
        item.uses?.startsWith("actions/upload-artifact@"),
      )!.with!.path = "package/*.exe";
    },
  },
  {
    name: "missing publication inventory check",
    mutate: (value) => {
      const entry = step(
        value.trusted.jobs["publish-qualified-installer"],
        "Verify exact accepted installer bytes",
      );
      entry.run = entry.run!.replaceAll("-ExpectedPackageRunnables", "-Unused");
    },
  },
  ...[
    "workflowRunId",
    "workflowRunAttempt",
    "ReparsePoint",
    "A transfer cache entry differs from its manifest.",
  ].map((fragment) => ({
    name: "missing transfer check " + fragment,
    mutate: (value: WindowsInstallerWorkflowSources) => {
      value.transferSource = value.transferSource.replaceAll(fragment, "removed-control");
    },
  })),
  ...[
    "Evidence input contains PE or MSI/OLE runnable content",
    "[IO.FileMode]::CreateNew",
    "The staged evidence inventory changed before upload.",
  ].map((fragment) => ({
    name: "missing evidence guard " + fragment,
    mutate: (value: WindowsInstallerWorkflowSources) => {
      value.evidenceSource = value.evidenceSource.replaceAll(fragment, "removed-control");
    },
  })),
];

describe("Windows installer workflow boundary validation", () => {
  it("accepts the shipped candidate and trusted workflow boundaries", () => {
    expect(() => assertWindowsInstallerWorkflow(sources())).not.toThrow();
  });
  it.each(mutations)("rejects $name", ({ mutate }) => {
    const value = sources();
    mutate(value);
    expect(() => assertWindowsInstallerWorkflow(value)).toThrow();
  });
});

const proofCases: {
  name: string;
  expectedStatus?: number;
  fixture?: Record<string, unknown>;
  burn?: Record<string, unknown>;
  migration?: Record<string, unknown>;
  proof?: Record<string, unknown>;
  editFiles?: (files: { file: string; sha256: string }[]) => void;
  encode?: (text: string) => string;
}[] = [
  { name: "valid", expectedStatus: 0 },
  { name: "wrong controller", proof: { controllerSourceRevision: "c".repeat(40) } },
  { name: "wrong artifact", proof: { artifactSourceRevision: "c".repeat(40) } },
  { name: "wrong installer", proof: { installerManifestSha256: "c".repeat(64) } },
  { name: "wrong run", proof: { workflowRunId: "124" } },
  { name: "wrong attempt", proof: { workflowRunAttempt: "2" } },
  { name: "wrong agent", proof: { agent: "hermes" } },
  { name: "unpassed proof", proof: { passed: false } },
  { name: "failed Burn", burn: { status: "failed" } },
  { name: "failed migration", migration: { status: "failed" } },
  { name: "incomplete cleanup", migration: { cleanupErrors: ["retained state"] } },
  {
    name: "missing case",
    migration: { cases: [{ kind: "conventional-reinstall", resetVerified: true }] },
  },
  {
    name: "failed reset",
    migration: {
      cases: [
        { kind: "conventional-reinstall", resetVerified: false },
        { kind: "native-replace-preview", resetVerified: true },
      ],
    },
  },
  {
    name: "changed report",
    editFiles: (files) => {
      files[1].sha256 = "0".repeat(64);
    },
  },
  {
    name: "path traversal",
    editFiles: (files) => {
      files[1].file = "../outside.json";
    },
  },
  { name: "duplicate property", encode: (text) => '{"passed":false,' + text.slice(1) },
  { name: "distribution fixture", fixture: { intendedForDistribution: true } },
  { name: "oversized proof", encode: (text) => text + " ".repeat(1048576) },
];
it.each(proofCases)("checks downloaded candidate migration proof: $name", (scenario) => {
  const root = mkdtempSync(join(tmpdir(), "candidate-migration-proof-"));
  const revision = "a".repeat(40);
  const manifest = "b".repeat(64);
  const fixture = {
    sourceRevision: revision,
    classification: "actual-burn-host-preparation-failure-fixture",
    intendedForDistribution: false,
    ...scenario.fixture,
  };
  const burn = {
    sourceRevision: revision,
    classification: "actual-burn-prerequisite-failure-qualification",
    agent: "openclaw",
    status: "pass",
    cleanupErrors: [] as string[],
    packageNotInstalled: true,
    ...scenario.burn,
  };
  const migration = {
    sourceRevision: revision,
    classification: "actual-published-preview-native-migration",
    newAgent: "openclaw",
    status: "pass",
    cleanupErrors: [] as string[],
    installationRootRemoved: true,
    cases: [
      { kind: "conventional-reinstall", resetVerified: true },
      { kind: "native-replace-preview", resetVerified: true },
    ],
    ...scenario.migration,
  };
  try {
    const reports = [
      ["diagnostics-fixture/fixture.json", fixture],
      ["burn-diagnostics/burn-diagnostics.json", burn],
      ["migration/preview-migration.json", migration],
    ] as const;
    const files = reports.map(([file, report]) => {
      const content = JSON.stringify(report);
      const target = join(root, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
      return { file: String(file), sha256: createHash("sha256").update(content).digest("hex") };
    });
    scenario.editFiles?.(files);
    const proof = {
      schemaVersion: 1,
      classification: "same-run-candidate-migration-controllers",
      passed: true,
      controllerSourceRevision: revision,
      artifactSourceRevision: revision,
      installerManifestSha256: manifest,
      agent: "openclaw",
      workflowRunId: "123",
      workflowRunAttempt: "1",
      files,
      ...scenario.proof,
    };
    const text = (scenario.encode ?? ((value: string) => value))(JSON.stringify(proof));
    writeFileSync(join(root, "candidate-migration-controller.json"), text);
    const program = step(
      sources().trusted.jobs["candidate-migration-proof"],
      "Verify candidate controller and artifact identities",
    ).run!;
    const result = spawnSync(process.platform === "win32" ? "python" : "python3", ["-c", program], {
      encoding: "utf8",
      timeout: 30000,
      windowsHide: true,
      env: {
        ...process.env,
        PROOF_ROOT: root,
        PROOF_SHA256: createHash("sha256").update(text).digest("hex"),
        CANDIDATE_SHA: revision,
        INSTALLER_MANIFEST: manifest,
        SELECTED_AGENT: "openclaw",
        GITHUB_RUN_ID: "123",
        GITHUB_RUN_ATTEMPT: "1",
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(scenario.expectedStatus ?? 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.skipIf(skipEvidenceProcesses).each([
  { exitCode: 0, summary: "ok. 18 passed; 0 failed; 0 ignored;", rejected: false },
  { exitCode: 1, summary: "ok. 18 passed; 0 failed; 0 ignored;", rejected: true },
  { exitCode: 0, summary: "ok. 15 passed; 0 failed; 0 ignored;", rejected: true },
  { exitCode: 0, summary: "ok. 17 passed; 0 failed; 1 ignored;", rejected: true },
  { exitCode: 0, summary: "FAILED. 17 passed; 1 failed; 0 ignored;", rejected: true },
  { exitCode: 0, summary: "ok. 180 passed; 0 failed; 0 ignored;", rejected: true },
  { exitCode: 0, summary: "", rejected: true },
])("checks the state ownership result: $exitCode / $summary", (scenario) => {
  const root = mkdtempSync(join(tmpdir(), "windows-state-result-"));
  const script = join(root, "result-controls.ps1");
  const run = step(
    sources().workflow.jobs["windows-runtime-controls"],
    "Exercise shared configuration and per-agent state ownership",
  ).run!;
  try {
    mkdirSync(join(root, "windows-runtime-controls"));
    writeFileSync(
      script,
      `
$ErrorActionPreference = 'Stop'
function rustup {
  $global:LASTEXITCODE = ${scenario.exitCode}
  Write-Output 'test result: ${scenario.summary}'
}
$rejected = $false
try {
  & {
${run}
  } | Out-Null
} catch { $rejected = $true }
if ($rejected -ne $${scenario.rejected}) { throw 'State ownership result was misclassified.' }
`,
    );
    const result = spawnSync(
      evidencePowerShell,
      ["-NoProfile", "-NonInteractive", "-File", script],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 30000,
        env: { ...process.env, RUNNER_TEMP: root, GITHUB_WORKSPACE: repoRoot },
      },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.skipIf(skipEvidenceProcesses)(
  "accepts only a complete successful MSI Python test result",
  () => {
    const discovered = spawnSync(
      process.platform === "win32" ? "python" : "python3",
      [
        "-c",
        "import unittest; print(unittest.defaultTestLoader.discover('packaging/windows/installer', pattern='test_*.py').countTestCases())",
      ],
      { cwd: repoRoot, encoding: "utf8", timeout: 30000, windowsHide: true },
    );
    expect(discovered.status, discovered.stdout + discovered.stderr).toBe(0);
    expect(discovered.stdout.trim()).toMatch(/^[1-9][0-9]*$/);
    const completeCount = discovered.stdout.trim();
    const root = mkdtempSync(join(tmpdir(), "windows-msi-result-"));
    const script = join(root, "result-controls.ps1");
    const run = step(
      sources().workflow.jobs["windows-runtime-controls"],
      "Check MSI manifest controls",
    ).run!;
    try {
      mkdirSync(join(root, "windows-runtime-controls"));
      writeFileSync(
        script,
        `
$ErrorActionPreference = 'Stop'
$gate = {
${run}
}
function python {
  $global:LASTEXITCODE = $case.ExitCode
  Write-Output $case.Text
}
foreach ($case in @(
  @{ ExitCode = 0; Text = "Ran ${completeCount} tests in 1.2s\nOK"; Reject = $false },
  @{ ExitCode = 1; Text = "Ran ${completeCount} tests in 1.2s\nOK"; Reject = $true },
  @{ ExitCode = 0; Text = "Ran 130 tests in 1.2s\nOK"; Reject = $true },
  @{ ExitCode = 0; Text = "Ran 89 tests in 1.2s\nOK"; Reject = $true },
  @{ ExitCode = 0; Text = "Ran ${completeCount} tests in 1.2s\nOK (skipped=1)"; Reject = $true },
  @{ ExitCode = 0; Text = "Ran ${completeCount} tests in 1.2s\nFAILED"; Reject = $true },
  @{ ExitCode = 0; Text = "Ran 1300 tests in 1.2s\nOK"; Reject = $true },
  @{ ExitCode = 0; Text = ''; Reject = $true }
)) {
  $rejected = $false
  try { & $gate | Out-Null } catch { $rejected = $true }
  if ($rejected -ne $case.Reject) { throw 'MSI test result was misclassified.' }
}
Write-Output '8 result controls passed'
`,
      );
      const result = spawnSync(
        evidencePowerShell,
        ["-NoProfile", "-NonInteractive", "-File", script],
        {
          encoding: "utf8",
          windowsHide: true,
          timeout: 30000,
          env: { ...process.env, RUNNER_TEMP: root, GITHUB_WORKSPACE: repoRoot },
        },
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("8 result controls passed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

it.skipIf(skipEvidenceProcesses)("rejects PE content disguised as allowlisted evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "windows-native-evidence-"));
  const input = join(root, "candidate-evidence.json");
  const output = join(root, "staged");
  const evidenceScript = join(repoRoot, "scripts/checks/stage-windows-native-evidence.ps1");
  try {
    writeFileSync(input, Buffer.from([0x4d, 0x5a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
    const result = spawnSync(
      evidencePowerShell,
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
});

const evidenceKey = "nvapi-fixture-NotARealCredential-123456789";
const secondEvidenceKey = 'fixture-inference<&/+-"key-98456321';
const evidenceCases = [
  { name: "UTF-8 log", bytes: Buffer.from(evidenceKey) },
  { name: "UTF-16 log", bytes: Buffer.from(evidenceKey, "utf16le") },
  {
    name: "UTF-32 log",
    bytes: Buffer.from([...evidenceKey].flatMap((value) => [value.charCodeAt(0), 0, 0, 0])),
  },
  {
    name: "UTF-32 big-endian log",
    bytes: Buffer.from([...evidenceKey].flatMap((value) => [0, 0, 0, value.charCodeAt(0)])),
  },
  { name: "UTF-16 big-endian log", bytes: Buffer.from(evidenceKey, "utf16le").swap16() },
  {
    name: "JSON escaped inference key",
    bytes: Buffer.from(JSON.stringify({ apiKey: secondEvidenceKey })),
    extension: ".json",
  },
  {
    name: "JSON unicode escapes",
    bytes: Buffer.from(
      [...evidenceKey]
        .map((value) => "\\u" + value.charCodeAt(0).toString(16).padStart(4, "0"))
        .join(""),
    ),
  },
  { name: "URL encoded inference key", bytes: Buffer.from(encodeURIComponent(secondEvidenceKey)) },
  { name: "base64 key", bytes: Buffer.from(Buffer.from(evidenceKey).toString("base64")) },
  {
    name: "base64url inference key",
    bytes: Buffer.from(Buffer.from(secondEvidenceKey).toString("base64url")),
  },
  {
    name: "binary diagnostic",
    bytes: Buffer.concat([Buffer.from([0, 1, 255]), Buffer.from(evidenceKey)]),
    extension: ".etl",
  },
  { name: "key across scan chunks", bytes: Buffer.from("x".repeat(65530) + evidenceKey) },
  {
    name: "key in evidence filename",
    bytes: Buffer.from("safe content"),
    filename: evidenceKey + ".txt",
  },
];

it.skipIf(skipEvidenceProcesses).each(evidenceCases)(
  "blocks credential-bearing evidence: $name",
  ({ bytes, extension, filename }) => {
    const root = mkdtempSync(join(tmpdir(), "windows-native-evidence-secret-"));
    const input = join(root, filename ?? "diagnostic" + (extension ?? ".log"));
    const output = join(root, "staged");
    try {
      writeFileSync(input, bytes);
      const result = spawnSync(
        evidencePowerShell,
        [
          "-NoProfile",
          "-NonInteractive",
          "-File",
          join(repoRoot, "scripts/checks/stage-windows-native-evidence.ps1"),
          "-SourceBase",
          root,
          "-InputPath",
          input,
          "-OutputRoot",
          output,
          "-RequireProtectedCredential",
        ],
        {
          encoding: "utf8",
          windowsHide: true,
          timeout: 30_000,
          env: {
            ...process.env,
            NVIDIA_API_KEY: evidenceKey,
            NVIDIA_INFERENCE_API_KEY: secondEvidenceKey,
          },
        },
      );
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain(
        "Evidence contains a protected credential; upload is blocked.",
      );
      expect(result.stdout + result.stderr).not.toContain(evidenceKey);
      expect(result.stdout + result.stderr).not.toContain(secondEvidenceKey);
      expect(existsSync(join(output, "evidence-manifest.json"))).toBe(false);
      expect(existsSync(join(output, filename ?? "diagnostic" + (extension ?? ".log")))).toBe(
        false,
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);

function withStagedSafeEvidence(
  credential: string,
  inspect: (value: {
    status: number | null;
    diagnostics: string;
    output: string;
    content: string;
  }) => void,
) {
  const root = mkdtempSync(join(tmpdir(), "windows-native-evidence-safe-"));
  const input = join(root, "diagnostic.json");
  const output = join(root, "staged");
  const content = '{"passed":true,"credential":"[REDACTED]"}';
  try {
    writeFileSync(input, content);
    const result = spawnSync(
      evidencePowerShell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        join(repoRoot, "scripts/checks/stage-windows-native-evidence.ps1"),
        "-SourceBase",
        root,
        "-InputPath",
        input,
        "-OutputRoot",
        output,
        "-RequireProtectedCredential",
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 30_000,
        env: {
          ...process.env,
          NVIDIA_API_KEY: credential,
          NVIDIA_INFERENCE_API_KEY: "",
        },
      },
    );
    inspect({ status: result.status, diagnostics: result.stdout + result.stderr, output, content });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

it.skipIf(skipEvidenceProcesses)(
  "rejects protected evidence when comparison credentials are absent",
  () => {
    withStagedSafeEvidence("", ({ status, diagnostics, output }) => {
      expect(status).toBe(1);
      expect(diagnostics).toContain("Protected evidence requires a credential for comparison.");
      expect(existsSync(join(output, "evidence-manifest.json"))).toBe(false);
    });
  },
);

it.skipIf(skipEvidenceProcesses)(
  "stages safe evidence byte-for-byte when comparison credentials are present",
  () => {
    withStagedSafeEvidence(evidenceKey, ({ status, output, content }) => {
      expect(status).toBe(0);
      expect(readFileSync(join(output, "diagnostic.json"), "utf8")).toBe(content);
      const manifest = JSON.parse(readFileSync(join(output, "evidence-manifest.json"), "utf8"));
      expect(manifest.files).toEqual([
        {
          path: "diagnostic.json",
          bytes: Buffer.byteLength(content),
          sha256: createHash("sha256").update(content).digest("hex"),
        },
      ]);
    });
  },
);
