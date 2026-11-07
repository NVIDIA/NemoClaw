// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertWindowsInstallerWorkflow,
  type WorkflowStep,
} from "../../tools/windows-installer/workflow-boundary.mts";
import {
  previewFixture,
  previewSources,
  previewStep,
  skipPreviewProcesses,
} from "../support/windows-native-preview.ts";

describe.each(["openclaw", "hermes"] as const)("%s preview", (agent) => {
  const displayName = agent === "hermes" ? "Hermes" : "OpenClaw";
  const verifyName = `Verify and label the unqualified ${displayName} preview`;
  const uploadName = `Publish the unqualified ${displayName} preview download`;
  const fixtureForAgent = (extraRunnables: string[] = []) => previewFixture(extraRunnables, agent);
  const mutations: { name: string; target: string; change: (step: WorkflowStep) => void }[] = [
    {
      name: "verify condition",
      target: verifyName,
      change: (step) => {
        step.if = "${{ always() }}";
      },
    },
    {
      name: "upload condition",
      target: uploadName,
      change: (step) => {
        step.if = "${{ always() }}";
      },
    },
    {
      name: "wildcard upload",
      target: uploadName,
      change: (step) => {
        step.with!.path = "${{ runner.temp }}/**/*";
      },
    },
    {
      name: "qualified artifact name",
      target: uploadName,
      change: (step) => {
        step.with!.name = "qualified-windows-installer";
      },
    },
    {
      name: "missing inventory check",
      target: verifyName,
      change: (step) => {
        step.run = step.run!.replace("-ExpectedPackageRunnables", "-Unused");
      },
    },
    {
      name: "ignored verification failure",
      target: verifyName,
      change: (step) => {
        step["continue-on-error"] = true;
      },
    },
    {
      name: "wrong agent verification",
      target: verifyName,
      change: (step) => {
        step.run = step.run!.replace(`-Agent ${agent}`, "-Agent other");
      },
    },
    {
      name: "qualification claim",
      target: verifyName,
      change: (step) => {
        step.run = step.run!.replace("windowsQualified = $false", "windowsQualified = $true");
      },
    },
  ];

  it.each(mutations)("rejects unqualified preview mutation: $name", ({ target, change }) => {
    const sources = previewSources();
    change(previewStep(sources.workflow.jobs["windows-finished-installer"].steps!, target));
    expect(() => assertWindowsInstallerWorkflow(sources)).toThrow();
  });

  it("rejects preview upload before verification", () => {
    const sources = previewSources();
    const job = sources.workflow.jobs["windows-finished-installer"];
    const upload = previewStep(job.steps!, uploadName);
    job.steps = [upload, ...job.steps!.filter((item) => item !== upload)];
    expect(() => assertWindowsInstallerWorkflow(sources)).toThrow();
  });

  it.skipIf(skipPreviewProcesses)(
    "labels exact sealed preview bytes without claiming qualification",
    () => {
      const fixture = fixtureForAgent();
      try {
        const result = fixture.run();
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(JSON.parse(readFileSync(fixture.label, "utf8"))).toMatchObject({
          classification: `unqualified-${agent}-installer-preview`,
          agent,
          sourceRevision: fixture.revision,
          workflowRunId: "123",
          workflowRunAttempt: "1",
          transferManifestSha256: fixture.manifest,
          installer: fixture.installer,
          installedAcceptance: false,
          windowsQualified: false,
          release: false,
        });
        expect(JSON.parse(readFileSync(fixture.receiptPath, "utf8"))).toEqual(fixture.receipt);
        expect(JSON.parse(readFileSync(fixture.label, "utf8")).msi).toEqual(
          agent === "hermes" ? fixture.msi : undefined,
        );
      } finally {
        fixture.cleanup();
      }
    },
  );

  const deniedCases: { name: string; overrides: Record<string, string>; error: string }[] = [
    { name: "wrong run", overrides: { GITHUB_RUN_ID: "124" }, error: "identity does not match" },
    {
      name: "wrong source",
      overrides: { CANDIDATE_SHA: "b".repeat(40) },
      error: "identity does not match",
    },
    {
      name: "wrong manifest",
      overrides: { INSTALLER_MANIFEST: "b".repeat(64) },
      error: "differs from the producer output",
    },
  ];
  it.skipIf(skipPreviewProcesses).each(deniedCases)(
    "rejects preview from $name",
    ({ overrides, error }) => {
      const fixture = fixtureForAgent();
      try {
        const result = fixture.run(overrides);
        expect(result.status).not.toBe(0);
        expect(result.stdout + result.stderr).toContain(error);
        expect(existsSync(fixture.label)).toBe(false);
      } finally {
        fixture.cleanup();
      }
    },
  );

  it.skipIf(skipPreviewProcesses)("rejects changed preview executable bytes", () => {
    const fixture = fixtureForAgent();
    try {
      writeFileSync(fixture.setupPath, "tampered");
      const result = fixture.run();
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("cache entry differs from its manifest");
      expect(existsSync(fixture.label)).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  it.skipIf(skipPreviewProcesses)("rejects a manifest-valid extra preview executable", () => {
    const fixture = fixtureForAgent(["unexpected.exe"]);
    try {
      const result = fixture.run();
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain(
        "inventory differs from the qualified publication allowlist",
      );
      expect(existsSync(fixture.label)).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  it.skipIf(skipPreviewProcesses)("preserves an existing preview label", () => {
    const fixture = fixtureForAgent();
    try {
      writeFileSync(fixture.label, "preserve-existing-label");
      const result = fixture.run();
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("preview label must be fresh");
      expect(readFileSync(fixture.label, "utf8")).toBe("preserve-existing-label");
    } finally {
      fixture.cleanup();
    }
  });
});
