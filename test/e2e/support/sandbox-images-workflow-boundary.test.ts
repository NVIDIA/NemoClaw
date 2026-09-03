// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  readSandboxImagesWorkflow,
  validateGlibcProbeLifecycleWorkflowPaths,
  validateSandboxImagesWorkflow,
} from "../../../tools/e2e/sandbox-images-workflow-boundary.mts";

function readWorkflows() {
  return {
    imageWorkflow: readSandboxImagesWorkflow(),
    mainWorkflow: readSandboxImagesWorkflow(".github/workflows/main.yaml"),
    prWorkflow: readSandboxImagesWorkflow(".github/workflows/pr-self-hosted.yaml"),
  };
}

describe("sandbox image workflow boundary", () => {
  it("runs the glibc probe lifecycle test from its grouped runtime path (#10155)", () => {
    const { imageWorkflow, prWorkflow } = readWorkflows();

    expect(validateGlibcProbeLifecycleWorkflowPaths(prWorkflow, imageWorkflow)).toEqual([]);
  });

  it.each([
    ["PR self-hosted workflow", "prWorkflow"],
    ["sandbox image workflow", "imageWorkflow"],
  ] as const)("rejects the removed glibc probe lifecycle path in the %s (#10155)", (_, key) => {
    const { imageWorkflow, prWorkflow } = readWorkflows();
    const workflow = { imageWorkflow, prWorkflow }[key];
    const step = workflow.jobs["test-e2e-gateway-isolation"].steps!.find(
      (candidate) => candidate.name === "Run glibc probe lifecycle regression",
    )!;
    step.run = step.run!.replace("test/e2e-runtime/", "test/");

    expect(validateGlibcProbeLifecycleWorkflowPaths(prWorkflow, imageWorkflow)).toEqual([
      `${key === "prWorkflow" ? "PR self-hosted workflow" : "sandbox image workflow"} must run the grouped glibc probe lifecycle test exactly once`,
    ]);
  });

  it.each([
    ["PR self-hosted workflow", "prWorkflow"],
    ["sandbox image workflow", "imageWorkflow"],
  ] as const)("rejects a renamed duplicate glibc probe command in the %s (#10155)", (_, key) => {
    const { imageWorkflow, prWorkflow } = readWorkflows();
    const workflow = { imageWorkflow, prWorkflow }[key];
    const steps = workflow.jobs["test-e2e-gateway-isolation"].steps!;
    const canonicalStep = steps.find(
      (candidate) => candidate.name === "Run glibc probe lifecycle regression",
    )!;
    steps.push({ ...canonicalStep, name: "Run duplicate glibc probe" });

    expect(validateGlibcProbeLifecycleWorkflowPaths(prWorkflow, imageWorkflow)).toEqual([
      `${key === "prWorkflow" ? "PR self-hosted workflow" : "sandbox image workflow"} must run the grouped glibc probe lifecycle test exactly once`,
    ]);
  });

  it.each([
    ["PR self-hosted workflow", "prWorkflow"],
    ["sandbox image workflow", "imageWorkflow"],
  ] as const)("rejects the glibc probe command in another %s job (#10155)", (_, key) => {
    const { imageWorkflow, prWorkflow } = readWorkflows();
    const workflow = { imageWorkflow, prWorkflow }[key];
    const canonicalStep = workflow.jobs["test-e2e-gateway-isolation"].steps!.find(
      (candidate) => candidate.name === "Run glibc probe lifecycle regression",
    )!;
    workflow.jobs["build-sandbox-images"].steps!.push({
      ...canonicalStep,
      name: "Run duplicate glibc probe in another job",
    });

    expect(validateGlibcProbeLifecycleWorkflowPaths(prWorkflow, imageWorkflow)).toEqual([
      `${key === "prWorkflow" ? "PR self-hosted workflow" : "sandbox image workflow"} must run the grouped glibc probe lifecycle test exactly once`,
    ]);
  });

  it.each([
    ["PR self-hosted workflow", "prWorkflow"],
    ["sandbox image workflow", "imageWorkflow"],
  ] as const)("rejects the removed glibc probe beside the canonical %s step (#10155)", (_, key) => {
    const { imageWorkflow, prWorkflow } = readWorkflows();
    const workflow = { imageWorkflow, prWorkflow }[key];
    const canonicalStep = workflow.jobs["test-e2e-gateway-isolation"].steps!.find(
      (candidate) => candidate.name === "Run glibc probe lifecycle regression",
    )!;
    workflow.jobs["build-sandbox-images"].steps!.push({
      ...canonicalStep,
      name: "Run removed glibc probe",
      run: canonicalStep.run!.replace("test/e2e-runtime/", "test/"),
    });

    expect(validateGlibcProbeLifecycleWorkflowPaths(prWorkflow, imageWorkflow)).toEqual([
      `${key === "prWorkflow" ? "PR self-hosted workflow" : "sandbox image workflow"} must run the grouped glibc probe lifecycle test exactly once`,
    ]);
  });

  it.each([
    [
      "missing enable flag",
      "PR self-hosted workflow",
      "prWorkflow",
      "NEMOCLAW_RUN_GLIBC_PROBE_DOCKER_E2E",
      undefined,
    ],
    [
      "changed enable flag",
      "PR self-hosted workflow",
      "prWorkflow",
      "NEMOCLAW_RUN_GLIBC_PROBE_DOCKER_E2E",
      "true",
    ],
    [
      "missing image",
      "PR self-hosted workflow",
      "prWorkflow",
      "NEMOCLAW_TEST_IMAGE",
      undefined,
    ],
    [
      "changed image",
      "PR self-hosted workflow",
      "prWorkflow",
      "NEMOCLAW_TEST_IMAGE",
      "other-image",
    ],
    [
      "missing enable flag",
      "sandbox image workflow",
      "imageWorkflow",
      "NEMOCLAW_RUN_GLIBC_PROBE_DOCKER_E2E",
      undefined,
    ],
    [
      "changed enable flag",
      "sandbox image workflow",
      "imageWorkflow",
      "NEMOCLAW_RUN_GLIBC_PROBE_DOCKER_E2E",
      "true",
    ],
    [
      "missing image",
      "sandbox image workflow",
      "imageWorkflow",
      "NEMOCLAW_TEST_IMAGE",
      undefined,
    ],
    [
      "changed image",
      "sandbox image workflow",
      "imageWorkflow",
      "NEMOCLAW_TEST_IMAGE",
      "other-image",
    ],
  ] as const)(
    "rejects the %s in the %s glibc probe lifecycle step (#10155)",
    (_, label, key, envName, value) => {
      const { imageWorkflow, prWorkflow } = readWorkflows();
      const workflow = { imageWorkflow, prWorkflow }[key];
      const step = workflow.jobs["test-e2e-gateway-isolation"].steps!.find(
        (candidate) => candidate.name === "Run glibc probe lifecycle regression",
      )!;
      const mutateEnv =
        value === undefined
          ? () => Reflect.deleteProperty(step.env!, envName)
          : () => Reflect.set(step.env!, envName, value);
      mutateEnv();

      expect(validateGlibcProbeLifecycleWorkflowPaths(prWorkflow, imageWorkflow)).toEqual([
        `${label} glibc probe lifecycle step must enable the Docker E2E against nemoclaw-production`,
      ]);
    },
  );

  it("accepts the production-image handoff and focused metadata probe", () => {
    const { imageWorkflow, mainWorkflow } = readWorkflows();

    expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).toEqual([]);
  });

  it("rejects late sandbox scheduling or omission from the final main gate", () => {
    const { imageWorkflow, mainWorkflow } = readWorkflows();
    mainWorkflow.jobs["sandbox-images-and-e2e"].needs = "checks";
    mainWorkflow.jobs.checks.needs = (mainWorkflow.jobs.checks.needs as string[]).filter(
      (dependency) => dependency !== "sandbox-images-and-e2e",
    );
    const gate = mainWorkflow.jobs.checks.steps!.find(
      (step) => step.name === "Verify required main checks",
    )!;
    delete gate.env!.SANDBOX_IMAGES_E2E_RESULT;
    gate.run = gate.run!.replace(
      'require_success "sandbox-images-and-e2e" "$SANDBOX_IMAGES_E2E_RESULT"',
      "",
    );

    expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).toEqual(
      expect.arrayContaining([
        "main sandbox image workflow must start after the cheap preflight jobs",
        "main checks must wait for the sandbox image workflow",
        "main checks must require the sandbox image workflow result",
      ]),
    );
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

  it.each([
    {
      jobName: "build-sandbox-images",
      stepName: "Build production image",
      error:
        "OpenClaw production image must use the guarded build_args shape under nemoclaw-production",
    },
    {
      jobName: "build-hermes-sandbox-image",
      stepName: "Validate Hermes production build args",
      error: "Hermes production image must validate the guarded build_args shape",
    },
    {
      jobName: "build-sandbox-images-arm64",
      stepName: "Build production image on arm64",
      error:
        "OpenClaw arm64 production image must use the guarded build_args shape under nemoclaw-production-arm64",
    },
  ])("requires guarded build_args in $jobName", ({ jobName, stepName, error }) => {
    const { imageWorkflow, mainWorkflow } = readWorkflows();
    const build = imageWorkflow.jobs[jobName].steps!.find((step) => step.name === stepName)!;
    build.run = build.run!.replace(
      'scripts/check-production-build-args.sh "${build_args[@]}"',
      'echo "guard bypassed"',
    );

    expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).toContain(error);
  });

  it.each([
    {
      jobName: "build-sandbox-images",
      stepName: "Build production image",
      error: "OpenClaw production image must have exactly one source build",
    },
    {
      jobName: "build-sandbox-images-arm64",
      stepName: "Build production image on arm64",
      error: "OpenClaw arm64 production image must have exactly one source build",
    },
  ])("rejects a second source build in $jobName", ({ jobName, stepName, error }) => {
    const { imageWorkflow, mainWorkflow } = readWorkflows();
    const build = imageWorkflow.jobs[jobName].steps!.find((step) => step.name === stepName)!;
    build.run = `${build.run}docker build -t duplicate-production-image .\n`;

    expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).toContain(error);
  });

  it("rejects a Hermes Buildx action that can publish or bypass the shared cache", () => {
    const { imageWorkflow, mainWorkflow } = readWorkflows();
    const build = imageWorkflow.jobs["build-hermes-sandbox-image"].steps!.find(
      (step) => step.name === "Build Hermes production image",
    )!;
    build.with!.push = true;
    build.with!["cache-to"] = "type=registry,ref=registry.example.invalid/cache";

    expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).toEqual(
      expect.arrayContaining([
        "build-hermes-sandbox-image step 'Build Hermes production image' must not write images to a registry",
        "Hermes producer must build the production image exactly once with the canonical local-load Buildx action and OS/architecture-scoped GHA cache",
      ]),
    );
  });

  it("requires the canonical no-CA Hermes build and its default-trust image proof", () => {
    const { imageWorkflow, mainWorkflow } = readWorkflows();
    const producer = imageWorkflow.jobs["build-hermes-sandbox-image"];
    const build = producer.steps!.find((step) => step.name === "Build Hermes production image")!;
    build.with!["build-args"] = `${build.with!["build-args"]}\nNEMOCLAW_CORPORATE_CA_B64=test`;
    const proof = producer.steps!.find(
      (step) => step.name === "Verify Hermes default-trust final image",
    )!;
    proof.run = proof.run!.replace(
      "test ! -e /usr/local/share/nemoclaw/corporate-ca.pem",
      "test -e /usr/local/share/nemoclaw/corporate-ca.pem",
    );

    expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).toEqual(
      expect.arrayContaining([
        "Hermes producer must build the production image exactly once with the canonical local-load Buildx action and OS/architecture-scoped GHA cache",
        "Hermes producer must verify that the final image uses default trust when no corporate CA is supplied.",
      ]),
    );
  });

  it.each(["Set up Docker Buildx", "Build Hermes production image"])(
    "rejects non-canonical Hermes Buildx action pins [case %#]",
    (stepName) => {
      const { imageWorkflow, mainWorkflow } = readWorkflows();
      const step = imageWorkflow.jobs["build-hermes-sandbox-image"].steps!.find(
        (candidate) => candidate.name === stepName,
      )!;
      step.uses = step.uses!.replace(/@[0-9a-f]{40}$/u, `@${"0".repeat(40)}`);

      expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).toContain(
        stepName === "Set up Docker Buildx"
          ? "Hermes producer must use the canonical Docker Buildx setup action exactly once"
          : "Hermes producer must build the production image exactly once with the canonical local-load Buildx action and OS/architecture-scoped GHA cache",
      );
    },
  );

  it("rejects a non-canonical Hermes artifact download pin", () => {
    const { imageWorkflow, mainWorkflow } = readWorkflows();
    const download = imageWorkflow.jobs["test-hermes-sandbox-image"].steps!.find(
      (step) => step.name === "Download Hermes production image",
    )!;
    download.uses = `actions/download-artifact@${"0".repeat(40)}`;

    expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).toContain(
      "Hermes image tests must download and load the producer artifact exactly once with the canonical action",
    );
  });

  it("rejects omitting the Hermes base-image resolver before the secret-boundary probe", () => {
    const { imageWorkflow, mainWorkflow } = readWorkflows();
    const consumer = imageWorkflow.jobs["test-hermes-sandbox-image"];
    consumer.steps = consumer.steps!.filter((step) => step.name !== "Resolve Hermes base image");

    expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).toContain(
      "Hermes image tests must resolve the Hermes base image exactly once with the canonical action before the secret-boundary probe",
    );
  });

  it("rejects replacing the Hermes base-image resolver with another action", () => {
    const { imageWorkflow, mainWorkflow } = readWorkflows();
    const consumer = imageWorkflow.jobs["test-hermes-sandbox-image"];
    const resolver = consumer.steps!.find((step) => step.name === "Resolve Hermes base image")!;
    resolver.uses = "./.github/actions/resolve-sandbox-base-image";

    expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).toContain(
      "Hermes image tests must resolve the Hermes base image exactly once with the canonical action before the secret-boundary probe",
    );
  });

  it("rejects conditionally skipping the Hermes base-image resolver", () => {
    const { imageWorkflow, mainWorkflow } = readWorkflows();
    const consumer = imageWorkflow.jobs["test-hermes-sandbox-image"];
    const resolver = consumer.steps!.find((step) => step.name === "Resolve Hermes base image")!;
    resolver.if = "${{ false }}";

    expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).toContain(
      "Hermes base-image resolver must run unconditionally",
    );
  });

  it("rejects tolerating a Hermes base-image resolver failure", () => {
    const { imageWorkflow, mainWorkflow } = readWorkflows();
    const consumer = imageWorkflow.jobs["test-hermes-sandbox-image"];
    const resolver = consumer.steps!.find((step) => step.name === "Resolve Hermes base image")!;
    resolver["continue-on-error"] = true;

    expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).toContain(
      "Hermes base-image resolver must fail closed",
    );
  });

  it("rejects a renamed duplicate Hermes base-image resolver", () => {
    const { imageWorkflow, mainWorkflow } = readWorkflows();
    const consumer = imageWorkflow.jobs["test-hermes-sandbox-image"];
    const resolver = consumer.steps!.find((step) => step.name === "Resolve Hermes base image")!;
    consumer.steps!.push({ ...resolver, name: "Resolve Hermes base image again" });

    expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).toContain(
      "Hermes image tests must resolve the Hermes base image exactly once with the canonical action before the secret-boundary probe",
    );
  });

  it("rejects a conditional trailing-separator alias of the Hermes base-image resolver", () => {
    const { imageWorkflow, mainWorkflow } = readWorkflows();
    const consumer = imageWorkflow.jobs["test-hermes-sandbox-image"];
    const resolver = consumer.steps!.find((step) => step.name === "Resolve Hermes base image")!;
    consumer.steps!.push({
      ...resolver,
      name: "Resolve Hermes base image through trailing separator",
      uses: `${resolver.uses}/`,
      if: "${{ false }}",
    });

    expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).toEqual(
      expect.arrayContaining([
        "Hermes image tests must resolve the Hermes base image exactly once with the canonical action before the secret-boundary probe",
        "Hermes base-image resolver must run unconditionally",
      ]),
    );
  });

  it("rejects a failure-tolerant dot-segment alias of the Hermes base-image resolver", () => {
    const { imageWorkflow, mainWorkflow } = readWorkflows();
    const consumer = imageWorkflow.jobs["test-hermes-sandbox-image"];
    const resolver = consumer.steps!.find((step) => step.name === "Resolve Hermes base image")!;
    consumer.steps!.push({
      ...resolver,
      name: "Resolve Hermes base image through dot segment",
      uses: `${resolver.uses}/.`,
      "continue-on-error": true,
    });

    expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).toEqual(
      expect.arrayContaining([
        "Hermes image tests must resolve the Hermes base image exactly once with the canonical action before the secret-boundary probe",
        "Hermes base-image resolver must fail closed",
      ]),
    );
  });

  it("rejects resolving the Hermes base image after the secret-boundary probe", () => {
    const { imageWorkflow, mainWorkflow } = readWorkflows();
    const consumer = imageWorkflow.jobs["test-hermes-sandbox-image"];
    const resolverIndex = consumer.steps!.findIndex(
      (step) => step.name === "Resolve Hermes base image",
    );
    const [resolver] = consumer.steps!.splice(resolverIndex, 1);
    const secretBoundaryIndex = consumer.steps!.findIndex(
      (step) => step.name === "Run Hermes sandbox secret boundary test",
    );
    consumer.steps!.splice(secretBoundaryIndex + 1, 0, resolver);

    expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).toContain(
      "Hermes image tests must resolve the Hermes base image exactly once with the canonical action before the secret-boundary probe",
    );
  });

  it("rejects Docker Hub authentication in the Hermes image consumer", () => {
    const { imageWorkflow, mainWorkflow } = readWorkflows();
    const producer = imageWorkflow.jobs["build-hermes-sandbox-image"];
    const consumer = imageWorkflow.jobs["test-hermes-sandbox-image"];
    consumer.steps!.push({
      ...producer.steps!.find((step) => step.name === "Authenticate to Docker Hub")!,
    });

    expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).toContain(
      "Hermes image test consumer must not authenticate to Docker Hub",
    );
  });

  it("rejects action-based Docker auth and secrets in Hermes consumer inputs", () => {
    const { imageWorkflow, mainWorkflow } = readWorkflows();
    imageWorkflow.jobs["test-hermes-sandbox-image"].steps!.push({
      name: "Authenticate with Docker action",
      uses: `docker/login-action@${"0".repeat(40)}`,
      with: {
        username: "${{ secrets.DOCKERHUB_USERNAME }}",
        password: "${{ secrets.DOCKERHUB_TOKEN }}",
      },
    });

    expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).toEqual(
      expect.arrayContaining([
        "Hermes image test consumer must not authenticate to Docker Hub",
        "test-hermes-sandbox-image step \x27Authenticate with Docker action\x27 must not receive DOCKERHUB_USERNAME",
        "test-hermes-sandbox-image step \x27Authenticate with Docker action\x27 must not receive DOCKERHUB_TOKEN",
        "test-hermes-sandbox-image step \x27Authenticate with Docker action\x27 must not authenticate to a registry",
      ]),
    );
  });

  it("rejects a continued Buildx rebuild in the Hermes image consumer", () => {
    const { imageWorkflow, mainWorkflow } = readWorkflows();
    imageWorkflow.jobs["test-hermes-sandbox-image"].steps!.push({
      name: "Rebuild Hermes production image",
      run: [
        "docker buildx \\",
        "  build --load -f agents/hermes/Dockerfile -t nemoclaw-hermes-production .",
      ].join("\n"),
    });

    expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).toContain(
      "Hermes image test consumer must not rebuild the prebuilt image",
    );
  });

  it("rejects a duplicate Hermes production-image build", () => {
    const { imageWorkflow, mainWorkflow } = readWorkflows();
    const producer = imageWorkflow.jobs["build-hermes-sandbox-image"];
    producer.steps!.push({
      ...producer.steps!.find((step) => step.name === "Build Hermes production image")!,
    });

    expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).toContain(
      "Hermes producer must build the production image exactly once with the canonical local-load Buildx action and OS/architecture-scoped GHA cache",
    );
  });

  it("rejects a second Hermes production build through the Buildx CLI", () => {
    const { imageWorkflow, mainWorkflow } = readWorkflows();
    const producer = imageWorkflow.jobs["build-hermes-sandbox-image"];
    producer.steps!.splice(-1, 0, {
      name: "Build Hermes production image again",
      run: "docker buildx build --load -f agents/hermes/Dockerfile -t nemoclaw-hermes-production .",
    });

    expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).toContain(
      "Hermes producer must build the production image exactly once with the canonical local-load Buildx action and OS/architecture-scoped GHA cache",
    );
  });

  it("rejects a multiline Hermes Buildx registry write", () => {
    const { imageWorkflow, mainWorkflow } = readWorkflows();
    const producer = imageWorkflow.jobs["build-hermes-sandbox-image"];
    producer.steps!.splice(-1, 0, {
      name: "Publish Hermes production image",
      run: [
        "docker buildx build \\",
        "  --push -t registry.example.invalid/nemoclaw-hermes .",
      ].join("\n"),
    });

    expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).toContain(
      "build-hermes-sandbox-image step \x27Publish Hermes production image\x27 must not write images to a registry",
    );
  });

  it("rejects an assigned Buildx push flag in an image consumer", () => {
    const { imageWorkflow, mainWorkflow } = readWorkflows();
    imageWorkflow.jobs["state-dir-guard-metadata"].steps!.push({
      name: "Publish from metadata consumer",
      run: "docker buildx build --push=true -t registry.example.invalid/nemoclaw .",
    });

    expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).toContain(
      "state-dir-guard-metadata step \x27Publish from metadata consumer\x27 must not write images to a registry",
    );
  });

  it("rejects a mixed-case assigned Buildx push flag in an image consumer", () => {
    const { imageWorkflow, mainWorkflow } = readWorkflows();
    imageWorkflow.jobs["state-dir-guard-metadata"].steps!.push({
      name: "Publish from metadata consumer",
      run: "docker buildx build --push=True -t registry.example.invalid/nemoclaw .",
    });

    expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).toContain(
      "state-dir-guard-metadata step \x27Publish from metadata consumer\x27 must not write images to a registry",
    );
  });

  it("rejects a shell-expanded Buildx push flag in an image consumer", () => {
    const { imageWorkflow, mainWorkflow } = readWorkflows();
    imageWorkflow.jobs["state-dir-guard-metadata"].steps!.push({
      name: "Publish from expanded metadata consumer",
      run: 'docker buildx build --push="${PUSH_IMAGES}" -t registry.example.invalid/nemoclaw .',
    });

    expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).toContain(
      "state-dir-guard-metadata step \x27Publish from expanded metadata consumer\x27 must not write images to a registry",
    );
  });

  it("treats an explicit false Buildx push assignment as non-writing", () => {
    const { imageWorkflow, mainWorkflow } = readWorkflows();
    imageWorkflow.jobs["state-dir-guard-metadata"].steps!.push({
      name: "Disable publishing from metadata consumer",
      run: "docker buildx build --push=false -t nemoclaw-metadata-consumer .",
    });

    expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).not.toContain(
      "state-dir-guard-metadata step \x27Disable publishing from metadata consumer\x27 must not write images to a registry",
    );
  });

  it("requires the Hermes artifact download before its load", () => {
    const { imageWorkflow, mainWorkflow } = readWorkflows();
    const consumer = imageWorkflow.jobs["test-hermes-sandbox-image"];
    const downloadIndex = consumer.steps!.findIndex(
      (step) => step.name === "Download Hermes production image",
    );
    const [download] = consumer.steps!.splice(downloadIndex, 1);
    const loadIndex = consumer.steps!.findIndex(
      (step) => step.name === "Load Hermes production image",
    );
    consumer.steps!.splice(loadIndex + 1, 0, download);

    expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).toContain(
      "Hermes image tests must download and load the producer artifact exactly once with the canonical action",
    );
  });

  it("rejects non-canonical Hermes artifact upload and metadata download pins", () => {
    const { imageWorkflow, mainWorkflow } = readWorkflows();
    const upload = imageWorkflow.jobs["build-hermes-sandbox-image"].steps!.find(
      (step) => step.name === "Upload Hermes isolation image",
    )!;
    upload.uses = `actions/upload-artifact@${"0".repeat(40)}`;
    const download = imageWorkflow.jobs["state-dir-guard-metadata"].steps!.find(
      (step) => step.name === "Download Hermes production image",
    )!;
    download.uses = `actions/download-artifact@${"0".repeat(40)}`;

    expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).toEqual(
      expect.arrayContaining([
        "Hermes producer must upload the saved production image before auth cleanup",
        "state-dir guard metadata must download the saved Hermes production image",
      ]),
    );
  });

  it("rejects a Hermes cache scope without runner OS and architecture", () => {
    const { imageWorkflow, mainWorkflow } = readWorkflows();
    const build = imageWorkflow.jobs["build-hermes-sandbox-image"].steps!.find(
      (step) => step.name === "Build Hermes production image",
    )!;
    build.with!["cache-from"] = "type=gha,scope=hermes-production-";
    build.with!["cache-to"] = "type=gha,mode=max,scope=hermes-production-";

    expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).toContain(
      "Hermes producer must build the production image exactly once with the canonical local-load Buildx action and OS/architecture-scoped GHA cache",
    );
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
    hermes.run = hermes
      .run!.replace(
        'scripts/check-production-build-args.sh "${build_args[@]}"',
        'echo "guard bypassed"',
      )
      .replace(
        '--build-arg "NEMOCLAW_CORPORATE_CA_B64=${corporate_ca_b64}"',
        '--build-arg "NEMOCLAW_CORPORATE_CA_B64="',
      )
      .replace("crl2pkcs7 -nocrl", "version")
      .replace(
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
        'hermes messaging plan image boundary must include scripts/check-production-build-args.sh "${build_args[@]}"',
        'hermes messaging plan image boundary must include --build-arg "NEMOCLAW_CORPORATE_CA_B64=${corporate_ca_b64}"',
        "hermes messaging plan image boundary must include docker run --rm --network none --entrypoint openssl nemoclaw-hermes-plan-boundary crl2pkcs7 -nocrl -certfile /usr/local/share/nemoclaw/corporate-ca.pem -out /dev/null",
        "hermes messaging plan image boundary must include node --experimental-strip-types scripts/check-messaging-plan-image-boundary.mts verify nemoclaw-hermes-plan-boundary hermes",
        "messaging plan image boundary must not publish probe image artifacts",
      ]),
    );
  });

  it("requires the exact compact CA root helper invocation", () => {
    const { imageWorkflow, mainWorkflow } = readWorkflows();
    const hermes = imageWorkflow.jobs["messaging-plan-image-boundary"].steps!.find(
      (step) => step.name === "Build and verify Hermes messaging plan boundary",
    )!;
    hermes.run = hermes.run!.replace(
      "select-ci-endpoint-ca-roots.mts",
      "select-ci-endpoint-ca-roots.mts --endpoint registry.example.invalid",
    );

    expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).toContain(
      'hermes messaging plan image boundary must include exactly node --experimental-strip-types scripts/checks/select-ci-endpoint-ca-roots.mts --output "$compact_ca_bundle"',
    );
  });

  it.each([
    'forbidden_ca_b64="$(base64 -w 0 "$system_ca_bundle")"',
    [
      "corporate_ca_bundle=/etc/ssl/certs/ca-certificates.crt",
      'forbidden_ca_b64="$(base64 -w 0 "$corporate_ca_bundle")"',
    ].join("\n"),
  ])("rejects direct base64 encoding of the broad system CA bundle [case %#]", (forbidden) => {
    const { imageWorkflow, mainWorkflow } = readWorkflows();
    const hermes = imageWorkflow.jobs["messaging-plan-image-boundary"].steps!.find(
      (step) => step.name === "Build and verify Hermes messaging plan boundary",
    )!;
    hermes.run = `${hermes.run}\n${forbidden}`;

    expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).toContain(
      "hermes messaging plan image boundary must not encode the system CA bundle directly",
    );
  });

  it("requires offline equality and parse proofs for the installed Hermes CA bundle", () => {
    const { imageWorkflow, mainWorkflow } = readWorkflows();
    const hermes = imageWorkflow.jobs["messaging-plan-image-boundary"].steps!.find(
      (step) => step.name === "Build and verify Hermes messaging plan boundary",
    )!;
    hermes.run = hermes
      .run!.replace(
        'test "$installed_ca_sha256" = "$corporate_ca_sha256"',
        'test -n "$installed_ca_sha256"',
      )
      .replace("crl2pkcs7 -nocrl", "version");

    expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).toEqual(
      expect.arrayContaining([
        'hermes messaging plan image boundary must include test "$installed_ca_sha256" = "$corporate_ca_sha256"',
        "hermes messaging plan image boundary must include docker run --rm --network none --entrypoint openssl nemoclaw-hermes-plan-boundary crl2pkcs7 -nocrl -certfile /usr/local/share/nemoclaw/corporate-ca.pem -out /dev/null",
      ]),
    );
  });

  it("requires the Hermes build guard before the build and offline CA proofs", () => {
    const { imageWorkflow, mainWorkflow } = readWorkflows();
    const hermes = imageWorkflow.jobs["messaging-plan-image-boundary"].steps!.find(
      (step) => step.name === "Build and verify Hermes messaging plan boundary",
    )!;
    const guard = 'scripts/check-production-build-args.sh "${build_args[@]}"';
    hermes.run = `${hermes.run!.replace(guard, "")}\n${guard}`;

    expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).toEqual(
      expect.arrayContaining([
        "hermes messaging plan image boundary steps are out of order",
        "hermes messaging plan image boundary CA fixture steps are out of order",
      ]),
    );
  });

  it("rejects the Hermes CA build argument after the image build", () => {
    const { imageWorkflow, mainWorkflow } = readWorkflows();
    const hermes = imageWorkflow.jobs["messaging-plan-image-boundary"].steps!.find(
      (step) => step.name === "Build and verify Hermes messaging plan boundary",
    )!;
    const buildArg = '--build-arg "NEMOCLAW_CORPORATE_CA_B64=${corporate_ca_b64}"';
    const buildCommand = 'docker build "${build_args[@]}" -t nemoclaw-hermes-plan-boundary .';
    expect(hermes.run).toContain(buildArg);
    hermes.run = hermes
      .run!.replace(buildArg, "")
      .replace(buildCommand, `${buildCommand}\n${buildArg}`);

    expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).toContain(
      "hermes messaging plan image boundary CA fixture steps are out of order",
    );
  });

  it.each(
    ["build-hermes-sandbox-image", "messaging-plan-image-boundary"],
  )("requires bounded swap before every hosted Hermes image export [%s]", (jobName) => {
    const { imageWorkflow, mainWorkflow } = readWorkflows();

    const job = imageWorkflow.jobs[jobName];
    const swap = job.steps!.find((step) => step.name === "Add swap for Hermes image export")!;
    swap.run = swap.run!.replace('sudo swapon "$swap_file"', 'echo "swap omitted"');

    expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).toEqual(
      expect.arrayContaining([
        'build-hermes-sandbox-image Hermes export swap must include sudo swapon "$swap_file"',
        'messaging-plan-image-boundary Hermes export swap must include sudo swapon "$swap_file"',
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
        "build-sandbox-images must retain its 45-minute producer budget",
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

  it.each(
    ["Set up Node", "Install root dependencies"],
  )(
    "rejects duplicate setup, rebuilding, or failing to reuse the Hermes image [%s]",
    (stepName) => {
      const { imageWorkflow, mainWorkflow } = readWorkflows();
      const producer = imageWorkflow.jobs["build-hermes-sandbox-image"];
      const hermes = imageWorkflow.jobs["test-hermes-sandbox-image"];
      producer["timeout-minutes"] = 45;
      hermes["timeout-minutes"] = 75;

      hermes.steps!.push({ ...hermes.steps!.find((step) => step.name === stepName)! });
      producer.steps!.push({ ...hermes.steps!.find((step) => step.name === stepName)! });

      const rootEntrypoint = hermes.steps!.find(
        (step) => step.name === "Run Hermes root entrypoint smoke Vitest test",
      )!;
      rootEntrypoint.env!.NEMOCLAW_HERMES_TEST_IMAGE = "nemoclaw-hermes-rebuilt";
      rootEntrypoint.run = `${rootEntrypoint.run}\ndocker build -f agents/hermes/Dockerfile -t nemoclaw-hermes-rebuilt .`;

      expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).toEqual(
        expect.arrayContaining([
          "Hermes image producer must retain its 30-minute budget",
          "Hermes image test consumer must retain its 90-minute budget",
          "build-hermes-sandbox-image must not install Node dependencies",
          `test-hermes-sandbox-image must run '${stepName}' exactly once`,
          "Hermes root entrypoint must consume the prebuilt Hermes production image",
          "Hermes root entrypoint step must not rebuild the prebuilt image",
        ]),
      );
    },
  );

  it("keeps Hermes probes failure-isolated with their inherited budgets", () => {
    const { imageWorkflow, mainWorkflow } = readWorkflows();
    const hermes = imageWorkflow.jobs["test-hermes-sandbox-image"];
    const secretBoundary = hermes.steps!.find(
      (step) => step.name === "Run Hermes sandbox secret boundary test",
    )!;
    delete secretBoundary.id;
    secretBoundary["timeout-minutes"] = 44;
    const rootEntrypoint = hermes.steps!.find(
      (step) => step.name === "Run Hermes root entrypoint smoke Vitest test",
    )!;
    delete rootEntrypoint.if;
    rootEntrypoint["timeout-minutes"] = 29;

    expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).toEqual(
      expect.arrayContaining([
        "Hermes secret boundary step must expose its outcome to the next probe",
        "Hermes secret boundary must retain its 45-minute probe budget",
        "Hermes root entrypoint must run after either secret-boundary outcome",
        "Hermes root entrypoint must retain its 30-minute probe budget",
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
