// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  {
    name: "reviewed installer cache uses a path different from its consumers",
    mutate: (value) => {
      step(
        value.workflow.jobs["windows-finished-reviewed-installer"],
        "Retain rebuilt executables only in the same-run private cache",
      ).with!.path = "${{ runner.temp }}/wrong-transfer";
    },
  },
  ...["full-installed-acceptance", "migration", "publish-qualified-installer"].map((name) => ({
    name: "reviewed installer restore path changes in " + name,
    mutate: (value: WindowsInstallerWorkflowSources) => {
      value.trusted.jobs[name].steps!.find((step) =>
        step.uses?.startsWith("actions/cache/restore@"),
      )!.with!.path = "${{ runner.temp }}/wrong-transfer";
    },
  })),
  {
    name: "OpenClaw no longer builds the finished runtime image",
    mutate: (value) => {
      step(
        value.workflow.jobs["windows-finished-installer"],
        "Build the selected runtime as one finished application image",
      ).if = "false";
    },
  },
  {
    name: "initial installer omits the runtime image input",
    mutate: (value) => {
      const build = step(
        value.workflow.jobs["windows-finished-installer"],
        "Build the finished WPF, guarded launcher, transactional MSI and Burn preview",
      );
      build.run = build.run!.replace("@imageArguments", "");
    },
  },
  ...["trusted_main", "exact_workflow", "exact_pr", "credential_authorized"].map((gate) => ({
    name: "bootstrap call loses " + gate,
    mutate: (value: WindowsInstallerWorkflowSources) => {
      const job = value.workflow.jobs["windows-finished-runtime-qualification"];
      job.if = job.if!.replace(`needs.windows-finished-request.outputs.${gate} == 'true'`, "true");
    },
  })),
  {
    name: "cancelled controller can still start credentialed acceptance",
    mutate: (value) => {
      const job = value.trusted.jobs["full-installed-acceptance"];
      job.if = job.if!.replace("!cancelled() && ", "");
    },
  },
  {
    name: "reviewed packaging runs before completed protected runtime review",
    mutate: (value) => {
      const job = value.workflow.jobs["windows-finished-reviewed-installer"];
      job.if = job.if!.replace(
        "needs.windows-finished-runtime-qualification.result == 'success'",
        "true",
      );
    },
  },
  {
    name: "reviewed packaging receives a protected environment",
    mutate: (value) => {
      value.workflow.jobs["windows-finished-reviewed-installer"].environment = "qualification";
    },
  },
  {
    name: "reviewed packaging drops decision hash comparison",
    mutate: (value) => {
      const verify = step(
        value.workflow.jobs["windows-finished-reviewed-installer"],
        "Verify original package and exact reviewed decision before executable use",
      );
      verify.run = verify.run!.replace("-cne $env:AVAILABILITY_SHA256", "-cne 'unchecked'");
    },
  },
  {
    name: "reviewed packaging rebuilds instead of reusing runtime input",
    mutate: (value) => {
      const build = step(
        value.workflow.jobs["windows-finished-reviewed-installer"],
        "Rebuild native UI MSI and Burn without rebuilding the qualified runtime",
      );
      build.run = build.run!.replace("-UnqualifiedPackageDirectory", "-OtherDirectory");
    },
  },
  ...["installer_cache_key", "installer_manifest_sha256"].map((name) => ({
    name: "final acceptance consumes original unreviewed " + name,
    mutate: (value: WindowsInstallerWorkflowSources) => {
      value.workflow.jobs["windows-finished-trusted-qualification"].with![name] =
        `\${{ needs.windows-finished-installer.outputs.${name} }}`;
    },
  })),
  ...["migration", "publish-qualified-installer"].map((jobName) => ({
    name: "runtime bootstrap reaches final-only " + jobName,
    mutate: (value: WindowsInstallerWorkflowSources) => {
      const job = value.trusted.jobs[jobName];
      job.if = job.if!.replace("inputs.qualification_phase == 'final' && ", "");
    },
  })),
  {
    name: "availability review lacks independent protected environment",
    mutate: (value) => {
      value.trusted.jobs["review-runtime-availability"].environment = undefined;
    },
  },
  {
    name: "availability review receives inference credentials",
    mutate: (value) => {
      step(
        value.trusted.jobs["review-runtime-availability"],
        "Require independently reviewed availability environment",
      ).env!.NVIDIA_API_KEY = "${{ secrets.WINDOWS_NATIVE_INSTALLER_NVIDIA_API_KEY }}";
    },
  },
  {
    name: "availability review accepts failed full acceptance",
    mutate: (value) => {
      const job = value.trusted.jobs["review-runtime-availability"];
      job.if = job.if!.replace("needs.full-installed-acceptance.result == 'success'", "true");
    },
  },
  {
    name: "availability review executes candidate source",
    mutate: (value) => {
      step(
        value.trusted.jobs["review-runtime-availability"],
        "Check out exact trusted availability controller",
      ).with!.ref = "${{ inputs.candidate_sha }}";
    },
  },
  {
    name: "availability review consumes unbound artifact ID",
    mutate: (value) => {
      step(
        value.trusted.jobs["review-runtime-availability"],
        "Download this controller's completed runtime evidence",
      ).with!["artifact-ids"] = "123";
    },
  },
  ...[
    '--evidence-manifest-sha256 "$EVIDENCE_SHA256"',
    '--controller-source-revision "$CONTROLLER_SHA"',
    '--source-revision "$CANDIDATE_SHA"',
    '--controller-run "$GITHUB_RUN_ID:$GITHUB_RUN_ATTEMPT"',
  ].map((token) => ({
    name: "availability review loses " + token,
    mutate: (value: WindowsInstallerWorkflowSources) => {
      const command = step(
        value.trusted.jobs["review-runtime-availability"],
        "Bind reviewed availability to exact successful runtime evidence",
      );
      command.run = command.run!.replace(token, "");
    },
  })),
  {
    name: "bootstrap runtime gate loses its selected-agent scope",
    mutate: (value) => {
      const job = value.trusted.jobs["full-installed-acceptance"];
      job.if = job.if!.replace(
        ' && contains(fromJSON(\'["openclaw","hermes"]\'), inputs.agent)',
        "",
      );
    },
  },
  {
    name: "final acceptance loses candidate migration proof",
    mutate: (value) => {
      const job = value.trusted.jobs["full-installed-acceptance"];
      job.if = job.if!.replace(" && needs.candidate-migration-proof.result == 'success'", "");
    },
  },
  {
    name: "availability review ignores a failed evidence validator",
    mutate: (value) => {
      step(
        value.trusted.jobs["review-runtime-availability"],
        "Bind reviewed availability to exact successful runtime evidence",
      )["continue-on-error"] = true;
    },
  },
];

