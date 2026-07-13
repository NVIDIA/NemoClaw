// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import YAML from "yaml";
import { UPLOAD_E2E_ARTIFACTS_ACTION } from "./upload-e2e-artifacts-workflow-boundary.mts";

const DEFAULT_WORKFLOW_PATH = ".github/workflows/e2e.yaml";
const MCP_JOBS = ["mcp-bridge", "mcp-bridge-dev"] as const;
const TERMINAL_JOBS = ["report-to-pr", "scorecard"] as const;
const DOCKER_CLEANUP_RUN = "bash .github/scripts/docker-auth-cleanup.sh";
const DEV_DOCKER_CLEANUP_NAME = "Revoke Docker auth before unverified dev tooling";
const DEV_COMPATIBILITY_STEP_NAME = "Classify OpenShell credential-boundary compatibility";
const DEV_COMPATIBILITY_STEP_ID = "mcp_runtime_compatibility";
const DEV_COMPATIBILITY_TOOL = "tools/e2e/mcp-bridge-runtime-compatibility.mts";
const DEV_EXACT_MAIN_STAGE_NAME = "Stage exact OpenShell main artifacts";
const DEV_EXACT_MAIN_FULL_LIFECYCLE_NAME = "Require exact-main full lifecycle";
const DEV_EXACT_MAIN_SOURCE_SHA = "bb72d0123c748ed7e209880f7bab593e10aae221";
const DEV_EXACT_MAIN_RUN_ID = "29215426930";
const DEV_EXACT_MAIN_CLI_VERSION = "0.0.82-dev.11+gbb72d012";
const MCP_AGENT_MATRIX_FILTER = "-t '^(mcp-bridge|mcp-bridge-hermes|mcp-bridge-deepagents)$'";
const MCP_AGENT_MATRIX_PROOF_TOOL = "tools/e2e/assert-mcp-agent-matrix-artifacts.mts";
const DEV_EXACT_MAIN_SUPERVISOR_INDEX =
  "fc441051102b1a16ffcabf59878fa464d3c548f29bfbfa6e4acb232ab67198b7";
const DEV_EXACT_MAIN_REQUIRED_STAGE_TOKENS = [
  DEV_EXACT_MAIN_CLI_VERSION,
  "0.0.82-dev.11+gbb72d0123",
  "0.0.82.dev11+gbb72d0123",
  DEV_EXACT_MAIN_SUPERVISOR_INDEX,
  "8266446648",
  "78923b27a492204b6e869d9f5f392e57b37d8ddcb9367d746f4ee46cfaf0e5a2",
  "d1732c0b87801560afd1b06cfea31c60d6a357100d5b817b4a4fb181b0b71933",
  "09083ef8087e5191fc3513a7239b08041b511fdeb7f2fe074bdf8820886cbea1",
  "8266452366",
  "39504758f07a8bac0a52d958ec56e380ac59824bde8db72a815a9b82c6bbcfd6",
  "5e3728564b1f965cb5d320bab4f37d388303723f42a64c308227dbc1ef382043",
  "39e75f7a2a96c220e3f2d645067f0623d922385ade07edb2037a27cc07ea81d1",
  "8266435047",
  "7b2e47adbbfc644806b465a4f4c3c7bfaba7117e1f19ec9f151b37695b418bf4",
  "6f7040e89ec249df7f3b36ddff609a87f096fcdf62cd5c28e86757f175e40a7a",
  "58e5d99261d2b8ea06664d020995830fd3f153ea692f36622b92f9b827ea60c8",
  "8266448422",
  "cb043b6a8d5aec9a048e4bbefdf6df12cc939e76cebaf69828acd65f96a36dc2",
  "4a54b434decd007d2a966edb5db751adb3ca4cf8ab8ac0b248901f8efe614b71",
  "5432194fa43840c333bc7b166bf6e7c0e15247e9dc195cb9a38c1a85b7415f44",
  "d1baeaebaddef6291e0a94b697f28c3c319ac2ec1a83843026e89553cc7cd27e",
  "8e89067afca2d1c02a25fb19906dd27fd8d524ee4eb3b2b36b1210338dae9235",
  "8266451406",
  "fccd6b98e64732cd00c54f1923449954d6a7d3294887c708bb62be90159b68a6",
  "fab8d5c551991648a19bf7876d2edf19fdcf4e95139ce5f75d638354c0820d51",
  "66a1d121d6386e19297d05a950ba7409c5752f337bacfbc156c7c76513e40136",
  "818c727cb5cbcdb78918a274ca6b9aa85be6a95fdb604e49f523cf2c87f2eba4",
  "8ec9b88c49f001d070ada7bb5a98fb6f96498fc446b0f2f614056247d7300b85",
] as const;
const DEV_COMPATIBILITY_RUN = [
  "set -euo pipefail",
  'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"',
  `npx tsx ${DEV_COMPATIBILITY_TOOL}`,
  "",
].join("\n");
const DEV_FULL_LIFECYCLE_CONDITION =
  "${{ steps.mcp_runtime_compatibility.outputs.mode == 'full-lifecycle' }}";
