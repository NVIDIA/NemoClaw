// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { validateMcpOpenShellWorkflowBoundary } from "../../../tools/e2e/mcp-workflow-boundary.mts";

describe("MCP workflow artifact boundary", () => {
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
      assert(upload?.with, "MCP artifact upload fixture is missing");
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
      assert(cloudflared?.env, "MCP cloudflared installer fixture is missing");
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

  it("gates the dev full lifecycle on the canonical runtime classifier (#6426)", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-workflow-"));
    const workflowPath = path.join(directory, "e2e.yaml");
    try {
      const workflow = YAML.parse(fs.readFileSync(".github/workflows/e2e.yaml", "utf8")) as {
        jobs: Record<
          string,
          { steps: Array<{ id?: string; if?: string; name?: string; run?: string }> }
        >;
      };
      expect(validateMcpOpenShellWorkflowBoundary()).toEqual([]);

      workflow.jobs["mcp-bridge-dev"].steps = workflow.jobs["mcp-bridge-dev"].steps.filter(
        (step) => step.id !== "mcp_runtime_compatibility",
      );
      const lifecycle = workflow.jobs["mcp-bridge-dev"].steps.find(
        (step) => step.name === "Run MCP OpenShell provider live test",
      );
      assert(lifecycle, "MCP dev lifecycle fixture is missing");
      delete lifecycle.if;
      fs.writeFileSync(workflowPath, YAML.stringify(workflow));

      expect(validateMcpOpenShellWorkflowBoundary(workflowPath)).toEqual(
        expect.arrayContaining([
          "mcp-bridge-dev must use exactly one canonical runtime compatibility classifier",
          "mcp-bridge-dev runtime compatibility classifier must expose its canonical step id",
          "mcp-bridge-dev must run the full MCP lifecycle only for an aligned runtime",
          "mcp-bridge-dev must classify the installed runtime before the full MCP lifecycle",
        ]),
      );
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects dev compatibility classifier identity or ordering drift (#6426)", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-workflow-"));
    const workflowPath = path.join(directory, "e2e.yaml");
    try {
      const workflow = YAML.parse(fs.readFileSync(".github/workflows/e2e.yaml", "utf8")) as {
        jobs: Record<string, { steps: Array<{ id?: string; name?: string; run?: string }> }>;
      };
      const steps = workflow.jobs["mcp-bridge-dev"].steps;
      const classifierIndex = steps.findIndex(
        (step) => step.name === "Classify OpenShell credential-boundary compatibility",
      );
      const lifecycleIndex = steps.findIndex(
        (step) => step.name === "Run MCP OpenShell provider live test",
      );
      assert(classifierIndex >= 0, "MCP dev classifier fixture is missing");
      assert(lifecycleIndex >= 0, "MCP dev lifecycle fixture is missing");
      const classifier = steps[classifierIndex]!;
      classifier.id = "uncanonical_classifier";
      classifier.run = "npx tsx tools/e2e/unreviewed-classifier.mts";
      steps.splice(classifierIndex, 1);
      steps.splice(lifecycleIndex + 1, 0, classifier);
      fs.writeFileSync(workflowPath, YAML.stringify(workflow));

      expect(validateMcpOpenShellWorkflowBoundary(workflowPath)).toEqual(
        expect.arrayContaining([
          "mcp-bridge-dev must use exactly one canonical runtime compatibility classifier",
          "mcp-bridge-dev runtime compatibility classifier must expose its canonical step id",
          "mcp-bridge-dev runtime compatibility classifier must use the reviewed tool",
          "mcp-bridge-dev must classify the installed runtime before the full MCP lifecycle",
        ]),
      );
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects bypasses around the dev compatibility classifier (#6426)", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-workflow-"));
    const workflowPath = path.join(directory, "e2e.yaml");
    try {
      const workflow = YAML.parse(fs.readFileSync(".github/workflows/e2e.yaml", "utf8")) as {
        jobs: Record<
          string,
          {
            steps: Array<{
              "continue-on-error"?: boolean;
              env?: Record<string, string>;
              if?: string;
              name?: string;
              run?: string;
            }>;
          }
        >;
      };
      const classifier = workflow.jobs["mcp-bridge-dev"].steps.find(
        (step) => step.name === "Classify OpenShell credential-boundary compatibility",
      );
      assert(classifier?.run, "MCP dev classifier fixture is missing");
      classifier.if = "false";
      classifier["continue-on-error"] = true;
      classifier.env = { E2E_ARTIFACT_DIR: "/tmp/unreviewed" };
      classifier.run += 'echo "mode=full-lifecycle" >> "$GITHUB_OUTPUT"\n';
      fs.writeFileSync(workflowPath, YAML.stringify(workflow));

      expect(validateMcpOpenShellWorkflowBoundary(workflowPath)).toContain(
        "mcp-bridge-dev must use the canonical unconditional runtime compatibility classifier",
      );
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("keeps the stable MCP lifecycle independent of dev compatibility branching (#6426)", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-workflow-"));
    const workflowPath = path.join(directory, "e2e.yaml");
    try {
      const workflow = YAML.parse(fs.readFileSync(".github/workflows/e2e.yaml", "utf8")) as {
        jobs: Record<
          string,
          { steps: Array<{ id?: string; if?: string; name?: string; run?: string }> }
        >;
      };
      const lifecycle = workflow.jobs["mcp-bridge"].steps.find(
        (step) => step.name === "Run MCP OpenShell provider live test",
      );
      assert(lifecycle, "MCP stable lifecycle fixture is missing");
      lifecycle.if = "${{ steps.mcp_runtime_compatibility.outputs.mode == 'full-lifecycle' }}";
      workflow.jobs["mcp-bridge"].steps.splice(
        workflow.jobs["mcp-bridge"].steps.indexOf(lifecycle),
        0,
        {
          id: "mcp_runtime_compatibility",
          name: "Classify OpenShell credential-boundary compatibility",
          run: "npx tsx tools/e2e/mcp-bridge-runtime-compatibility.mts",
        },
      );
      fs.writeFileSync(workflowPath, YAML.stringify(workflow));

      expect(validateMcpOpenShellWorkflowBoundary(workflowPath)).toEqual(
        expect.arrayContaining([
          "mcp-bridge stable lane must not use dev runtime compatibility branching",
          "mcp-bridge stable lane must run its full MCP lifecycle unconditionally",
        ]),
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
