// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { validateStandardProfileWorkflowBoundary } from "../../../tools/e2e/standard-profile-workflow-boundary.mts";
import { readWorkflow } from "../../helpers/e2e-workflow-contract";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("standard E2E execution profile", () => {
  it("accepts the catalogue callers and reusable profile", () => {
    expect(validateStandardProfileWorkflowBoundary(readWorkflow())).toEqual([]);
  });

  it("rejects a cloudflared PATH shortcut before package verification", () => {
    const profile = YAML.parse(
      fs.readFileSync(
        path.join(REPO_ROOT, ".github", "workflows", "e2e-standard-profile.yaml"),
        "utf8",
      ),
    ) as { jobs: { run: { steps: Array<{ name?: string; run?: string }> } } };
    const step = profile.jobs.run.steps.find(
      (candidate) => candidate.name === "Install reviewed cloudflared",
    )!;
    step.run = `${step.run}\ncommand -v cloudflared`;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-standard-profile-"));
    const profilePath = path.join(directory, "profile.yaml");
    try {
      fs.writeFileSync(profilePath, YAML.stringify(profile));
      expect(validateStandardProfileWorkflowBoundary(readWorkflow(), profilePath)).toContain(
        "standard E2E profile must install only the reviewed cloudflared package",
      );
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects secret crossover between catalogue profiles", () => {
    const workflow = readWorkflow() as {
      jobs: Record<string, { secrets: Record<string, string> }>;
    };
    workflow.jobs["catalogue-standard"]!.secrets.NVIDIA_INFERENCE_API_KEY =
      "${{ secrets.NVIDIA_INFERENCE_API_KEY }}";

    expect(validateStandardProfileWorkflowBoundary(workflow)).toContain(
      "catalogue-standard must receive only its profile secrets",
    );
  });

  it("rejects an unguarded existing catalogue caller secret", () => {
    const workflow = readWorkflow() as {
      jobs: Record<string, { secrets: Record<string, string> }>;
    };
    workflow.jobs["catalogue-nvidia-api"]!.secrets.NVIDIA_API_KEY = "${{ secrets.NVIDIA_API_KEY }}";

    expect(validateStandardProfileWorkflowBoundary(workflow)).toContain(
      "catalogue-nvidia-api must receive only its profile secrets",
    );
  });

  it("rejects catalogue callers that bypass E2E credential authorization (#9047)", () => {
    const workflow = readWorkflow() as {
      jobs: Record<string, { with: Record<string, string> }>;
    };
    workflow.jobs["catalogue-brave-nvidia-inference"]!.with.trusted_main =
      "${{ github.repository == 'NVIDIA/NemoClaw' && github.ref == 'refs/heads/main' }}";

    expect(validateStandardProfileWorkflowBoundary(workflow)).toContain(
      "catalogue-brave-nvidia-inference must pass trusted_main from the catalogue matrix",
    );
  });

  it("passes checkout_sha and the correlation ID from the catalogue matrix", () => {
    const workflow = readWorkflow() as {
      jobs: Record<string, { with: Record<string, string> }>;
    };
    workflow.jobs["catalogue-standard"]!.with.risk_signal_expected_sha =
      "${{ inputs.checkout_sha || github.sha }}";
    workflow.jobs["catalogue-standard"]!.with.risk_signal_correlation_id =
      "${{ inputs.correlation_id }}";

    expect(validateStandardProfileWorkflowBoundary(workflow)).toEqual(
      expect.arrayContaining([
        "catalogue-standard must pass risk_signal_expected_sha from the catalogue matrix",
        "catalogue-standard must pass risk_signal_correlation_id from the catalogue matrix",
      ]),
    );
  });

  it("passes the reusable managed-image revision through every catalogue profile", () => {
    const workflow = readWorkflow() as {
      jobs: Record<string, { needs: string[]; with: Record<string, string> }>;
    };
    workflow.jobs["catalogue-nvidia-inference"]!.needs = ["generate-matrix"];
    workflow.jobs["catalogue-nvidia-inference"]!.with.managed_image_revision =
      "${{ inputs.checkout_sha }}";

    expect(validateStandardProfileWorkflowBoundary(workflow)).toEqual(
      expect.arrayContaining([
        "catalogue-nvidia-inference must call the standard E2E profile after matrix generation and base-image publication",
        "catalogue-nvidia-inference must pass managed_image_revision from the catalogue matrix",
      ]),
    );
  });

  it("uses the planned target display name", () => {
    const workflow = readWorkflow() as {
      jobs: Record<string, { name: string; with: Record<string, string> }>;
    };
    workflow.jobs["catalogue-standard"]!.name = "${{ matrix.id }}";

    expect(validateStandardProfileWorkflowBoundary(workflow)).toContain(
      "catalogue-standard must use the planned outcome-first display name",
    );
  });

  it("passes each profile's credential description from the catalogue matrix", () => {
    const workflow = readWorkflow() as {
      jobs: Record<string, { with: Record<string, string> }>;
    };
    workflow.jobs["catalogue-nvidia-api"]!.with.credential_boundary = "NVIDIA inference API key";

    expect(validateStandardProfileWorkflowBoundary(workflow)).toContain(
      "catalogue-nvidia-api must pass credential_boundary from the catalogue matrix",
    );
  });

  it("rejects changes to shared setup, credentials, telemetry, and artifact paths", () => {
    const profile = YAML.parse(
      fs.readFileSync(
        path.join(REPO_ROOT, ".github", "workflows", "e2e-standard-profile.yaml"),
        "utf8",
      ),
    ) as {
      jobs: {
        run: {
          steps: Array<{
            env?: Record<string, string>;
            if?: string;
            name?: string;
            run?: string;
            with?: Record<string, string>;
          }>;
        };
      };
    };
    const steps = profile.jobs.run.steps;
    steps.find((step) => step.name === "Validate catalogue execution plan")!.run = "echo skipped";
    steps.find((step) => step.name === "Provision trusted Hermes E2E swap")!.run +=
      "\necho candidate-controlled";
    steps.find((step) => step.name === "Add swap for Hermes image rebuild")!.run =
      "echo unsafe swap";
    steps.find((step) => step.name === "Install reviewed cloudflared")!.run =
      "sudo apt-get install cloudflared";
    steps.find((step) => step.name === "Initialize runner comparison telemetry")!.run =
      "echo skipped";
    steps.find((step) => step.name === "Run catalogue E2E target")!.env!.COMPATIBLE_API_KEY =
      "${{ secrets.NVIDIA_INFERENCE_API_KEY }}";
    steps.find((step) => step.name === "Upload E2E artifacts")!.with!.path =
      "e2e-artifacts/live/all/";
    steps.find((step) => step.name === "Upload skill-agent artifacts")!.with!.path =
      "/tmp/unreviewed-skill-output";

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-standard-profile-"));
    const profilePath = path.join(directory, "profile.yaml");
    try {
      fs.writeFileSync(profilePath, YAML.stringify(profile));
      expect(validateStandardProfileWorkflowBoundary(readWorkflow(), profilePath)).toEqual(
        expect.arrayContaining([
          "standard E2E profile must derive validated execution paths before candidate checkout",
          "standard E2E profile must preserve trusted Hermes swap before candidate checkout",
          "standard E2E profile must add the reviewed Hermes rebuild swap after CLI restore",
          "standard E2E profile must install only the reviewed cloudflared package",
          "standard E2E profile must initialize only planned trusted-main runner telemetry",
          "standard E2E profile must run the planned catalogue target with guarded secrets",
          "standard E2E profile must upload only the fixed skill-agent artifact set with the reviewed action",
          "standard E2E profile must upload only its validated artifact path with the reviewed action",
        ]),
      );
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("derives artifact paths before checkout and rejects unsafe plan values", () => {
    const profile = YAML.parse(
      fs.readFileSync(
        path.join(REPO_ROOT, ".github", "workflows", "e2e-standard-profile.yaml"),
        "utf8",
      ),
    ) as { jobs: { run: { steps: Array<{ name?: string; run?: string }> } } };
    const planScript = profile.jobs.run.steps.find(
      (step) => step.name === "Validate catalogue execution plan",
    )!.run!;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-execution-plan-"));
    const githubOutput = path.join(directory, "github-output");
    const githubEnvironment = path.join(directory, "github-environment");
    const environment = {
      ARTIFACT_LAYOUT: "target-shard",
      BASH_ENV: "/dev/null",
      CANDIDATE_REPOSITORY: "NVIDIA/NemoClaw",
      CANDIDATE_SHA: "a".repeat(40),
      CATALOGUE_ID: "hermes-inference-switch",
      ENV: "/dev/null",
      GITHUB_ENV: githubEnvironment,
      GITHUB_OUTPUT: githubOutput,
      GITHUB_WORKSPACE_VALUE: directory,
      HOST_PACKAGES: "",
      HOST_PREPARATION: "hermes-swap",
      INSTALL_MODE: "credential-free",
      LC_ALL: "C",
      PATH: process.env.PATH ?? "",
      SHARD: "anthropic",
      TARGET_ID: "hermes-inference-switch",
      TEST_FILE: "test/e2e/live/hermes-inference-switch.test.ts",
    };

    try {
      const shellArguments = ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c"];
      const valid = spawnSync("bash", [...shellArguments, planScript], {
        encoding: "utf8",
        env: environment,
      });
      expect(valid.status, valid.stderr).toBe(0);
      expect(fs.readFileSync(githubOutput, "utf8")).toBe(
        "artifact_directory=e2e-artifacts/live/hermes-inference-switch/anthropic\n" +
          "upload_name=e2e-hermes-inference-switch-anthropic\n",
      );
      expect(fs.readFileSync(githubEnvironment, "utf8")).toBe(
        `E2E_ARTIFACT_DIR=${directory}/e2e-artifacts/live/hermes-inference-switch/anthropic\n` +
          "NEMOCLAW_E2E_SHARD=anthropic\n",
      );

      const unsafe = spawnSync("bash", [...shellArguments, planScript], {
        encoding: "utf8",
        env: { ...environment, TARGET_ID: "../../runner-temp" },
      });
      expect(unsafe.status).not.toBe(0);
      expect(unsafe.stderr).toContain("Invalid catalogue execution plan: target ID");
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("writes normalized evidence and rejects successful empty runs", () => {
    const profile = YAML.parse(
      fs.readFileSync(
        path.join(REPO_ROOT, ".github", "workflows", "e2e-standard-profile.yaml"),
        "utf8",
      ),
    ) as { jobs: { run: { steps: Array<{ name?: string; run?: string }> } } };
    const evidenceScript = profile.jobs.run.steps.find(
      (step) => step.name === "Write E2E evidence manifest",
    )!.run!;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-evidence-manifest-"));
    const artifactDirectory = path.join("e2e-artifacts", "live", "snapshot-commands");
    const environment = {
      ...process.env,
      ARTIFACT_DIRECTORY: artifactDirectory,
      CANDIDATE_REPOSITORY: "NVIDIA/NemoClaw",
      CANDIDATE_SHA: "a".repeat(40),
      JOB_STATUS: "success",
      RUN_ATTEMPT: "2",
      RUN_ID: "123",
      TARGET_ID: "snapshot-commands",
      WORKFLOW_REPOSITORY: "NVIDIA/NemoClaw",
      WORKFLOW_SHA: "b".repeat(40),
    };

    try {
      fs.mkdirSync(path.join(directory, artifactDirectory), { recursive: true });
      fs.writeFileSync(path.join(directory, artifactDirectory, "test-progress.json"), "{}\n");
      const success = spawnSync("bash", ["-c", evidenceScript], {
        cwd: directory,
        encoding: "utf8",
        env: environment,
      });
      expect(success.status, success.stderr).toBe(0);
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(directory, artifactDirectory, "evidence-manifest.json"),
            "utf8",
          ),
        ),
      ).toEqual({
        kind: "nemoclaw-e2e-evidence-v1",
        targetId: "snapshot-commands",
        candidate: { repository: "NVIDIA/NemoClaw", sha: "a".repeat(40) },
        workflow: {
          repository: "NVIDIA/NemoClaw",
          sha: "b".repeat(40),
          runId: "123",
          runAttempt: "2",
          jobStatus: "success",
        },
        artifactDirectory,
        productEvidenceFileCount: 1,
      });

      fs.rmSync(path.join(directory, artifactDirectory), { force: true, recursive: true });
      const empty = spawnSync("bash", ["-c", evidenceScript], {
        cwd: directory,
        encoding: "utf8",
        env: environment,
      });
      expect(empty.status).not.toBe(0);
      expect(empty.stderr).toContain("successful E2E target produced no product evidence");
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("keeps checkout, credential cleanup, target execution, and artifact upload in order", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-standard-profile-"));
    const profilePath = path.join(tmp, "profile.yaml");
    const profile = YAML.parse(
      fs.readFileSync(
        path.join(REPO_ROOT, ".github", "workflows", "e2e-standard-profile.yaml"),
        "utf8",
      ),
    ) as {
      jobs: {
        run: {
          env?: Record<string, unknown>;
          name?: string;
          steps: Array<{
            if?: string;
            env?: Record<string, unknown>;
            name?: string;
            run?: string;
            uses?: string;
            with?: Record<string, unknown>;
          }>;
        };
      };
    };
    const steps = profile.jobs.run.steps;
    profile.jobs.run.name = "${{ inputs.target_id }}";
    const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@"))!;
    checkout.uses = "actions/checkout@v7";
    checkout.with!["persist-credentials"] = true;
    const auth = steps.find((step) => step.name === "Authenticate to Docker Hub")!;
    auth.with!["auth-required"] = "${{ !inputs.trusted_main && '1' || '0' }}";
    const hostDependencies = steps.find(
      (step) => step.name === "Install target host dependencies",
    )!;
    hostDependencies.uses =
      "NVIDIA/NemoClaw/.github/actions/host-dependency-setup@0000000000000000000000000000000000000000";
    const prepareIndex = steps.findIndex((step) => step.name === "Prepare E2E workspace");
    const hostDependenciesIndex = steps.indexOf(hostDependencies);
    steps.splice(hostDependenciesIndex, 1);
    steps.splice(prepareIndex + 1, 0, hostDependencies);
    const execute = steps.find((step) => step.name === "Run catalogue E2E target")!;
    execute.run = "npm test";
    execute.env = {
      ...execute.env,
      NVIDIA_API_KEY: "${{ !inputs.trusted_main && secrets.NVIDIA_API_KEY || '' }}",
    };
    profile.jobs.run.env!.NEMOCLAW_E2E_EXPECTED_SHA = "${{ github.sha }}";
    profile.jobs.run.env!.NEMOCLAW_E2E_CORRELATION_ID = "";
    profile.jobs.run.env!.NEMOCLAW_E2E_RISK_SIGNAL_EXPECTED_SHA = "${{ github.sha }}";
    profile.jobs.run.env!.BASH_ENV = "${{ github.workspace }}/scripts/leak.sh";
    steps.find((step) => step.name === "Validate catalogue execution plan")!.env!.SHARD =
      "${{ github.event.issue.title }}";
    const upload = steps.find((step) => step.name === "Upload E2E artifacts")!;
    upload.if = "success()";
    upload.with = { path: "/tmp/unreviewed-e2e-output" };
    const cleanup = steps.pop()!;
    steps.unshift(cleanup);
    steps.splice(3, 0, { name: "Run unreviewed helper", run: "bash scripts/helper.sh" });
    fs.writeFileSync(profilePath, YAML.stringify(profile));

    try {
      expect(validateStandardProfileWorkflowBoundary(readWorkflow(), profilePath)).toEqual(
        expect.arrayContaining([
          "standard E2E profile checkout action must use a full commit SHA",
          "standard E2E profile must check out checkout_sha without credentials",
          "standard E2E profile Docker Hub auth-required must be guarded by trusted_main",
          "standard E2E profile must install only the planned host packages with the reviewed action",
          "standard E2E profile must install host dependencies before workspace prep",
          "standard E2E profile must run the planned catalogue target with guarded secrets",
          "standard E2E profile must set NEMOCLAW_E2E_EXPECTED_SHA",
          "standard E2E profile must set NEMOCLAW_E2E_CORRELATION_ID",
          "standard E2E profile must set NEMOCLAW_E2E_RISK_SIGNAL_EXPECTED_SHA",
          "standard E2E profile must derive validated execution paths before candidate checkout",
          "standard E2E profile must expose only its reviewed job environment",
          "standard E2E profile must show the planned credential boundary",
          "standard E2E profile must keep its reviewed step set and order",
          "standard E2E profile must upload only its validated artifact path with the reviewed action",
          "standard E2E profile must always clean up Docker authentication last",
        ]),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