const MCP_CLOUDFLARED_VERSION = "2026.6.1";
const MCP_CLOUDFLARED_DEB_SHA256 =
  "ccd02ec216c62bfa573395d8f72cb2e91e95cbdf8726a8acc06b3e2d9aa31526";
const LEGACY_WORKFLOWS = [
  ".github/workflows/e2e-script.yaml",
  ".github/workflows/e2e-vitest-scenarios.yaml",
  ".github/workflows/nightly-e2e.yaml",
] as const;
const FORBIDDEN_INFERENCE_SECRETS =
  /ANTHROPIC_API_KEY|AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY)|COMPATIBLE_(?:ANTHROPIC_)?API_KEY|NVIDIA_(?:INFERENCE_)?API_KEY|OPENAI_API_KEY/;
const GITHUB_CREDENTIAL = /GITHUB_TOKEN|GH_TOKEN/;

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asSteps(job: UnknownRecord): UnknownRecord[] {
  const steps = job.steps;
  return Array.isArray(steps) ? steps.map(asRecord) : [];
}

function namedStep(job: UnknownRecord, name: string): UnknownRecord {
  return asSteps(job).find((step) => step.name === name) ?? {};
}

function isArtifactUploadStep(step: UnknownRecord): boolean {
  const uses = asString(step.uses);
  return uses === UPLOAD_E2E_ARTIFACTS_ACTION || uses.startsWith("actions/upload-artifact@");
}

function jobNeeds(job: UnknownRecord): string[] {
  if (typeof job.needs === "string") return [job.needs];
  return Array.isArray(job.needs)
    ? job.needs.filter((item): item is string => typeof item === "string")
    : [];
}

function requireEqual(errors: string[], actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) errors.push(message);
}

function requireContains(
  errors: string[],
  actual: unknown,
  expected: string,
  message: string,
): void {
  if (!asString(actual).includes(expected)) errors.push(message);
}

function hasExactEntries(actual: UnknownRecord, expected: UnknownRecord): boolean {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index]) &&
    expectedKeys.every((key) => actual[key] === expected[key])
  );
}

