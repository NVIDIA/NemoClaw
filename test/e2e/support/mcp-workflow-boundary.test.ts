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
  it("rejects a false-green dev proof that runs only one MCP agent", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-workflow-"));
    const workflowPath = path.join(directory, "e2e.yaml");
    try {
      const workflow = YAML.parse(fs.readFileSync(".github/workflows/e2e.yaml", "utf8")) as {
        jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
      };
      const lifecycle = workflow.jobs["mcp-bridge-dev"].steps.find(
        (step) => step.name === "Run MCP OpenShell provider live test",
      );
      requireFixture(lifecycle?.run, "MCP dev lifecycle fixture is missing");
      lifecycle.run = [
        "npx vitest run --project e2e-live",
        "test/e2e/live/mcp-bridge.test.ts",
        "-t '^mcp-bridge-deepagents$'",
        "",
      ].join("\n");
      fs.writeFileSync(workflowPath, YAML.stringify(workflow));

      expect(validateMcpOpenShellWorkflowBoundary(workflowPath)).toEqual(
        expect.arrayContaining([
          "mcp-bridge-dev must select its exact matrix",
          "mcp-bridge-dev exact-main proof must run the credential generation-window lifecycle",
          "mcp-bridge-dev must serialize stateful exact-main lifecycle files",
          "mcp-bridge-dev must record proof that every MCP agent lifecycle produced artifacts",
        ]),
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
          {
            steps: Array<{
              name?: string;
              uses?: string;
              with?: Record<string, unknown>;
            }>;
          }
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

  it("confines actions:read and the GitHub token to exact-main artifact staging", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-workflow-"));
    const workflowPath = path.join(directory, "e2e.yaml");
    try {
      const workflow = YAML.parse(fs.readFileSync(".github/workflows/e2e.yaml", "utf8")) as {
        jobs: Record<
          string,
          {
            permissions: Record<string, string>;
            steps: Array<{ env?: Record<string, string>; name?: string }>;
          }
        >;
      };
      const dev = workflow.jobs["mcp-bridge-dev"];
      const install = dev.steps.find((step) => step.name === "Install OpenShell CLI");
      requireFixture(install, "MCP dev installer fixture is missing");
      dev.permissions.packages = "read";
      install.env = { ...install.env, GH_TOKEN: "${{ github.token }}" };
      fs.writeFileSync(workflowPath, YAML.stringify(workflow));

      expect(validateMcpOpenShellWorkflowBoundary(workflowPath)).toEqual(
        expect.arrayContaining([
          "mcp-bridge-dev must use only actions:read and contents:read permissions",
          "mcp-bridge-dev may expose the GitHub token only to exact-main artifact staging",
        ]),
      );
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects source, artifact, archive, and supervisor identity drift", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-workflow-"));
    const workflowPath = path.join(directory, "e2e.yaml");
    try {
      const workflow = YAML.parse(fs.readFileSync(".github/workflows/e2e.yaml", "utf8")) as {
        jobs: Record<
          string,
          {
            env: Record<string, string>;
            steps: Array<{
              env?: Record<string, string>;
              name?: string;
              run?: string;
            }>;
          }
        >;
      };
      const dev = workflow.jobs["mcp-bridge-dev"];
      const stage = dev.steps.find((step) => step.name === "Stage exact OpenShell main artifacts");
      requireFixture(stage?.env && stage.run, "exact-main staging fixture is missing");
      stage.env.OPENSHELL_SOURCE_SHA = "a".repeat(40);
      stage.run = stage.run
        .replaceAll("8266446648", "9999999999")
        .replaceAll(
          "d1732c0b87801560afd1b06cfea31c60d6a357100d5b817b4a4fb181b0b71933",
          "b".repeat(64),
        );
      dev.env.OPENSHELL_DOCKER_SUPERVISOR_IMAGE = `ghcr.io/nvidia/openshell/supervisor@sha256:${"c".repeat(64)}`;
      fs.writeFileSync(workflowPath, YAML.stringify(workflow));

      const errors = validateMcpOpenShellWorkflowBoundary(workflowPath);
      expect(errors).toEqual(
        expect.arrayContaining([
          "mcp-bridge-dev exact-main staging credentials and source identity must remain exact",
          "mcp-bridge-dev must pin the exact reviewed supervisor index",
          "mcp-bridge-dev exact-main staging is missing reviewed identity: 8266446648",
          "mcp-bridge-dev exact-main staging is missing reviewed identity: d1732c0b87801560afd1b06cfea31c60d6a357100d5b817b4a4fb181b0b71933",
        ]),
      );
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects unsafe extraction or a skippable exact-main lifecycle", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-workflow-"));
    const workflowPath = path.join(directory, "e2e.yaml");
    try {
      const workflow = YAML.parse(fs.readFileSync(".github/workflows/e2e.yaml", "utf8")) as {
        jobs: Record<string, { steps: Array<{ if?: string; name?: string; run?: string }> }>;
      };
      const steps = workflow.jobs["mcp-bridge-dev"].steps;
      const stage = steps.find((step) => step.name === "Stage exact OpenShell main artifacts");
      const required = steps.find((step) => step.name === "Require exact-main full lifecycle");
      requireFixture(stage?.run && required, "exact-main proof fixtures are missing");
      stage.run = stage.run.replace("tarfile.open", "tarfile.unchecked_open");
      required.if = "success()";
      fs.writeFileSync(workflowPath, YAML.stringify(workflow));

      expect(validateMcpOpenShellWorkflowBoundary(workflowPath)).toEqual(
        expect.arrayContaining([
          "mcp-bridge-dev exact-main staging must validate immutable artifact structure and provenance",
          "mcp-bridge-dev must fail unless the exact-main proof runs full-lifecycle",
        ]),
      );
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects omission of the credential generation-window proof", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-workflow-"));
    const workflowPath = path.join(directory, "e2e.yaml");
    try {
      const workflow = YAML.parse(fs.readFileSync(".github/workflows/e2e.yaml", "utf8")) as {
        jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
      };
      const run = workflow.jobs["mcp-bridge-dev"].steps.find(
        (step) => step.name === "Run MCP OpenShell provider live test",
      );
      requireFixture(run?.run, "MCP exact-main execution fixture is missing");
      run.run = [
        "npx vitest run --project e2e-live",
        "test/e2e/live/mcp-bridge.test.ts",
        "-t '^(mcp-bridge|mcp-bridge-hermes|mcp-bridge-deepagents)$'",
        "--no-file-parallelism",
        'npx tsx tools/e2e/assert-mcp-agent-matrix-artifacts.mts "$E2E_ARTIFACT_DIR"',
        "",
      ].join("\n");
      fs.writeFileSync(workflowPath, YAML.stringify(workflow));

      expect(validateMcpOpenShellWorkflowBoundary(workflowPath)).toEqual(
        expect.arrayContaining([
          "mcp-bridge-dev exact-main proof must run the credential generation-window lifecycle",
          "mcp-bridge-dev must select its exact matrix",
          "mcp-bridge-dev must record proof that every MCP agent lifecycle produced artifacts",
        ]),
      );
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });
});
