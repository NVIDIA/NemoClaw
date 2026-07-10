// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readYaml, type Workflow, type WorkflowStep } from "./helpers/e2e-workflow-contract";

type DocsPublishStagingWorkflow = Workflow & {
  env: Record<string, string>;
};

function requiredStep(steps: WorkflowStep[] | undefined, name: string): WorkflowStep {
  const step = steps?.find((candidate) => candidate.name === name);
  if (!step) {
    throw new Error(`Missing workflow step: ${name}`);
  }
  return step;
}

describe("staging docs preview cleanup", () => {
  const workflow = readYaml<DocsPublishStagingWorkflow>(
    ".github/workflows/docs-publish-staging.yaml",
  );

  it("preserves the configured Fern instance path in every preview deletion URL", () => {
    const deleteStep = requiredStep(workflow.jobs["delete-preview"]?.steps, "Delete Fern previews");
    const temp = mkdtempSync(join(tmpdir(), "nemoclaw-fern-preview-cleanup-"));
    const fakeBin = join(temp, "bin");
    const commandLog = join(temp, "commands.jsonl");
    mkdirSync(fakeBin);
    writeFileSync(
      join(fakeBin, "npx"),
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        'fs.appendFileSync(process.env.COMMAND_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");',
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
      const result = spawnSync("bash", ["-c", deleteStep.run ?? ""], {
        encoding: "utf8",
        env: {
          ...process.env,
          COMMAND_LOG: commandLog,
          FERN_STAGING_INSTANCE: workflow.env.FERN_STAGING_INSTANCE,
          FERN_TOKEN: "test-token",
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          PREVIEW_IDS: "pr-6654\npr-6507",
        },
      });

      expect(result.status, result.stderr).toBe(0);
      const commands = readFileSync(commandLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(commands).toEqual([
        [
          "--yes",
          "fern-api@5.65.2",
          "docs",
          "preview",
          "delete",
          "https://nvidia-preview-pr-6654.docs.buildwithfern.com/nemoclaw",
        ],
        [
          "--yes",
          "fern-api@5.65.2",
          "docs",
          "preview",
          "delete",
          "https://nvidia-preview-pr-6507.docs.buildwithfern.com/nemoclaw",
        ],
      ]);
    } finally {
      rmSync(temp, { force: true, recursive: true });
    }
  });
});
