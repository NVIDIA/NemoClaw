// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  assertNativeRuntimeQualificationEvidence,
  compileNativeRuntimeQualification,
  type NativeRuntimeQualificationEvidence,
} from "../registry/activation-qualification.ts";
import { hasRegisteredRuntimeProfile } from "../registry/registry.ts";
import {
  nativeRuntimeQualificationDefinition,
  PODMAN_NATIVE_ACTIVATION_QUALIFICATION,
} from "./native-runtime-qualification-fixtures.ts";

const HEAD_SHA = "1".repeat(40);
const BASE_SHA = "2".repeat(40);
const ARTIFACT_SHA = "a".repeat(64);
const AUTHORITY_SHA = "b".repeat(64);
const BINDING_SHA = "c".repeat(64);
const SPEC_SHA = "d".repeat(64);
const IMAGE_REFS = {
  agent: `nvcr.io/nvidia/nemoclaw-agent@sha256:${"1".repeat(64)}`,
  inference: `nvcr.io/nvidia/nemoclaw-inference@sha256:${"2".repeat(64)}`,
  probe: `quay.io/curl/curl@sha256:${"3".repeat(64)}`,
} as const;

const APPLICATIONS = {
  openclaw: "openclaw",
  hermes: "hermes",
  dcode: "langchain-deepagents-code",
} as const;

function artifact(label: string) {
  return { path: `qualification/${label}.json`, sha256: ARTIFACT_SHA };
}

function completeEvidence(): NativeRuntimeQualificationEvidence[] {
  return PODMAN_NATIVE_ACTIVATION_QUALIFICATION.cases.map((qualificationCase, index) => {
    const managed = qualificationCase.inference !== "ollama";
    return {
      schemaVersion: 1,
      caseId: qualificationCase.id,
      protectedRun: {
        repository: "NVIDIA/NemoClaw",
        workflow: "E2E / PR Gate",
        workflowSha: BASE_SHA,
        runId: 1000 + index,
        attempt: 1,
        jobId: 2000 + index,
        headSha: HEAD_SHA,
        baseSha: BASE_SHA,
      },
      installer: {
        provider: PODMAN_NATIVE_ACTIVATION_QUALIFICATION.provider,
        architecture: qualificationCase.profile.architecture,
        dockerAvailability: "unavailable",
        exitCode: 0,
        invocation: artifact(`${qualificationCase.id}-installer-invocation`),
        script: artifact(`${qualificationCase.id}-installer-script`),
      },
      runtime: {
        provider: PODMAN_NATIVE_ACTIVATION_QUALIFICATION.provider,
        profileId: qualificationCase.profile.id,
        agent: qualificationCase.agent,
        application: APPLICATIONS[qualificationCase.agent],
        inference: qualificationCase.inference,
        architecture: qualificationCase.profile.architecture,
        acceleration: qualificationCase.profile.acceleration,
        rootMode: "rootless",
        engineName: "podman",
        engineVersion: "5.6.2",
        engineAuthority: {
          schemaVersion: 1,
          providerId: PODMAN_NATIVE_ACTIVATION_QUALIFICATION.provider,
          operation: "host-local-inference",
          engineId: "podman-rootless",
          authorityId: "podman:host-local-inference",
          bindingSha256: BINDING_SHA,
        },
        managedImages: [
          { role: "agent" as const, imageRef: IMAGE_REFS.agent },
          { role: "probe" as const, imageRef: IMAGE_REFS.probe },
          ...(managed ? [{ role: "inference" as const, imageRef: IMAGE_REFS.inference }] : []),
        ],
        route: {
          service: qualificationCase.inference,
          endpoint: {
            host: "podman.internal",
            port: 8000,
            networkName: "podman-inference",
            gatewayProviderBaseUrl: "http://host.openshell.internal:8000/v1",
            applicationBaseUrl: "https://inference.local/v1",
          },
          authority: {
            receiptSha256: AUTHORITY_SHA,
            kind: managed ? ("container" as const) : ("host" as const),
            runtimeId: managed ? `podman-${qualificationCase.inference}` : null,
            containerName: managed ? `nemoclaw-${qualificationCase.inference}` : null,
            specSha256: managed ? SPEC_SHA : null,
          },
        },
        modelId: `${qualificationCase.inference}-qualification-model`,
        inferenceResult: artifact(`${qualificationCase.id}-inference-result`),
      },
      operations: qualificationCase.obligations.map((id) => ({
        id,
        authoritySha256: AUTHORITY_SHA,
        artifact: artifact(`${qualificationCase.id}-${id}`),
      })),
      recovery: {
        status: "reconciled" as const,
        authoritySha256: AUTHORITY_SHA,
        artifact: artifact(`${qualificationCase.id}-recovery`),
      },
      cleanup: {
        status: managed ? ("removed-owned" as const) : ("retained-external" as const),
        authoritySha256: AUTHORITY_SHA,
        providerOwnedRuntimeIds: [],
        artifact: artifact(`${qualificationCase.id}-cleanup`),
      },
      ...(qualificationCase.profile.acceleration === "nvidia-gpu"
        ? {
            nvidiaCdi: {
              devices: ["nvidia.com/gpu=all"] as const,
              artifact: artifact(`${qualificationCase.id}-nvidia-cdi`),
            },
          }
        : {}),
    };
  });
}