function cacheFixture() {
  const seal = step(
    sources().workflow.jobs["windows-finished-reviewed-installer"],
    "Seal the rebuilt installer under a distinct same-run identity",
  ).run!;
  const start = seal.indexOf("$cacheRoot =");
  const end = seal.indexOf('"manifest_sha256=', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const root = mkdtempSync(join(tmpdir(), "reviewed-cache-"));
  const runner = join(root, "runner");
  const work = join(runner, "finished-windows");
  const original = join(runner, "finished-windows-product-transfer");
  const reviewed = join(runner, "finished-windows-reviewed-transfer");
  mkdirSync(work, { recursive: true });
  mkdirSync(original);
  mkdirSync(reviewed);
  writeFileSync(join(original, "identity.txt"), "original");
  writeFileSync(join(reviewed, "identity.txt"), "reviewed");
  const script =
    "$ErrorActionPreference='Stop'; $work=$env:TEST_WORK; $transfer=$env:TEST_REVIEWED;\n" +
    seal.slice(start, end);
  return {
    root,
    work,
    original,
    reviewed,
    run(transfer = reviewed) {
      return spawnSync(
        "pwsh.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        {
          env: { ...process.env, RUNNER_TEMP: runner, TEST_WORK: work, TEST_REVIEWED: transfer },
          encoding: "utf8",
          timeout: 10000,
        },
      );
    },
  };
}

