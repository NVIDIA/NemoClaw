// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_ACTION_DIR = join(REPO_ROOT, ".github", "actions", "docker-auth-setup");
const DEFAULT_ACTION_PATH = join(DEFAULT_ACTION_DIR, "action.yaml");
const DEFAULT_SETUP_PATH = join(DEFAULT_ACTION_DIR, "setup.sh");

const DOCKER_AUTH_SETUP_ACTION_PROVENANCE = {
  reference:
    "NVIDIA/NemoClaw/.github/actions/docker-auth-setup@66cf71b3af6c32ab972a1ce0e505499da0b495f2",
  actionYamlSha256: "fc1b656caaa96da3b179b7f2f81d53a8459d5f4d477070c1538bc2384e7f5c1a",
  setupShSha256: "7e4eba935281957447a41a3227aeb9a30f242fc549bcac2d87e53667f1379f7b",
} as const;

export const DOCKER_AUTH_SETUP_ACTION = DOCKER_AUTH_SETUP_ACTION_PROVENANCE.reference;
export const DOCKER_AUTH_SETUP_STEP = "Authenticate to Docker Hub";
export const CHECKOUT_LOCAL_DOCKER_AUTH_SETUP_ACTION = "./.github/actions/docker-auth-setup";

type WorkflowRecord = Record<string, unknown>;

function record(value: unknown): WorkflowRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as WorkflowRecord)
    : {};
}

