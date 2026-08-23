// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readYaml } from "./helpers/e2e-workflow-contract.ts";

const WORKFLOW_DIRECTORY = ".github/workflows";
const CATEGORIES = [
  "Automation",
  "CI",
  "Docs",
  "E2E",
  "Governance",
  "Images",
  "Release",
  "Security",
] as const;
const NAME_PATTERN = new RegExp(`^(?:${CATEGORIES.join("|")}) \/ [^/].+$`);

type WorkflowIdentity = {
  name?: unknown;
  on?: {
    workflow_run?: {
      workflows?: unknown;
    };
  };
};

function workflowFiles(): string[] {
  return readdirSync(WORKFLOW_DIRECTORY)
    .filter((file) => /\.ya?ml$/.test(file))
    .sort()
    .map((file) => path.posix.join(WORKFLOW_DIRECTORY, file));
}

function workflow(pathname: string): WorkflowIdentity {
  return readYaml<WorkflowIdentity>(pathname);
}

describe("GitHub Actions workflow names", () => {
  it("categorizes every workflow with one purpose-based prefix", () => {
    const invalid = workflowFiles().flatMap((pathname) => {
      const name = workflow(pathname).name;
      return typeof name === "string" && NAME_PATTERN.test(name) ? [] : [{ pathname, name }];
    });

    expect(invalid).toEqual([]);
  });

  it("keeps top-level names unique", () => {
    const entries = workflowFiles().map((pathname) => ({
      pathname,
      name: workflow(pathname).name,
    }));
    const duplicates = entries.filter(
      (entry, index) => entries.findIndex((candidate) => candidate.name === entry.name) !== index,
    );

    expect(duplicates).toEqual([]);
  });

  it("resolves every workflow-run subscription to one local workflow", () => {
    const entries = workflowFiles().map((pathname) => ({ pathname, value: workflow(pathname) }));
    const names = entries.map((entry) => entry.value.name);
    const unresolved = entries.flatMap(({ pathname, value }) =>
      (Array.isArray(value.on?.workflow_run?.workflows)
        ? value.on.workflow_run.workflows
        : []
      ).flatMap((name) =>
        typeof name === "string" && names.filter((candidate) => candidate === name).length === 1
          ? []
          : [{ pathname, name }],
      ),
    );

    expect(unresolved).toEqual([]);
  });
});