describe.skipIf(process.platform !== "win32")("reviewed installer cache relocation", () => {
  it("retains original bytes and places reviewed bytes at the consumer path", () => {
    const f = cacheFixture();
    try {
      const result = f.run();
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(join(f.original, "identity.txt"), "utf8")).toBe("reviewed");
      expect(readFileSync(join(f.work, "original-transfer", "identity.txt"), "utf8")).toBe(
        "original",
      );
      expect(existsSync(f.reviewed)).toBe(false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
  it("rejects an occupied preservation path without changing either transfer", () => {
    const f = cacheFixture();
    try {
      mkdirSync(join(f.work, "original-transfer"));
      const result = f.run();
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(readFileSync(join(f.original, "identity.txt"), "utf8")).toBe("original");
      expect(readFileSync(join(f.reviewed, "identity.txt"), "utf8")).toBe("reviewed");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
  it("rejects relocation outside runner storage without changing either transfer", () => {
    const f = cacheFixture();
    try {
      const outside = join(f.root, "outside-transfer");
      renameSync(f.reviewed, outside);
      const result = f.run(outside);
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(readFileSync(join(f.original, "identity.txt"), "utf8")).toBe("original");
      expect(readFileSync(join(outside, "identity.txt"), "utf8")).toBe("reviewed");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});

const sha = "a".repeat(40);
const originalCache = "windows-finished-installer-v1-123-1-" + sha + "-openclaw";
const reviewedCache = "windows-finished-reviewed-installer-v1-123-1-" + sha + "-openclaw";
const environment = {
  PATH: process.env.PATH,
  GITHUB_REPOSITORY: "NVIDIA/NemoClaw",
  GITHUB_REF: "refs/heads/main",
  PR_NUMBER: "12014",
  CANDIDATE_REPOSITORY: "NVIDIA/NemoClaw",
  CANDIDATE_SHA: sha,
  BASE_SHA: "b".repeat(40),
  WORKFLOW_SHA: "b".repeat(40),
  INSTALLER_MANIFEST: "c".repeat(64),
  APPLICATION_MANIFEST: "d".repeat(64),
  SELECTED_AGENT: "openclaw",
  PRODUCT_VERSION: "0.1.10",
  GITHUB_RUN_ID: "123",
  GITHUB_RUN_ATTEMPT: "1",
  QUALIFICATION_PHASE: "final",
  INSTALLER_CACHE_KEY: originalCache,
  CANDIDATE_MIGRATION_EVIDENCE_ID: "456",
  CANDIDATE_MIGRATION_PROOF_SHA256: "e".repeat(64),
};
const phaseCases = [
  { name: "original final", accepted: true, change: {} },
  { name: "reviewed final", accepted: true, change: { INSTALLER_CACHE_KEY: reviewedCache } },
  {
    name: "OpenClaw bootstrap",
    accepted: true,
    change: {
      QUALIFICATION_PHASE: "runtime-bootstrap",
      CANDIDATE_MIGRATION_EVIDENCE_ID: "",
      CANDIDATE_MIGRATION_PROOF_SHA256: "",
    },
  },
  {
    name: "bootstrap with final proof",
    accepted: false,
    change: { QUALIFICATION_PHASE: "runtime-bootstrap" },
  },
  {
    name: "Hermes bootstrap with OpenClaw cache",
    accepted: false,
    change: {
      QUALIFICATION_PHASE: "runtime-bootstrap",
      CANDIDATE_MIGRATION_EVIDENCE_ID: "",
      CANDIDATE_MIGRATION_PROOF_SHA256: "",
      SELECTED_AGENT: "hermes",
    },
  },
  {
    name: "bootstrap with reviewed cache",
    accepted: false,
    change: {
      QUALIFICATION_PHASE: "runtime-bootstrap",
      CANDIDATE_MIGRATION_EVIDENCE_ID: "",
      CANDIDATE_MIGRATION_PROOF_SHA256: "",
      INSTALLER_CACHE_KEY: reviewedCache,
    },
  },
  { name: "unknown phase", accepted: false, change: { QUALIFICATION_PHASE: "unknown" } },
  {
    name: "final without proof",
    accepted: false,
    change: { CANDIDATE_MIGRATION_EVIDENCE_ID: "", CANDIDATE_MIGRATION_PROOF_SHA256: "" },
  },
  {
    name: "foreign cache attempt",
    accepted: false,
    change: { INSTALLER_CACHE_KEY: reviewedCache.replace("123-1", "123-2") },
  },
  {
    name: "Hermes with OpenClaw cache",
    accepted: false,
    change: { SELECTED_AGENT: "hermes", INSTALLER_CACHE_KEY: reviewedCache },
  },
  {
    name: "feature-branch controller",
    accepted: false,
    change: { GITHUB_REF: "refs/heads/feature" },
  },
];

describe("reviewed OpenClaw installer workflow", () => {
  it.each(mutations)("rejects $name", ({ mutate }) => {
    const value = sources();
    const before = JSON.stringify(value);
    mutate(value);
    expect(JSON.stringify(value)).not.toBe(before);
    expect(() => assertWindowsInstallerWorkflow(value)).toThrow();
  });
  it.skipIf(process.platform !== "linux").each(phaseCases)(
    "checks $name before GitHub authorization",
    ({ accepted, change }) => {
      const authorization = step(
        sources().trusted.jobs.authorize,
        "Require current main controller and exact internal PR identity",
      ).run!;
      const end = authorization.indexOf('main_sha="$(gh api ');
      expect(end).toBeGreaterThan(0);
      const result = spawnSync("bash", ["-s"], {
        input: authorization.slice(0, end),
        encoding: "utf8",
        timeout: 10000,
        env: { ...environment, ...change },
      });
      expect(result.error).toBeUndefined();
      expect(result.status === 0, JSON.stringify(change) + result.stderr).toBe(accepted);
      expect(result.stdout).toBe("");
    },
  );
});
