// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { validateE2eWorkflowBoundary } from "../../../tools/e2e/workflow-boundary.mts";
import { readWorkflow } from "../../helpers/e2e-workflow-contract";

const NO_IMAGE_E2E_JOBS = [
  "docs-validation",
  "gateway-drift-preflight",
  "gateway-health-honest",
  "inference-routing",
  "onboard-negative-paths",
  "openshell-version-pin",
] as const;
const AUTH_STEP_NAME = "Authenticate to Docker Hub";
const CLEANUP_STEP_NAME = "Clean up Docker auth";
const CLEANUP_HELPER_RUN = "bash .github/scripts/docker-auth-cleanup.sh";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CLEANUP_HELPER_PATH = path.join(REPO_ROOT, ".github", "scripts", "docker-auth-cleanup.sh");
const EXPECTED_CLEANUP_STEP = {
  name: CLEANUP_STEP_NAME,
  if: "always()",
  shell: "bash",
  run: CLEANUP_HELPER_RUN,
};

type WorkflowStep = Record<string, unknown> & {
  env?: Record<string, unknown>;
  name?: string;
  run?: string;
  uses?: string;
};

type WorkflowJob = {
  env?: Record<string, unknown>;
  steps?: WorkflowStep[];
};

type Workflow = {
  jobs: Record<string, WorkflowJob>;
};

function loadWorkflow(): Workflow {
  return readWorkflow() as Workflow;
}

function imageJobNames(workflow: Workflow): string[] {
  return [
    "live",
    ...Object.entries(workflow.jobs)
      .filter(
        ([jobName, job]) =>
          job.env?.E2E_JOB === "1" &&
          !NO_IMAGE_E2E_JOBS.includes(jobName as (typeof NO_IMAGE_E2E_JOBS)[number]),
      )
      .map(([jobName]) => jobName),
  ];
}

function namedStep(job: WorkflowJob, name: string): WorkflowStep | undefined {
  return job.steps?.find((step) => step.name === name);
}

