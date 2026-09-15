// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import YAML from "yaml";

import { E2E_ACTION_PROVENANCE } from "./workflow-boundary-policy.mts";

type WorkflowRecord = Record<string, unknown>;

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_ACTION_PATH = join(
  REPO_ROOT,
  ".github",
  "actions",
  "install-reviewed-openshell-sdk",
  "action.yaml",
);

export const REVIEWED_OPEN_SHELL_SDK_INSTALL_STEP =
  "Install reviewed OpenShell SDK archive without package credentials";

function record(value: unknown): WorkflowRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as WorkflowRecord)
    : {};
}

function records(value: unknown): WorkflowRecord[] {
  return Array.isArray(value) ? value.map(record) : [];
}

export function isReviewedOpenShellSdkInstallStep(value: unknown): boolean {
  return isDeepStrictEqual(record(value), {
    name: REVIEWED_OPEN_SHELL_SDK_INSTALL_STEP,
    uses: E2E_ACTION_PROVENANCE.reviewedSdkInstall.reference,
  });
}

export function readReviewedOpenShellSdkInstallScript(actionPath = DEFAULT_ACTION_PATH): string {
  const action = record(YAML.parse(readFileSync(actionPath, "utf8")));
  const actionSteps = records(record(action.runs).steps);
  const install = actionSteps.find((step) => step.name === REVIEWED_OPEN_SHELL_SDK_INSTALL_STEP);
  return typeof install?.run === "string" ? install.run : "";
}

export function validateReviewedOpenShellSdkInstallAction(
  actionPath = DEFAULT_ACTION_PATH,
): string[] {
  const source = readFileSync(actionPath, "utf8");
  const action = record(YAML.parse(source));
  const runs = record(action.runs);
  const actionSteps = records(runs.steps);
  const errors: string[] = [];

  if (
    createHash("sha256").update(source).digest("hex") !==
    E2E_ACTION_PROVENANCE.reviewedSdkInstall.contentSha256
  ) {
    errors.push(
      "reviewed OpenShell SDK install action content must match its immutable commit pin",
    );
  }
  if (
    !isDeepStrictEqual(Object.keys(action).sort(), ["description", "name", "runs"]) ||
    action.name !== "install-reviewed-openshell-sdk" ||
    action.description !==
      "Install the lock-selected reviewed OpenShell SDK archive without package credentials or lifecycle scripts."
  ) {
    errors.push("reviewed OpenShell SDK install action must keep its fixed public contract");
  }
  if (
    runs.using !== "composite" ||
    !isDeepStrictEqual(Object.keys(runs).sort(), ["steps", "using"]) ||
    actionSteps.length !== 1
  ) {
    errors.push("reviewed OpenShell SDK install action must contain one composite install step");
    return errors;
  }

  const install = actionSteps[0]!;
  if (
    !isDeepStrictEqual(Object.keys(install).sort(), ["name", "run", "shell"]) ||
    install.name !== REVIEWED_OPEN_SHELL_SDK_INSTALL_STEP ||
    install.shell !== "bash" ||
    typeof install.run !== "string" ||
    install.run.length === 0
  ) {
    errors.push("reviewed OpenShell SDK install action must own the fixed credential-free script");
  }
  return errors;
}