function sha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export function validateDockerAuthSetupAction(
  actionPath = DEFAULT_ACTION_PATH,
  setupPath = DEFAULT_SETUP_PATH,
): string[] {
  const errors: string[] = [];
  const actionSource = readFileSync(actionPath, "utf8");
  const setupSource = readFileSync(setupPath, "utf8");

  if (sha256(actionPath) !== DOCKER_AUTH_SETUP_ACTION_PROVENANCE.actionYamlSha256) {
    errors.push(
      "docker-auth-setup action.yaml must match the content reviewed at its immutable commit pin",
    );
  }
  if (sha256(setupPath) !== DOCKER_AUTH_SETUP_ACTION_PROVENANCE.setupShSha256) {
    errors.push(
      "docker-auth-setup setup.sh must match the content reviewed at its immutable commit pin",
    );
  }

  const action = record(YAML.parse(actionSource));
  if (action.name !== "docker-auth-setup") {
    errors.push("docker-auth-setup action identity must remain canonical");
  }
  if (Object.keys(record(action.inputs)).length !== 0) {
    errors.push("docker-auth-setup must not expose inputs; credential mapping stays in YAML");
  }

  const runs = record(action.runs);
  if (runs.using !== "composite") {
    errors.push("docker-auth-setup must be a composite action");
  }
  const expectedSteps = [
    {
      name: "Authenticate to Docker Hub",
      shell: "bash",
      run: 'bash "${{ github.action_path }}/setup.sh"',
    },
  ];
  if (!isDeepStrictEqual(runs.steps, expectedSteps)) {
    errors.push("docker-auth-setup must run only the reviewed setup.sh from github.action_path");
  }

  for (const fragment of [
    'mktemp -d "${RUNNER_TEMP}/docker-config-${GITHUB_JOB}-XXXXXX"',
    'chmod 700 "${docker_config}"',
    'export DOCKER_CONFIG="${docker_config}"',
    'if [[ "${DOCKERHUB_AUTH_REQUIRED}" != "1" ]]; then',
    "continuing with anonymous pulls",
    'if [[ -z "${DOCKERHUB_USERNAME}" || -z "${DOCKERHUB_TOKEN}" ]]; then',
    "Docker Hub credentials are required for trusted runs",
    'auth_marker="${DOCKER_CONFIG}/.nemoclaw-docker-login-attempted"',
    ': > "${auth_marker}"',
    'chmod 600 "${auth_marker}"',
    "for attempt in 1 2 3; do",
    "timeout 30s docker login docker.io",
    '--username "${DOCKERHUB_USERNAME}"',
    "--password-stdin",
    "Docker Hub login failed after 3 attempts",
  ]) {
    if (!setupSource.includes(fragment)) {
      errors.push(`docker-auth-setup setup.sh must include ${fragment}`);
    }
  }
  if (
    !setupSource.includes("printf 'DOCKER_CONFIG=%s\\n'") ||
    !setupSource.includes('"${DOCKER_CONFIG}"') ||
    !setupSource.includes('>> "${GITHUB_ENV}"')
  ) {
    errors.push(
      "docker-auth-setup setup.sh must persist the isolated DOCKER_CONFIG through GITHUB_ENV",
    );
  }
  if (setupSource.includes("${{ github.workspace }}") || setupSource.includes("GITHUB_WORKSPACE")) {
    errors.push("docker-auth-setup setup.sh must not use the checkout workspace");
  }
  if (/--password(?:=|\s)(?!-stdin\b)/u.test(setupSource)) {
    errors.push("docker-auth-setup must pass the token only through --password-stdin");
  }

  const configIndex = setupSource.indexOf(
    'mktemp -d "${RUNNER_TEMP}/docker-config-${GITHUB_JOB}-XXXXXX"',
  );
  const trustIndex = setupSource.indexOf('if [[ "${DOCKERHUB_AUTH_REQUIRED}" != "1" ]]; then');
  const loginIndex = setupSource.indexOf("docker login docker.io");
  if (configIndex < 0 || trustIndex <= configIndex || loginIndex <= trustIndex) {
    errors.push(
      "docker-auth-setup must isolate Docker config before evaluating trust and authenticating",
    );
  }
  const missingCredentialsIndex = setupSource.indexOf(
    'if [[ -z "${DOCKERHUB_USERNAME}" || -z "${DOCKERHUB_TOKEN}" ]]; then',
  );
  const missingCredentialsEndIndex = setupSource.indexOf("\nfi", missingCredentialsIndex);
  const markerPathIndex = setupSource.indexOf(
    'auth_marker="${DOCKER_CONFIG}/.nemoclaw-docker-login-attempted"',
  );
  const markerCreateIndex = setupSource.indexOf(': > "${auth_marker}"');
  const markerChmodIndex = setupSource.indexOf('chmod 600 "${auth_marker}"');
  const retryIndex = setupSource.indexOf("for attempt in 1 2 3; do");
  const missingCredentialsBlock =
    missingCredentialsIndex >= 0 && retryIndex > missingCredentialsIndex
      ? setupSource.slice(missingCredentialsIndex, retryIndex)
      : "";
  if (!missingCredentialsBlock.includes("exit 1")) {
    errors.push("docker-auth-setup must fail when trusted credentials are missing");
  }
  if (
    missingCredentialsEndIndex < 0 ||
    markerPathIndex <= missingCredentialsEndIndex ||
    markerCreateIndex <= markerPathIndex ||
    markerChmodIndex <= markerCreateIndex ||
    retryIndex <= markerChmodIndex ||
    loginIndex <= retryIndex
  ) {
    errors.push(
      "docker-auth-setup must create and protect its login-attempt marker after trusted credential validation and before login",
    );
  }
  const exhaustedLoginIndex = setupSource.indexOf("Docker Hub login failed after 3 attempts");
  if (exhaustedLoginIndex < 0 || !setupSource.slice(exhaustedLoginIndex).includes("exit 1")) {
    errors.push("docker-auth-setup must fail after exhausting login retries");
  }
  if ((setupSource.match(/\bexit 1\b/gu) ?? []).length !== 2) {
    errors.push(
      "docker-auth-setup must fail closed on missing credentials and exhausted login retries",
    );
  }

  return errors;
}

export function validateDockerAuthSetupWorkflowBoundary(
  actionPath = DEFAULT_ACTION_PATH,
  setupPath = DEFAULT_SETUP_PATH,
): string[] {
  return validateDockerAuthSetupAction(actionPath, setupPath);
}