function validateJobIdentity(
  errors: string[],
  jobName: (typeof MCP_JOBS)[number],
  job: UnknownRecord,
): void {
  const env = asRecord(job.env);
  requireEqual(errors, env.E2E_JOB, "1", `${jobName} must declare E2E_JOB=1`);
  requireEqual(
    errors,
    env.E2E_TARGET_ID,
    jobName,
    `${jobName} must use its job id as E2E_TARGET_ID`,
  );
  requireEqual(
    errors,
    env.NEMOCLAW_MCP_BRIDGE_AGENT_MATRIX,
    "1",
    `${jobName} must exercise all three MCP adapters`,
  );
  requireEqual(
    errors,
    env.NEMOCLAW_RUN_LIVE_E2E,
    "1",
    `${jobName} must enable the unified live E2E project`,
  );
  requireContains(
    errors,
    env.E2E_ARTIFACT_DIR,
    `e2e-artifacts/live/${jobName}`,
    `${jobName} must isolate its artifact directory`,
  );
  if (jobName === "mcp-bridge") {
    requireEqual(
      errors,
      env.NEMOCLAW_OPENSHELL_CHANNEL,
      "stable",
      "mcp-bridge must pin the stable OpenShell channel",
    );
    if (Object.hasOwn(env, "E2E_DEFAULT_ENABLED")) {
      errors.push("mcp-bridge must remain default-enabled");
    }
    requireContains(
      errors,
      job.if,
      "inputs.jobs == ''",
      "mcp-bridge must run in default full-suite dispatches",
    );
  } else {
    requireEqual(errors, env.E2E_DEFAULT_ENABLED, "0", "mcp-bridge-dev must remain explicit-only");
    requireEqual(
      errors,
      env.NEMOCLAW_OPENSHELL_CHANNEL,
      "dev",
      "mcp-bridge-dev must select the OpenShell dev channel",
    );
    requireEqual(
      errors,
      env.NEMOCLAW_OPENSHELL_EXACT_MAIN_PROOF,
      "1",
      "mcp-bridge-dev must enable the exact-main live contract proof",
    );
    requireEqual(
      errors,
      env.OPENSHELL_DOCKER_SUPERVISOR_IMAGE,
      `ghcr.io/nvidia/openshell/supervisor@sha256:${DEV_EXACT_MAIN_SUPERVISOR_INDEX}`,
      "mcp-bridge-dev must pin the exact reviewed supervisor index",
    );
    if (Object.hasOwn(env, "NEMOCLAW_ACCEPT_DEV_UNVERIFIED_INSTALL")) {
      errors.push("mcp-bridge-dev must scope unverified artifact opt-in to its installer step");
    }
    if (asString(job.if).includes("inputs.jobs == ''")) {
      errors.push("mcp-bridge-dev must not run in default full-suite dispatches");
    }
  }
}

