// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

type Step = {
  if?: string;
  name?: string;
  env?: Record<string, string>;
  run?: string;
};
type Job = {
  env?: Record<string, string>;
  steps?: Step[];
  with?: Record<string, unknown>;
};
type Workflow = {
  on?: {
    workflow_dispatch?: {
      inputs?: Record<string, { default?: unknown; options?: unknown[] }>;
    };
  };
  jobs: Record<string, Job>;
};

function workflow(path: string): Workflow {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      'const fs=require("node:fs"); const {parse}=require("yaml"); process.stdout.write(JSON.stringify(parse(fs.readFileSync(process.argv[1], "utf8"))))',
      path,
    ],
    { cwd: process.cwd(), encoding: "utf8", timeout: 5_000 },
  );
  expect(result.status, result.stderr || `Could not parse workflow ${path}`).toBe(0);
  return JSON.parse(result.stdout) as Workflow;
}

function installStep(job: Job): Step | undefined {
  return job.steps?.find((step) => step.name === "Install OpenShell CLI");
}

function tlsStep(job: Job): Step | undefined {
  return job.steps?.find((step) => step.name === "Generate MCP test TLS");
}

function dockerHubAuthStep(job: Job): Step | undefined {
  return job.steps?.find((step) => step.name === "Authenticate to Docker Hub");
}

describe("MCP OpenShell workflow boundary", () => {
  it("targets the current OpenShell main dev build by default", () => {
    const nightly = workflow(".github/workflows/nightly-e2e.yaml");
    const vitest = workflow(".github/workflows/e2e-vitest-scenarios.yaml");
    const nightlyInstall = installStep(nightly.jobs["mcp-bridge-e2e"]);

    expect(nightly.on?.workflow_dispatch?.inputs?.openshell_channel?.default).toBe("dev");
    expect(vitest.on?.workflow_dispatch?.inputs?.openshell_channel?.default).toBe("dev");
    expect(nightlyInstall?.env?.NEMOCLAW_OPENSHELL_CHANNEL).toContain("|| 'dev'");
    expect(nightlyInstall?.env?.NEMOCLAW_OPENSHELL_FORCE_INSTALL).toBe("1");
    expect(
      installStep(workflow(".github/workflows/e2e-vitest-scenarios.yaml").jobs["mcp-bridge-vitest"])
        ?.env?.NEMOCLAW_OPENSHELL_FORCE_INSTALL,
    ).toBe("1");
  });

  it("offers only stable, current-main dev, and auto channels", () => {
    const nightly = workflow(".github/workflows/nightly-e2e.yaml");
    const vitest = workflow(".github/workflows/e2e-vitest-scenarios.yaml");

    for (const candidate of [nightly, vitest]) {
      const inputs = candidate.on?.workflow_dispatch?.inputs ?? {};
      expect(inputs.openshell_channel?.options).toEqual(["stable", "dev", "auto"]);
      expect(inputs).not.toHaveProperty("openshell_artifact_run_id");
      expect(inputs).not.toHaveProperty("openshell_artifact_head_sha");
    }
  });

  it("never passes a cross-repository token into checked-out installer code", () => {
    const nightly = workflow(".github/workflows/nightly-e2e.yaml");
    const vitest = workflow(".github/workflows/e2e-vitest-scenarios.yaml");

    for (const step of [
      installStep(nightly.jobs["mcp-bridge-e2e"]),
      installStep(vitest.jobs["mcp-bridge-vitest"]),
    ]) {
      expect(step?.env ?? {}).not.toHaveProperty("GH_TOKEN");
      expect(step?.env ?? {}).not.toHaveProperty("NEMOCLAW_INSTALL_OPENSHELL_GH_TOKEN");
      expect(step?.run ?? "").not.toContain("OPENSHELL_ARTIFACT_READ_TOKEN");
    }
  });

  it("does not expose Docker Hub credentials to a feature-ref MCP workflow", () => {
    const vitest = workflow(".github/workflows/e2e-vitest-scenarios.yaml");

    expect(dockerHubAuthStep(vitest.jobs["mcp-bridge-vitest"])?.if).toBe(
      "${{ github.ref == 'refs/heads/main' }}",
    );
  });

  it("generates the HTTPS MCP fixture certificate before the live test", () => {
    const nightly = workflow(".github/workflows/nightly-e2e.yaml");
    const vitest = workflow(".github/workflows/e2e-vitest-scenarios.yaml");

    for (const job of [nightly.jobs["mcp-bridge-e2e"], vitest.jobs["mcp-bridge-vitest"]]) {
      expect(tlsStep(job)?.run).toBe("bash test/e2e/setup-mcp-test-tls.sh");
      const tlsIndex = job.steps?.findIndex((step) => step.name === "Generate MCP test TLS");
      const installIndex = job.steps?.findIndex((step) => step.name === "Install OpenShell CLI");
      expect(tlsIndex).toBeGreaterThanOrEqual(0);
      expect(installIndex).toBeGreaterThan(tlsIndex ?? -1);
    }
  });

  it("passes the selected channel into both Hermes rebuild proof jobs", () => {
    const vitest = workflow(".github/workflows/e2e-vitest-scenarios.yaml");

    for (const name of ["rebuild-hermes-vitest", "rebuild-hermes-stale-base-vitest"]) {
      expect(vitest.jobs[name].env?.NEMOCLAW_OPENSHELL_CHANNEL, name).toBe(
        "${{ inputs.openshell_channel }}",
      );
    }
  });
});
