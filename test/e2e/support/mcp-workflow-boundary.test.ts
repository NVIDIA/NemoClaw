// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { validateMcpOpenShellWorkflowBoundary } from "../../../tools/e2e/mcp-workflow-boundary.mts";

describe("MCP workflow artifact boundary", () => {
  it("rejects uploads outside the directory that passed secret scanning", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-workflow-"));
    const workflowPath = path.join(directory, "e2e.yaml");
    try {
      const workflow = YAML.parse(fs.readFileSync(".github/workflows/e2e.yaml", "utf8")) as {
        jobs: Record<string, { steps: Array<{ name?: string; with?: Record<string, unknown> }> }>;
      };
      const upload = workflow.jobs["mcp-bridge"].steps.find(
        (step) => step.name === "Upload MCP server artifacts",
      );
      expect(upload?.with, "MCP artifact upload fixture is missing").toBeDefined();
      upload!.with!.path = "e2e-artifacts/live/unscanned/";
      fs.writeFileSync(workflowPath, YAML.stringify(workflow));

      expect(validateMcpOpenShellWorkflowBoundary(workflowPath)).toContain(
        "mcp-bridge artifact upload must use exactly the scanned directory",
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
      expect(cloudflared?.env, "MCP cloudflared installer fixture is missing").toBeDefined();
      cloudflared!.env!.CLOUDFLARED_DEB_SHA256 = "mutable";
      cloudflared!.run = "sudo apt-get install -y cloudflared";
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
