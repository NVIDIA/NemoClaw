// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { E2E_EXECUTION_PROFILES } from "./target-catalogue.mts";
import { E2E_ACTION_PROVENANCE } from "./workflow-boundary-policy.mts";

type WorkflowRecord = Record<string, unknown>;
type WorkflowStep = WorkflowRecord & {
  env?: WorkflowRecord;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: WorkflowRecord;
};

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_PROFILE_PATH = join(REPO_ROOT, ".github", "workflows", "e2e-standard-profile.yaml");
const PROFILE_WORKFLOW = "./.github/workflows/e2e-standard-profile.yaml";
const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const PROFILE_JOBS = {
  standard: {
    job: "catalogue-standard",
    matrix: "catalogue_standard_matrix",
    secrets: ["DOCKERHUB_TOKEN", "DOCKERHUB_USERNAME"],
  },
  "nvidia-api": {
    job: "catalogue-nvidia-api",
    matrix: "catalogue_nvidia_api_matrix",
    secrets: ["DOCKERHUB_TOKEN", "DOCKERHUB_USERNAME", "NVIDIA_API_KEY"],
  },
  "nvidia-inference": {
    job: "catalogue-nvidia-inference",
    matrix: "catalogue_nvidia_inference_matrix",
    secrets: ["DOCKERHUB_TOKEN", "DOCKERHUB_USERNAME", "NVIDIA_INFERENCE_API_KEY"],
  },
} as const;

function record(value: unknown): WorkflowRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as WorkflowRecord)
    : {};
}

function steps(value: unknown): WorkflowStep[] {
  return Array.isArray(value) ? (value as WorkflowStep[]) : [];
}

function namedStep(workflowSteps: readonly WorkflowStep[], name: string): WorkflowStep | undefined {
  return workflowSteps.find((step) => step.name === name);
}

function requireStep(
  errors: string[],
  workflowSteps: readonly WorkflowStep[],
  name: string,
): WorkflowStep | undefined {
  const matches = workflowSteps.filter((step) => step.name === name);
  if (matches.length !== 1) errors.push(`standard E2E profile must define one '${name}' step`);
  return matches[0];
}

function requirePinnedAction(errors: string[], step: WorkflowStep | undefined, name: string): void {
  if (!step?.uses || !/@[0-9a-f]{40}$/u.test(step.uses)) {
    errors.push(`standard E2E profile ${name} action must use a full commit SHA`);
  }
}

function validateProfileCallers(errors: string[], workflow: WorkflowRecord): void {
  const jobs = record(workflow.jobs);
  for (const profile of E2E_EXECUTION_PROFILES) {
    const contract = PROFILE_JOBS[profile];
    const job = record(jobs[contract.job]);
    if (Object.keys(job).length === 0) {
      errors.push(`workflow is missing ${contract.job}`);
      continue;
    }
    if (job.needs !== "generate-matrix" || job.uses !== PROFILE_WORKFLOW) {
      errors.push(`${contract.job} must call the standard E2E profile after matrix generation`);
    }
    const matrixOutput = `needs.generate-matrix.outputs.${contract.matrix}`;
    if (
      job.if !== `\${{ ${matrixOutput} != '[]' }}` ||
      record(record(job.strategy).matrix).include !== `\${{ fromJSON(${matrixOutput}) }}`
    ) {
      errors.push(`${contract.job} must use its generated catalogue matrix`);
    }
    const withInputs = record(job.with);
    for (const [name, expected] of Object.entries({
      candidate_repository: "${{ inputs.checkout_repository || github.repository }}",
      candidate_sha: "${{ inputs.checkout_sha || github.sha }}",
      cli_artifact_provenance: "${{ needs.generate-matrix.outputs.cli_artifact_provenance }}",
      target_id: "${{ matrix.id }}",
      runner: "${{ matrix.runner }}",
      test_file: "${{ matrix.test_file }}",
      timeout_minutes: "${{ matrix.timeout_minutes }}",
      install_mode: "${{ matrix.install_mode }}",
      restore_cli: "${{ matrix.restore_cli }}",
      trusted_main:
        "${{ github.repository == 'NVIDIA/NemoClaw' && github.ref == 'refs/heads/main' && inputs.checkout_sha == '' }}",
    })) {
      if (withInputs[name] !== expected) {
        errors.push(`${contract.job} must pass ${name} from the trusted execution plan`);
      }
    }
    const callerSecrets = record(job.secrets);
    if (
      Object.keys(callerSecrets).sort().join(",") !== [...contract.secrets].sort().join(",") ||
      contract.secrets.some((name) => callerSecrets[name] !== `\${{ secrets.${name} }}`)
    ) {
      errors.push(`${contract.job} must receive only its profile secrets`);
    }
  }
}

