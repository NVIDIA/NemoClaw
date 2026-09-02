// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { CURRENT_RUNTIME_PROVIDER_BUNDLES } from "../../../src/lib/onboard/runtime-provider/current";
import {
  nativeQualificationEvidence as qualificationEvidence,
  nativeQualificationExpectedSource as expectedProtectedSource,
  nativeQualificationReceiptReader,
  NATIVE_QUALIFICATION_HEAD_SHA,
} from "../../helpers/native-runtime-qualification-evidence";
import {
  compileNativeRuntimeQualification,
  consumeNativeRuntimeCandidateEvidence,
  consumeNativeRuntimeQualificationEvidence,
  nativeRuntimeQualificationDefinition,
  NATIVE_RUNTIME_QUALIFICATION_AGENTS,
  NATIVE_RUNTIME_QUALIFICATION_OBLIGATIONS,
  PODMAN_PROTECTED_HOST_LOCAL_INFERENCE_QUALIFICATION,
  type NativeRuntimeCandidateEvidence,
  type NativeRuntimeQualificationExpectedSource,
} from "../registry/native-runtime-qualification";

const SOURCE_REVISION = NATIVE_QUALIFICATION_HEAD_SHA;

function candidateEvidence(): NativeRuntimeCandidateEvidence {
  return {
    schemaVersion: 1,
    claim: "candidate-execution-prerequisites",
    candidateId: "podman-cpu-lifecycle",
    providerId: "podman",
    sourceRevision: SOURCE_REVISION,
    executionPath: "runtime-provider-bundle",
    architecture: "amd64",
    acceleration: "cpu",
    agents: [...NATIVE_RUNTIME_QUALIFICATION_AGENTS],
    socketFree: true,
    dockerUnavailable: {
      service: true,
      socket: true,
      daemon: true,
      invocationGuard: true,
    },
  };
}