function validateJobSecurity(
  errors: string[],
  jobName: (typeof MCP_JOBS)[number],
  job: UnknownRecord,
  canonicalDockerAuth: UnknownRecord,
): void {
  const permissions = asRecord(job.permissions);
  const expectedPermissions =
    jobName === "mcp-bridge-dev" ? { actions: "read", contents: "read" } : { contents: "read" };
  if (!hasExactEntries(permissions, expectedPermissions)) {
    errors.push(
      jobName === "mcp-bridge-dev"
        ? "mcp-bridge-dev must use only actions:read and contents:read permissions"
        : "mcp-bridge must use only contents:read permissions",
    );
  }

  const checkouts = asSteps(job).filter((step) =>
    asString(step.uses).startsWith("actions/checkout@"),
  );
  if (checkouts.length !== 1) errors.push(`${jobName} must use exactly one checkout step`);
  for (const checkout of checkouts) {
    if (!/^actions\/checkout@[0-9a-f]{40}$/.test(asString(checkout.uses))) {
      errors.push(`${jobName} must use a SHA-pinned checkout`);
    }
    if (asRecord(checkout.with)["persist-credentials"] !== false) {
      errors.push(`${jobName} checkout must set persist-credentials:false`);
    }
  }
  if (FORBIDDEN_INFERENCE_SECRETS.test(JSON.stringify(job))) {
    errors.push(`${jobName} must not receive inference credentials`);
  }

  const login = namedStep(job, "Authenticate to Docker Hub");
  const cleanup = namedStep(job, "Clean up Docker auth");
  if (JSON.stringify(login) !== JSON.stringify(canonicalDockerAuth)) {
    errors.push(`${jobName} must reuse the canonical isolated Docker Hub auth step`);
  }
  const expectedCleanup = {
    name: "Clean up Docker auth",
    if: "always()",
    shell: "bash",
    run: DOCKER_CLEANUP_RUN,
  };
  if (JSON.stringify(cleanup) !== JSON.stringify(expectedCleanup)) {
    errors.push(`${jobName} must use the canonical unconditional Docker auth cleanup`);
  }
  const steps = asSteps(job);
  const checkoutIndex = steps.findIndex((step) =>
    asString(step.uses).startsWith("actions/checkout@"),
  );
  if (steps.indexOf(login) !== checkoutIndex + 1) {
    errors.push(`${jobName} must authenticate immediately after credential-free checkout`);
  }
  if (steps.indexOf(cleanup) !== steps.length - 1) {
    errors.push(`${jobName} Docker auth cleanup must remain the final step`);
  }
  if (jobName === "mcp-bridge-dev") {
    const exactStages = steps.filter((step) => step.name === DEV_EXACT_MAIN_STAGE_NAME);
    const exactStage = exactStages[0] ?? {};
    if (exactStages.length !== 1) {
      errors.push("mcp-bridge-dev must use exactly one exact-main artifact staging step");
    }
    const exactStageEnv = asRecord(exactStage.env);
    if (
      !hasExactEntries(exactStageEnv, {
        GH_TOKEN: "${{ github.token }}",
        OPENSHELL_RUN_ID: DEV_EXACT_MAIN_RUN_ID,
        OPENSHELL_SOURCE_SHA: DEV_EXACT_MAIN_SOURCE_SHA,
      })
    ) {
      errors.push(
        "mcp-bridge-dev exact-main staging credentials and source identity must remain exact",
      );
    }
    for (const step of steps) {
      if (step !== exactStage && GITHUB_CREDENTIAL.test(JSON.stringify(step))) {
        errors.push(
          "mcp-bridge-dev may expose the GitHub token only to exact-main artifact staging",
        );
        break;
      }
    }
    requireContains(
      errors,
      exactStage.run,
      "unset GH_TOKEN",
      "mcp-bridge-dev exact-main staging must remove GH_TOKEN before dev binaries run",
    );

    const devCleanup = namedStep(job, DEV_DOCKER_CLEANUP_NAME);
    const install = namedStep(job, "Install OpenShell CLI");
    const expectedDevCleanup = {
      name: DEV_DOCKER_CLEANUP_NAME,
      shell: "bash",
      run: DOCKER_CLEANUP_RUN,
    };
    if (JSON.stringify(devCleanup) !== JSON.stringify(expectedDevCleanup)) {
      errors.push("mcp-bridge-dev must revoke Docker auth before unverified dev tooling");
    }
    const devCleanupIndex = steps.indexOf(devCleanup);
    const installIndex = steps.indexOf(install);
    const exactStageIndex = steps.indexOf(exactStage);
    if (
      exactStageIndex <= steps.indexOf(login) ||
      devCleanupIndex <= exactStageIndex ||
      installIndex <= devCleanupIndex
    ) {
      errors.push(
        "mcp-bridge-dev exact staging must precede credential revocation and the dev installer",
      );
    }
    if (
      devCleanupIndex >= 0 &&
      steps.slice(devCleanupIndex + 1).some((step) => step.name === "Authenticate to Docker Hub")
    ) {
      errors.push("mcp-bridge-dev must not restore Docker auth after dev-tooling revocation");
    }
  } else {
    if (GITHUB_CREDENTIAL.test(JSON.stringify(job))) {
      errors.push("mcp-bridge must not receive GitHub credentials");
    }
    if (Object.keys(namedStep(job, DEV_EXACT_MAIN_STAGE_NAME)).length > 0) {
      errors.push("mcp-bridge stable lane must not stage exact-main development artifacts");
    }
  }
}

