// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  validateDockerHubAuthAction,
  validateDockerHubCleanupAction,
  validateE2eWorkflowBoundary,
} from "../../../tools/e2e/workflow-boundary.mts";
import { readWorkflow } from "../../helpers/e2e-workflow-contract";
import { testTimeout } from "../../helpers/timeouts";

const NO_IMAGE_E2E_JOBS = [
  "external-gateway-health",
  "staging-brev-launchable",
  "staging-brev-launchable-identity",
  "shared-e2e",
] as const;
const AUTH_STEP_NAME = "Authenticate to Docker Hub";
const CLEANUP_STEP_NAME = "Clean up Docker auth";
const CLEANUP_HELPER_RUN = "bash .github/scripts/docker-auth-cleanup.sh";
const AUTH_HELPER_USES =
  "NVIDIA/NemoClaw/.github/actions/docker-auth-setup@05fa6b810017752ab21148cb7e9d82d12a88c92f";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CLEANUP_HELPER_PATH = path.join(REPO_ROOT, ".github", "scripts", "docker-auth-cleanup.sh");
const AUTH_HELPER_PATH = path.join(REPO_ROOT, ".github", "scripts", "docker-auth-setup.sh");
const AUTH_ACTION_PATH = path.join(
  REPO_ROOT,
  ".github",
  "actions",
  "docker-auth-setup",
  "action.yaml",
);
const CLEANUP_ACTION_PATH = path.join(
  REPO_ROOT,
  ".github",
  "actions",
  "docker-auth-cleanup",
  "action.yaml",
);