function validateMutation(mutate: (workflow: Workflow) => void): string[] {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-auth-workflow-"));
  const workflowPath = path.join(directory, "workflow.yaml");
  try {
    const workflow = loadWorkflow();
    mutate(workflow);
    fs.writeFileSync(workflowPath, YAML.stringify(workflow));
    return validateE2eWorkflowBoundary(workflowPath);
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
}

function writeExecutable(filePath: string, source: string): void {
  fs.writeFileSync(filePath, source);
  fs.chmodSync(filePath, 0o755);
}

describe("shared Docker Hub authentication workflow boundary", () => {
  it("reuses one auth alias and one explicit audited cleanup step across every image job (#6430)", () => {
    const workflow = loadWorkflow();
    const requiredJobs = imageJobNames(workflow);
    const canonicalAuth = namedStep(workflow.jobs.live, AUTH_STEP_NAME);
    const cleanupSteps: WorkflowStep[] = [];

    expect(requiredJobs.length).toBeGreaterThan(50);
    expect(requiredJobs).toEqual(
      expect.arrayContaining([
        "live",
        "diagnostics",
        "messaging-compatible-endpoint",
        "openshell-gateway-auth-contract",
      ]),
    );
    expect(canonicalAuth).toBeDefined();

    for (const jobName of requiredJobs) {
      const job = workflow.jobs[jobName];
      expect(job, jobName).toBeDefined();
      expect(
        job.steps?.filter((step) => step.name === AUTH_STEP_NAME),
        `${jobName} auth steps`,
      ).toHaveLength(1);
      expect(
        job.steps?.filter((step) => step.name === CLEANUP_STEP_NAME),
        `${jobName} cleanup steps`,
      ).toHaveLength(1);
      expect(namedStep(job, AUTH_STEP_NAME), `${jobName} auth alias`).toBe(canonicalAuth);
      const cleanup = namedStep(job, CLEANUP_STEP_NAME);
      expect(cleanup, `${jobName} cleanup mapping`).toEqual(EXPECTED_CLEANUP_STEP);
      cleanupSteps.push(cleanup!);

      const checkoutIndex =
        job.steps?.findIndex((step) => String(step.uses ?? "").startsWith("actions/checkout@")) ??
        -1;
      const authIndex = job.steps?.findIndex((step) => step.name === AUTH_STEP_NAME) ?? -1;
      const cleanupIndex = job.steps?.findIndex((step) => step.name === CLEANUP_STEP_NAME) ?? -1;
      const expectedAuthIndex =
        jobName === "jetson-nvmap-gpu" ? checkoutIndex + 2 : checkoutIndex + 1;
      expect(authIndex, `${jobName} auth order`).toBe(expectedAuthIndex);
      expect(cleanupIndex, `${jobName} cleanup order`).toBe((job.steps?.length ?? 0) - 1);
    }
    expect(new Set(cleanupSteps).size, "cleanup steps must not consume the YAML alias budget").toBe(
      requiredJobs.length,
    );

    for (const jobName of NO_IMAGE_E2E_JOBS) {
      expect(namedStep(workflow.jobs[jobName], AUTH_STEP_NAME), jobName).toBeUndefined();
      expect(namedStep(workflow.jobs[jobName], CLEANUP_STEP_NAME), jobName).toBeUndefined();
    }
  });

  it("rejects missing auth and cleanup coverage for every classified image job", () => {
    const workflow = loadWorkflow();
    const requiredJobs = imageJobNames(workflow);
    const errors = validateMutation((mutatedWorkflow) => {
      for (const jobName of requiredJobs) {
        mutatedWorkflow.jobs[jobName].steps = mutatedWorkflow.jobs[jobName].steps?.filter(
          (step) => step.name !== AUTH_STEP_NAME && step.name !== CLEANUP_STEP_NAME,
        );
      }
    });

    expect(errors).toEqual(
      expect.arrayContaining(
        requiredJobs.flatMap((jobName) => [
          `${jobName} image-consuming job must have exactly one Docker Hub auth step`,
          `${jobName} image-consuming job must have exactly one Docker Hub cleanup step`,
        ]),
      ),
    );
  });

  it("rejects step-level Docker config overrides outside the canonical auth step", () => {
    const errors = validateMutation((workflow) => {
      const run = namedStep(
        workflow.jobs["messaging-compatible-endpoint"],
        "Run messaging compatible endpoint live test",
      );
      expect(run).toBeDefined();
      run!.env = {
        ...run!.env,
        DOCKER_CONFIG: "${{ runner.temp }}/alternate-docker-config",
      };
    });

    expect(errors).toContain(
      "messaging-compatible-endpoint step 'Run messaging compatible endpoint live test' env must not include DOCKER_CONFIG",
    );
  });

  it("rejects trust, isolation, retry, password, and cleanup mapping drift", () => {
    const errors = validateMutation((workflow) => {
      const auth = namedStep(workflow.jobs.live, AUTH_STEP_NAME);
      const cleanup = namedStep(workflow.jobs.live, CLEANUP_STEP_NAME);
      expect(auth).toBeDefined();
      expect(cleanup).toBeDefined();

      auth!.if = "github.event_name == 'schedule'";
      auth!.env = {
        ...auth!.env,
        DOCKERHUB_USERNAME: "${{ secrets.DOCKERHUB_USERNAME }}",
      };
      auth!.run = String(auth!.run)
        .replace(
          "${RUNNER_TEMP}/docker-config-${GITHUB_JOB}-XXXXXX",
          "${GITHUB_WORKSPACE}/docker-config",
        )
        .replace("for attempt in 1 2 3; do", "for attempt in 1 2; do")
        .replace(
          'auth_marker="${DOCKER_CONFIG}/.nemoclaw-docker-login-attempted"',
          'auth_marker="${GITHUB_WORKSPACE}/login-attempted"',
        )
        .replace(': > "${auth_marker}"', 'touch "${auth_marker}"')
        .replace('chmod 600 "${auth_marker}"', 'chmod 644 "${auth_marker}"')
        .replace("--password-stdin", '--password "${DOCKERHUB_TOKEN}"')
        .replaceAll("exit 1", "exit 0");

      cleanup!.if = "success()";
      cleanup!.run = `${String(cleanup!.run)} || true`;
      cleanup!.env = { DOCKER_CONFIG: "${{ github.workspace }}/docker-config" };

      const messagingSteps = workflow.jobs["messaging-compatible-endpoint"].steps!;
      const messagingCleanupIndex = messagingSteps.findIndex(
        (step) => step.name === CLEANUP_STEP_NAME,
      );
      const [messagingCleanup] = messagingSteps.splice(messagingCleanupIndex, 1);
      messagingSteps.splice(2, 0, messagingCleanup);
    });

    expect(errors).toEqual(
      expect.arrayContaining([
        "canonical Docker Hub auth step must always run so untrusted refs receive an isolated empty Docker config",
        "canonical Docker Hub auth must gate DOCKERHUB_USERNAME on the trusted repository, main ref, and scheduled/manual events",
        'canonical Docker Hub auth run script must include mktemp -d "${RUNNER_TEMP}/docker-config-${GITHUB_JOB}-XXXXXX"',
        "canonical Docker Hub auth directory must not use the checkout workspace",
        "canonical Docker Hub auth run script must include for attempt in 1 2 3; do",
        'canonical Docker Hub auth run script must include auth_marker="${DOCKER_CONFIG}/.nemoclaw-docker-login-attempted"',
        'canonical Docker Hub auth run script must include : > "${auth_marker}"',
        'canonical Docker Hub auth run script must include chmod 600 "${auth_marker}"',
        "canonical Docker Hub auth must create and protect its login-attempt marker after trusted credential validation and before login",
        "canonical Docker Hub auth run script must include --password-stdin",
        "canonical Docker Hub auth must pass the token only through --password-stdin",
        "canonical Docker Hub auth must fail when trusted credentials are missing",
        "canonical Docker Hub auth must fail after exhausting login retries",
        "live Docker Hub cleanup step must contain exactly name, if, shell, and run",
        "live Docker Hub cleanup step must always run",
        `live Docker Hub cleanup step must run only ${CLEANUP_HELPER_RUN}`,
        "messaging-compatible-endpoint Docker Hub cleanup must be the final job step",
      ]),
    );
  });

  it("rejects uniform unsafe cleanup drift without trusting the live job as canonical", () => {
    const workflow = loadWorkflow();
    const requiredJobs = imageJobNames(workflow);
    const errors = validateMutation((mutatedWorkflow) => {
      for (const jobName of requiredJobs) {
        const cleanup = namedStep(mutatedWorkflow.jobs[jobName], CLEANUP_STEP_NAME)!;
        cleanup.run = `${CLEANUP_HELPER_RUN} || true`;
        cleanup["continue-on-error"] = true;
      }
    });

    for (const jobName of requiredJobs) {
      expect(errors).toContain(
        `${jobName} Docker Hub cleanup step must contain exactly name, if, shell, and run`,
      );
      expect(errors).toContain(
        `${jobName} Docker Hub cleanup step must run only ${CLEANUP_HELPER_RUN}`,
      );
    }
  });

  it("treats every new E2E job as image-consuming unless it is explicitly exempt", () => {
    const errors = validateMutation((workflow) => {
      workflow.jobs["future-image-job"] = {
        env: { E2E_JOB: "1", E2E_TARGET_ID: "future-image-job" },
        steps: [{ uses: "actions/checkout@0000000000000000000000000000000000000000" }],
      };
    });

    expect(errors).toContain(
      "future-image-job image-consuming job must have exactly one Docker Hub auth step",
    );
    expect(errors).toContain(
      "future-image-job image-consuming job must have exactly one Docker Hub cleanup step",
    );
  });

  it("executes the shared auth script with isolated config and bounded fail-closed retries", () => {
    const workflow = loadWorkflow();
    const authScript = String(namedStep(workflow.jobs.live, AUTH_STEP_NAME)?.run ?? "");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-auth-script-"));
    const fakeBin = path.join(directory, "bin");
    const runnerTemp = path.join(directory, "runner-temp");
    const callsPath = path.join(directory, "docker-calls");
    const tokensPath = path.join(directory, "docker-tokens");
    const githubEnv = path.join(directory, "github-env");
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(runnerTemp);
    writeExecutable(
      path.join(fakeBin, "timeout"),
      '#!/usr/bin/env bash\nset -euo pipefail\n[[ "$1" == "30s" ]]\nshift\nexec "$@"\n',
    );
    writeExecutable(path.join(fakeBin, "sleep"), "#!/usr/bin/env bash\nexit 0\n");
    writeExecutable(
      path.join(fakeBin, "docker"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "\${DOCKER_CALLS}"
cat >> "\${DOCKER_TOKENS}"
printf '\\n' >> "\${DOCKER_TOKENS}"
attempt="$(wc -l < "\${DOCKER_CALLS}")"
if [[ "\${attempt}" -lt "\${DOCKER_SUCCESS_ATTEMPT}" ]]; then
  exit 1
fi
`,
    );

    const runAuth = (options: {
      authRequired: "0" | "1";
      successAttempt: number;
      token?: string;
      username?: string;
    }) => {
      fs.rmSync(callsPath, { force: true });
      fs.rmSync(tokensPath, { force: true });
      fs.rmSync(githubEnv, { force: true });
      return spawnSync("bash", ["-c", authScript], {
        encoding: "utf8",
        env: {
          ...process.env,
          DOCKER_CALLS: callsPath,
          DOCKER_SUCCESS_ATTEMPT: String(options.successAttempt),
          DOCKER_TOKENS: tokensPath,
          DOCKERHUB_AUTH_REQUIRED: options.authRequired,
          DOCKERHUB_TOKEN: options.token ?? "",
          DOCKERHUB_USERNAME: options.username ?? "",
          GITHUB_ENV: githubEnv,
          GITHUB_JOB: "live",
          PATH: `${fakeBin}:${process.env.PATH}`,
          RUNNER_TEMP: runnerTemp,
        },
      });
    };

    try {
      const untrusted = runAuth({ authRequired: "0", successAttempt: 1 });
      expect(untrusted.status).toBe(0);
      expect(fs.existsSync(callsPath)).toBe(false);
      const isolatedConfig = fs.readFileSync(githubEnv, "utf8").trim().split("=")[1];
      expect(isolatedConfig.startsWith(`${runnerTemp}/docker-config-live-`)).toBe(true);
      expect(fs.statSync(isolatedConfig).mode & 0o777).toBe(0o700);
      expect(fs.existsSync(path.join(isolatedConfig, ".nemoclaw-docker-login-attempted"))).toBe(
        false,
      );

      const retried = runAuth({
        authRequired: "1",
        successAttempt: 3,
        token: "test-docker-token",
        username: "test-user",
      });
      expect(retried.status, retried.stderr).toBe(0);
      const authenticatedConfig = fs.readFileSync(githubEnv, "utf8").trim().split("=")[1];
      const authMarker = path.join(authenticatedConfig, ".nemoclaw-docker-login-attempted");
      expect(fs.existsSync(authMarker)).toBe(true);
      expect(fs.statSync(authMarker).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(callsPath, "utf8").trim().split("\n")).toHaveLength(3);
      expect(fs.readFileSync(callsPath, "utf8")).toContain("--password-stdin");
      expect(fs.readFileSync(callsPath, "utf8")).not.toContain("test-docker-token");
      expect(fs.readFileSync(tokensPath, "utf8").trim().split("\n")).toEqual([
        "test-docker-token",
        "test-docker-token",
        "test-docker-token",
      ]);

      const exhausted = runAuth({
        authRequired: "1",
        successAttempt: 4,
        token: "test-docker-token",
        username: "test-user",
      });
      expect(exhausted.status).toBe(1);
      expect(fs.readFileSync(callsPath, "utf8").trim().split("\n")).toHaveLength(3);
      expect(`${exhausted.stdout}${exhausted.stderr}`).toContain(
        "Docker Hub login failed after 3 attempts",
      );

      const missing = runAuth({ authRequired: "1", successAttempt: 1 });
      expect(missing.status).toBe(1);
      expect(fs.existsSync(callsPath)).toBe(false);
      expect(`${missing.stdout}${missing.stderr}`).toContain(
        "Docker Hub credentials are required for trusted E2E runs",
      );
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("runs the checked-in cleanup helper only for exact job-owned Docker configs", () => {
    expect(fs.statSync(CLEANUP_HELPER_PATH).mode & 0o111).not.toBe(0);

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-cleanup-script-"));
    const fakeBin = path.join(directory, "bin");
    const runnerTemp = path.join(directory, "runner-temp");
    const callsPath = path.join(directory, "docker-calls");
    const sentinelPath = path.join(directory, "command-substitution-ran");
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(runnerTemp);
    writeExecutable(
      path.join(fakeBin, "timeout"),
      '#!/usr/bin/env bash\nset -euo pipefail\n[[ "${1:-}" == "30s" ]]\nshift\nexec "$@"\n',
    );
    writeExecutable(
      path.join(fakeBin, "docker"),
      '#!/usr/bin/env bash\nset -euo pipefail\nprintf \'%s\\n\' "$*" >> "${DOCKER_CALLS}"\nexit "${DOCKER_EXIT_CODE:-0}"\n',
    );

    const createConfig = (name: string): string => {
      const dockerConfig = path.join(runnerTemp, name);
      fs.mkdirSync(dockerConfig, { recursive: true });
      fs.writeFileSync(path.join(dockerConfig, "config.json"), "{}\n");
      const authMarker = path.join(dockerConfig, ".nemoclaw-docker-login-attempted");
      fs.writeFileSync(authMarker, "");
      fs.chmodSync(authMarker, 0o600);
      return dockerConfig;
    };
    const runCleanup = (options: {
      dockerConfig?: string;
      dockerExitCode?: number;
      githubJob?: string;
      runnerTemp?: string;
    }) => {
      fs.rmSync(callsPath, { force: true });
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        DOCKER_CALLS: callsPath,
        DOCKER_EXIT_CODE: String(options.dockerExitCode ?? 0),
        GITHUB_JOB: options.githubJob ?? "live",
        PATH: `${fakeBin}:${process.env.PATH}`,
        RUNNER_TEMP: options.runnerTemp ?? runnerTemp,
      };
      delete env.DOCKER_CONFIG;
      Object.assign(
        env,
        options.dockerConfig === undefined ? {} : { DOCKER_CONFIG: options.dockerConfig },
      );
      return spawnSync(CLEANUP_HELPER_PATH, [], {
        encoding: "utf8",
        env,
      });
    };
    const expectRefused = (options: Parameters<typeof runCleanup>[0]) => {
      const result = runCleanup(options);
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(1);
      expect(fs.existsSync(callsPath)).toBe(false);
      return result;
    };

    try {
      const empty = runCleanup({});
      expect(empty.status, empty.stderr).toBe(0);
      expect(fs.existsSync(callsPath)).toBe(false);

      const absentConfig = path.join(runnerTemp, "docker-config-live-Ab12Cd");
      const absent = runCleanup({ dockerConfig: absentConfig });
      expect(absent.status, absent.stderr).toBe(0);
      expect(fs.existsSync(callsPath)).toBe(false);

      const anonymousConfig = path.join(runnerTemp, "docker-config-live-Cd34Ef");
      fs.mkdirSync(anonymousConfig);
      const anonymous = runCleanup({ dockerConfig: anonymousConfig });
      expect(anonymous.status, anonymous.stderr).toBe(0);
      expect(fs.existsSync(anonymousConfig)).toBe(false);
      expect(fs.existsSync(callsPath)).toBe(false);

      const validConfig = createConfig("docker-config-live-Ef34Gh");
      const valid = runCleanup({ dockerConfig: validConfig });
      expect(valid.status, valid.stderr).toBe(0);
      expect(fs.existsSync(validConfig)).toBe(false);
      expect(fs.readFileSync(callsPath, "utf8")).toContain(
        `--config ${validConfig} logout docker.io`,
      );

      const outsideConfig = path.join(directory, "docker-config-live-Ij56Kl");
      fs.mkdirSync(outsideConfig);
      expectRefused({ dockerConfig: outsideConfig });
      expect(fs.existsSync(outsideConfig)).toBe(true);

      const prefixCollision = path.join(`${runnerTemp}-other`, "docker-config-live-Mn78Op");
      fs.mkdirSync(prefixCollision, { recursive: true });
      expectRefused({ dockerConfig: prefixCollision });
      expect(fs.existsSync(prefixCollision)).toBe(true);

      const traversalTarget = path.join(directory, "traversal-target");
      fs.mkdirSync(traversalTarget);
      const traversalConfig = `${runnerTemp}/docker-config-live-Qr90St/../../traversal-target`;
      expectRefused({ dockerConfig: traversalConfig });
      expect(fs.existsSync(traversalTarget)).toBe(true);

      const wrongJobConfig = createConfig("docker-config-other-Uv12Wx");
      expectRefused({ dockerConfig: wrongJobConfig });
      expect(fs.existsSync(wrongJobConfig)).toBe(true);

      const malformedSuffixConfig = createConfig("docker-config-live-short");
      expectRefused({ dockerConfig: malformedSuffixConfig });
      expect(fs.existsSync(malformedSuffixConfig)).toBe(true);

      const symlinkTarget = path.join(directory, "symlink-target");
      fs.mkdirSync(symlinkTarget);
      const configSymlink = path.join(runnerTemp, "docker-config-live-Yz34Ab");
      fs.symlinkSync(symlinkTarget, configSymlink);
      expectRefused({ dockerConfig: configSymlink });
      expect(fs.existsSync(configSymlink)).toBe(true);
      expect(fs.existsSync(symlinkTarget)).toBe(true);

      const configFileTarget = path.join(directory, "external-config.json");
      fs.writeFileSync(configFileTarget, '{"auths":{"docker.io":{}}}\n');
      const configFileSymlinkDir = path.join(runnerTemp, "docker-config-live-Cd56Ef");
      fs.mkdirSync(configFileSymlinkDir);
      const configFileSymlinkMarker = path.join(
        configFileSymlinkDir,
        ".nemoclaw-docker-login-attempted",
      );
      fs.writeFileSync(configFileSymlinkMarker, "");
      fs.chmodSync(configFileSymlinkMarker, 0o600);
      fs.symlinkSync(configFileTarget, path.join(configFileSymlinkDir, "config.json"));
      const configFileSymlink = runCleanup({ dockerConfig: configFileSymlinkDir });
      expect(configFileSymlink.status).toBe(1);
      expect(fs.existsSync(configFileSymlinkDir)).toBe(false);
      expect(fs.readFileSync(configFileTarget, "utf8")).toContain("docker.io");
      expect(fs.existsSync(callsPath)).toBe(false);

      const markerTarget = path.join(directory, "external-login-marker");
      fs.writeFileSync(markerTarget, "preserve me\n");
      const markerSymlinkDir = path.join(runnerTemp, "docker-config-live-Ef67Gh");
      fs.mkdirSync(markerSymlinkDir);
      fs.writeFileSync(path.join(markerSymlinkDir, "config.json"), "{}\n");
      fs.symlinkSync(markerTarget, path.join(markerSymlinkDir, ".nemoclaw-docker-login-attempted"));
      const markerSymlink = runCleanup({ dockerConfig: markerSymlinkDir });
      expect(markerSymlink.status).toBe(1);
      expect(fs.existsSync(markerSymlinkDir)).toBe(false);
      expect(fs.readFileSync(markerTarget, "utf8")).toBe("preserve me\n");
      expect(fs.existsSync(callsPath)).toBe(false);

      const metacharConfig = `${runnerTemp}/docker-config-live-$(touch ${sentinelPath})`;
      expectRefused({ dockerConfig: metacharConfig });
      expect(fs.existsSync(sentinelPath)).toBe(false);

      const logoutFailureConfig = createConfig("docker-config-live-Gh78Ij");
      const logoutFailure = runCleanup({
        dockerConfig: logoutFailureConfig,
        dockerExitCode: 42,
      });
      expect(logoutFailure.status).toBe(1);
      expect(fs.existsSync(logoutFailureConfig)).toBe(false);
      expect(fs.readFileSync(callsPath, "utf8")).toContain(
        `--config ${logoutFailureConfig} logout docker.io`,
      );
      expect(`${logoutFailure.stdout}${logoutFailure.stderr}`).toContain("Docker logout failed");
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });
});
