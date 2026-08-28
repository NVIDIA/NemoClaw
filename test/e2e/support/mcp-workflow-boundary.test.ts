// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { validateMcpOpenShellWorkflowBoundary } from "../../../tools/e2e/mcp-workflow-boundary.mts";
import { requireFixture } from "./require-fixture";

describe("MCP workflow artifact boundary", () => {
  it.each([
    "mcp-bridge",
    "mcp-bridge-dev",
  ])("rejects missing canonical risk-signal evidence in %s", (jobName) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-workflow-"));
    const workflowPath = path.join(directory, "e2e.yaml");
    try {
      const workflow = YAML.parse(fs.readFileSync(".github/workflows/e2e.yaml", "utf8")) as {
        jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
      };
      const run = workflow.jobs[jobName].steps.find(
        (step) => step.name === "Run MCP OpenShell provider live test",
      );
      requireFixture(run?.run, `${jobName} MCP live-test fixture is missing`);
      const helper = "tools/e2e/live-vitest-invocation.mts run --test-path";
      requireFixture(run.run.includes(helper), `${jobName} live-vitest helper fixture is missing`);
      const updatedRun = run.run.replace(helper, "vitest run");
      requireFixture(updatedRun !== run.run, `${jobName} live-vitest helper could not be removed`);
      run.run = updatedRun;
      fs.writeFileSync(workflowPath, YAML.stringify(workflow));

      expect(validateMcpOpenShellWorkflowBoundary(workflowPath)).toContain(
        `${jobName} must publish canonical risk-signal evidence`,
      );
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects missing, fail-fast, or in-process MCP agent shards", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-workflow-"));
    const workflowPath = path.join(directory, "e2e.yaml");
    try {
      const workflow = YAML.parse(fs.readFileSync(".github/workflows/e2e.yaml", "utf8")) as {
        jobs: Record<
          string,
          {
            env: Record<string, unknown>;
            strategy: { "fail-fast": boolean; matrix: { agent: string[] } };
          }
        >;
      };
      const stable = workflow.jobs["mcp-bridge"];
      stable.strategy["fail-fast"] = true;
      stable.strategy.matrix.agent = ["openclaw", "hermes"];
      stable.env.NEMOCLAW_MCP_BRIDGE_AGENT = "all";
      stable.env.NEMOCLAW_MCP_BRIDGE_AGENT_MATRIX = "1";
      fs.writeFileSync(workflowPath, YAML.stringify(workflow));

      expect(validateMcpOpenShellWorkflowBoundary(workflowPath)).toEqual(
        expect.arrayContaining([
          "mcp-bridge shards must not fail fast",
          "mcp-bridge must exercise the reviewed OpenClaw, Hermes, and Deep Agents shards",
          "mcp-bridge must select exactly its current MCP agent shard",
          "mcp-bridge must not enable the retired in-process agent matrix",
        ]),
      );
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects re-serializing the credential generation-window proof behind the MCP matrix", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-workflow-"));
    const workflowPath = path.join(directory, "e2e.yaml");
    try {
      const workflow = YAML.parse(fs.readFileSync(".github/workflows/e2e.yaml", "utf8")) as {
        jobs: Record<
          string,
          {
            needs?: string | string[];
            steps: Array<{ name?: string; run?: string }>;
          }
        >;
      };
      const mcpRun = workflow.jobs["mcp-bridge"].steps.find(
        (step) => step.name === "Run MCP OpenShell provider live test",
      );
      requireFixture(mcpRun?.run, "MCP stable lifecycle fixture is missing");
      mcpRun.run += "\ntest/e2e/live/openshell-credential-generation-window.test.ts";
      workflow.jobs["openshell-credential-generation-window"].needs = [
        "generate-matrix",
        "mcp-bridge",
      ];
      fs.writeFileSync(workflowPath, YAML.stringify(workflow));

      expect(validateMcpOpenShellWorkflowBoundary(workflowPath)).toEqual(
        expect.arrayContaining([
          "mcp-bridge must not serialize the independent credential generation-window proof",
          "openshell-credential-generation-window must depend on publication and matrix generation",
        ]),
      );
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it.each([
    {
      expected:
        "mcp-bridge stable installer command block must match the reviewed release installation and provenance sequence",
      job: "mcp-bridge",
      mutation: "\n: # unreviewed no-op\n",
      name: "no-op in the stable MCP installer",
    },
    {
      expected:
        "mcp-bridge stable installer command block must match the reviewed release installation and provenance sequence",
      job: "mcp-bridge",
      mutation: "\nbash unreviewed-installer.sh\n",
      name: "second installer in the stable MCP installer",
    },
    {
      expected:
        "openshell-credential-generation-window installer command block must match the reviewed release installation and provenance sequence",
      job: "openshell-credential-generation-window",
      mutation: "\n: # unreviewed no-op\n",
      name: "no-op in the credential-window installer",
    },
    {
      expected:
        "openshell-credential-generation-window installer command block must match the reviewed release installation and provenance sequence",
      job: "openshell-credential-generation-window",
      mutation: "\nbash unreviewed-installer.sh\n",
      name: "second installer in the credential-window installer",
    },
  ])("rejects a $name", ({ expected, job, mutation }) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-workflow-"));
    const workflowPath = path.join(directory, "e2e.yaml");
    try {
      const workflow = YAML.parse(fs.readFileSync(".github/workflows/e2e.yaml", "utf8")) as {
        jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
      };
      const install = workflow.jobs[job].steps.find(
        (step) => step.name === "Install OpenShell CLI",
      );
      requireFixture(install?.run, `${job} installer fixture is missing`);
      install.run += mutation;
      fs.writeFileSync(workflowPath, YAML.stringify(workflow));

      expect(validateMcpOpenShellWorkflowBoundary(workflowPath)).toContain(expected);
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it.each([
    {
      expected: "openshell-credential-generation-window must run its exact isolated live proof",
      mutate: (run: string) =>
        run.replace("test/e2e/live/openshell-credential-generation-window.test.ts", ""),
      name: "is missing",
    },
    {
      expected:
        "openshell-credential-generation-window must publish one canonical risk-signal stream",
      mutate: (run: string) => run.replace("--reporter=test/e2e/risk-signal-reporter.ts", ""),
      name: "omits its risk-signal reporter",
    },
  ])("rejects an independent credential generation-window proof that $name", ({
    expected,
    mutate,
    name,
  }) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-workflow-"));
    const workflowPath = path.join(directory, "e2e.yaml");
    try {
      const workflow = YAML.parse(fs.readFileSync(".github/workflows/e2e.yaml", "utf8")) as {
        jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
      };
      const run = workflow.jobs["openshell-credential-generation-window"].steps.find(
        (step) => step.name === "Run OpenShell credential generation-window live test",
      );
      requireFixture(run?.run, "MCP stable lifecycle fixture is missing");
      const updatedRun = mutate(run.run);
      requireFixture(updatedRun !== run.run, `credential generation-window proof ${name}`);
      run.run = updatedRun;
      fs.writeFileSync(workflowPath, YAML.stringify(workflow));

      expect(validateMcpOpenShellWorkflowBoundary(workflowPath)).toContain(expected);
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it.each([
    "release-qualification",
    "report-to-pr",
    "scorecard",
  ])("requires %s to wait for the independent credential-window result", (terminalJob) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-workflow-"));
    const workflowPath = path.join(directory, "e2e.yaml");
    try {
      const workflow = YAML.parse(fs.readFileSync(".github/workflows/e2e.yaml", "utf8")) as {
        jobs: Record<string, { needs: string[] }>;
      };
      workflow.jobs[terminalJob].needs = workflow.jobs[terminalJob].needs.filter(
        (job) => job !== "openshell-credential-generation-window",
      );
      fs.writeFileSync(workflowPath, YAML.stringify(workflow));

      expect(validateMcpOpenShellWorkflowBoundary(workflowPath)).toContain(
        `${terminalJob} must wait for openshell-credential-generation-window`,
      );
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects upload action or path drift from the reviewed shared boundary", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-workflow-"));
    const workflowPath = path.join(directory, "e2e.yaml");
    try {
      const workflow = YAML.parse(fs.readFileSync(".github/workflows/e2e.yaml", "utf8")) as {
        jobs: Record<
          string,
          { steps: Array<{ name?: string; uses?: string; with?: Record<string, unknown> }> }
        >;
      };
      const upload = workflow.jobs["mcp-bridge"].steps.find(
        (step) => step.name === "Upload MCP server artifacts",
      );
      requireFixture(upload?.with, "MCP artifact upload fixture is missing");
      upload.uses = "NVIDIA/NemoClaw/.github/actions/upload-e2e-artifacts@main";
      upload.with.path = "e2e-artifacts/live/unscanned/";
      fs.writeFileSync(workflowPath, YAML.stringify(workflow));

      expect(validateMcpOpenShellWorkflowBoundary(workflowPath)).toEqual(
        expect.arrayContaining([
          "mcp-bridge artifact upload must use the reviewed shared uploader",
          "mcp-bridge artifact upload must use exactly the scanned directory",
        ]),
      );
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it.each([
    "mcp-bridge-dev",
    "openshell-credential-generation-window",
  ])("rejects an unverified or mutable cloudflared installer in %s", (jobName) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-workflow-"));
    const workflowPath = path.join(directory, "e2e.yaml");
    try {
      const workflow = YAML.parse(fs.readFileSync(".github/workflows/e2e.yaml", "utf8")) as {
        jobs: Record<
          string,
          {
            steps: Array<{
              env?: Record<string, unknown>;
              name?: string;
              run?: string;
            }>;
          }
        >;
      };
      const cloudflared = workflow.jobs[jobName].steps.find(
        (step) => step.name === "Install and verify cloudflared prerequisite",
      );
      requireFixture(cloudflared?.env, `${jobName} cloudflared installer fixture is missing`);
      cloudflared.env.CLOUDFLARED_DEB_SHA256 = "mutable";
      cloudflared.run = "sudo apt-get install -y cloudflared";
      fs.writeFileSync(workflowPath, YAML.stringify(workflow));

      expect(validateMcpOpenShellWorkflowBoundary(workflowPath)).toEqual(
        expect.arrayContaining([
          `${jobName} must pin the reviewed cloudflared package checksum`,
          `${jobName} cloudflared installation must not use mutable package repositories`,
        ]),
      );
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects any additional credential-persisting checkout", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-workflow-"));
    const workflowPath = path.join(directory, "e2e.yaml");
    try {
      const workflow = YAML.parse(fs.readFileSync(".github/workflows/e2e.yaml", "utf8")) as {
        jobs: Record<string, { steps: Array<Record<string, unknown>> }>;
      };
      workflow.jobs["mcp-bridge"].steps.push({
        uses: "actions/checkout@v6",
        with: { "persist-credentials": true },
      });
      fs.writeFileSync(workflowPath, YAML.stringify(workflow));

      expect(validateMcpOpenShellWorkflowBoundary(workflowPath)).toEqual(
        expect.arrayContaining([
          "mcp-bridge must use exactly one checkout step",
          "mcp-bridge must use a SHA-pinned checkout",
          "mcp-bridge checkout must set persist-credentials:false",
        ]),
      );
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("revokes Docker credentials before executing OpenShell development tooling (#9051)", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-workflow-"));
    const workflowPath = path.join(directory, "e2e.yaml");
    try {
      const workflow = YAML.parse(fs.readFileSync(".github/workflows/e2e.yaml", "utf8")) as {
        jobs: Record<string, { steps: Array<Record<string, unknown>> }>;
      };
      workflow.jobs["mcp-bridge-dev"].steps = workflow.jobs["mcp-bridge-dev"].steps.filter(
        (step) => step.name !== "Revoke Docker auth before OpenShell development tooling",
      );
      fs.writeFileSync(workflowPath, YAML.stringify(workflow));

      expect(validateMcpOpenShellWorkflowBoundary(workflowPath)).toContain(
        "mcp-bridge-dev must revoke Docker auth before OpenShell development tooling",
      );
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects candidate execution inside the trusted OpenShell installation sequence (#9051)", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-workflow-"));
    const workflowPath = path.join(directory, "e2e.yaml");
    try {
      const workflow = YAML.parse(fs.readFileSync(".github/workflows/e2e.yaml", "utf8")) as {
        jobs: Record<string, { steps: Array<Record<string, unknown>> }>;
      };
      const steps = workflow.jobs["mcp-bridge-dev"].steps;
      const installIndex = steps.findIndex(
        (step) => step.name === "Install immutable OpenShell dev artifact",
      );
      requireFixture(installIndex >= 0, "OpenShell dev installation fixture is missing");
      steps.splice(installIndex, 0, {
        name: "Run candidate workspace script",
        run: "bash test/e2e/setup-mcp-test-tls.sh",
      });
      fs.writeFileSync(workflowPath, YAML.stringify(workflow));

      expect(validateMcpOpenShellWorkflowBoundary(workflowPath)).toContain(
        "mcp-bridge-dev must complete trusted Node.js setup, Docker auth, artifact verification, credential revocation, and installation before candidate dependency preparation and CLI restore",
      );
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects dependency caching before trusted installation (#9051)", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-workflow-"));
    const workflowPath = path.join(directory, "e2e.yaml");
    try {
      const workflow = YAML.parse(fs.readFileSync(".github/workflows/e2e.yaml", "utf8")) as {
        jobs: Record<string, { steps: Array<Record<string, unknown>> }>;
      };
      const setupNode = workflow.jobs["mcp-bridge-dev"].steps.find(
        (step) => step.name === "Set up Node.js for trusted OpenShell verification",
      );
      requireFixture(setupNode, "trusted Node.js setup fixture is missing");
      setupNode.with = {
        ...(setupNode.with as Record<string, unknown>),
        "package-manager-cache": true,
      };
      fs.writeFileSync(workflowPath, YAML.stringify(workflow));

      expect(validateMcpOpenShellWorkflowBoundary(workflowPath)).toContain(
        "mcp-bridge-dev must set up Node.js without dependency caching before candidate checkout",
      );
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects package manager probes after candidate checkout (#9051)", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-workflow-"));
    const workflowPath = path.join(directory, "e2e.yaml");
    try {
      const workflow = YAML.parse(fs.readFileSync(".github/workflows/e2e.yaml", "utf8")) as {
        jobs: Record<string, { steps: Array<Record<string, unknown>> }>;
      };
      const steps = workflow.jobs["mcp-bridge-dev"].steps;
      const setupNodeIndex = steps.findIndex(
        (step) => step.name === "Set up Node.js for trusted OpenShell verification",
      );
      const candidateCheckoutIndex = steps.findIndex((step) =>
        String(step.uses ?? "").startsWith("actions/checkout@"),
      );
      requireFixture(setupNodeIndex >= 0, "trusted Node.js setup fixture is missing");
      requireFixture(candidateCheckoutIndex >= 0, "candidate checkout fixture is missing");
      const [setupNode] = steps.splice(setupNodeIndex, 1);
      steps.splice(candidateCheckoutIndex, 0, setupNode);
      fs.writeFileSync(workflowPath, YAML.stringify(workflow));

      expect(validateMcpOpenShellWorkflowBoundary(workflowPath)).toContain(
        "mcp-bridge-dev must set up Node.js without dependency caching before candidate checkout",
      );
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects candidate execution embedded in the trusted OpenShell installer (#9051)", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-workflow-"));
    const workflowPath = path.join(directory, "e2e.yaml");
    try {
      const workflow = YAML.parse(fs.readFileSync(".github/workflows/e2e.yaml", "utf8")) as {
        jobs: Record<string, { steps: Array<Record<string, unknown>> }>;
      };
      const install = workflow.jobs["mcp-bridge-dev"].steps.find(
        (step) => step.name === "Install immutable OpenShell dev artifact",
      );
      requireFixture(typeof install?.run === "string", "OpenShell dev installation fixture is missing");
      install.run = `bash test/e2e/setup-mcp-test-tls.sh\n${install.run}`;
      fs.writeFileSync(workflowPath, YAML.stringify(workflow));

      expect(validateMcpOpenShellWorkflowBoundary(workflowPath)).toContain(
        "mcp-bridge-dev must preserve every reviewed step through trusted installation",
      );
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects candidate-controlled process hooks in the trusted OpenShell job (#9051)", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-workflow-"));
    const workflowPath = path.join(directory, "e2e.yaml");
    try {
      const workflow = YAML.parse(fs.readFileSync(".github/workflows/e2e.yaml", "utf8")) as {
        jobs: Record<string, { env: Record<string, string> }>;
      };
      workflow.jobs["mcp-bridge-dev"].env.NODE_OPTIONS = "--require=./candidate-preload.cjs";
      fs.writeFileSync(workflowPath, YAML.stringify(workflow));

      expect(validateMcpOpenShellWorkflowBoundary(workflowPath)).toContain(
        "mcp-bridge-dev must preserve its reviewed job execution context before candidate activation",
      );
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects candidate-controlled process hooks in the workflow environment (#9051)", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-workflow-"));
    const workflowPath = path.join(directory, "e2e.yaml");
    try {
      const workflow = YAML.parse(fs.readFileSync(".github/workflows/e2e.yaml", "utf8")) as {
        env: Record<string, string>;
      };
      workflow.env.NODE_OPTIONS = "--require=./candidate-preload.cjs";
      fs.writeFileSync(workflowPath, YAML.stringify(workflow));

      expect(validateMcpOpenShellWorkflowBoundary(workflowPath)).toContain(
        "workflow must preserve the reviewed execution environment before candidate activation",
      );
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects skipping the trusted OpenShell installer (#9051)", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-workflow-"));
    const workflowPath = path.join(directory, "e2e.yaml");
    try {
      const workflow = YAML.parse(fs.readFileSync(".github/workflows/e2e.yaml", "utf8")) as {
        jobs: Record<string, { steps: Array<Record<string, unknown>> }>;
      };
      const install = workflow.jobs["mcp-bridge-dev"].steps.find(
        (step) => step.name === "Install immutable OpenShell dev artifact",
      );
      requireFixture(install, "OpenShell dev installation fixture is missing");
      install.if = "${{ false }}";
      fs.writeFileSync(workflowPath, YAML.stringify(workflow));

      expect(validateMcpOpenShellWorkflowBoundary(workflowPath)).toContain(
        "mcp-bridge-dev must preserve every reviewed step through trusted installation",
      );
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects removing the trusted OpenShell installer (#9051)", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-workflow-"));
    const workflowPath = path.join(directory, "e2e.yaml");
    try {
      const workflow = YAML.parse(fs.readFileSync(".github/workflows/e2e.yaml", "utf8")) as {
        jobs: Record<string, { steps: Array<Record<string, unknown>> }>;
      };
      const job = workflow.jobs["mcp-bridge-dev"];
      job.steps = job.steps.filter(
        (step) => step.name !== "Install immutable OpenShell dev artifact",
      );
      fs.writeFileSync(workflowPath, YAML.stringify(workflow));

      expect(validateMcpOpenShellWorkflowBoundary(workflowPath)).toContain(
        "mcp-bridge-dev must preserve every reviewed step through trusted installation",
      );
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects skipping post-install dependency preparation (#9051)", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-workflow-"));
    const workflowPath = path.join(directory, "e2e.yaml");
    try {
      const workflow = YAML.parse(fs.readFileSync(".github/workflows/e2e.yaml", "utf8")) as {
        jobs: Record<string, { steps: Array<Record<string, unknown>> }>;
      };
      const prepare = workflow.jobs["mcp-bridge-dev"].steps.find(
        (step) => step.name === "Prepare E2E workspace",
      );
      requireFixture(prepare, "post-install dependency preparation fixture is missing");
      prepare.if = "${{ false }}";
      fs.writeFileSync(workflowPath, YAML.stringify(workflow));

      expect(validateMcpOpenShellWorkflowBoundary(workflowPath)).toContain(
        "mcp-bridge-dev must preserve reviewed dependency preparation and candidate CLI restore after trusted installation",
      );
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects candidate execution before trusted OpenShell installation (#9051)", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-workflow-"));
    const workflowPath = path.join(directory, "e2e.yaml");
    try {
      const workflow = YAML.parse(fs.readFileSync(".github/workflows/e2e.yaml", "utf8")) as {
        jobs: Record<string, { steps: Array<Record<string, unknown>> }>;
      };
      const steps = workflow.jobs["mcp-bridge-dev"].steps;
      const candidateCheckoutIndex = steps.findIndex((step) =>
        String(step.uses ?? "").startsWith("actions/checkout@"),
      );
      requireFixture(candidateCheckoutIndex >= 0, "candidate checkout fixture is missing");
      steps.splice(candidateCheckoutIndex + 1, 0, {
        name: "Execute candidate CLI before trusted installation",
        run: "node bin/nemoclaw.js --version",
      });
      fs.writeFileSync(workflowPath, YAML.stringify(workflow));

      expect(validateMcpOpenShellWorkflowBoundary(workflowPath)).toContain(
        "mcp-bridge-dev must preserve every reviewed step through trusted installation",
      );
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects restoring the candidate CLI before trusted OpenShell installation (#9051)", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-workflow-"));
    const workflowPath = path.join(directory, "e2e.yaml");
    try {
      const workflow = YAML.parse(fs.readFileSync(".github/workflows/e2e.yaml", "utf8")) as {
        jobs: Record<string, { steps: Array<Record<string, unknown>> }>;
      };
      const steps = workflow.jobs["mcp-bridge-dev"].steps;
      const restoreIndex = steps.findIndex(
        (step) => step.name === "Restore exact-commit CLI artifact",
      );
      requireFixture(restoreIndex >= 0, "candidate CLI restore fixture is missing");
      const [restore] = steps.splice(restoreIndex, 1);
      const trustedCheckoutIndex = steps.findIndex(
        (step) => step.name === "Checkout trusted OpenShell dev tooling",
      );
      requireFixture(trustedCheckoutIndex >= 0, "trusted checkout fixture is missing");
      steps.splice(trustedCheckoutIndex, 0, restore);
      fs.writeFileSync(workflowPath, YAML.stringify(workflow));

      expect(validateMcpOpenShellWorkflowBoundary(workflowPath)).toContain(
        "mcp-bridge-dev must complete trusted Node.js setup, Docker auth, artifact verification, credential revocation, and installation before candidate dependency preparation and CLI restore",
      );
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects moving or unverified inputs for the OpenShell dev shards (#9051)", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-workflow-"));
    const workflowPath = path.join(directory, "e2e.yaml");
    try {
      const workflow = YAML.parse(fs.readFileSync(".github/workflows/e2e.yaml", "utf8")) as {
        jobs: Record<
          string,
          {
            needs?: string | string[];
            steps: Array<{
              env?: Record<string, unknown>;
              name?: string;
              run?: string;
              uses?: string;
              with?: Record<string, unknown>;
            }>;
          }
        >;
      };
      const dev = workflow.jobs["mcp-bridge-dev"];
      dev.needs = "generate-matrix";
      const restore = dev.steps.find(
        (step) => step.name === "Restore immutable OpenShell dev artifact",
      );
      const verify = dev.steps.find(
        (step) => step.name === "Verify immutable OpenShell dev artifact",
      );
      const install = dev.steps.find(
        (step) => step.name === "Install immutable OpenShell dev artifact",
      );
      requireFixture(restore?.with, "OpenShell dev artifact restore fixture is missing");
      requireFixture(verify?.run, "OpenShell dev artifact verification fixture is missing");
      requireFixture(install?.run, "OpenShell dev artifact installation fixture is missing");
      restore.uses = "actions/download-artifact@main";
      restore.with.name = "openshell-dev-latest";
      verify.run = verify.run.replace(".trusted-openshell-dev-artifact/", "");
      install.env = { NEMOCLAW_ACCEPT_DEV_UNVERIFIED_INSTALL: "1" };
      install.run = "bash scripts/install-openshell.sh";
      fs.writeFileSync(workflowPath, YAML.stringify(workflow));

      expect(validateMcpOpenShellWorkflowBoundary(workflowPath)).toEqual(
        expect.arrayContaining([
          "mcp-bridge-dev must depend on its reviewed artifact producers",
          "mcp-bridge-dev must use the reviewed immutable artifact downloader",
          "mcp-bridge-dev must restore exactly the resolver's content-addressed artifact",
          "mcp-bridge-dev must verify the immutable OpenShell artifact before installation",
          "mcp-bridge-dev installer must receive only the retained OpenShell asset directory",
          "mcp-bridge-dev must install retained assets through the trusted no-network release path",
        ]),
      );
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it.each([
    {
      name: "candidate checkout ref",
      mutate: (job: { steps: Array<Record<string, unknown>> }) => {
        const checkout = job.steps.find(
          (step) => step.name === "Checkout trusted OpenShell dev tooling",
        );
        requireFixture(
          checkout?.with,
          "trusted OpenShell resolver checkout fixture is missing",
        );
        const withValues = checkout.with as Record<string, unknown>;
        withValues.ref = "${{ inputs.checkout_sha || github.sha }}";
      },
      expected: "openshell-dev-artifact must check out only the trusted workflow revision",
    },
    {
      name: "candidate workspace invocation",
      mutate: (job: { steps: Array<Record<string, unknown>> }) => {
        const resolve = job.steps.find(
          (step) => step.name === "Resolve immutable OpenShell dev artifact",
        );
        requireFixture(
          typeof resolve?.run === "string",
          "trusted OpenShell resolver invocation fixture is missing",
        );
        resolve.run = resolve.run.replace(
          ".trusted-openshell-dev-artifact/tools/e2e/openshell-dev-artifact.mts",
          ".candidate-runtime/tools/e2e/openshell-dev-artifact.mts",
        );
      },
      expected: "openshell-dev-artifact must run the trusted immutable resolver",
    },
  ])("rejects a $name for OpenShell dev artifact resolution (#9051)", ({
    expected,
    mutate,
  }) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-workflow-"));
    const workflowPath = path.join(directory, "e2e.yaml");
    try {
      const workflow = YAML.parse(fs.readFileSync(".github/workflows/e2e.yaml", "utf8")) as {
        jobs: Record<string, { steps: Array<Record<string, unknown>> }>;
      };
      mutate(workflow.jobs["openshell-dev-artifact"]);
      fs.writeFileSync(workflowPath, YAML.stringify(workflow));

      expect(validateMcpOpenShellWorkflowBoundary(workflowPath)).toContain(expected);
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects any additional artifact upload outside the scanned directory", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-workflow-"));
    const workflowPath = path.join(directory, "e2e.yaml");
    try {
      const workflow = YAML.parse(fs.readFileSync(".github/workflows/e2e.yaml", "utf8")) as {
        jobs: Record<string, { steps: Array<Record<string, unknown>> }>;
      };
      workflow.jobs["mcp-bridge-dev"].steps.push({
        name: "Upload unscanned output",
        uses: "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
        with: { name: "unscanned", path: "e2e-artifacts/live/unscanned/" },
      });
      fs.writeFileSync(workflowPath, YAML.stringify(workflow));

      expect(validateMcpOpenShellWorkflowBoundary(workflowPath)).toContain(
        "mcp-bridge-dev must use exactly one reviewed MCP artifact upload step",
      );
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });
});
