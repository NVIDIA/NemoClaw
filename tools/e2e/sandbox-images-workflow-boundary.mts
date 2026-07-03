// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_WORKFLOW_PATH = join(
  REPO_ROOT,
  ".github",
  "workflows",
  "sandbox-images-and-e2e.yaml",
);
const DEFAULT_MAIN_WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "main.yaml");

const AUTH_STEP_NAME = "Authenticate to Docker Hub";
const CLEANUP_STEP_NAME = "Clean up Docker auth";
const CLEANUP_RUN = "bash .github/scripts/docker-auth-cleanup.sh";
const HERMES_SECRET_BOUNDARY_STEP_ID = "hermes-secret-boundary";
const HERMES_ROOT_AFTER_SECRET_CONDITION =
  "${{ !cancelled() && (steps.hermes-secret-boundary.outcome == 'success' || steps.hermes-secret-boundary.outcome == 'failure') }}";
const IMAGE_BUILD_JOBS = [
  "build-sandbox-images",
  "build-hermes-sandbox-image",
  "build-sandbox-images-arm64",
] as const;
const OPENCLAW_IMAGE_CONSUMER_JOBS = [
  "runtime-overrides",
  "test-e2e-sandbox",
  "test-e2e-gateway-isolation",
  "test-e2e-port-overrides",
] as const;
const DOCKERHUB_SECRETS = ["DOCKERHUB_USERNAME", "DOCKERHUB_TOKEN"] as const;
const FORBIDDEN_RUNTIME_SECRETS = [
  "NVIDIA_API_KEY",
  "NVIDIA_INFERENCE_API_KEY",
  "GITHUB_TOKEN",
] as const;
// The reusable workflow inherits `push` from its main-workflow caller and uses
// `workflow_dispatch` for branch validation; unlike the E2E workflow, it has no schedule trigger.
const TRUSTED_PREDICATE =
  "github.repository == 'NVIDIA/NemoClaw' && github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')";
const EXPECTED_AUTH_ENV = {
  DOCKERHUB_AUTH_REQUIRED: `\${{ ${TRUSTED_PREDICATE} && '1' || '0' }}`,
  DOCKERHUB_USERNAME: `\${{ ${TRUSTED_PREDICATE} && secrets.DOCKERHUB_USERNAME || '' }}`,
  DOCKERHUB_TOKEN: `\${{ ${TRUSTED_PREDICATE} && secrets.DOCKERHUB_TOKEN || '' }}`,
};
const FULL_SHA_ACTION = /^[^\s@]+@[0-9a-f]{40}$/u;
const REGISTRY_WRITE =
  /(?:\bdocker\s+(?:image\s+)?push\b|\bdocker\s+buildx\s+build\b[^\n]*\s--push(?:\s|$)|\b(?:oras|crane)\s+push\b|\bskopeo\s+copy\b)/u;

type GuardedProductionBuildContract = {
  args: string;
  envName: string;
  jobName: (typeof IMAGE_BUILD_JOBS)[number];
  label: string;
  stepName: string;
  target: string;
  testImageDockerfile?: string;
};

const GUARDED_PRODUCTION_BUILD_CONTRACTS: readonly GuardedProductionBuildContract[] = [
  {
    args: '--build-arg "BASE_IMAGE=${BASE_IMAGE}"',
    envName: "BASE_IMAGE",
    jobName: "build-sandbox-images",
    label: "OpenClaw production image",
    stepName: "Build production image",
    target: "nemoclaw-production",
    testImageDockerfile: "-f test/Dockerfile.sandbox",
  },
  {
    args: '-f agents/hermes/Dockerfile --build-arg "BASE_IMAGE=${HERMES_BASE_IMAGE}"',
    envName: "HERMES_BASE_IMAGE",
    jobName: "build-hermes-sandbox-image",
    label: "Hermes production image",
    stepName: "Build Hermes production image",
    target: "nemoclaw-hermes-production",
  },
  {
    args: '--build-arg "BASE_IMAGE=${BASE_IMAGE}"',
    envName: "BASE_IMAGE",
    jobName: "build-sandbox-images-arm64",
    label: "OpenClaw arm64 production image",
    stepName: "Build production image on arm64",
    target: "nemoclaw-production-arm64",
    testImageDockerfile: "-f test/Dockerfile.sandbox",
  },
];

type WorkflowRecord = Record<string, unknown>;

export type SandboxImagesWorkflowStep = WorkflowRecord & {
  env?: WorkflowRecord;
  name?: string;
  run?: string;
  uses?: string;
  with?: WorkflowRecord;
};

