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
const IMAGE_DIGEST = `sha256:${"b".repeat(64)}`;

function artifact(label: string) {
  return { path: `qualification/${label}.json`, sha256: ARTIFACT_SHA };
}

function completeEvidence(): NativeRuntimeQualificationEvidence[] {
  return PODMAN_NATIVE_ACTIVATION_QUALIFICATION.cases.map((qualificationCase, index) => ({
    schemaVersion: 1,
    caseId: qualificationCase.id,
    protectedRun: {
      repository: "NVIDIA/NemoClaw",
      workflow: "E2E / PR Gate",
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
      inference: qualificationCase.inference,
      architecture: qualificationCase.profile.architecture,
      acceleration: qualificationCase.profile.acceleration,
      rootMode: "rootless",
      engineName: "podman",
      engineVersion: "5.6.2",
      managedImages: [{ role: "agent", digest: IMAGE_DIGEST }],
      result: artifact(`${qualificationCase.id}-result`),
    },
    operations: qualificationCase.obligations.map((id) => ({
      id,
      artifact: artifact(`${qualificationCase.id}-${id}`),
    })),
    ...(qualificationCase.profile.acceleration === "nvidia-gpu"
      ? {
          nvidiaCdi: {
            device: "nvidia.com/gpu=all" as const,
            artifact: artifact(`${qualificationCase.id}-nvidia-cdi`),
          },
        }
      : {}),
  }));
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

    const mixedSourcePair = completeEvidence();
    mixedSourcePair[0]!.protectedRun.headSha = "3".repeat(40);
    expect(() =>
      assertNativeRuntimeQualificationEvidence(
        PODMAN_NATIVE_ACTIVATION_QUALIFICATION,
        mixedSourcePair,
      ),
    ).toThrow(/one exact head\/base pair/u);

    const badImage = completeEvidence();
    badImage[0]!.runtime.managedImages = [{ role: "agent", digest: "latest" }];
    expect(() =>
      assertNativeRuntimeQualificationEvidence(PODMAN_NATIVE_ACTIVATION_QUALIFICATION, badImage),
    ).toThrow(/exact image digests/u);

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
});