function validateJobExecution(
  errors: string[],
  jobName: (typeof MCP_JOBS)[number],
  job: UnknownRecord,
): void {
  const steps = asSteps(job);
  const cloudflared = namedStep(job, "Install and verify cloudflared prerequisite");
  const tls = namedStep(job, "Generate MCP test TLS");
  const exactStage = namedStep(job, DEV_EXACT_MAIN_STAGE_NAME);
  const install = namedStep(job, "Install OpenShell CLI");
  const run = namedStep(job, "Run MCP OpenShell provider live test");
  const compatibility = namedStep(job, DEV_COMPATIBILITY_STEP_NAME);
  const requireFullLifecycle = namedStep(job, DEV_EXACT_MAIN_FULL_LIFECYCLE_NAME);
  const compatibilitySteps = steps.filter((step) =>
    asString(step.run).includes(DEV_COMPATIBILITY_TOOL),
  );
  const scan = namedStep(job, "Scan MCP artifacts for fixture credentials");
  const uploads = steps.filter(isArtifactUploadStep);
  const upload = namedStep(job, "Upload MCP server artifacts");
  if (uploads.length !== 1 || uploads[0] !== upload) {
    errors.push(`${jobName} must use exactly one reviewed MCP artifact upload step`);
  }

  const cloudflaredEnv = asRecord(cloudflared.env);
  requireEqual(
    errors,
    cloudflaredEnv.CLOUDFLARED_VERSION,
    MCP_CLOUDFLARED_VERSION,
    `${jobName} must pin cloudflared ${MCP_CLOUDFLARED_VERSION}`,
  );
  requireEqual(
    errors,
    cloudflaredEnv.CLOUDFLARED_DEB_SHA256,
    MCP_CLOUDFLARED_DEB_SHA256,
    `${jobName} must pin the reviewed cloudflared package checksum`,
  );
  for (const required of [
    "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64.deb",
    "sha256sum -c -",
    "dpkg-deb -f",
    "sudo dpkg -i",
    "cloudflared version ${CLOUDFLARED_VERSION}",
  ]) {
    requireContains(
      errors,
      cloudflared.run,
      required,
      `${jobName} cloudflared installation is not immutable and verified`,
    );
  }
  for (const forbidden of ["pkg.cloudflare.com", "apt-get install", "apt install"]) {
    if (asString(cloudflared.run).includes(forbidden)) {
      errors.push(`${jobName} cloudflared installation must not use mutable package repositories`);
    }
  }
  if (steps.indexOf(cloudflared) < 0 || steps.indexOf(tls) <= steps.indexOf(cloudflared)) {
    errors.push(`${jobName} must install verified cloudflared before creating MCP fixtures`);
  }

  requireEqual(
    errors,
    tls.run,
    "bash test/e2e/setup-mcp-test-tls.sh",
    `${jobName} must generate its HTTPS fixture before installation`,
  );
  if (steps.indexOf(tls) < 0 || steps.indexOf(install) <= steps.indexOf(tls)) {
    errors.push(`${jobName} must generate HTTPS fixtures before installing OpenShell`);
  }
  const installEnv = asRecord(install.env);
  if (jobName === "mcp-bridge-dev") {
    requireEqual(
      errors,
      installEnv.NEMOCLAW_OPENSHELL_FORCE_INSTALL,
      "0",
      "mcp-bridge-dev must preserve the exact staged OpenShell binaries",
    );
    requireEqual(
      errors,
      installEnv.NEMOCLAW_ACCEPT_DEV_UNVERIFIED_INSTALL,
      "1",
      "mcp-bridge-dev installer must explicitly authorize unverified dev artifacts",
    );

    const stageRun = asString(exactStage.run);
    for (const token of DEV_EXACT_MAIN_REQUIRED_STAGE_TOKENS) {
      if (!stageRun.includes(token)) {
        errors.push(`mcp-bridge-dev exact-main staging is missing reviewed identity: ${token}`);
      }
    }
    for (const required of [
      "zipfile.ZipFile",
      "tarfile.open",
      "len(members) != 1",
      "member.isfile()",
      "stat.S_ISREG",
      "os.O_NOFOLLOW",
      'attestationStatus: "absent"',
      'runtimeEvidence: "identity-only"',
    ]) {
      requireContains(
        errors,
        stageRun,
        required,
        "mcp-bridge-dev exact-main staging must validate immutable artifact structure and provenance",
      );
    }
    if (
      steps.indexOf(exactStage) <= steps.indexOf(tls) ||
      steps.indexOf(install) <= steps.indexOf(exactStage)
    ) {
      errors.push(
        "mcp-bridge-dev must stage exact-main artifacts after fixtures and before installation",
      );
    }
  } else if (Object.hasOwn(installEnv, "NEMOCLAW_ACCEPT_DEV_UNVERIFIED_INSTALL")) {
    errors.push("mcp-bridge stable installer must not authorize unverified dev artifacts");
  } else {
    requireEqual(
      errors,
      installEnv.NEMOCLAW_OPENSHELL_FORCE_INSTALL,
      "1",
      "mcp-bridge must force the selected stable OpenShell install",
    );
  }
  requireContains(
    errors,
    install.run,
    "bash scripts/install-openshell.sh",
    `${jobName} must use the repository OpenShell installer`,
  );
  if (jobName === "mcp-bridge-dev") {
    if (compatibilitySteps.length !== 1 || compatibilitySteps[0] !== compatibility) {
      errors.push("mcp-bridge-dev must use exactly one canonical runtime compatibility classifier");
    }
    const expectedCompatibility = {
      id: DEV_COMPATIBILITY_STEP_ID,
      name: DEV_COMPATIBILITY_STEP_NAME,
      run: DEV_COMPATIBILITY_RUN,
    };
    if (!hasExactEntries(compatibility, expectedCompatibility)) {
      errors.push(
        "mcp-bridge-dev must use the canonical unconditional runtime compatibility classifier",
      );
    }
    requireEqual(
      errors,
      compatibility.id,
      DEV_COMPATIBILITY_STEP_ID,
      "mcp-bridge-dev runtime compatibility classifier must expose its canonical step id",
    );
    requireContains(
      errors,
      compatibility.run,
      `npx tsx ${DEV_COMPATIBILITY_TOOL}`,
      "mcp-bridge-dev runtime compatibility classifier must use the reviewed tool",
    );
    requireEqual(
      errors,
      run.if,
      DEV_FULL_LIFECYCLE_CONDITION,
      "mcp-bridge-dev must run the full MCP lifecycle only for an aligned runtime",
    );
    const expectedFullLifecycleRun = [
      "set -euo pipefail",
      'if [[ "$COMPATIBILITY_MODE" != "full-lifecycle" ]]; then',
      "  echo \"::error::Exact OpenShell main proof requires full-lifecycle; got '${COMPATIBILITY_MODE:-missing}'\" >&2",
      "  exit 1",
      "fi",
      "",
    ].join("\n");
    if (
      Object.keys(requireFullLifecycle).sort().join(",") !== "env,if,name,run" ||
      requireFullLifecycle.if !== "always()" ||
      requireFullLifecycle.name !== DEV_EXACT_MAIN_FULL_LIFECYCLE_NAME ||
      requireFullLifecycle.run !== expectedFullLifecycleRun ||
      !hasExactEntries(asRecord(requireFullLifecycle.env), {
        COMPATIBILITY_MODE: "${{ steps.mcp_runtime_compatibility.outputs.mode }}",
      })
    ) {
      errors.push("mcp-bridge-dev must fail unless the exact-main proof runs full-lifecycle");
    }
    if (
      steps.indexOf(install) < 0 ||
      steps.indexOf(compatibility) <= steps.indexOf(install) ||
      steps.indexOf(requireFullLifecycle) <= steps.indexOf(compatibility) ||
      steps.indexOf(run) <= steps.indexOf(requireFullLifecycle)
    ) {
      errors.push(
        "mcp-bridge-dev must classify the installed runtime before the full MCP lifecycle",
      );
    }
  } else {
    if (compatibilitySteps.length > 0 || Object.keys(compatibility).length > 0) {
      errors.push("mcp-bridge stable lane must not use dev runtime compatibility branching");
    }
    if (Object.hasOwn(run, "if")) {
      errors.push("mcp-bridge stable lane must run its full MCP lifecycle unconditionally");
    }
  }
  for (const required of ["--project e2e-live", "test/e2e/live/mcp-bridge.test.ts"]) {
    requireContains(errors, run.run, required, `${jobName} must run the unified MCP live test`);
  }
  requireContains(
    errors,
    run.run,
    MCP_AGENT_MATRIX_FILTER,
    `${jobName} must select the exact OpenClaw, Hermes, and Deep Agents lifecycle matrix`,
  );
  requireContains(
    errors,
    run.run,
    `npx tsx ${MCP_AGENT_MATRIX_PROOF_TOOL} "$E2E_ARTIFACT_DIR"`,
    `${jobName} must record proof that every MCP agent lifecycle produced artifacts`,
  );
  requireEqual(
    errors,
    scan.id,
    "mcp_artifact_secret_scan",
    `${jobName} secret scanner must expose its gated step id`,
  );
  requireEqual(
    errors,
    scan.if,
    "always()",
    `${jobName} artifact secret scan must run unconditionally`,
  );
  for (const required of [
    "tools/e2e/assert-mcp-artifact-secrets-absent.mts",
    `e2e-artifacts/live/${jobName}`,
  ]) {
    requireContains(errors, scan.run, required, `${jobName} artifact secret scan is incomplete`);
  }
  requireEqual(
    errors,
    upload.uses,
    UPLOAD_E2E_ARTIFACTS_ACTION,
    `${jobName} artifact upload must use the reviewed shared uploader`,
  );
  requireEqual(
    errors,
    upload.if,
    "${{ always() && steps.mcp_artifact_secret_scan.outcome == 'success' }}",
    `${jobName} artifact upload must be gated by the secret scanner`,
  );
  const uploadOptions = asRecord(upload.with);
  requireEqual(
    errors,
    uploadOptions.path,
    `e2e-artifacts/live/${jobName}/`,
    `${jobName} artifact upload must use exactly the scanned directory`,
  );
  requireEqual(
    errors,
    uploadOptions.name,
    `e2e-${jobName}`,
    `${jobName} artifact upload must use its isolated artifact name`,
  );
  if (Object.keys(uploadOptions).sort().join(",") !== "name,path") {
    errors.push(`${jobName} artifact upload must delegate policy to the reviewed shared uploader`);
  }
  if (steps.indexOf(scan) < 0 || steps.indexOf(upload) <= steps.indexOf(scan)) {
    errors.push(`${jobName} must scan artifacts before upload`);
  }
  if (steps.indexOf(run) < 0 || steps.indexOf(scan) <= steps.indexOf(run)) {
    errors.push(`${jobName} must scan artifacts after its MCP compatibility execution`);
  }
}

