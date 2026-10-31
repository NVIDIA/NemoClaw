// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

const WORKFLOW = new URL("../../.github/workflows/managed-images.yaml", import.meta.url);
const STEP_NAMES = [
  "Publish exact same-repository PR managed image by digest",
  "Remove PR publication credentials",
  "Pull exact published PR managed image",
  "Verify published PR Hermes Discord status",
  "Export exact published PR managed-image contract",
];

type Value = Record<string, unknown>;

function object(value: unknown): Value {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Value) : {};
}

export function validateManagedImageDiscordWorkflowBoundary(
  source = readFileSync(WORKFLOW, "utf8"),
): string[] {
  let workflow: Value;
  try {
    workflow = object(YAML.parse(source));
  } catch {
    return ["managed image workflow must be valid YAML"];
  }
  const job = object(object(workflow.jobs)["pr-build-and-entrypoint"]);
  const steps = Array.isArray(job.steps) ? job.steps.map(object) : [];
  const indices = STEP_NAMES.map((name) => steps.findIndex((step) => step.name === name));
  if (STEP_NAMES.some((name) => steps.filter((step) => step.name === name).length !== 1)) {
    return ["PR Discord qualification requires one of each publication and qualification step"];
  }

  const errors: string[] = [];
  if (indices.some((index, position) => position > 0 && indices[position - 1]! >= index)) {
    errors.push(
      "PR publication must precede logout, public pull, native Discord qualification, and contract export",
    );
  }
  const native = steps[indices[3]!]!;
  if (
    native.if !==
    "matrix.agent == 'hermes' && github.event.pull_request.head.repo.full_name == github.repository"
  ) {
    errors.push("published PR Discord qualification must run for same-repository Hermes images");
  }
  if (
    object(native.env).IMAGE_REFERENCE !==
    "${{ format('{0}@{1}', matrix.repository, steps.publish.outputs.digest) }}"
  ) {
    errors.push("published PR Discord qualification must use the published immutable digest");
  }
  if ("continue-on-error" in native) {
    errors.push("published PR Discord qualification must fail closed");
  }
  if (object(steps[indices[4]!]!.env).DIGEST !== "${{ steps.publish.outputs.digest }}") {
    errors.push("PR managed-image contract must export the qualified publication digest");
  }
  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const errors = validateManagedImageDiscordWorkflowBoundary();
  if (errors.length > 0) {
    errors.forEach((error) => console.error(error));
    process.exitCode = 1;
  } else {
    console.log("Managed image Discord workflow boundary passed.");
  }
}