function validateProfileWorkflow(errors: string[], profile: WorkflowRecord): void {
  const triggers = record(profile.on ?? profile[true as unknown as string]);
  const call = record(triggers.workflow_call);
  const inputs = record(call.inputs);
  const requiredInputs = {
    candidate_repository: "string",
    candidate_sha: "string",
    cli_artifact_provenance: "string",
    target_id: "string",
    runner: "string",
    test_file: "string",
    timeout_minutes: "number",
    install_mode: "string",
    restore_cli: "boolean",
    trusted_main: "boolean",
  };
  if (
    Object.keys(inputs).sort().join(",") !== Object.keys(requiredInputs).sort().join(",") ||
    Object.entries(requiredInputs).some(
      ([name, type]) =>
        record(inputs[name]).required !== true || record(inputs[name]).type !== type,
    )
  ) {
    errors.push("standard E2E profile must require its exact execution-plan inputs");
  }
  const acceptedSecrets = [
    "DOCKERHUB_TOKEN",
    "DOCKERHUB_USERNAME",
    "NVIDIA_API_KEY",
    "NVIDIA_INFERENCE_API_KEY",
  ];
  const declaredSecrets = record(call.secrets);
  if (
    Object.keys(declaredSecrets).sort().join(",") !== acceptedSecrets.sort().join(",") ||
    acceptedSecrets.some((name) => record(declaredSecrets[name]).required !== false)
  ) {
    errors.push("standard E2E profile must accept only its four optional profile secrets");
  }
  if (record(profile.permissions).contents !== "read") {
    errors.push("standard E2E profile permissions must be contents: read");
  }

  const runJob = record(record(profile.jobs).run);
  if (runJob["runs-on"] !== "${{ inputs.runner }}") {
    errors.push("standard E2E profile must use the catalogue runner");
  }
  if (runJob["timeout-minutes"] !== "${{ inputs.timeout_minutes }}") {
    errors.push("standard E2E profile must use the catalogue timeout");
  }
  const jobEnv = record(runJob.env);
  for (const [name, expected] of Object.entries({
    E2E_JOB: "1",
    E2E_TARGET_ID: "${{ inputs.target_id }}",
    E2E_ARTIFACT_DIR: "${{ github.workspace }}/e2e-artifacts/live/${{ inputs.target_id }}",
    NEMOCLAW_RUN_LIVE_E2E: "1",
    NEMOCLAW_E2E_EXPECTED_SHA: "${{ inputs.candidate_sha }}",
    NEMOCLAW_LLAMA_CPP_QUALIFICATION_HEAD_SHA: "${{ inputs.candidate_sha }}",
  })) {
    if (jobEnv[name] !== expected) errors.push(`standard E2E profile must set ${name}`);
  }

  const workflowSteps = steps(runJob.steps);
  const checkout = workflowSteps.find((step) => step.uses?.startsWith("actions/checkout@"));
  requirePinnedAction(errors, checkout, "checkout");
  const checkoutWith = record(checkout?.with);
  if (
    checkout?.uses !== CHECKOUT ||
    checkoutWith.repository !== "${{ inputs.candidate_repository }}" ||
    checkoutWith.ref !== "${{ inputs.candidate_sha }}" ||
    checkoutWith["persist-credentials"] !== false
  ) {
    errors.push("standard E2E profile must check out the exact candidate without credentials");
  }

  const auth = requireStep(errors, workflowSteps, "Authenticate to Docker Hub");
  if (auth?.uses !== E2E_ACTION_PROVENANCE.dockerAuth.reference) {
    errors.push("standard E2E profile must use the reviewed Docker Hub authentication action");
  }
  const authInputs = record(auth?.with);
  const expectedAuthInputs = {
    "auth-required": "${{ inputs.trusted_main && '1' || '0' }}",
    username: "${{ inputs.trusted_main && secrets.DOCKERHUB_USERNAME || '' }}",
    token: "${{ inputs.trusted_main && secrets.DOCKERHUB_TOKEN || '' }}",
  };
  for (const [name, expected] of Object.entries(expectedAuthInputs)) {
    if (authInputs[name] !== expected) {
      errors.push(`standard E2E profile Docker Hub ${name} must be guarded by trusted_main`);
    }
  }

  const prepare = requireStep(errors, workflowSteps, "Prepare E2E workspace");
  if (
    prepare?.uses !== E2E_ACTION_PROVENANCE.prepareWorkspace.reference ||
    record(prepare?.with)["build-cli"] !== "false"
  ) {
    errors.push("standard E2E profile must prepare once without rebuilding the CLI");
  }
  const restore = requireStep(errors, workflowSteps, "Restore exact-commit CLI artifact");
  if (
    restore?.if !== "${{ inputs.restore_cli }}" ||
    restore.uses !== E2E_ACTION_PROVENANCE.restoreCliArtifact.reference ||
    record(restore.with)["provenance-json"] !== "${{ inputs.cli_artifact_provenance }}"
  ) {
    errors.push("standard E2E profile must restore the planned exact-commit CLI artifact");
  }

  const authenticatedInstall = requireStep(errors, workflowSteps, "Install OpenShell CLI");
  if (
    authenticatedInstall?.if !== "${{ inputs.install_mode == 'authenticated' }}" ||
    authenticatedInstall.run !== "bash scripts/install-openshell.sh"
  ) {
    errors.push("standard E2E profile must gate authenticated OpenShell installation by mode");
  }
  const credentialFreeInstall = requireStep(
    errors,
    workflowSteps,
    "Install OpenShell CLI without workflow credentials",
  );
  if (
    credentialFreeInstall?.if !== "${{ inputs.install_mode == 'credential-free' }}" ||
    !String(credentialFreeInstall.run).includes("env -u DOCKER_CONFIG") ||
    !String(credentialFreeInstall.run).includes("-u NVIDIA_INFERENCE_API_KEY")
  ) {
    errors.push(
      "standard E2E profile must remove workflow credentials from credential-free installs",
    );
  }

  const execute = requireStep(errors, workflowSteps, "Run catalogue E2E target");
  const executeEnv = record(execute?.env);
  if (
    !String(execute?.run).includes('if [ "$INSTALL_MODE" != "none" ]; then') ||
    !String(execute?.run).includes('OPENSHELL_BIN="$(command -v openshell)"') ||
    !String(execute?.run).includes('"$OPENSHELL_BIN" --version') ||
    !String(execute?.run).includes(
      'npx tsx tools/e2e/target-catalogue.mts run "$TARGET_ID" "$TEST_FILE"',
    ) ||
    executeEnv.INSTALL_MODE !== "${{ inputs.install_mode }}" ||
    executeEnv.TARGET_ID !== "${{ inputs.target_id }}" ||
    executeEnv.TEST_FILE !== "${{ inputs.test_file }}" ||
    executeEnv.NVIDIA_API_KEY !== "${{ inputs.trusted_main && secrets.NVIDIA_API_KEY || '' }}" ||
    executeEnv.NVIDIA_INFERENCE_API_KEY !==
      "${{ inputs.trusted_main && secrets.NVIDIA_INFERENCE_API_KEY || '' }}"
  ) {
    errors.push("standard E2E profile must run the planned catalogue target with guarded secrets");
  }

  const upload = requireStep(errors, workflowSteps, "Upload E2E artifacts");
  if (
    upload?.if !== "always()" ||
    upload.uses !== E2E_ACTION_PROVENANCE.uploadArtifacts.reference
  ) {
    errors.push("standard E2E profile must always upload artifacts with the reviewed action");
  }
  const evidence = requireStep(errors, workflowSteps, "Write E2E evidence manifest");
  const evidenceEnv = record(evidence?.env);
  const evidenceRun = String(evidence?.run ?? "");
  if (
    evidence?.if !== "always()" ||
    evidenceEnv.CANDIDATE_SHA !== "${{ inputs.candidate_sha }}" ||
    evidenceEnv.WORKFLOW_SHA !== "${{ github.workflow_sha }}" ||
    evidenceEnv.JOB_STATUS !== "${{ job.status }}" ||
    !evidenceRun.includes('kind: "nemoclaw-e2e-evidence-v1"') ||
    !evidenceRun.includes("successful E2E target produced no product evidence") ||
    !evidenceRun.includes('>"$ARTIFACT_DIRECTORY/evidence-manifest.json"') ||
    workflowSteps.indexOf(evidence ?? {}) >= workflowSteps.indexOf(upload ?? {})
  ) {
    errors.push(
      "standard E2E profile must write exact-commit product evidence before artifact upload",
    );
  }
  const cleanup = namedStep(workflowSteps, "Clean up Docker auth");
  if (
    cleanup?.if !== "always()" ||
    cleanup.run !== "bash .github/scripts/docker-auth-cleanup.sh" ||
    workflowSteps.at(-1) !== cleanup
  ) {
    errors.push("standard E2E profile must always clean up Docker authentication last");
  }
}

export function validateStandardProfileWorkflowBoundary(
  workflow: WorkflowRecord,
  profilePath = DEFAULT_PROFILE_PATH,
): string[] {
  const errors: string[] = [];
  validateProfileCallers(errors, workflow);
  validateProfileWorkflow(errors, record(YAML.parse(readFileSync(profilePath, "utf8"))));
  return errors;
}
