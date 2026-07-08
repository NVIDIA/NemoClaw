// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  readSandboxImagesWorkflow,
  validateSandboxImagesWorkflow,
} from "../../../tools/e2e/sandbox-images-workflow-boundary.mts";

function readWorkflows() {
  return {
    imageWorkflow: readSandboxImagesWorkflow(),
    mainWorkflow: readSandboxImagesWorkflow(".github/workflows/main.yaml"),
  };
}

describe("sandbox image workflow boundary", () => {
  it("reuses workflow setup anchors and ends every image build with cleanup", () => {
    const { imageWorkflow } = readWorkflows();
    const imageJobNames = [
      "build-sandbox-images",
      "build-hermes-sandbox-image",
      "build-sandbox-images-arm64",
    ];
    const producer = imageWorkflow.jobs["build-sandbox-images"];
    const canonicalAuth = producer.steps?.find(
      (step) => step.name === "Authenticate to Docker Hub",
    );
    expect(canonicalAuth).toBeDefined();

    for (const jobName of imageJobNames) {
      const job = imageWorkflow.jobs[jobName];
      const auth = job.steps?.find((step) => step.name === "Authenticate to Docker Hub");
      expect(auth, `${jobName} auth alias`).toBe(canonicalAuth);
      expect(job.steps?.at(-1)).toEqual({
        name: "Clean up Docker auth",
        if: "always()",
        shell: "bash",
        run: "bash .github/scripts/docker-auth-cleanup.sh",
      });
    }

    const canonicalCheckout = producer.steps?.find((step) => step.name === "Checkout");
    expect(canonicalCheckout).toBeDefined();
    for (const job of Object.values(imageWorkflow.jobs)) {
      expect(job.steps?.find((step) => step.name === "Checkout")).toBe(canonicalCheckout);
    }
    const hermes = imageWorkflow.jobs["build-hermes-sandbox-image"];
    for (const stepName of ["Set up Node", "Install root dependencies"]) {
      const canonicalStep = hermes.steps?.find((step) => step.name === stepName);
      expect(canonicalStep).toBeDefined();
      expect(
        imageWorkflow.jobs["runtime-overrides"].steps?.find((step) => step.name === stepName),
      ).toBe(canonicalStep);
    }
    const gateway = imageWorkflow.jobs["test-e2e-gateway-isolation"];
    for (const stepName of ["Download image artifact", "Load image"]) {
      const canonicalStep = gateway.steps?.find((step) => step.name === stepName);
      expect(canonicalStep).toBeDefined();
      for (const jobName of ["runtime-overrides", "test-e2e-port-overrides"]) {
        expect(imageWorkflow.jobs[jobName].steps?.find((step) => step.name === stepName)).toBe(
          canonicalStep,
        );
      }
    }
  });

  it("rejects auth ordering drift, incomplete cleanup, and registry writes", () => {
    const { imageWorkflow, mainWorkflow } = readWorkflows();
    const hermes = imageWorkflow.jobs["build-hermes-sandbox-image"];
    const cleanup = hermes.steps!.pop()!;
    hermes.steps!.splice(2, 0, cleanup);
    const arm = imageWorkflow.jobs["build-sandbox-images-arm64"];
    const auth = arm.steps!.splice(1, 1)[0];
    arm.steps!.splice(3, 0, auth);
    const build = imageWorkflow.jobs["build-sandbox-images"].steps!.find(
      (step) => step.name === "Build production image",
    )!;
    build.run = `${build.run}\ndocker push registry.example.invalid/nemoclaw:test`;

    expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).toEqual(
      expect.arrayContaining([
        "build-hermes-sandbox-image Docker Hub cleanup must be the final step",
        "build-sandbox-images-arm64 Docker Hub auth must run immediately after checkout",
        "build-sandbox-images step 'Build production image' must not write images to a registry",
      ]),
    );
  });

  it("keeps non-main branch dispatch anonymous and main credentials gated", () => {
    const { imageWorkflow, mainWorkflow } = readWorkflows();
    expect(imageWorkflow.on).toHaveProperty("workflow_dispatch");
    const auth = imageWorkflow.jobs["build-sandbox-images"].steps!.find(
      (step) => step.name === "Authenticate to Docker Hub",
    )!;
    auth.env!.DOCKERHUB_AUTH_REQUIRED = "1";

    expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).toContain(
      "sandbox image Docker Hub credentials must be gated to trusted main push/manual runs",
    );
  });

  it("requires the guarded build_args shape for every production image build", () => {
    const cases = [
      {
        jobName: "build-sandbox-images",
        stepName: "Build production image",
        error:
          "OpenClaw production image must use the guarded build_args shape under nemoclaw-production",
      },
      {
        jobName: "build-hermes-sandbox-image",
        stepName: "Build Hermes production image",
        error:
          "Hermes production image must use the guarded build_args shape under nemoclaw-hermes-production",
      },
      {
        jobName: "build-sandbox-images-arm64",
        stepName: "Build production image on arm64",
        error:
          "OpenClaw arm64 production image must use the guarded build_args shape under nemoclaw-production-arm64",
      },
    ];

    for (const { jobName, stepName, error } of cases) {
      const { imageWorkflow, mainWorkflow } = readWorkflows();
      const build = imageWorkflow.jobs[jobName].steps!.find((step) => step.name === stepName)!;
      build.run = build.run!.replace(
        'scripts/check-production-build-args.sh "${build_args[@]}"',
        'echo "guard bypassed"',
      );

      expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).toContain(error);
    }
  });

  it("rejects a second source build for every production image job", () => {
    const cases = [
      {
        jobName: "build-sandbox-images",
        stepName: "Build production image",
        error: "OpenClaw production image must have exactly one source build",
      },
      {
        jobName: "build-hermes-sandbox-image",
        stepName: "Build Hermes production image",
        error: "Hermes production image must have exactly one source build",
      },
      {
        jobName: "build-sandbox-images-arm64",
        stepName: "Build production image on arm64",
        error: "OpenClaw arm64 production image must have exactly one source build",
      },
    ];

    for (const { jobName, stepName, error } of cases) {
      const { imageWorkflow, mainWorkflow } = readWorkflows();
      const build = imageWorkflow.jobs[jobName].steps!.find((step) => step.name === stepName)!;
      build.run = `${build.run}docker build -t duplicate-production-image .\n`;

      expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).toContain(error);
    }
  });

  it("rejects coupling, rebuilding, or failing to reuse the OpenClaw image artifact", () => {
    const { imageWorkflow, mainWorkflow } = readWorkflows();
    const producer = imageWorkflow.jobs["build-sandbox-images"];
    producer["timeout-minutes"] = 60;
    const runtimeJob = imageWorkflow.jobs["runtime-overrides"];
    runtimeJob["timeout-minutes"] = 45;
    runtimeJob.needs = "runtime-overrides";
    runtimeJob.env!.NEMOCLAW_TEST_IMAGE = "nemoclaw-runtime-overrides-rebuilt";
    runtimeJob.env!.E2E_TARGET_ID = "runtime-overrides-drifted";
    const runtimeSteps = runtimeJob.steps!;
    const runtime = runtimeSteps.find(
      (step) => step.name === "Run runtime overrides test against production image",
    )!;
    runtime["timeout-minutes"] = 30;
    runtime.run = `${runtime.run}\ndocker build -t nemoclaw-runtime-overrides-rebuilt .`;
    producer.steps!.push({ ...runtime });
    producer.steps!.push({ ...runtimeSteps.find((step) => step.name === "Set up Node")! });
    const save = producer.steps!.find((step) => step.name === "Save images to tarballs")!;
    save.run = save.run!.replace("docker save nemoclaw-production", "docker save rebuilt-image");
    producer.steps!.push({ ...save });
    const isolationUpload = producer.steps!.find((step) => step.name === "Upload isolation image")!;
    isolationUpload.with!.path = "/tmp/rebuilt-image.tar.gz";
    const downloadIndex = runtimeSteps.findIndex((step) => step.name === "Download image artifact");
    const download = runtimeSteps[downloadIndex];
    runtimeSteps[downloadIndex] = {
      ...download,
      with: { ...download.with, name: "rebuilt-image" },
    };
    const loadIndex = runtimeSteps.findIndex((step) => step.name === "Load image");
    const load = runtimeSteps[loadIndex];
    runtimeSteps[loadIndex] = {
      ...load,
      run: "gunzip -c /tmp/isolation-image.tar.gz | docker load",
    };
    const upload = runtimeSteps.find((step) => step.name === "Upload runtime overrides artifacts")!;
    delete upload.if;
    runtimeSteps.splice(downloadIndex, 0, runtimeSteps.pop()!);
    runtimeSteps.push({
      ...producer.steps!.find((step) => step.name === "Authenticate to Docker Hub")!,
    });

    expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).toEqual(
      expect.arrayContaining([
        "build-sandbox-images must retain its 15-minute producer budget",
        "runtime-overrides timeout must cover its 45-minute probe budget",
        "runtime-overrides must remain an independent consumer of build-sandbox-images",
        "OpenClaw producer must not run the failure-isolated runtime probe",
        "OpenClaw producer must not run 'Set up Node'",
        "OpenClaw producer must save the production image for sibling consumers",
        "OpenClaw producer must upload the saved production image exactly once",
        "runtime overrides must consume the prebuilt OpenClaw production image",
        "runtime overrides must retain its canonical target id",
        "runtime overrides must retain its 45-minute probe budget",
        "runtime overrides must not authenticate to Docker Hub",
        "runtime overrides step must not rebuild the prebuilt image",
        "runtime overrides must download the saved OpenClaw production image",
        "runtime overrides must load the saved OpenClaw production image",
        "runtime overrides must always use the shared E2E artifact uploader",
        "runtime overrides image handoff and artifact upload steps are out of order",
      ]),
    );
  });

  it("rejects duplicate setup, rebuilding, or failing to reuse the Hermes image", () => {
    const { imageWorkflow, mainWorkflow } = readWorkflows();
    const hermes = imageWorkflow.jobs["build-hermes-sandbox-image"];
    hermes["timeout-minutes"] = 30;
    for (const stepName of ["Set up Node", "Install root dependencies"]) {
      hermes.steps!.push({ ...hermes.steps!.find((step) => step.name === stepName)! });
    }
    const rootEntrypoint = hermes.steps!.find(
      (step) => step.name === "Run Hermes root entrypoint smoke Vitest test",
    )!;
    rootEntrypoint.env!.NEMOCLAW_HERMES_TEST_IMAGE = "nemoclaw-hermes-rebuilt";
    rootEntrypoint.run = `${rootEntrypoint.run}\ndocker build -f agents/hermes/Dockerfile -t nemoclaw-hermes-rebuilt .`;

    expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).toEqual(
      expect.arrayContaining([
        "Hermes image job timeout must cover both inherited probe budgets",
        "build-hermes-sandbox-image must run 'Set up Node' exactly once",
        "build-hermes-sandbox-image must run 'Install root dependencies' exactly once",
        "Hermes production image must have exactly one source build",
        "Hermes root entrypoint must consume the prebuilt Hermes production image",
        "Hermes root entrypoint step must not rebuild the prebuilt image",
      ]),
    );
  });

  it("keeps Hermes probes failure-isolated with their inherited budgets", () => {
    const { imageWorkflow, mainWorkflow } = readWorkflows();
    const hermes = imageWorkflow.jobs["build-hermes-sandbox-image"];
    const secretBoundary = hermes.steps!.find(
      (step) => step.name === "Run Hermes sandbox secret boundary test",
    )!;
    delete secretBoundary.id;
    secretBoundary["timeout-minutes"] = 45;
    const rootEntrypoint = hermes.steps!.find(
      (step) => step.name === "Run Hermes root entrypoint smoke Vitest test",
    )!;
    delete rootEntrypoint.if;
    rootEntrypoint["timeout-minutes"] = 30;

    expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).toEqual(
      expect.arrayContaining([
        "Hermes secret boundary step must expose its outcome to the next probe",
        "Hermes secret boundary must retain its 60-minute probe budget",
        "Hermes root entrypoint must run after either secret-boundary outcome",
        "Hermes root entrypoint must retain its 45-minute probe budget",
      ]),
    );
  });

  it("removes duplicate runtime-only jobs from the general E2E workflow and scorecard", () => {
    const e2eWorkflow = readSandboxImagesWorkflow(".github/workflows/e2e.yaml");
    const removedJobs = [
      "runtime-overrides",
      "hermes-root-entrypoint-smoke",
      "hermes-sandbox-secret-boundary",
    ];

    for (const jobName of removedJobs) {
      expect(e2eWorkflow.jobs).not.toHaveProperty(jobName);
      expect(e2eWorkflow.jobs["report-to-pr"].needs).not.toContain(jobName);
    }
  });
});