export type SandboxImagesWorkflowJob = WorkflowRecord & {
  env?: WorkflowRecord;
  secrets?: WorkflowRecord;
  steps?: SandboxImagesWorkflowStep[];
};

export type SandboxImagesWorkflow = WorkflowRecord & {
  jobs: Record<string, SandboxImagesWorkflowJob>;
  on?: WorkflowRecord;
  permissions?: WorkflowRecord;
};

function record(value: unknown): WorkflowRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as WorkflowRecord)
    : {};
}

function steps(job: SandboxImagesWorkflowJob): SandboxImagesWorkflowStep[] {
  return Array.isArray(job.steps) ? job.steps : [];
}

function sortedKeys(value: WorkflowRecord): string[] {
  return Object.keys(value).sort();
}

function findStep(
  job: SandboxImagesWorkflowJob,
  name: string,
): SandboxImagesWorkflowStep | undefined {
  return steps(job).find((step) => step.name === name);
}

function stepIndex(job: SandboxImagesWorkflowJob, name: string): number {
  return steps(job).findIndex((step) => step.name === name);
}

function requireStep(
  errors: string[],
  jobName: string,
  job: SandboxImagesWorkflowJob,
  name: string,
): SandboxImagesWorkflowStep {
  const step = findStep(job, name);
  if (!step) errors.push(`${jobName} is missing step '${name}'`);
  return step ?? {};
}

function validateTriggersAndPermissions(errors: string[], workflow: SandboxImagesWorkflow): void {
  const triggers = record(workflow.on);
  if (!Object.hasOwn(triggers, "workflow_dispatch")) {
    errors.push("sandbox image workflow must support branch workflow_dispatch runs");
  }
  const workflowCall = record(triggers.workflow_call);
  const callSecrets = record(workflowCall.secrets);
  if (!isDeepStrictEqual(sortedKeys(callSecrets), [...DOCKERHUB_SECRETS].sort())) {
    errors.push("sandbox image workflow_call must declare only the two Docker Hub secrets");
  }
  for (const secret of DOCKERHUB_SECRETS) {
    if (record(callSecrets[secret]).required !== false) {
      errors.push(`sandbox image workflow_call secret ${secret} must remain optional`);
    }
  }
  if (!isDeepStrictEqual(record(workflow.permissions), { contents: "read" })) {
    errors.push("sandbox image workflow permissions must be read-only contents");
  }
}

function validateMainCaller(errors: string[], mainWorkflow: SandboxImagesWorkflow): void {
  const caller = record(record(mainWorkflow.jobs)["sandbox-images-and-e2e"]);
  if (caller.uses !== "./.github/workflows/sandbox-images-and-e2e.yaml") {
    errors.push("main workflow must call the local sandbox image workflow");
  }
  const callerSecrets = record(caller.secrets);
  const expectedSecrets = {
    DOCKERHUB_USERNAME: "${{ secrets.DOCKERHUB_USERNAME }}",
    DOCKERHUB_TOKEN: "${{ secrets.DOCKERHUB_TOKEN }}",
  };
  if (!isDeepStrictEqual(callerSecrets, expectedSecrets)) {
    errors.push(
      "main sandbox image caller must map only the optional Docker Hub secrets explicitly",
    );
  }
}

