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

  it.each([
    {
      expected: "mcp-bridge must isolate the credential generation-window proof to one shard",
      mutate: (run: string) =>
        run.replace('if [[ "$NEMOCLAW_MCP_BRIDGE_AGENT" == "deepagents" ]]; then', "if true; then"),
      name: "runs on every shard",
    },
    {
      expected: "mcp-bridge must run the credential generation-window lifecycle",
      mutate: (run: string) =>
        run.replace("test/e2e/live/openshell-credential-generation-window.test.ts", ""),
      name: "is missing",
    },
    {
      expected:
        "mcp-bridge credential generation-window proof must publish canonical risk-signal evidence",
      mutate: (run: string) => run.replace("--reporter=test/e2e/risk-signal-reporter.ts", ""),
      name: "omits its risk-signal reporter",
    },
  ])("rejects a credential generation-window proof that $name", ({ expected, mutate, name }) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-workflow-"));
    const workflowPath = path.join(directory, "e2e.yaml");
    try {
      const workflow = YAML.parse(fs.readFileSync(".github/workflows/e2e.yaml", "utf8")) as {
        jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
      };
      const run = workflow.jobs["mcp-bridge"].steps.find(
        (step) => step.name === "Run MCP OpenShell provider live test",
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

  it("rejects an unverified or mutable cloudflared installer in either MCP lane", () => {
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
      const cloudflared = workflow.jobs["mcp-bridge-dev"].steps.find(
        (step) => step.name === "Install and verify cloudflared prerequisite",
      );
      requireFixture(cloudflared?.env, "MCP cloudflared installer fixture is missing");
      cloudflared.env.CLOUDFLARED_DEB_SHA256 = "mutable";
      cloudflared.run = "sudo apt-get install -y cloudflared";
      fs.writeFileSync(workflowPath, YAML.stringify(workflow));

      expect(validateMcpOpenShellWorkflowBoundary(workflowPath)).toEqual(
        expect.arrayContaining([
          "mcp-bridge-dev must pin the reviewed cloudflared package checksum",
          "mcp-bridge-dev cloudflared installation must not use mutable package repositories",
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

  it("revokes Docker credentials before executing unverified dev artifacts", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-workflow-"));
    const workflowPath = path.join(directory, "e2e.yaml");
    try {
      const workflow = YAML.parse(fs.readFileSync(".github/workflows/e2e.yaml", "utf8")) as {
        jobs: Record<string, { steps: Array<Record<string, unknown>> }>;
      };
      workflow.jobs["mcp-bridge-dev"].steps = workflow.jobs["mcp-bridge-dev"].steps.filter(
        (step) => step.name !== "Revoke Docker auth before unverified dev tooling",
      );
      fs.writeFileSync(workflowPath, YAML.stringify(workflow));

      expect(validateMcpOpenShellWorkflowBoundary(workflowPath)).toContain(
        "mcp-bridge-dev must revoke Docker auth before unverified dev tooling",
      );
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
