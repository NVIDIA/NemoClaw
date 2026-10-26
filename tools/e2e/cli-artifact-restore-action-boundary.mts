// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import { CLI_ARTIFACT_PACKAGE_SCRIPT } from "./cli-artifact-workflow-boundary.mts";
import { E2E_ACTION_PROVENANCE, E2E_JOB_POLICY } from "./workflow-boundary-policy.mts";

type WorkflowRecord = Record<string, unknown>;

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RESTORE_ACTION_PREFIX = "NVIDIA/NemoClaw/.github/actions/restore-e2e-cli-artifact@";
const SETUP_NODE_PREFIX = "actions/setup-node@";
const LOCAL_ACTION_PREFIXES = ["./.trusted-ci-actions/.github/actions/", "./.github/actions/"];

export type CliArtifactRestoreActionPaths = {
  action: string;
  identityScript: string;
  restoreScript: string;
};

export const DEFAULT_CLI_ARTIFACT_RESTORE_ACTION_PATHS: CliArtifactRestoreActionPaths = {
  action: join(REPO_ROOT, ".github", "actions", "restore-e2e-cli-artifact", "action.yaml"),
  identityScript: join(REPO_ROOT, "scripts", "e2e", "validate-cli-artifact-identity.sh"),
  restoreScript: join(REPO_ROOT, "scripts", "e2e", "restore-cli-artifact.sh"),
};

function record(value: unknown): WorkflowRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as WorkflowRecord)
    : {};
}

function steps(value: unknown): WorkflowRecord[] {
  return Array.isArray(value) ? value.map(record) : [];
}

function sha256(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

/**
 * The pinned action runs the helpers beside its own action file, not the
 * candidate checkout. Binding the local copies to the pin lets offline tests
 * execute exactly the helpers that CI runs.
 */
export function validateCliArtifactRestoreAction(
  paths: CliArtifactRestoreActionPaths = DEFAULT_CLI_ARTIFACT_RESTORE_ACTION_PATHS,
): string[] {
  const provenance = E2E_ACTION_PROVENANCE.restoreCliArtifact;
  const errors: string[] = [];
  if (sha256(readFileSync(paths.action, "utf8")) !== provenance.contentSha256) {
    errors.push(
      "restore-e2e-cli-artifact action content must match the action reviewed at its immutable commit pin",
    );
  }
  if (sha256(readFileSync(paths.identityScript, "utf8")) !== provenance.identityScriptSha256) {
    errors.push(
      "restore-e2e-cli-artifact identity helper must match the helper reviewed at its immutable commit pin",
    );
  }
  if (sha256(readFileSync(paths.restoreScript, "utf8")) !== provenance.restoreScriptSha256) {
    errors.push(
      "restore-e2e-cli-artifact restore helper must match the helper reviewed at its immutable commit pin",
    );
  }
  return errors;
}

export type CliArtifactRestoreNodeRequirements = {
  consumer: string | undefined;
  manifest: string | undefined;
};

function singleMatch(source: string, pattern: RegExp): string | undefined {
  const matches = [...source.matchAll(pattern)].map((match) => match[1]);
  return matches.length === 1 ? matches[0] : undefined;
}

/** Returns the Node versions that the restore helper requires of its consumer and producer. */
export function cliArtifactRestoreNodeRequirements(
  restoreScriptSource: string,
): CliArtifactRestoreNodeRequirements {
  return {
    consumer: singleMatch(
      restoreScriptSource,
      /\[\[ "\$\(node --version\)" == "(v\d+\.\d+\.\d+)" \]\]/g,
    ),
    manifest: singleMatch(restoreScriptSource, /\.toolchain\.node == "(v\d+\.\d+\.\d+)"/g),
  };
}

function localActionPath(uses: string): string | undefined {
  if (uses === E2E_ACTION_PROVENANCE.prepareWorkspace.reference) {
    // validatePrepareE2eAction binds this local file to the pinned reference.
    return join(REPO_ROOT, ".github", "actions", "prepare-e2e", "action.yaml");
  }
  const prefix = LOCAL_ACTION_PREFIXES.find((candidate) => uses.startsWith(candidate));
  if (!prefix) return undefined;
  const name = uses.slice(prefix.length);
  return /^[a-z0-9-]+$/.test(name)
    ? join(REPO_ROOT, ".github", "actions", name, "action.yaml")
    : undefined;
}

type NodeSelection = { version: string | undefined };

function nodeSelection(step: WorkflowRecord): NodeSelection | undefined {
  const uses = typeof step.uses === "string" ? step.uses : "";
  if (uses.startsWith(SETUP_NODE_PREFIX)) {
    const version = record(step.with)["node-version"];
    return { version: typeof version === "string" ? `v${version}` : undefined };
  }
  const actionPath = localActionPath(uses);
  if (!actionPath) return undefined;
  const actionSteps = steps(
    record(record(YAML.parse(readFileSync(actionPath, "utf8"))).runs).steps,
  );
  return { version: effectiveNode(actionSteps, actionSteps.length) };
}

/** Returns the Node version selected by the last setup step before the given index. */
function effectiveNode(jobSteps: WorkflowRecord[], beforeIndex: number): string | undefined {
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    const selection = nodeSelection(jobSteps[index]);
    if (selection) return selection.version;
  }
  return undefined;
}