function validateCanonicalAuth(errors: string[], auth: SandboxImagesWorkflowStep): void {
  if (!isDeepStrictEqual(sortedKeys(auth), ["env", "name", "run", "shell"])) {
    errors.push("sandbox image Docker Hub auth step must expose only name, env, shell, and run");
  }
  if (auth.shell !== "bash") errors.push("sandbox image Docker Hub auth step must use bash");
  if (!isDeepStrictEqual(record(auth.env), EXPECTED_AUTH_ENV)) {
    errors.push(
      "sandbox image Docker Hub credentials must be gated to trusted main push/manual runs",
    );
  }

  const run = typeof auth.run === "string" ? auth.run : "";
  const requiredFragments = [
    'mktemp -d "${RUNNER_TEMP}/docker-config-${GITHUB_JOB}-XXXXXX"',
    'chmod 700 "${docker_config}"',
    'printf \'DOCKER_CONFIG=%s\\n\' "${DOCKER_CONFIG}" >> "${GITHUB_ENV}"',
    'if [[ "${DOCKERHUB_AUTH_REQUIRED}" != "1" ]]',
    'if [[ -z "${DOCKERHUB_USERNAME}" || -z "${DOCKERHUB_TOKEN}" ]]',
    'auth_marker="${DOCKER_CONFIG}/.nemoclaw-docker-login-attempted"',
    ': > "${auth_marker}"',
    'chmod 600 "${auth_marker}"',
    "for attempt in 1 2 3; do",
    `if printf '%s' "\${DOCKERHUB_TOKEN}" | timeout 30s docker login docker.io --username "\${DOCKERHUB_USERNAME}" --password-stdin; then`,
    "Docker Hub login failed after 3 attempts",
  ];
  for (const fragment of requiredFragments) {
    if (!run.includes(fragment)) {
      errors.push(`sandbox image Docker Hub auth script must include ${fragment}`);
    }
  }
  if (run.includes("GITHUB_WORKSPACE")) {
    errors.push("sandbox image Docker Hub auth directory must not use the checkout workspace");
  }
  if (/--password(?:[=\s]|$)/u.test(run)) {
    errors.push("sandbox image Docker Hub token must be passed only through --password-stdin");
  }
  if ((run.match(/\bexit 1\b/gu) ?? []).length !== 2) {
    errors.push(
      "sandbox image Docker Hub auth must fail closed on missing credentials and retries",
    );
  }
  const isolateIndex = run.indexOf("mktemp -d");
  const trustIndex = run.indexOf('if [[ "${DOCKERHUB_AUTH_REQUIRED}"');
  if (isolateIndex < 0 || trustIndex < 0 || isolateIndex >= trustIndex) {
    errors.push("sandbox image Docker config must be isolated before the trust decision");
  }
}

function validateImageJobAuth(
  errors: string[],
  jobName: string,
  job: SandboxImagesWorkflowJob,
  canonicalAuth: SandboxImagesWorkflowStep,
): void {
  const jobSteps = steps(job);
  const authSteps = jobSteps.filter((step) => step.name === AUTH_STEP_NAME);
  const cleanupSteps = jobSteps.filter((step) => step.name === CLEANUP_STEP_NAME);
  if (authSteps.length !== 1) {
    errors.push(`${jobName} must authenticate to Docker Hub exactly once`);
  }
  if (cleanupSteps.length !== 1) {
    errors.push(`${jobName} must clean up Docker Hub auth exactly once`);
  }

  const checkout = jobSteps[0] ?? {};
  if (!FULL_SHA_ACTION.test(typeof checkout.uses === "string" ? checkout.uses : "")) {
    errors.push(`${jobName} checkout must pin a full action SHA`);
  }
  if (record(checkout.with)["persist-credentials"] !== false) {
    errors.push(`${jobName} checkout must disable persisted credentials`);
  }
  if (jobSteps[1]?.name !== AUTH_STEP_NAME) {
    errors.push(`${jobName} Docker Hub auth must run immediately after checkout`);
  }
  if (authSteps[0] && !isDeepStrictEqual(authSteps[0], canonicalAuth)) {
    errors.push(`${jobName} must reuse the canonical guarded Docker Hub auth mapping`);
  }

  const cleanup = cleanupSteps[0] ?? {};
  const expectedCleanup = {
    name: CLEANUP_STEP_NAME,
    if: "always()",
    shell: "bash",
    run: CLEANUP_RUN,
  };
  if (!isDeepStrictEqual(cleanup, expectedCleanup)) {
    errors.push(`${jobName} must use the canonical always-running Docker Hub cleanup`);
  }
  if (jobSteps.at(-1)?.name !== CLEANUP_STEP_NAME) {
    errors.push(`${jobName} Docker Hub cleanup must be the final step`);
  }
}

function validateSecretScopeAndRegistryWrites(
  errors: string[],
  workflow: SandboxImagesWorkflow,
): void {
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    const serializedJobEnv = JSON.stringify(record(job.env));
    for (const secret of [...DOCKERHUB_SECRETS, ...FORBIDDEN_RUNTIME_SECRETS]) {
      if (serializedJobEnv.includes(secret)) {
        errors.push(`${jobName} must not expose ${secret} at job scope`);
      }
    }
    for (const step of steps(job)) {
      const label = `${jobName} step '${step.name ?? step.uses ?? "<unnamed>"}'`;
      const run = typeof step.run === "string" ? step.run : "";
      const serialized = `${JSON.stringify(record(step.env))}\n${run}`;
      for (const secret of FORBIDDEN_RUNTIME_SECRETS) {
        if (serialized.includes(secret)) {
          errors.push(`${label} must not receive ${secret}`);
        }
      }
      if (step.name !== AUTH_STEP_NAME) {
        for (const secret of DOCKERHUB_SECRETS) {
          if (serialized.includes(secret)) {
            errors.push(`${label} must not receive ${secret}`);
          }
        }
        if (/\bdocker\s+login\b/u.test(run)) {
          errors.push(`${label} must not authenticate to a registry`);
        }
      }
      if (
        REGISTRY_WRITE.test(run) ||
        String(step.uses ?? "").includes("docker/build-push-action")
      ) {
        errors.push(`${label} must not write images to a registry`);
      }
    }
  }
}