export function validateMcpOpenShellWorkflowBoundary(
  workflowPath = DEFAULT_WORKFLOW_PATH,
): string[] {
  const errors: string[] = [];
  const workflowText = fs.readFileSync(workflowPath, "utf8");
  const workflow = asRecord(YAML.parse(workflowText));
  const jobs = asRecord(workflow.jobs);
  const canonicalDockerAuth = namedStep(asRecord(jobs.live), "Authenticate to Docker Hub");
  const inputs = asRecord(asRecord(asRecord(workflow.on).workflow_dispatch).inputs);
  const globalEnv = asRecord(workflow.env);

  if (Object.hasOwn(inputs, "openshell_channel")) {
    errors.push("the unified workflow must not expose a fan-out-wide OpenShell channel input");
  }
  if (Object.hasOwn(globalEnv, "NEMOCLAW_OPENSHELL_CHANNEL")) {
    errors.push("the unified workflow must select OpenShell channels only inside MCP jobs");
  }
  for (const legacy of LEGACY_WORKFLOWS) {
    if (workflowPath === DEFAULT_WORKFLOW_PATH && fs.existsSync(legacy)) {
      errors.push(`retired workflow must remain deleted: ${legacy}`);
    }
  }
  for (const retiredToken of [
    "test/e2e-scenario/",
    "tools/e2e-scenarios/",
    "e2e-scenarios-live",
    "NEMOCLAW_RUN_E2E_SCENARIOS",
    "e2e-artifacts/vitest/",
  ]) {
    if (workflowText.includes(retiredToken)) {
      errors.push(`unified MCP workflow must not reference retired token: ${retiredToken}`);
    }
  }

  for (const jobName of MCP_JOBS) {
    const job = asRecord(jobs[jobName]);
    if (Object.keys(job).length === 0) {
      errors.push(`missing unified MCP job: ${jobName}`);
      continue;
    }
    validateJobIdentity(errors, jobName, job);
    validateJobSecurity(errors, jobName, job, canonicalDockerAuth);
    validateJobExecution(errors, jobName, job);
  }

  for (const terminalJobName of TERMINAL_JOBS) {
    const terminal = asRecord(jobs[terminalJobName]);
    const terminalNeeds = new Set(jobNeeds(terminal));
    for (const mcpJob of MCP_JOBS) {
      if (!terminalNeeds.has(mcpJob)) {
        errors.push(`${terminalJobName} must wait for ${mcpJob}`);
      }
    }
  }

  return errors;
}
