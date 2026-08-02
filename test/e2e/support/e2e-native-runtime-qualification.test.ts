// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { compileNativeRuntimeQualification } from "../registry/activation-qualification.ts";
import { hasRegisteredRuntimeProfile } from "../registry/registry.ts";
import {
  nativeRuntimeQualificationDefinition,
  PODMAN_NATIVE_ACTIVATION_QUALIFICATION,
} from "./native-runtime-qualification-fixtures.ts";

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
    expect(
      qualification.cases
        .filter((entry) => entry.profile.acceleration === "nvidia-gpu")
        .every((entry) => entry.evidenceKinds.includes("nvidia-cdi")),
    ).toBe(true);
    expect(
      qualification.cases
        .filter((entry) => entry.profile.acceleration === "cpu")
        .every((entry) => !entry.evidenceKinds.includes("nvidia-cdi")),
    ).toBe(true);
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
      expect(entry.obligations).toEqual([
        "installer.install",
        "runtime.docker-unavailable",
        "agent.onboard",
        "agent.turn",
        "sandbox.stop-start",
        "sandbox.snapshot-restore",
        "sandbox.rebuild",
        "runtime.restart-reconcile",
        "cleanup.exact",
      ]);
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

    const providerWithAccelerationText = compileNativeRuntimeQualification(
      nativeRuntimeQualificationDefinition("nvidia-gpu-runtime"),
    );
    expect(
      providerWithAccelerationText.cases.every((entry) =>
        entry.id.startsWith("nvidia-gpu-runtime-"),
      ),
    ).toBe(true);
    expect(
      providerWithAccelerationText.cases.some((entry) => entry.id.includes("-amd64-gpu-ollama")),
    ).toBe(true);
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
});