function dockerBuildLines(job: SandboxImagesWorkflowJob): string[] {
  return steps(job).flatMap((step) =>
    (step.run ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^docker\s+build(?:\s|$)/u.test(line)),
  );
}

function validateGuardedProductionBuild(
  errors: string[],
  workflow: SandboxImagesWorkflow,
  contract: GuardedProductionBuildContract,
): void {
  const job = workflow.jobs[contract.jobName] ?? {};
  const build = requireStep(errors, contract.jobName, job, contract.stepName);
  const expectedRun = [
    "set -euo pipefail",
    `build_args=(${contract.args})`,
    'scripts/check-production-build-args.sh "${build_args[@]}"',
    `docker build "\${build_args[@]}" -t ${contract.target} .`,
    "",
  ].join("\n");
  const expectedEnv = {
    [contract.envName]: `\${{ env.${contract.envName} }}`,
  };

  if (!isDeepStrictEqual(record(build.env), expectedEnv) || build.run !== expectedRun) {
    errors.push(`${contract.label} must use the guarded build_args shape under ${contract.target}`);
  }

  const sourceBuilds = dockerBuildLines(job).filter(
    (line) =>
      contract.testImageDockerfile === undefined || !line.includes(contract.testImageDockerfile),
  );
  if (sourceBuilds.length !== 1) {
    errors.push(`${contract.label} must have exactly one source build`);
  }
}

function validateGuardedProductionBuildContracts(
  errors: string[],
  workflow: SandboxImagesWorkflow,
): void {
  for (const contract of GUARDED_PRODUCTION_BUILD_CONTRACTS) {
    validateGuardedProductionBuild(errors, workflow, contract);
  }
}

