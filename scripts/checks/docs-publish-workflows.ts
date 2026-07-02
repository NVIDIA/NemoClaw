// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const STAGING_INSTANCE = "nvidia-nemoclaw-staging.docs.buildwithfern.com/nemoclaw";
const PUBLIC_INSTANCE = "nvidia-nemoclaw.docs.buildwithfern.com/nemoclaw";
const FERN_VERSION_FROM_CONFIG = `FERN_VERSION=$(node -p "require('./fern/fern.config.json').version")`;

type Workflow = {
  path: string;
  text: string;
  doc: Record<string, unknown>;
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readYamlFile(relativePath: string): Workflow {
  const absolutePath = path.join(REPO_ROOT, relativePath);
  const text = readFileSync(absolutePath, "utf-8");
  return {
    path: relativePath,
    text,
    doc: asRecord(YAML.parse(text)),
  };
}

function includesAll(values: readonly unknown[], expected: readonly string[]): boolean {
  const actual = new Set(values.filter((value): value is string => typeof value === "string"));
  return expected.every((value) => actual.has(value));
}

function workflowEnv(workflow: Workflow): Record<string, unknown> {
  return asRecord(workflow.doc.env);
}

function workflowJob(workflow: Workflow, jobName: string): Record<string, unknown> {
  return asRecord(asRecord(workflow.doc.jobs)[jobName]);
}

function workflowSteps(workflow: Workflow, jobName: string): Record<string, unknown>[] {
  return asArray(workflowJob(workflow, jobName).steps).map(asRecord);
}

function stepNamed(workflow: Workflow, jobName: string, name: string): Record<string, unknown> {
  return workflowSteps(workflow, jobName).find((step) => step.name === name) ?? {};
}

function pushTrigger(workflow: Workflow): Record<string, unknown> {
  return asRecord(asRecord(workflow.doc.on).push);
}

function assertPinnedActions(workflow: Workflow, errors: string[]): void {
  const usesLines = workflow.text.matchAll(/^\s*uses:\s+([^\s#]+)(?:\s+#.*)?$/gm);
  for (const match of usesLines) {
    const uses = match[1] ?? "";
    if (!/@[a-f0-9]{40}$/.test(uses)) {
      errors.push(`${workflow.path}: action is not pinned to a full commit SHA: ${uses}`);
    }
  }
}

function assertFernVersionSource(
  workflow: Workflow,
  run: string,
  stepName: string,
  errors: string[],
): void {
  if (workflowEnv(workflow).FERN_VERSION !== undefined) {
    errors.push(`${workflow.path}: FERN_VERSION must come from fern/fern.config.json`);
  }
  if (!run.includes(FERN_VERSION_FROM_CONFIG)) {
    errors.push(`${workflow.path}: ${stepName} must read FERN_VERSION from fern/fern.config.json`);
  }
}

function assertFernInstances(errors: string[]): void {
  const fern = readYamlFile("fern/docs.yml");
  const urls = asArray(fern.doc.instances).map((instance) => asRecord(instance).url);
  if (!includesAll(urls, [STAGING_INSTANCE, PUBLIC_INSTANCE])) {
    errors.push("fern/docs.yml: must declare both staging and public Fern instances");
  }
}

function assertPreviewWorkflow(workflow: Workflow, errors: string[]): void {
  const env = workflowEnv(workflow);
  if (env.FERN_STAGING_INSTANCE !== STAGING_INSTANCE) {
    errors.push(`${workflow.path}: preview workflow must target the staging Fern instance`);
  }
  if (env.FERN_PUBLIC_INSTANCE !== undefined) {
    errors.push(`${workflow.path}: preview workflow must not target the public Fern instance`);
  }

  const generateStep = stepNamed(workflow, "preview", "Generate preview URL");
  const run = stringValue(generateStep.run);
  assertFernVersionSource(workflow, run, "Generate preview URL", errors);
  if (!run.includes('npx --yes "fern-api@${FERN_VERSION}" generate --docs')) {
    errors.push(`${workflow.path}: preview publish command must use FERN_VERSION from config`);
  }
  if (!run.includes('--instance "$FERN_STAGING_INSTANCE" --preview')) {
    errors.push(`${workflow.path}: preview publish command must pass the staging --instance`);
  }
}

function assertStagingWorkflow(workflow: Workflow, errors: string[]): void {
  const push = pushTrigger(workflow);
  if (!includesAll(asArray(push.branches), ["main"])) {
    errors.push(`${workflow.path}: staging publish must run on pushes to main`);
  }
  if (
    !includesAll(asArray(push.paths), [
      "docs/**",
      "fern/**",
      "package.json",
      "package-lock.json",
      "scripts/sync-agent-variant-docs.ts",
      ".github/workflows/docs-publish-staging.yaml",
    ])
  ) {
    errors.push(`${workflow.path}: staging path filters must cover docs build inputs`);
  }

  const job = workflowJob(workflow, "publish");
  if (job.environment !== "docs-staging") {
    errors.push(`${workflow.path}: staging publish must use the docs-staging environment`);
  }
  if (workflowEnv(workflow).FERN_STAGING_INSTANCE !== STAGING_INSTANCE) {
    errors.push(`${workflow.path}: staging workflow must target the staging Fern instance`);
  }
  assertPublishSteps(workflow, "FERN_STAGING_INSTANCE", errors);
}

function assertPublicWorkflow(workflow: Workflow, errors: string[]): void {
  const push = pushTrigger(workflow);
  if (!includesAll(asArray(push.tags), ["v*.*.*"])) {
    errors.push(`${workflow.path}: public publish must run only for semver release tags`);
  }

  const job = workflowJob(workflow, "publish");
  if (job.environment !== "docs-public") {
    errors.push(`${workflow.path}: public publish must use the docs-public environment`);
  }
  if (workflowEnv(workflow).FERN_PUBLIC_INSTANCE !== PUBLIC_INSTANCE) {
    errors.push(`${workflow.path}: public workflow must target the public Fern instance`);
  }

  const checkout = workflowSteps(workflow, "publish").find((step) =>
    stringValue(step.uses).startsWith("actions/checkout@"),
  );
  if (asRecord(checkout?.with)["fetch-depth"] !== 0) {
    errors.push(`${workflow.path}: public publish checkout must use fetch-depth: 0`);
  }

  const steps = workflowSteps(workflow, "publish");
  const guardIndex = steps.findIndex(
    (step) => step.name === "Verify release tag commit is on main",
  );
  const publishIndex = steps.findIndex((step) => step.name === "Publish public docs");
  const guardRun = stringValue(steps[guardIndex]?.run);
  if (guardIndex < 0 || publishIndex < 0 || guardIndex > publishIndex) {
    errors.push(`${workflow.path}: public main-ancestor guard must run before Fern token use`);
  }
  if (!guardRun.includes('git merge-base --is-ancestor "$GITHUB_SHA" origin/main')) {
    errors.push(`${workflow.path}: public guard must verify the tag commit is reachable from main`);
  }

  assertPublishSteps(workflow, "FERN_PUBLIC_INSTANCE", errors);
}

function assertPublishSteps(
  workflow: Workflow,
  instanceEnvName: "FERN_STAGING_INSTANCE" | "FERN_PUBLIC_INSTANCE",
  errors: string[],
): void {
  const validateStep = stepNamed(
    workflow,
    "publish",
    "Generate doc variants and validate Fern docs",
  );
  const validateRun = stringValue(validateStep.run);
  if (
    !validateRun.includes("npm run docs:sync-agent-variants") ||
    !validateRun.includes("npm run docs")
  ) {
    errors.push(`${workflow.path}: publish workflows must build variants before Fern publish`);
  }

  const publishStep = stepNamed(
    workflow,
    "publish",
    instanceEnvName === "FERN_STAGING_INSTANCE" ? "Publish staging docs" : "Publish public docs",
  );
  if (asRecord(publishStep.env).FERN_TOKEN !== "${{ secrets.FERN_TOKEN }}") {
    errors.push(`${workflow.path}: Fern publish step must be the only step with FERN_TOKEN`);
  }
  const publishRun = stringValue(publishStep.run);
  assertFernVersionSource(workflow, publishRun, String(publishStep.name ?? "Publish docs"), errors);
  if (!publishRun.includes('npx --yes "fern-api@${FERN_VERSION}" generate --docs')) {
    errors.push(`${workflow.path}: Fern publish command must use FERN_VERSION from config`);
  }
  if (!publishRun.includes(`--instance "$${instanceEnvName}"`)) {
    errors.push(`${workflow.path}: Fern publish command must pass the expected --instance`);
  }
}

function main(): void {
  const workflows = [
    readYamlFile(".github/workflows/docs-preview-pr.yaml"),
    readYamlFile(".github/workflows/docs-publish-staging.yaml"),
    readYamlFile(".github/workflows/docs-publish-public.yaml"),
  ];
  const errors: string[] = [];

  assertFernInstances(errors);
  for (const workflow of workflows) {
    assertPinnedActions(workflow, errors);
  }
  assertPreviewWorkflow(workflows[0], errors);
  assertStagingWorkflow(workflows[1], errors);
  assertPublicWorkflow(workflows[2], errors);

  if (errors.length > 0) {
    console.error(`Docs publish workflow check failed:\n${errors.join("\n")}`);
    process.exit(1);
  }
  console.log("Docs publish workflows passed.");
}

main();
