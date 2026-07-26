// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readYaml, type Workflow, type WorkflowStep } from "./helpers/e2e-workflow-contract";

const fernConfig = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "fern", "fern.config.json"), "utf8"),
) as { version: string };

const deletionCases = [
  [
    "nvidia-nemoclaw-staging.docs.buildwithfern.com/nemoclaw",
    "https://nvidia-preview-pr-123.docs.buildwithfern.com/nemoclaw",
  ],
  [
    "nvidia-nemoclaw-staging.docs.buildwithfern.com",
    "https://nvidia-preview-pr-123.docs.buildwithfern.com",
  ],
] as const;

function requiredStep(steps: WorkflowStep[] | undefined, name: string): WorkflowStep {
  const step = steps?.find((candidate) => candidate.name === name);
  assert(step, `Missing workflow step: ${name}`);
  return step;
}

describe("staging docs preview cleanup", () => {
  const workflow = readYaml<Workflow>(".github/workflows/docs-publish-staging.yaml");

  it.each(
    deletionCases,
  )("passes the complete preview URL to Fern for instance %s", (instance, expectedUrl) => {
    const deleteStep = requiredStep(workflow.jobs["delete-preview"]?.steps, "Delete Fern previews");
    const temp = mkdtempSync(join(tmpdir(), "nemoclaw-fern-preview-cleanup-"));
    const fakeBin = join(temp, "bin");
    const commandLog = join(temp, "command.json");
    mkdirSync(fakeBin);
    writeFileSync(
      join(fakeBin, "npx"),
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        "fs.writeFileSync(process.env.COMMAND_LOG, JSON.stringify(process.argv.slice(2)));",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
      const result = spawnSync("bash", ["-c", deleteStep.run ?? ""], {
        encoding: "utf8",
        env: {
          ...process.env,
          COMMAND_LOG: commandLog,
          FERN_STAGING_INSTANCE: instance,
          FERN_TOKEN: "test-token",
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          PREVIEW_IDS: "pr-123",
        },
      });

      expect(result.status, result.stderr).toBe(0);
      const command = JSON.parse(readFileSync(commandLog, "utf8")) as string[];
      expect(command).toEqual([
        "--yes",
        `fern-api@${fernConfig.version}`,
        "docs",
        "preview",
        "delete",
        expectedUrl,
      ]);
      expect(command).not.toContain("--id");
    } finally {
      rmSync(temp, { force: true, recursive: true });
    }
  });

  it.each([
    [0, "Domain not registered", "Fern preview pr-123 does not exist."],
    [1, "Authentication failed", "Authentication failed"],
  ])("returns exit status %i when Fern reports %s", (expectedStatus, fernError, expectedOutput) => {
    const deleteStep = requiredStep(workflow.jobs["delete-preview"]?.steps, "Delete Fern previews");
    const temp = mkdtempSync(join(tmpdir(), "nemoclaw-fern-preview-cleanup-error-"));
    const fakeBin = join(temp, "bin");
    mkdirSync(fakeBin);
    writeFileSync(
      join(fakeBin, "npx"),
      [
        "#!/usr/bin/env node",
        "process.stderr.write(`${process.env.FERN_ERROR}\\n`);",
        "process.exit(1);",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
      const result = spawnSync("bash", ["-c", deleteStep.run ?? ""], {
        encoding: "utf8",
        env: {
          ...process.env,
          FERN_ERROR: fernError,
          FERN_STAGING_INSTANCE: "nvidia-nemoclaw-staging.docs.buildwithfern.com/nemoclaw",
          FERN_TOKEN: "test-token",
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          PREVIEW_IDS: "pr-123",
        },
      });

      expect(result.status).toBe(expectedStatus);
      expect(`${result.stdout}${result.stderr}`).toContain(expectedOutput);
    } finally {
      rmSync(temp, { force: true, recursive: true });
    }
  });
});