function validateRuntimeImageReuse(errors: string[], workflow: SandboxImagesWorkflow): void {
  const producerName = "build-sandbox-images";
  const producer = workflow.jobs[producerName] ?? {};
  const runtimeName = "runtime-overrides";
  const runtimeJob = workflow.jobs[runtimeName] ?? {};
  if (producer["timeout-minutes"] !== 15) {
    errors.push("build-sandbox-images must retain its 15-minute producer budget");
  }
  if (runtimeJob["timeout-minutes"] !== 60) {
    errors.push("runtime-overrides timeout must cover its 45-minute probe budget");
  }
  for (const consumerName of OPENCLAW_IMAGE_CONSUMER_JOBS) {
    if (workflow.jobs[consumerName]?.needs !== producerName) {
      errors.push(`${consumerName} must remain an independent consumer of build-sandbox-images`);
    }
  }
  const runtime = requireStep(
    errors,
    runtimeName,
    runtimeJob,
    "Run runtime overrides test against production image",
  );
  if (runtime["timeout-minutes"] !== 45) {
    errors.push("runtime overrides must retain its 45-minute probe budget");
  }
  const allRuns = steps(producer)
    .map((step) => step.run ?? "")
    .join("\n");
  if (
    findStep(producer, "Run runtime overrides test against production image") ||
    allRuns.includes("test/e2e/live/runtime-overrides.test.ts")
  ) {
    errors.push("OpenClaw producer must not run the failure-isolated runtime probe");
  }
  for (const stepName of ["Set up Node", "Install root dependencies"]) {
    if (findStep(producer, stepName)) {
      errors.push(`OpenClaw producer must not run '${stepName}'`);
    }
    if (steps(runtimeJob).filter((step) => step.name === stepName).length !== 1) {
      errors.push(`runtime-overrides must run '${stepName}' exactly once`);
    }
  }
  const save = requireStep(errors, producerName, producer, "Save images to tarballs");
  if (
    steps(producer).filter((step) => step.name === "Save images to tarballs").length !== 1 ||
    !(save.run ?? "").includes(
      "docker save nemoclaw-production | gzip > /tmp/isolation-image.tar.gz",
    )
  ) {
    errors.push("OpenClaw producer must save the production image for sibling consumers");
  }
  const isolationUpload = requireStep(errors, producerName, producer, "Upload isolation image");
  if (
    steps(producer).filter((step) => step.name === "Upload isolation image").length !== 1 ||
    !(isolationUpload.uses ?? "").startsWith("actions/upload-artifact@") ||
    !FULL_SHA_ACTION.test(isolationUpload.uses ?? "") ||
    !isDeepStrictEqual(record(isolationUpload.with), {
      name: "isolation-image",
      path: "/tmp/isolation-image.tar.gz",
      "retention-days": 1,
    }) ||
    stepIndex(producer, save.name ?? "") >= stepIndex(producer, isolationUpload.name ?? "")
  ) {
    errors.push("OpenClaw producer must upload the saved production image exactly once");
  }
  const runtimeEnv = record(runtimeJob.env);
  if (runtimeEnv.NEMOCLAW_TEST_IMAGE !== "nemoclaw-production") {
    errors.push("runtime overrides must consume the prebuilt OpenClaw production image");
  }
  if (runtimeEnv.NEMOCLAW_RUN_LIVE_E2E !== "1") {
    errors.push("runtime overrides must enable the live E2E fixture");
  }
  if (runtimeEnv.E2E_TARGET_ID !== "runtime-overrides") {
    errors.push("runtime overrides must retain its canonical target id");
  }
  if (
    runtimeEnv.E2E_ARTIFACT_DIR !== "${{ github.workspace }}/e2e-artifacts/live/runtime-overrides"
  ) {
    errors.push("runtime overrides must retain its canonical artifact directory");
  }
  if (findStep(runtimeJob, AUTH_STEP_NAME)) {
    errors.push("runtime overrides must not authenticate to Docker Hub");
  }
  if (!(runtime.run ?? "").includes("test/e2e/live/runtime-overrides.test.ts")) {
    errors.push("runtime overrides step must run its live Vitest target");
  }
  if (
    /\bdocker\s+build\b/u.test(
      steps(runtimeJob)
        .map((step) => step.run ?? "")
        .join("\n"),
    )
  ) {
    errors.push("runtime overrides step must not rebuild the prebuilt image");
  }
  const download = requireStep(errors, runtimeName, runtimeJob, "Download image artifact");
  if (
    steps(runtimeJob).filter((step) => step.name === "Download image artifact").length !== 1 ||
    !(download.uses ?? "").startsWith("actions/download-artifact@") ||
    !FULL_SHA_ACTION.test(download.uses ?? "") ||
    !isDeepStrictEqual(record(download.with), { name: "isolation-image", path: "/tmp" })
  ) {
    errors.push("runtime overrides must download the saved OpenClaw production image");
  }
  const load = requireStep(errors, runtimeName, runtimeJob, "Load image");
  if (
    steps(runtimeJob).filter((step) => step.name === "Load image").length !== 1 ||
    !(load.run ?? "").includes("/tmp/isolation-image.tar.gz | docker load") ||
    !(load.run ?? "").includes("docker image inspect nemoclaw-production")
  ) {
    errors.push("runtime overrides must load the saved OpenClaw production image");
  }
  const upload = requireStep(errors, runtimeName, runtimeJob, "Upload runtime overrides artifacts");
  if (
    steps(runtimeJob).filter((step) => step.name === "Upload runtime overrides artifacts")
      .length !== 1 ||
    upload.if !== "always()" ||
    upload.uses !== "./.github/actions/upload-e2e-artifacts"
  ) {
    errors.push("runtime overrides must always use the shared E2E artifact uploader");
  }
  if (
    stepIndex(runtimeJob, download.name ?? "") >= stepIndex(runtimeJob, load.name ?? "") ||
    stepIndex(runtimeJob, load.name ?? "") >= stepIndex(runtimeJob, runtime.name ?? "") ||
    stepIndex(runtimeJob, runtime.name ?? "") >= stepIndex(runtimeJob, upload.name ?? "")
  ) {
    errors.push("runtime overrides image handoff and artifact upload steps are out of order");
  }
}

