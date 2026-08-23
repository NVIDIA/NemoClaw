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

function walkMdxFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const absolute = path.join(dir, entry.name);
      return entry.name === "_build"
        ? []
        : entry.isDirectory()
          ? walkMdxFiles(absolute)
          : entry.isFile() && entry.name.endsWith(".mdx")
            ? [absolute]
            : [];
    });
}

function extractInvocation(line: string, index: number, file: string): DocumentedInvocation | null {
  const rest = LOGS_INVOCATION.exec(line.trim())?.groups?.rest.trim();
  return rest !== undefined && !PLACEHOLDER_OR_SHELL_SYNTAX.test(rest)
    ? {
        args: [SANDBOX_NAME, "logs", rest].filter(Boolean).join(" "),
        reference: `${path.relative(REPO_ROOT, file)}:${index + 1}`,
      }
    : null;
}

function isDocumentedInvocation(
  invocation: DocumentedInvocation | null,
): invocation is DocumentedInvocation {
  return invocation !== null;
}

function documentedLogsInvocations(): DocumentedInvocation[] {
  return walkMdxFiles(DOCS_ROOT).flatMap((file) =>
    fs
      .readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((line, index) => extractInvocation(line, index, file))
      .filter(isDocumentedInvocation),
  );
}

describe("documented sandbox logs invocations", () => {
  const invocations = documentedLogsInvocations();

  it("collects runnable logs invocations from the published pages", () => {
    expect(invocations.length).toBeGreaterThanOrEqual(5);
  });

  it.for(invocations.map(({ args, reference }) => [reference, args] as const))(
    "runs the invocation documented at %s",
    ([, args], { resources }) => {
      const setup = createLogsTestSetup(resources, "nemoclaw-cli-logs-documented-");
      const result = setup.runLogs(`${args} 2>&1`);

      expect(result.out).not.toContain("Nonexistent flag");
      expect(result.code).toBe(0);
    },
  );
});
