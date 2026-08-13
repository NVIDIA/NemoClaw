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

describe("standard E2E execution profile boundary", () => {
  it("accepts the catalogue callers and reusable profile", () => {
    expect(validateStandardProfileWorkflowBoundary(readWorkflow())).toEqual([]);
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

  it("rejects target display-name and credential-boundary drift", () => {
    const workflow = readWorkflow() as {
      jobs: Record<string, { name: string; with: Record<string, string> }>;
    };
    workflow.jobs["catalogue-standard"]!.name = "${{ matrix.id }}";
    workflow.jobs["catalogue-nvidia-api"]!.with.credential_boundary = "NVIDIA inference API key";

    expect(validateStandardProfileWorkflowBoundary(workflow)).toEqual(
      expect.arrayContaining([
        "catalogue-standard must use the planned outcome-first display name",
        "catalogue-nvidia-api must pass credential_boundary from the trusted execution plan",
      ]),
    );
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

  it("rejects checkout, credential guard, target execution, and cleanup drift", () => {
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
    profile.jobs.run.env!.BASH_ENV = "${{ github.workspace }}/scripts/leak.sh";
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
          "standard E2E profile must check out the exact candidate without credentials",
          "standard E2E profile Docker Hub auth-required must be guarded by trusted_main",
          "standard E2E profile must install only the planned host packages with the reviewed action",
          "standard E2E profile must install host dependencies before workspace prep",
          "standard E2E profile must run the planned catalogue target with guarded secrets",
          "standard E2E profile must set NEMOCLAW_E2E_EXPECTED_SHA",
          "standard E2E profile must expose only its reviewed job environment",
          "standard E2E profile must show the planned credential boundary",
          "standard E2E profile must keep its reviewed step set and order",
          "standard E2E profile must always upload its target-derived artifact path with the reviewed action",
          "standard E2E profile must always clean up Docker authentication last",
        ]),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
