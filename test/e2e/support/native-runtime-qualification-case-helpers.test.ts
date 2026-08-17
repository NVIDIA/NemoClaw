// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildNativeRuntimeQualificationProducerPlan,
  type NativeRuntimeQualificationProducerPlanInput,
} from "../../../tools/e2e/native-runtime-qualification-producer-plan.mts";
import {
  assertCredentialFreeQualificationEnvironment,
  digestFromImageReference,
  nativeRuntimeQualificationAgentImage,
  nativeRuntimeQualificationInferenceImage,
  nativeRuntimeQualificationPodmanExecutable,
  nativeRuntimeQualificationRunnerContractPath,
  parseNativeRuntimeQualificationRow,
  parseNativeRuntimeQualificationRunnerContract,
} from "../live/native-runtime-qualification-case-helpers.ts";

const SOURCE = {
  repository: "NVIDIA/NemoClaw",
  producerWorkflow: ".github/workflows/e2e.yaml",
  pullRequestNumber: 9144,
  candidateRepository: "NVIDIA/NemoClaw",
  candidateSha: "a".repeat(40),
  baseRef: "main",
  baseSha: "b".repeat(40),
  workflowSha: "b".repeat(40),
  producerRunId: "123456",
  producerRunAttempt: 1,
  dispatchArtifact: {
    id: "987654",
    name: "e2e-dispatch-123456-1",
    digest: `sha256:${"c".repeat(64)}`,
    sizeInBytes: 4096,
  },
} as const;

function row() {
  const plan = buildNativeRuntimeQualificationProducerPlan({
    source: SOURCE,
    installerSha256: "d".repeat(64),
    arm64GpuRunner: "native-arm64-gpu",
  } satisfies NativeRuntimeQualificationProducerPlanInput);
  return plan.include.find((entry) => entry.id === "podman-hermes-linux-amd64-cpu-ollama")!;
}

function runnerContract() {
  return {
    schemaVersion: 1,
    kind: "nemoclaw-native-runtime-qualification-runner-v1",
    architecture: "amd64",
    gpuProbeImageRef: `nvcr.io/nvidia/cuda@sha256:${"3".repeat(64)}`,
    nim: {
      imageRef: `nvcr.io/nim/nvidia/model@sha256:${"1".repeat(64)}`,
      model: "nvidia/model",
      modelPath: "/var/tmp/nemoclaw-native-runtime-resources-123456-1-1002/model",
      modelRevision: "7ae557604adf67be50417f59c2c2f167def9a775",
    },
    vllm: {
      imageRef: `docker.io/vllm/vllm-openai@sha256:${"2".repeat(64)}`,
      model: "qualification",
      modelPath: "/var/tmp/nemoclaw-native-runtime-resources-123456-1-1002/model",
      modelRevision: "7ae557604adf67be50417f59c2c2f167def9a775",
    },
  } as const;
}

function expectInvalidPodmanExecutablesRejected(): void {
  for (const executable of [
    "/usr/local/bin/podman",
    "/nemoclaw-native-runtime-podman-123456-1-0",
    "/nemoclaw-native-runtime-podman-123456-1-1003",
    "/nemoclaw-native-runtime-podman-123456-1-1002/../podman",
  ]) {
    expect(() =>
      nativeRuntimeQualificationPodmanExecutable(
        { NEMOCLAW_NATIVE_RUNTIME_QUALIFICATION_PODMAN_EXECUTABLE: executable },
        1002,
      ),
    ).toThrow("Podman executable path is invalid");
  }
}

function expectCredentialEnvironmentNamesRejected(): void {
  for (const name of [
    "GITHUB_TOKEN",
    "NGC_API_KEY",
    "HF_TOKEN",
    "AWS_SECRET_ACCESS_KEY",
    "SSH_AUTH_SOCK",
    "DOCKER_CONFIG",
    "DOCKER_HOST",
    "CUSTOM_API_KEY",
  ]) {
    expect(() => assertCredentialFreeQualificationEnvironment({ [name]: "forbidden" })).toThrow(
      name,
    );
  }
}

function expectInvalidRunnerContractPathsRejected(): void {
  for (const file of [
    "/etc/nemoclaw/native-runtime-qualification-v1.json",
    "/run/nemoclaw-native-runtime-123456-1-1003/runner-contract.json",
    "/run/nemoclaw-native-runtime-123456-1-1002/../runner-contract.json",
  ]) {
    expect(() =>
      nativeRuntimeQualificationRunnerContractPath(
        { NEMOCLAW_NATIVE_RUNTIME_QUALIFICATION_RUNNER_CONTRACT: file },
        1002,
      ),
    ).toThrow("runner contract path is invalid");
  }
}