type WorkflowStep = Record<string, unknown> & {
  env?: Record<string, unknown>;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
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

function mutateActionSource(
  source: string,
  mutateAction: (action: Record<string, unknown>) => void,
): string {
  const action = YAML.parse(source) as Record<string, unknown>;
  mutateAction(action);
  return YAML.stringify(action);
}

function validateAuthArtifactMutation(options: {
  mutateAction?: (action: Record<string, unknown>) => void;
  mutateScript?: (source: string) => string;
}): string[] {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-auth-action-"));
  const actionPath = path.join(directory, "action.yaml");
  const scriptPath = path.join(directory, "docker-auth-setup.sh");
  try {
    const actionSource = fs.readFileSync(AUTH_ACTION_PATH, "utf8");
    const mutatedActionSource = options.mutateAction
      ? mutateActionSource(actionSource, options.mutateAction)
      : actionSource;
    fs.writeFileSync(actionPath, mutatedActionSource);
    const scriptSource = fs.readFileSync(AUTH_HELPER_PATH, "utf8");
    fs.writeFileSync(scriptPath, options.mutateScript?.(scriptSource) ?? scriptSource);
    return validateDockerHubAuthAction(actionPath, scriptPath);
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
}

function validateCleanupArtifactMutation(options: {
  mutateAction?: (action: Record<string, unknown>) => void;
  mutateScript?: (source: string) => string;
}): string[] {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-cleanup-action-"));
  const actionPath = path.join(directory, "action.yaml");
  const scriptPath = path.join(directory, "docker-auth-cleanup.sh");
  try {
    const actionSource = fs.readFileSync(CLEANUP_ACTION_PATH, "utf8");
    const mutatedActionSource = options.mutateAction
      ? mutateActionSource(actionSource, options.mutateAction)
      : actionSource;
    fs.writeFileSync(actionPath, mutatedActionSource);
    const scriptSource = fs.readFileSync(CLEANUP_HELPER_PATH, "utf8");
    fs.writeFileSync(scriptPath, options.mutateScript?.(scriptSource) ?? scriptSource);
    return validateDockerHubCleanupAction(actionPath, scriptPath);
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
}

describe("shared Docker Hub authentication workflow boundary (#6961)", () => {
  it(
    "accepts only the pinned pre-restore cleanup action in the complete workflow",
    () => {
      expect(validateE2eWorkflowBoundary()).toEqual([]);

      const jobNames = [
        "openclaw-plugin-runtime-exdev",
        "openclaw-plugin-runtime-exdev-release",
      ] as const;
      const cleanupMutations: Array<(cleanup: WorkflowStep) => void> = [
        (cleanup) => {
          cleanup.uses = "NVIDIA/NemoClaw/.github/actions/docker-auth-cleanup@main";
        },
        (cleanup) => {
          cleanup.uses = "./.github/actions/docker-auth-cleanup";
        },
        (cleanup) => {
          delete cleanup.uses;
          cleanup.shell = "bash";
          cleanup.run = CLEANUP_HELPER_RUN;
        },
      ];
      for (const mutateCleanup of cleanupMutations) {
        const errors = validateMutation((workflow) => {
          for (const jobName of jobNames) {
            const cleanup = namedStep(
              workflow.jobs[jobName],
              "Remove Docker auth before release-pinned fixture",
            );
            expect(cleanup).toBeDefined();
            mutateCleanup(cleanup!);
          }
        });

        for (const jobName of jobNames) {
          expect(errors).toContain(
            `${jobName} must use the pinned Docker auth cleanup action before artifact restore`,
          );
        }
      }

      const orderingErrors = validateMutation((workflow) => {
        for (const jobName of jobNames) {
          const job = workflow.jobs[jobName];
          const steps = job.steps!;
          const cleanup = namedStep(job, "Remove Docker auth before release-pinned fixture");
          const restore = namedStep(job, "Restore exact-commit CLI artifact");
          expect(cleanup).toBeDefined();
          expect(restore).toBeDefined();
          steps.splice(steps.indexOf(cleanup!), 1);
          steps.splice(steps.indexOf(restore!) + 1, 0, cleanup!);
        }
      });

      for (const jobName of jobNames) {
        expect(orderingErrors).toContain(
          `${jobName} step 'Remove Docker auth before release-pinned fixture' must precede 'Prepare E2E workspace'`,
        );
      }
    },
    testTimeout(15_000),
  );

  it("rejects missing auth and cleanup coverage for every classified image job", () => {
    const workflow = loadWorkflow();
    const requiredJobs = imageJobNames(workflow);
    const errors = validateMutation((mutatedWorkflow) => {
      requiredJobs.forEach((jobName) => {
        mutatedWorkflow.jobs[jobName].steps = mutatedWorkflow.jobs[jobName].steps?.filter(
          (step) => step.name !== AUTH_STEP_NAME && step.name !== CLEANUP_STEP_NAME,
        );
      });
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

  it.each(NO_IMAGE_E2E_JOBS)(
    "rejects alias, ordering, and no-image exemption drift [case %#]",
    (jobName) => {
      const errors = validateMutation((workflow) => {
        const canonicalAuth = namedStep(workflow.jobs.live, AUTH_STEP_NAME)!;
        const messagingSteps = workflow.jobs["messaging-providers"].steps!;
        const messagingAuthIndex = messagingSteps.indexOf(
          namedStep(workflow.jobs["messaging-providers"], AUTH_STEP_NAME)!,
        );
        messagingSteps[messagingAuthIndex] = {
          ...canonicalAuth,
          env: { ...canonicalAuth.env },
        };

        const routingSteps = workflow.jobs["openclaw-plugin-runtime-exdev"].steps!;
        const routingAuthIndex = routingSteps.indexOf(
          namedStep(workflow.jobs["openclaw-plugin-runtime-exdev"], AUTH_STEP_NAME)!,
        );
        const [routingAuth] = routingSteps.splice(routingAuthIndex, 1);
        routingSteps.splice(routingSteps.length - 1, 0, routingAuth);

        workflow.jobs[jobName].steps!.push({ ...canonicalAuth });
      });

      expect(errors).toEqual(
        expect.arrayContaining([
          "messaging-providers Docker Hub auth must reuse the canonical workflow alias",
          "openclaw-plugin-runtime-exdev Docker Hub auth must run immediately after checkout",
          `${jobName} no-image job must not receive Docker Hub authentication`,
        ]),
      );
    },
  );

  it("rejects step-level Docker config overrides outside the canonical auth step", () => {
    const errors = validateMutation((workflow) => {
      const run = namedStep(
        workflow.jobs["openclaw-plugin-runtime-exdev"],
        "Run OpenClaw custom-plugin lifecycle and runtime-deps EXDEV live test",
      );
      expect(run).toBeDefined();
      run!.env = {
        ...run!.env,
        DOCKER_CONFIG: "${{ runner.temp }}/alternate-docker-config",
      };
    });

    expect(errors).toContain(
      "openclaw-plugin-runtime-exdev step 'Run OpenClaw custom-plugin lifecycle and runtime-deps EXDEV live test' env must not include DOCKER_CONFIG",
    );
  });

  it("rejects trust, helper, and cleanup mapping drift", () => {
    const errors = validateMutation((workflow) => {
      const auth = namedStep(workflow.jobs.live, AUTH_STEP_NAME);
      const cleanup = namedStep(workflow.jobs.live, CLEANUP_STEP_NAME);
      expect(auth).toBeDefined();
      expect(cleanup).toBeDefined();

      auth!.if = "github.event_name == 'schedule'";
      auth!.with = {
        ...auth!.with,
        username: "${{ secrets.DOCKERHUB_USERNAME }}",
      };
      auth!.uses =
        "NVIDIA/NemoClaw/.github/actions/docker-auth-setup@0000000000000000000000000000000000000000";

      cleanup!.if = "success()";
      cleanup!.run = `${String(cleanup!.run)} || true`;
      cleanup!.env = { DOCKER_CONFIG: "${{ github.workspace }}/docker-config" };

      const routingSteps = workflow.jobs["openclaw-plugin-runtime-exdev"].steps!;
      const routingCleanupIndex = routingSteps.findIndex((step) => step.name === CLEANUP_STEP_NAME);
      const [routingCleanup] = routingSteps.splice(routingCleanupIndex, 1);
      routingSteps.splice(2, 0, routingCleanup);
    });

    expect(errors).toEqual(
      expect.arrayContaining([
        "canonical Docker Hub auth step must always run so untrusted refs receive an isolated empty Docker config",
        "canonical Docker Hub auth must gate username on the trusted repository, main ref, and push/manual events",
        `canonical Docker Hub auth step must invoke only ${AUTH_HELPER_USES}`,
        "live Docker Hub cleanup step must contain exactly name, if, shell, and run",
        "live Docker Hub cleanup step must always run",
        `live Docker Hub cleanup step must run only ${CLEANUP_HELPER_RUN}`,
        "openclaw-plugin-runtime-exdev Docker Hub cleanup must be the final job step",
      ]),
    );
  });

  it("rejects Docker Hub credentials mapped without the checkout_sha guard", () => {
    const errors = validateMutation((workflow) => {
      const auth = namedStep(workflow.jobs.live, AUTH_STEP_NAME)!;
      const ungatedPredicate =
        "github.repository == 'NVIDIA/NemoClaw' && github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch') && inputs.checkout_sha == ''";
      auth.with = {
        "auth-required": `\${{ ${ungatedPredicate} && '1' || '0' }}`,
        username: `\${{ ${ungatedPredicate} && secrets.DOCKERHUB_USERNAME || '' }}`,
        token: `\${{ ${ungatedPredicate} && secrets.DOCKERHUB_TOKEN || '' }}`,
      };
    });

    expect(errors).toEqual(
      expect.arrayContaining([
        "canonical Docker Hub auth must gate auth-required on the trusted repository, main ref, and push/manual events",
        "canonical Docker Hub auth must gate username on the trusted repository, main ref, and push/manual events",
        "canonical Docker Hub auth must gate token on the trusted repository, main ref, and push/manual events",
      ]),
    );
  });

  it("rejects uniform unsafe cleanup drift without trusting the live job as canonical", () => {
    const workflow = loadWorkflow();
    const requiredJobs = imageJobNames(workflow);
    const errors = validateMutation((mutatedWorkflow) => {
      requiredJobs.forEach((jobName) => {
        const cleanup = namedStep(mutatedWorkflow.jobs[jobName], CLEANUP_STEP_NAME)!;
        cleanup.run = `${CLEANUP_HELPER_RUN} || true`;
        cleanup["continue-on-error"] = true;
      });
    });

    requiredJobs.forEach((jobName) => {
      expect(errors).toContain(
        `${jobName} Docker Hub cleanup step must contain exactly name, if, shell, and run`,
      );
      expect(errors).toContain(
        `${jobName} Docker Hub cleanup step must run only ${CLEANUP_HELPER_RUN}`,
      );
    });
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
    expect(namedStep(workflow.jobs.live, AUTH_STEP_NAME)?.uses).toBe(AUTH_HELPER_USES);
    expect(fs.statSync(AUTH_HELPER_PATH).mode & 0o111).not.toBe(0);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-auth-script-"));
    const fakeBin = path.join(directory, "bin");
    const runnerTemp = path.join(directory, "runner-temp");
    const callsPath = path.join(directory, "docker-calls");
    const sleepsPath = path.join(directory, "sleep-calls");
    const tokensPath = path.join(directory, "docker-tokens");
    const githubEnv = path.join(directory, "github-env");
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(runnerTemp);
    writeExecutable(
      path.join(fakeBin, "timeout"),
      '#!/usr/bin/env bash\nset -euo pipefail\n[[ "$1" == "30s" ]]\nshift\nexec "$@"\n',
    );
    writeExecutable(
      path.join(fakeBin, "sleep"),
      '#!/usr/bin/env bash\nset -euo pipefail\n[[ "$#" -eq 1 && "$1" == "5" ]]\nprintf \'%s\\n\' "$1" >> "${SLEEP_CALLS}"\n',
    );
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
      fs.rmSync(sleepsPath, { force: true });
      fs.rmSync(tokensPath, { force: true });
      fs.rmSync(githubEnv, { force: true });
      return spawnSync(AUTH_HELPER_PATH, [], {
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
          SLEEP_CALLS: sleepsPath,
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

      const recovered = runAuth({
        authRequired: "1",
        successAttempt: 4,
        token: "test-docker-token",
        username: "test-user",
      });
      expect(recovered.status, recovered.stderr).toBe(0);
      const authenticatedConfig = fs.readFileSync(githubEnv, "utf8").trim().split("=")[1];
      const authMarker = path.join(authenticatedConfig, ".nemoclaw-docker-login-attempted");
      expect(fs.existsSync(authMarker)).toBe(true);
      expect(fs.statSync(authMarker).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(callsPath, "utf8").trim().split("\n")).toHaveLength(4);
      expect(fs.readFileSync(callsPath, "utf8")).toContain("--password-stdin");
      expect(fs.readFileSync(callsPath, "utf8")).not.toContain("test-docker-token");
      expect(fs.readFileSync(tokensPath, "utf8").trim().split("\n")).toEqual([
        "test-docker-token",
        "test-docker-token",
        "test-docker-token",
        "test-docker-token",
      ]);
      expect(fs.readFileSync(sleepsPath, "utf8").trim().split("\n")).toEqual(["5", "5", "5"]);

      const recoveredOnFinalAttempt = runAuth({
        authRequired: "1",
        successAttempt: 5,
        token: "test-docker-token",
        username: "test-user",
      });
      expect(recoveredOnFinalAttempt.status, recoveredOnFinalAttempt.stderr).toBe(0);
      expect(fs.readFileSync(callsPath, "utf8").trim().split("\n")).toHaveLength(5);
      expect(fs.readFileSync(tokensPath, "utf8").trim().split("\n")).toEqual([
        "test-docker-token",
        "test-docker-token",
        "test-docker-token",
        "test-docker-token",
        "test-docker-token",
      ]);
      expect(fs.readFileSync(sleepsPath, "utf8").trim().split("\n")).toEqual(["5", "5", "5", "5"]);

      const exhausted = runAuth({
        authRequired: "1",
        successAttempt: 6,
        token: "test-docker-token",
        username: "test-user",
      });
      expect(exhausted.status).toBe(1);
      expect(fs.readFileSync(callsPath, "utf8").trim().split("\n")).toHaveLength(5);
      expect(fs.readFileSync(sleepsPath, "utf8").trim().split("\n")).toEqual(["5", "5", "5", "5"]);
      expect(`${exhausted.stdout}${exhausted.stderr}`).toContain(
        "Docker Hub login failed after 5 attempts",
      );

      const missing = runAuth({ authRequired: "1", successAttempt: 1 });
      expect(missing.status).toBe(1);
      expect(fs.existsSync(callsPath)).toBe(false);
      expect(`${missing.stdout}${missing.stderr}`).toContain(
        "Docker Hub credentials are required for trusted E2E runs",
      );

      const rejectedArgs = spawnSync(AUTH_HELPER_PATH, ["unexpected"], {
        encoding: "utf8",
        env: {
          ...process.env,
          DOCKERHUB_AUTH_REQUIRED: "0",
          GITHUB_ENV: githubEnv,
          GITHUB_JOB: "live",
          PATH: `${fakeBin}:${process.env.PATH}`,
          RUNNER_TEMP: runnerTemp,
        },
      });
      expect(rejectedArgs.status).toBe(1);
      expect(`${rejectedArgs.stdout}${rejectedArgs.stderr}`).toContain("does not accept arguments");
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
