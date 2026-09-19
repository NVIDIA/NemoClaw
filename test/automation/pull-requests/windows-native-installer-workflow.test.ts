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
  assertWindowsInstallerWorkflow,
  readWindowsInstallerWorkflowSources,
  type WindowsInstallerWorkflowSources,
  type WorkflowJob,
  type WorkflowStep,
} from "../../../tools/windows-installer/workflow-boundary.mts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
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
  ...[
    "windows-finished-request",
    "windows-compiled-application",
    "windows-finished-installer",
    "windows-finished-installed-startup",
    "windows-runtime-controls",
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