function expectPublicCaseImagesPinned(): void {
  for (const architecture of ["amd64", "arm64"] as const) {
    for (const agent of ["openclaw", "hermes", "langchain-deepagents-code"] as const) {
      expect(nativeRuntimeQualificationAgentImage(architecture, agent)).toMatch(
        /@sha256:[a-f0-9]{64}$/u,
      );
    }
    const ollama = nativeRuntimeQualificationInferenceImage({
      architecture,
      acceleration: "cpu",
      inference: "ollama",
    });
    expect(ollama).toMatchObject({ model: "qwen3:0.6b" });
    expect(digestFromImageReference(ollama.imageRef)).toMatch(/^sha256:[a-f0-9]{64}$/u);
  }
}

describe("native runtime qualification case boundaries", () => {
  it("accepts only an exact canonical trusted-plan row", () => {
    const expected = row();
    expect(parseNativeRuntimeQualificationRow(JSON.stringify(expected))).toEqual(expected);

    const forged = JSON.parse(JSON.stringify(expected)) as Record<string, unknown>;
    forged.rootModes = ["rootless", "rootful"];
    expect(() => parseNativeRuntimeQualificationRow(JSON.stringify(forged))).toThrow(
      "Root modes does not match",
    );
  });

  it("rejects candidate workflow authority in a forged row", () => {
    const candidateRow = JSON.parse(JSON.stringify(row())) as {
      source: { candidateSha: string; workflowSha: string };
    };
    candidateRow.source.workflowSha = candidateRow.source.candidateSha;

    expect(() => parseNativeRuntimeQualificationRow(JSON.stringify(candidateRow))).toThrow(
      "Native runtime qualification source identity is invalid",
    );
  });

  it("accepts only the run-owned rootless Podman executable path for the current uid", () => {
    const environment = {
      NEMOCLAW_NATIVE_RUNTIME_QUALIFICATION_PODMAN_EXECUTABLE:
        "/nemoclaw-native-runtime-podman-123456-1-1002",
    };
    expect(nativeRuntimeQualificationPodmanExecutable(environment, 1002)).toBe(
      environment.NEMOCLAW_NATIVE_RUNTIME_QUALIFICATION_PODMAN_EXECUTABLE,
    );
    expectInvalidPodmanExecutablesRejected();
  });

  it("rejects credential and alternate runtime authority environment names", () => {
    expect(() =>
      assertCredentialFreeQualificationEnvironment({
        HOME: "/tmp/home",
        PATH: "/usr/bin",
      }),
    ).not.toThrow();
    expectCredentialEnvironmentNamesRejected();
  });

  it("accepts only typed immutable GPU runner resources", () => {
    const parsed = parseNativeRuntimeQualificationRunnerContract(runnerContract(), "amd64");
    expect(parsed.nim.imageRef).toContain("@sha256:");
    expect(parsed.vllm.modelPath).toMatch(/^\/var\/tmp\/nemoclaw-native-runtime-resources-/u);

    expect(() =>
      parseNativeRuntimeQualificationRunnerContract(
        {
          ...runnerContract(),
          nim: { ...runnerContract().nim, command: ["bash", "-c", "id"] },
        },
        "amd64",
      ),
    ).toThrow("NIM runner contract fields are invalid");
    expect(() =>
      parseNativeRuntimeQualificationRunnerContract(
        {
          ...runnerContract(),
          vllm: { ...runnerContract().vllm, modelPath: "/tmp/model" },
        },
        "amd64",
      ),
    ).toThrow("vLLM runner contract is invalid");
  });

  it("accepts only the current uid's run-owned GPU contract path", () => {
    const environment = {
      NEMOCLAW_NATIVE_RUNTIME_QUALIFICATION_RUNNER_CONTRACT:
        "/run/nemoclaw-native-runtime-123456-1-1002/runner-contract.json",
    };
    expect(nativeRuntimeQualificationRunnerContractPath(environment, 1002)).toBe(
      environment.NEMOCLAW_NATIVE_RUNTIME_QUALIFICATION_RUNNER_CONTRACT,
    );
    expectInvalidRunnerContractPathsRejected();
  });

  it("pins every public case image to architecture-specific immutable digests", () => {
    expectPublicCaseImagesPinned();
  });

  it("requires the root-owned typed contract for NIM and vLLM", () => {
    expect(() =>
      nativeRuntimeQualificationInferenceImage({
        architecture: "amd64",
        acceleration: "nvidia-gpu",
        inference: "nim",
      }),
    ).toThrow("reviewed GPU runner contract");
    const contract = parseNativeRuntimeQualificationRunnerContract(runnerContract(), "amd64");
    expect(
      nativeRuntimeQualificationInferenceImage({
        architecture: "amd64",
        acceleration: "nvidia-gpu",
        inference: "vllm",
        runnerContract: contract,
      }),
    ).toMatchObject({ model: "qualification" });
  });
});