function validateHermesImageReuse(errors: string[], workflow: SandboxImagesWorkflow): void {
  const jobName = "build-hermes-sandbox-image";
  const job = workflow.jobs[jobName] ?? {};
  if (job["timeout-minutes"] !== 150) {
    errors.push("Hermes image job timeout must cover both inherited probe budgets");
  }
  for (const stepName of ["Set up Node", "Install root dependencies"]) {
    if (steps(job).filter((step) => step.name === stepName).length !== 1) {
      errors.push(`${jobName} must run '${stepName}' exactly once`);
    }
  }
  const secretBoundary = requireStep(
    errors,
    jobName,
    job,
    "Run Hermes sandbox secret boundary test",
  );
  const rootEntrypoint = requireStep(
    errors,
    jobName,
    job,
    "Run Hermes root entrypoint smoke Vitest test",
  );
  if (secretBoundary.id !== HERMES_SECRET_BOUNDARY_STEP_ID) {
    errors.push("Hermes secret boundary step must expose its outcome to the next probe");
  }
  if (secretBoundary["timeout-minutes"] !== 60) {
    errors.push("Hermes secret boundary must retain its 60-minute probe budget");
  }
  if (rootEntrypoint.if !== HERMES_ROOT_AFTER_SECRET_CONDITION) {
    errors.push("Hermes root entrypoint must run after either secret-boundary outcome");
  }
  if (rootEntrypoint["timeout-minutes"] !== 45) {
    errors.push("Hermes root entrypoint must retain its 45-minute probe budget");
  }
  for (const [label, step, target, artifactDirectory] of [
    [
      "Hermes secret boundary",
      secretBoundary,
      "test/e2e/live/hermes-sandbox-secret-boundary.test.ts",
      "${{ github.workspace }}/e2e-artifacts/live/hermes-sandbox-secret-boundary",
    ],
    [
      "Hermes root entrypoint",
      rootEntrypoint,
      "test/e2e/live/hermes-root-entrypoint-smoke.test.ts",
      "${{ github.workspace }}/e2e-artifacts/live/hermes-root-entrypoint-smoke",
    ],
  ] as const) {
    const env = record(step.env);
    if (env.NEMOCLAW_HERMES_TEST_IMAGE !== "nemoclaw-hermes-production") {
      errors.push(`${label} must consume the prebuilt Hermes production image`);
    }
    if (env.NEMOCLAW_RUN_LIVE_E2E !== "1") {
      errors.push(`${label} must enable the live E2E fixture`);
    }
    if (env.E2E_ARTIFACT_DIR !== artifactDirectory) {
      errors.push(`${label} must retain its canonical artifact directory`);
    }
    if (!(step.run ?? "").includes(target)) {
      errors.push(`${label} step must run ${target}`);
    }
    if (/\bdocker\s+build\b/u.test(step.run ?? "")) {
      errors.push(`${label} step must not rebuild the prebuilt image`);
    }
    if (stepIndex(job, "Build Hermes production image") >= stepIndex(job, step.name ?? "")) {
      errors.push(`${label} must run after the Hermes production image build`);
    }
  }
}

export function readSandboxImagesWorkflow(
  workflowPath = DEFAULT_WORKFLOW_PATH,
): SandboxImagesWorkflow {
  return YAML.parse(readFileSync(workflowPath, "utf8")) as SandboxImagesWorkflow;
}

export function validateSandboxImagesWorkflow(
  workflow: SandboxImagesWorkflow,
  mainWorkflow: SandboxImagesWorkflow,
): string[] {
  const errors: string[] = [];
  validateTriggersAndPermissions(errors, workflow);
  validateMainCaller(errors, mainWorkflow);

  const canonicalJob = workflow.jobs[IMAGE_BUILD_JOBS[0]] ?? {};
  const canonicalAuth = requireStep(errors, IMAGE_BUILD_JOBS[0], canonicalJob, AUTH_STEP_NAME);
  validateCanonicalAuth(errors, canonicalAuth);
  for (const jobName of IMAGE_BUILD_JOBS) {
    const job = workflow.jobs[jobName];
    if (!job) {
      errors.push(`sandbox image workflow is missing ${jobName}`);
      continue;
    }
    validateImageJobAuth(errors, jobName, job, canonicalAuth);
  }
  validateSecretScopeAndRegistryWrites(errors, workflow);
  validateGuardedProductionBuildContracts(errors, workflow);
  validateRuntimeImageReuse(errors, workflow);
  validateHermesImageReuse(errors, workflow);
  return errors;
}

export function validateSandboxImagesWorkflowBoundary(
  workflowPath = DEFAULT_WORKFLOW_PATH,
  mainWorkflowPath = DEFAULT_MAIN_WORKFLOW_PATH,
): string[] {
  return validateSandboxImagesWorkflow(
    readSandboxImagesWorkflow(workflowPath),
    readSandboxImagesWorkflow(mainWorkflowPath),
  );
}