describe("native runtime activation qualification", () => {
  it("compiles every required all-agent, multiarch, CPU/GPU, and local-inference case", () => {
    const qualification = PODMAN_NATIVE_ACTIVATION_QUALIFICATION;

    expect(qualification.cases).toHaveLength(24);
    expect(new Set(qualification.cases.map((entry) => entry.agent))).toEqual(
      new Set(["openclaw", "hermes", "dcode"]),
    );
    expect(new Set(qualification.cases.map((entry) => entry.profile.architecture))).toEqual(
      new Set(["amd64", "arm64"]),
    );
    expect(new Set(qualification.cases.map((entry) => entry.profile.acceleration))).toEqual(
      new Set(["cpu", "nvidia-gpu"]),
    );
    expect(new Set(qualification.cases.map((entry) => entry.inference))).toEqual(
      new Set(["ollama", "nim", "vllm"]),
    );
    for (const entry of qualification.cases) {
      expect(entry).toMatchObject({
        gate: "protected-e2e",
        install: "release-installer",
        dockerAvailability: "unavailable",
        profile: {
          platform: "linux",
          rootMode: "rootless",
          provider: "podman",
        },
      });
      expect(entry.profile.capabilities).toContain("transport.socket-free");
      expect(entry.profile.capabilities).not.toContain("transport.docker-socket");
      expect(entry.obligations).toEqual(
        expect.arrayContaining([
          "installer.install",
          "runtime.docker-unavailable",
          "agent.turn",
          "sandbox.stop-start",
          "sandbox.snapshot-restore",
          "sandbox.rebuild",
          "runtime.restart-reconcile",
          "cleanup.exact",
        ]),
      );
      expect(hasRegisteredRuntimeProfile(entry.profile.id)).toBe(false);
    }
  });

  it("accepts an MXC-style provider without a provider-specific compiler branch", () => {
    const mxc = compileNativeRuntimeQualification(
      nativeRuntimeQualificationDefinition("test-mxc-native"),
    );

    expect(mxc.cases).toHaveLength(PODMAN_NATIVE_ACTIVATION_QUALIFICATION.cases.length);
    expect(new Set(mxc.cases.map((entry) => entry.profile.provider))).toEqual(
      new Set(["test-mxc-native"]),
    );
    expect(mxc.engineName).toBe("test-mxc-native");
    expect(mxc.cases.every((entry) => entry.id.startsWith("test-mxc-native-"))).toBe(true);
  });

  it("fails closed when one required case is missing", () => {
    const definition = nativeRuntimeQualificationDefinition("missing-case-runtime");

    expect(() =>
      compileNativeRuntimeQualification({
        ...definition,
        cases: definition.cases.slice(1),
      }),
    ).toThrow(/coverage is incomplete.*missing/u);
  });

  it("fails closed when a case omits lifecycle or exact-evidence requirements", () => {
    const missingLifecycle = nativeRuntimeQualificationDefinition("missing-lifecycle-runtime");
    const firstLifecycle = missingLifecycle.cases[0]!;
    expect(() =>
      compileNativeRuntimeQualification({
        ...missingLifecycle,
        cases: [
          {
            ...firstLifecycle,
            obligations: firstLifecycle.obligations.filter(
              (entry) => entry !== "runtime.restart-reconcile",
            ),
          },
          ...missingLifecycle.cases.slice(1),
        ],
      }),
    ).toThrow(/obligations is incomplete/u);

    const missingEvidence = nativeRuntimeQualificationDefinition("missing-evidence-runtime");
    const firstEvidence = missingEvidence.cases[0]!;
    expect(() =>
      compileNativeRuntimeQualification({
        ...missingEvidence,
        cases: [
          {
            ...firstEvidence,
            evidenceKinds: firstEvidence.evidenceKinds.filter(
              (entry) => entry !== "installer-result",
            ),
          },
          ...missingEvidence.cases.slice(1),
        ],
      }),
    ).toThrow(/evidence kinds is incomplete/u);
  });

  it("rejects Docker availability and Docker-socket substitutions", () => {
    const dockerPresent = nativeRuntimeQualificationDefinition("docker-present-runtime");
    const first = dockerPresent.cases[0]!;
    expect(() =>
      compileNativeRuntimeQualification({
        ...dockerPresent,
        cases: [
          { ...first, dockerAvailability: "available" },
          ...dockerPresent.cases.slice(1),
        ] as typeof dockerPresent.cases,
      }),
    ).toThrow(/must prove Docker is unavailable/u);

    const dockerSocket = nativeRuntimeQualificationDefinition("docker-socket-runtime");
    const firstSocket = dockerSocket.cases[0]!;
    expect(() =>
      compileNativeRuntimeQualification({
        ...dockerSocket,
        cases: [
          {
            ...firstSocket,
            profile: {
              ...firstSocket.profile,
              capabilities: [...firstSocket.profile.capabilities, "transport.docker-socket"],
            },
          },
          ...dockerSocket.cases.slice(1),
        ],
      }),
    ).toThrow(/must be socket-free/u);
  });

  it("accepts only a complete exact evidence set for the compiled candidate", () => {
    expect(() =>
      assertNativeRuntimeQualificationEvidence(
        PODMAN_NATIVE_ACTIVATION_QUALIFICATION,
        completeEvidence(),
      ),
    ).not.toThrow();

    expect(() =>
      assertNativeRuntimeQualificationEvidence(
        PODMAN_NATIVE_ACTIVATION_QUALIFICATION,
        completeEvidence().slice(1),
      ),
    ).toThrow(/evidence is incomplete/u);
  });

  it("rejects inexact source, image, operation, and CDI receipts", () => {
    const badSource = completeEvidence();
    badSource[0]!.protectedRun.headSha = "main";
    expect(() =>
      assertNativeRuntimeQualificationEvidence(PODMAN_NATIVE_ACTIVATION_QUALIFICATION, badSource),
    ).toThrow(/exact head\/base SHAs/u);

    const wrongWorkflow = completeEvidence();
    wrongWorkflow[0]!.protectedRun.workflow = "Unprotected runtime test";
    expect(() =>
      assertNativeRuntimeQualificationEvidence(
        PODMAN_NATIVE_ACTIVATION_QUALIFICATION,
        wrongWorkflow,
      ),
    ).toThrow(/wrong workflow/u);

    const wrongWorkflowSource = structuredClone(completeEvidence());
    wrongWorkflowSource[0]!.protectedRun.workflowSha = "main";
    expect(() =>
      assertNativeRuntimeQualificationEvidence(
        PODMAN_NATIVE_ACTIVATION_QUALIFICATION,
        wrongWorkflowSource,
      ),
    ).toThrow(/protected workflow SHA/u);

    const mixedSourcePair = completeEvidence();
    mixedSourcePair[0]!.protectedRun.headSha = "3".repeat(40);
    expect(() =>
      assertNativeRuntimeQualificationEvidence(
        PODMAN_NATIVE_ACTIVATION_QUALIFICATION,
        mixedSourcePair,
      ),
    ).toThrow(/one exact head\/base\/workflow source/u);

    const mixedWorkflowSource = structuredClone(completeEvidence());
    mixedWorkflowSource[0]!.protectedRun.workflowSha = "4".repeat(40);
    expect(() =>
      assertNativeRuntimeQualificationEvidence(
        PODMAN_NATIVE_ACTIVATION_QUALIFICATION,
        mixedWorkflowSource,
      ),
    ).toThrow(/one exact head\/base\/workflow source/u);

    const badImage = completeEvidence();
    badImage[0]!.runtime.managedImages = [
      { role: "agent", imageRef: "nvcr.io/nvidia/nemoclaw-agent:latest" },
      { role: "probe", imageRef: IMAGE_REFS.probe },
    ];
    expect(() =>
      assertNativeRuntimeQualificationEvidence(PODMAN_NATIVE_ACTIVATION_QUALIFICATION, badImage),
    ).toThrow(/exact image references/u);

    const badOperations = completeEvidence();
    badOperations[0]!.operations = badOperations[0]!.operations.slice(1);
    expect(() =>
      assertNativeRuntimeQualificationEvidence(
        PODMAN_NATIVE_ACTIVATION_QUALIFICATION,
        badOperations,
      ),
    ).toThrow(/operations is incomplete/u);

    const gpuEvidence = completeEvidence();
    const gpu = gpuEvidence.find((entry) => entry.runtime.acceleration === "nvidia-gpu")!;
    gpu.nvidiaCdi = undefined;
    expect(() =>
      assertNativeRuntimeQualificationEvidence(PODMAN_NATIVE_ACTIVATION_QUALIFICATION, gpuEvidence),
    ).toThrow(/must prove NVIDIA CDI access/u);
  });

  it("binds application, engine, endpoint, and managed-runtime identity", () => {
    const wrongApplication = completeEvidence();
    wrongApplication[0]!.runtime.application = "hermes";
    expect(() =>
      assertNativeRuntimeQualificationEvidence(
        PODMAN_NATIVE_ACTIVATION_QUALIFICATION,
        wrongApplication,
      ),
    ).toThrow(/invalid runtime identity/u);

    const wrongEngine = completeEvidence();
    wrongEngine[0]!.runtime.engineName = "docker";
    expect(() =>
      assertNativeRuntimeQualificationEvidence(PODMAN_NATIVE_ACTIVATION_QUALIFICATION, wrongEngine),
    ).toThrow(/wrong runtime engine/u);

    const missingAuthority = completeEvidence();
    missingAuthority[0]!.runtime.engineAuthority.authorityId = "";
    expect(() =>
      assertNativeRuntimeQualificationEvidence(
        PODMAN_NATIVE_ACTIVATION_QUALIFICATION,
        missingAuthority,
      ),
    ).toThrow(/exact non-empty runtime identifier/u);

    const wrongEndpoint = completeEvidence();
    wrongEndpoint[0]!.runtime.route.endpoint.gatewayProviderBaseUrl =
      "http://host.openshell.internal:9000/v1";
    expect(() =>
      assertNativeRuntimeQualificationEvidence(
        PODMAN_NATIVE_ACTIVATION_QUALIFICATION,
        wrongEndpoint,
      ),
    ).toThrow(/mismatched gateway endpoint/u);

    const missingManagedImage = completeEvidence();
    const managedImageCase = missingManagedImage.find(
      (entry) => entry.runtime.inference === "nim",
    )!;
    managedImageCase.runtime.managedImages = managedImageCase.runtime.managedImages.filter(
      (image) => image.role !== "inference",
    );
    expect(() =>
      assertNativeRuntimeQualificationEvidence(
        PODMAN_NATIVE_ACTIVATION_QUALIFICATION,
        missingManagedImage,
      ),
    ).toThrow(/managed image roles is incomplete/u);

    const missingRuntimeId = completeEvidence();
    const managedRuntimeCase = missingRuntimeId.find(
      (entry) => entry.runtime.inference === "vllm",
    )!;
    managedRuntimeCase.runtime.route.authority.runtimeId = null;
    expect(() =>
      assertNativeRuntimeQualificationEvidence(
        PODMAN_NATIVE_ACTIVATION_QUALIFICATION,
        missingRuntimeId,
      ),
    ).toThrow(/must name managed inference/u);
  });

  it("binds lifecycle, recovery, and exact cleanup to one durable authority", () => {
    const wrongOperation = completeEvidence();
    wrongOperation[0]!.operations[0]!.authoritySha256 = "e".repeat(64);
    expect(() =>
      assertNativeRuntimeQualificationEvidence(
        PODMAN_NATIVE_ACTIVATION_QUALIFICATION,
        wrongOperation,
      ),
    ).toThrow(/different runtime authority/u);

    const wrongRecovery = completeEvidence();
    wrongRecovery[0]!.recovery.authoritySha256 = "e".repeat(64);
    expect(() =>
      assertNativeRuntimeQualificationEvidence(
        PODMAN_NATIVE_ACTIVATION_QUALIFICATION,
        wrongRecovery,
      ),
    ).toThrow(/invalid recovery evidence/u);

    const wrongCleanup = completeEvidence();
    const managedCleanupCase = wrongCleanup.find((entry) => entry.runtime.inference === "nim")!;
    managedCleanupCase.cleanup.status = "retained-external";
    expect(() =>
      assertNativeRuntimeQualificationEvidence(
        PODMAN_NATIVE_ACTIVATION_QUALIFICATION,
        wrongCleanup,
      ),
    ).toThrow(/invalid exact cleanup evidence/u);

    const residualRuntime = completeEvidence();
    residualRuntime[0]!.cleanup.providerOwnedRuntimeIds = ["podman-stale-container"];
    expect(() =>
      assertNativeRuntimeQualificationEvidence(
        PODMAN_NATIVE_ACTIVATION_QUALIFICATION,
        residualRuntime,
      ),
    ).toThrow(/invalid exact cleanup evidence/u);
  });
});
