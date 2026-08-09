// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { readYaml, type WorkflowJob, type WorkflowStep } from "./helpers/e2e-workflow-contract";

type QualificationWorkflow = { jobs: Record<string, WorkflowJob> };

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readYaml<QualificationWorkflow>(
  ".github/workflows/openshell-0.0.101-pr-gate.yaml",
);
const tempRoots: string[] = [];

function step(jobName: string, stepName: string): WorkflowStep {
  const owner = workflow.jobs[jobName];
  assert(owner, `missing workflow job ${jobName}`);
  const value = owner.steps?.find((candidate) => candidate.name === stepName);
  assert(value, `missing workflow step ${stepName}`);
  return value;
}

function sparsePaths(jobName: string, stepName: string): string[] {
  const value = step(jobName, stepName).with?.["sparse-checkout"];
  assert(typeof value === "string", `${stepName} must declare sparse paths`);
  return value.trim().split("\n");
}

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openshell-sparse-bootstrap-"));
  tempRoots.push(root);
  return root;
}

function constructBundle(paths: readonly string[]): string {
  const root = tempRoot();
  for (const relativePath of paths) {
    const destination = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, relativePath), destination);
  }
  return root;
}

function importVerifier(root: string) {
  const verifier = pathToFileURL(
    path.join(root, "scripts/checks/verify-openshell-qualification-pr-gate.mts"),
  ).href;
  return spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--no-warnings",
      "--input-type=module",
      "--eval",
      `await import(${JSON.stringify(verifier)})`,
    ],
    { encoding: "utf8" },
  );
}

function bundleFiles(root: string): string[] {
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    .sort();
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

describe("OpenShell qualification sparse bootstrap bundle", () => {
  it("imports the real verifier from the workflow-declared trusted bundle (#8590)", () => {
    const paths = sparsePaths("classify", "Checkout base-trusted qualification verifier");
    const root = constructBundle(paths);
    const result = importVerifier(root);

    expect(result.status, result.stderr).toBe(0);
    expect(bundleFiles(root)).toEqual([...paths].sort());
  });

  it("fails when a runtime dependency is absent from the trusted bundle (#8590)", () => {
    const paths = sparsePaths("classify", "Checkout base-trusted qualification verifier");
    const root = constructBundle(paths);
    fs.unlinkSync(path.join(root, "scripts/checks/openshell-qualification-io.mts"));
    const result = importVerifier(root);

    expect(result.status).not.toBe(0);
  });

  it("constructs the verify bundle with contract and blueprint data (#8590)", () => {
    const paths = sparsePaths("verify-draft", "Checkout base-trusted draft verifier and data");
    const root = constructBundle(paths);

    expect(importVerifier(root).status).toBe(0);
    expect(bundleFiles(root)).toEqual([...paths].sort());
  });

  it("keeps the candidate bundle declarative and receipt-free (#8590)", () => {
    const paths = sparsePaths("verify-draft", "Checkout candidate qualification data");
    const root = constructBundle(paths);

    expect(bundleFiles(root)).toEqual([
      "ci/openshell-0.0.101-qualification-v1.json",
      "nemoclaw-blueprint/blueprint.yaml",
    ]);
    expect(
      [
        ".github/workflows/openshell-0.0.101-qualification.yaml",
        "scripts/checks/verify-openshell-qualification-producer-workflow.mts",
        "scripts/release-cut-tag.sh",
      ].every((relativePath) => !fs.existsSync(path.join(root, relativePath))),
    ).toBe(true);
  });
});