describe("native runtime qualification contract", () => {
  it("compiles the complete all-agent, multiarch, CPU/GPU inference matrix", () => {
    const qualification = PODMAN_PROTECTED_HOST_LOCAL_INFERENCE_QUALIFICATION;

    expect(qualification.cases).toHaveLength(24);
    expect(new Set(qualification.cases.map((entry) => entry.agent))).toEqual(
      new Set(["openclaw", "hermes", "langchain-deepagents-code"]),
    );
    expect(new Set(qualification.cases.map((entry) => entry.architecture))).toEqual(
      new Set(["amd64", "arm64"]),
    );
    expect(new Set(qualification.cases.map((entry) => entry.acceleration))).toEqual(
      new Set(["cpu", "nvidia-gpu"]),
    );
    expect(new Set(qualification.cases.map((entry) => entry.inference))).toEqual(
      new Set(["ollama", "nim", "vllm"]),
    );
    qualification.cases.forEach((entry) => {
      expect(entry).toMatchObject({
        platform: "linux",
        rootMode: "rootless",
        gate: "protected-e2e",
        install: "release-installer",
        dockerAvailability: "unavailable",
        obligations: NATIVE_RUNTIME_QUALIFICATION_OBLIGATIONS,
      });
      expect(entry.capabilities).toContain("transport.socket-free");
      expect(entry.capabilities).not.toContain("transport.docker-socket");
      expect(entry.evidenceKinds.includes("nvidia-cdi")).toBe(entry.acceleration === "nvidia-gpu");
    });
  });

  it("preserves the provider-neutral socket-free seam without a Podman branch", () => {
    const mxc = compileNativeRuntimeQualification(
      nativeRuntimeQualificationDefinition("mxc-candidate"),
    );

    expect(mxc.cases).toHaveLength(24);
    expect(mxc.cases.every((entry) => entry.id.startsWith("mxc-candidate-"))).toBe(true);
    expect(mxc.cases.every((entry) => entry.capabilities.includes("transport.socket-free"))).toBe(
      true,
    );
  });

  it("rejects missing coverage and exact evidence obligations", () => {
    const missingCase = nativeRuntimeQualificationDefinition("missing-case");
    expect(() =>
      compileNativeRuntimeQualification({
        ...missingCase,
        cases: missingCase.cases.slice(1),
      }),
    ).toThrow("coverage is incomplete");

    const missingEvidence = nativeRuntimeQualificationDefinition("missing-evidence");
    const first = missingEvidence.cases[0]!;
    expect(() =>
      compileNativeRuntimeQualification({
        ...missingEvidence,
        cases: [
          {
            ...first,
            evidenceKinds: first.evidenceKinds.filter((value) => value !== "source-identity"),
          },
          ...missingEvidence.cases.slice(1),
        ],
      }),
    ).toThrow("evidence kinds is incomplete");
  });

  it("rejects incomplete candidate evidence before runtime construction", () => {
    const constructRuntime = vi.fn();
    const incomplete = {
      ...candidateEvidence(),
      dockerUnavailable: { ...candidateEvidence().dockerUnavailable, socket: false },
    } as unknown as NativeRuntimeCandidateEvidence;

    expect(() => {
      consumeNativeRuntimeCandidateEvidence(incomplete, SOURCE_REVISION);
      constructRuntime();
    }).toThrow("candidate evidence is incomplete");
    expect(constructRuntime).not.toHaveBeenCalled();
  });

  it.each([
    ["duplicate", [...NATIVE_RUNTIME_QUALIFICATION_AGENTS, "openclaw"]],
    ["unknown", [...NATIVE_RUNTIME_QUALIFICATION_AGENTS.slice(0, -1), "unknown-agent"]],
  ])("rejects %s candidate agents before runtime construction", (_label, agents) => {
    const constructRuntime = vi.fn();
    const evidence = {
      ...candidateEvidence(),
      agents,
    } as unknown as NativeRuntimeCandidateEvidence;

    expect(() => {
      consumeNativeRuntimeCandidateEvidence(evidence, SOURCE_REVISION);
      constructRuntime();
    }).toThrow("Native runtime candidate agents is incomplete");
    expect(constructRuntime).not.toHaveBeenCalled();
  });

  it.each([
    ["null evidence", null],
    ["an invalid agent list", { ...candidateEvidence(), agents: "openclaw" }],
    ["invalid Docker evidence", { ...candidateEvidence(), dockerUnavailable: null }],
  ])("rejects %s with the candidate-evidence contract error", (_label, evidence) => {
    expect(() => consumeNativeRuntimeCandidateEvidence(evidence, SOURCE_REVISION)).toThrow(
      "Native runtime candidate evidence is incomplete or does not match source",
    );
  });

  it("accepts candidate prerequisites only for the expected candidate commit and target-branch base SHA", () => {
    expect(consumeNativeRuntimeCandidateEvidence(candidateEvidence(), SOURCE_REVISION)).toEqual({
      schemaVersion: 1,
      candidateId: "podman-cpu-lifecycle",
      providerId: "podman",
      sourceRevision: SOURCE_REVISION,
      executionPath: "runtime-provider-bundle",
    });
    expect(() =>
      consumeNativeRuntimeCandidateEvidence(candidateEvidence(), "b".repeat(40)),
    ).toThrow("does not match source");
    expect(CURRENT_RUNTIME_PROVIDER_BUNDLES).toHaveProperty("podman");
  });

  it("consumes complete evidence only against externally resolved protected identities", () => {
    const authority = consumeNativeRuntimeQualificationEvidence(
      PODMAN_PROTECTED_HOST_LOCAL_INFERENCE_QUALIFICATION,
      qualificationEvidence(),
      expectedProtectedSource(),
      nativeQualificationReceiptReader,
    );

    expect(authority).toEqual({
      schemaVersion: 1,
      qualificationId: "podman-protected-host-local-inference",
      providerId: "podman",
      source: expectedProtectedSource(),
    });
    expect(Object.isFrozen(authority.source.artifact)).toBe(true);
    expect(CURRENT_RUNTIME_PROVIDER_BUNDLES).toHaveProperty("podman");
  });

  it.each([
    [
      "candidate commit",
      { headSha: "e".repeat(40), baseSha: "f".repeat(40) },
      "externally expected protected source",
    ],
    [
      "target-branch base SHA",
      { headSha: "f".repeat(40), baseSha: "e".repeat(40) },
      "externally expected protected source",
    ],
  ])("rejects an internally consistent but wrong %s evidence pair", (_label, source, error) => {
    expect(() =>
      consumeNativeRuntimeQualificationEvidence(
        PODMAN_PROTECTED_HOST_LOCAL_INFERENCE_QUALIFICATION,
        qualificationEvidence(source),
        expectedProtectedSource(),
        nativeQualificationReceiptReader,
      ),
    ).toThrow(error);
  });

  it("rejects missing immutable GitHub artifact identity", () => {
    const source = {
      ...expectedProtectedSource(),
      artifact: {
        ...expectedProtectedSource().artifact,
        digest: "",
      },
    } as NativeRuntimeQualificationExpectedSource;

    expect(() =>
      consumeNativeRuntimeQualificationEvidence(
        PODMAN_PROTECTED_HOST_LOCAL_INFERENCE_QUALIFICATION,
        qualificationEvidence(),
        source,
        nativeQualificationReceiptReader,
      ),
    ).toThrow("GitHub artifact identity is invalid");
  });
});
