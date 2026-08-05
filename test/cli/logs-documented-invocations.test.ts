// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, test as it } from "../helpers/owned-test-resources";

import { createLogsTestSetup } from "./helpers";

const REPO_ROOT = path.join(import.meta.dirname, "..", "..");
const DOCS_ROOT = path.join(REPO_ROOT, "docs");
const SANDBOX_NAME = "alpha";
const LOGS_INVOCATION = /^\$\$nemoclaw\s+\S+\s+logs\b(?<rest>.*)$/;
const PLACEHOLDER_OR_SHELL_SYNTAX = /[[\]|><]/;

type DocumentedInvocation = {
  args: string;
  reference: string;
};

function* walkMdxFiles(dir: string): Generator<string> {
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "_build") continue;
      yield* walkMdxFiles(absolute);
    } else if (entry.isFile() && entry.name.endsWith(".mdx")) {
      yield absolute;
    }
  }
}

function documentedLogsInvocations(): DocumentedInvocation[] {
  const invocations: DocumentedInvocation[] = [];
  for (const file of walkMdxFiles(DOCS_ROOT)) {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      const rest = LOGS_INVOCATION.exec(line.trim())?.groups?.rest.trim();
      if (rest === undefined) return;
      if (PLACEHOLDER_OR_SHELL_SYNTAX.test(rest)) return;
      invocations.push({
        args: [SANDBOX_NAME, "logs", rest].filter(Boolean).join(" "),
        reference: `${path.relative(REPO_ROOT, file)}:${index + 1}`,
      });
    });
  }
  return invocations;
}

describe("documented sandbox logs invocations", () => {
  const invocations = documentedLogsInvocations();

  it("collects runnable logs invocations from the published pages", () => {
    expect(invocations.length).toBeGreaterThanOrEqual(5);
  });

  for (const { args, reference } of invocations) {
    it(`runs the invocation documented at ${reference}`, ({ resources }) => {
      const setup = createLogsTestSetup(resources, "nemoclaw-cli-logs-documented-");
      const result = setup.runLogs(`${args} 2>&1`);

      expect(result.out).not.toContain("Nonexistent flag");
      expect(result.code).toBe(0);
    });
  }
});