export type CliArtifactRestoreNodeVersions = {
  consumers: { job: string; uses: string; node: string | undefined }[];
  producer: string | undefined;
};

/** Returns the Node version active at each CLI artifact restore and at artifact packaging. */
export function cliArtifactRestoreNodeVersions(
  workflowValue: unknown,
): CliArtifactRestoreNodeVersions {
  const jobs = record(record(workflowValue).jobs);
  const consumers: CliArtifactRestoreNodeVersions["consumers"] = [];
  for (const [job, jobValue] of Object.entries(jobs)) {
    const jobSteps = steps(record(jobValue).steps);
    jobSteps.forEach((step, index) => {
      const uses = typeof step.uses === "string" ? step.uses : "";
      if (uses.startsWith(RESTORE_ACTION_PREFIX)) {
        consumers.push({ job, uses, node: effectiveNode(jobSteps, index) });
      }
    });
  }
  const producerSteps = steps(record(jobs[E2E_JOB_POLICY.cliArtifactProducer]).steps);
  const packageIndex = producerSteps.findIndex((step) => step.run === CLI_ARTIFACT_PACKAGE_SCRIPT);
  return {
    consumers,
    producer: packageIndex < 0 ? undefined : effectiveNode(producerSteps, packageIndex),
  };
}

export type CliArtifactRestoreToolchainOptions = {
  requireProducer: boolean;
  restoreScriptPath?: string;
};

/**
 * Requires every CLI artifact restore to use the reviewed action and to run under
 * the Node version its helper accepts. When the workflow owns the producer, the
 * packaging Node version must also match the helper's manifest requirement.
 */
export function validateCliArtifactRestoreToolchain(
  workflowValue: unknown,
  options: CliArtifactRestoreToolchainOptions,
): string[] {
  const requirements = cliArtifactRestoreNodeRequirements(
    readFileSync(
      options.restoreScriptPath ?? DEFAULT_CLI_ARTIFACT_RESTORE_ACTION_PATHS.restoreScript,
      "utf8",
    ),
  );
  if (!requirements.consumer || !requirements.manifest) {
    return ["CLI artifact restore helper must declare one consumer and one manifest Node version"];
  }
  const errors: string[] = [];
  const versions = cliArtifactRestoreNodeVersions(workflowValue);
  for (const consumer of versions.consumers) {
    if (consumer.uses !== E2E_ACTION_PROVENANCE.restoreCliArtifact.reference) {
      errors.push(
        `${consumer.job} must restore the CLI artifact with the reviewed action reference`,
      );
    }
    if (consumer.node !== requirements.consumer) {
      errors.push(
        `${consumer.job} must prepare Node ${requirements.consumer} before the pinned CLI artifact restore helper`,
      );
    }
  }
  if (options.requireProducer && versions.producer !== requirements.manifest) {
    errors.push(
      `${E2E_JOB_POLICY.cliArtifactProducer} must package the CLI artifact under Node ${requirements.manifest} accepted by the pinned restore helper`,
    );
  }
  return errors;
}
