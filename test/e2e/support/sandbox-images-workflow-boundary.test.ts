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
  it("accepts the production-image handoff and focused metadata probe", () => {
    const { imageWorkflow, mainWorkflow } = readWorkflows();

    expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).toEqual([]);
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

  it("keeps messaging plan image probes isolated, guarded, local, and verified", () => {
    const { imageWorkflow, mainWorkflow } = readWorkflows();
    const probe = imageWorkflow.jobs["messaging-plan-image-boundary"];
    probe["timeout-minutes"] = 60;
    probe.needs = "build-sandbox-images";
    probe.steps!.find((step) => step.name === "Set up Node")!.with!["node-version"] = "22";
    probe.steps!.push({ ...probe.steps!.find((step) => step.name === "Set up Node")! });
    probe.steps!.push({
      name: "Publish probe image",
      uses: "actions/upload-artifact@0000000000000000000000000000000000000000",
    });

    const openclaw = probe.steps!.find(
      (step) => step.name === "Build and verify OpenClaw messaging plan boundary",
    )!;
    openclaw.run = openclaw.run!.replace(
      'scripts/check-production-build-args.sh "${build_args[@]}"',
      'echo "guard bypassed"',
    );

    const hermes = probe.steps!.find(
      (step) => step.name === "Build and verify Hermes messaging plan boundary",
    )!;
    hermes.run = hermes.run!.replace(
      "check-messaging-plan-image-boundary.mts verify",
      "check-messaging-plan-image-boundary.mts bypass",
    );

    expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).toEqual(
      expect.arrayContaining([
        "messaging plan image boundary must retain its 30-minute budget",
        "messaging plan image boundary must remain isolated from canonical image jobs",
        "messaging plan image boundary must set up Node exactly once",
        "messaging plan image boundary must use Node 22.19.0",
        'openclaw messaging plan image boundary must include scripts/check-production-build-args.sh "${build_args[@]}"',
        "hermes messaging plan image boundary must include node --experimental-strip-types scripts/check-messaging-plan-image-boundary.mts verify nemoclaw-hermes-plan-boundary hermes",
        "messaging plan image boundary must not publish probe image artifacts",
      ]),
    );
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

  it("rejects rebuilding, incomplete handoff, or weak metadata-probe tooling", () => {
    const { imageWorkflow, mainWorkflow } = readWorkflows();
    const hermes = imageWorkflow.jobs["build-hermes-sandbox-image"];
    const hermesSave = hermes.steps!.find((step) => step.name === "Save Hermes production image")!;
    hermesSave.run = "echo skipped";
    const hermesUpload = hermes.steps!.find(
      (step) => step.name === "Upload Hermes isolation image",
    )!;
    hermesUpload.with!.name = "wrong-image";

    const metadata = imageWorkflow.jobs["state-dir-guard-metadata"];
    metadata.needs = ["build-sandbox-images"];
    metadata["timeout-minutes"] = 15;
    metadata.env!.NEMOCLAW_HERMES_TEST_IMAGE = "rebuilt-hermes";
    metadata.steps!.push({
      ...imageWorkflow.jobs["build-sandbox-images"].steps!.find(
        (step) => step.name === "Authenticate to Docker Hub",
      )!,
    });
    const openclawDownload = metadata.steps!.find(
      (step) => step.name === "Download OpenClaw production image",
    )!;
    openclawDownload.with!.name = "wrong-image";
    const load = metadata.steps!.find((step) => step.name === "Load production images")!;
    load.run = "echo skipped";
    const tools = metadata.steps!.find(
      (step) => step.name === "Install filesystem metadata tools",
    )!;
    tools.run = "sudo apt-get install acl";
    const probe = metadata.steps!.find(
      (step) => step.name === "Run installed state-dir guard metadata test",
    )!;
    probe["timeout-minutes"] = 5;
    probe.run = `${probe.run}\ndocker build -t rebuilt-hermes .`;
    hermes.steps!.push({ ...probe });
    const upload = metadata.steps!.find(
      (step) => step.name === "Upload state-dir guard metadata artifacts",
    )!;
    delete upload.if;

    expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).toEqual(
      expect.arrayContaining([
        "Hermes producer must save and verify its production image exactly once",
        "Hermes producer must upload the saved production image before auth cleanup",
        "state-dir guard metadata must depend on both production image producers",
        "state-dir guard metadata job must retain its 30-minute budget",
        "state-dir guard metadata must consume both named prebuilt production images",
        "state-dir guard metadata must not authenticate to Docker Hub",
        "state-dir guard metadata must not rebuild either production image",
        "build-hermes-sandbox-image must not run the failure-isolated state-dir guard probe",
        "state-dir guard metadata must download the saved OpenClaw production image",
        "state-dir guard metadata image load must include /tmp/isolation-image.tar.gz | docker load",
        "state-dir guard metadata tool setup must include sudo apt-get install --yes --no-install-recommends acl attr",
        "state-dir guard metadata probe must retain its 15-minute budget",
        "state-dir guard metadata must always use the shared E2E artifact uploader",
      ]),
    );
  });
});
