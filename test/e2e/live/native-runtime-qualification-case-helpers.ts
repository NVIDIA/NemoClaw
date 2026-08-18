// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
} from "node:fs";
import path from "node:path";

import {
  NATIVE_RUNTIME_QUALIFICATION_FOCUSED_CASE,
  NATIVE_RUNTIME_QUALIFICATION_FOCUSED_OPERATIONS,
  type NativeRuntimeQualificationProducerPlanRow,
} from "../../../tools/e2e/native-runtime-qualification-producer-plan.mts";
import {
  PODMAN_PROTECTED_HOST_LOCAL_INFERENCE_QUALIFICATION,
  type NativeRuntimeQualificationAcceleration,
  type NativeRuntimeQualificationAgent,
  type NativeRuntimeQualificationArchitecture,
  type NativeRuntimeQualificationInference,
} from "../registry/native-runtime-qualification.ts";

export const NATIVE_RUNTIME_QUALIFICATION_MODEL_REVISION =
  "7ae557604adf67be50417f59c2c2f167def9a775";

const SHA = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const OCI_DIGEST = /^(?:[A-Za-z0-9._-]+(?::[0-9]+)?\/)*(?:[A-Za-z0-9._-]+)@sha256:[a-f0-9]{64}$/u;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,511}$/u;
const ABSOLUTE_MODEL =
  /^\/var\/tmp\/nemoclaw-native-runtime-resources-[1-9][0-9]*-[1-9][0-9]*-[1-9][0-9]*\/model$/u;
const MODEL_FILES = Object.freeze([
  Object.freeze({
    path: "config.json",
    size: 659,
    algorithm: "sha1" as const,
    digest: "0dbb161213629a23f0fc00ef286e6b1e366d180f",
  }),
  Object.freeze({
    path: "generation_config.json",
    size: 242,
    algorithm: "sha1" as const,
    digest: "dfc11073787daf1b0f9c0f1499487ab5f4c93738",
  }),
  Object.freeze({
    path: "merges.txt",
    size: 1_671_839,
    algorithm: "sha1" as const,
    digest: "20024bfe7c83998e9aeaf98a0cd6a2ce6306c2f0",
  }),
  Object.freeze({
    path: "model.safetensors",
    size: 988_097_824,
    algorithm: "sha256" as const,
    digest: "fdf756fa7fcbe7404d5c60e26bff1a0c8b8aa1f72ced49e7dd0210fe288fb7fe",
  }),
  Object.freeze({
    path: "tokenizer.json",
    size: 7_031_645,
    algorithm: "sha1" as const,
    digest: "443909a61d429dff23010e5bddd28ff530edda00",
  }),
  Object.freeze({
    path: "tokenizer_config.json",
    size: 7_305,
    algorithm: "sha1" as const,
    digest: "07bfe0640cb5a0037f9322287fbfc682806cf672",
  }),
  Object.freeze({
    path: "vocab.json",
    size: 2_776_833,
    algorithm: "sha1" as const,
    digest: "4783fe10ac3adce15ac8f358ef5462739852c569",
  }),
]);
const SENSITIVE_ENVIRONMENT =
  /^(?:GH_TOKEN|GITHUB_TOKEN|NVIDIA_API_KEY|NVIDIA_INFERENCE_API_KEY|NGC_API_KEY|NIM_NGC_API_KEY|HF_TOKEN|HUGGING_FACE_HUB_TOKEN|SSH_AUTH_SOCK|DOCKER_CERT_PATH|DOCKER_CONFIG|DOCKER_CONTEXT|DOCKER_HOST|DOCKER_TLS_VERIFY|CONTAINER_HOST|AWS_.+|AZURE_.+|GOOGLE_.+|.*(?:_API_KEY|_ACCESS_TOKEN|_AUTH_TOKEN|_PASSWORD|_PRIVATE_KEY|_SECRET|_SECRET_KEY))$/u;

const AGENT_IMAGES = Object.freeze({
  amd64: Object.freeze({
    openclaw:
      "ghcr.io/nvidia/nemoclaw/openclaw-sandbox@sha256:2bca5955feb48f9b9170e51bbd5114c8ec481714b95a804d213957d4f5c3d069",
    hermes:
      "ghcr.io/nvidia/nemoclaw/hermes-sandbox@sha256:28b9578ab9676ef046de37fa6feb9b7b61824b87d77fd08978758bd01c03cb54",
    "langchain-deepagents-code":
      "ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox@sha256:f7ad7ddc95cea260cff02d26b873903805806ccfef5d27436cbec4eba3455eff",
  }),
  arm64: Object.freeze({
    openclaw:
      "ghcr.io/nvidia/nemoclaw/openclaw-sandbox@sha256:2f5bd4025b7cb61502d48f1fa02dd282d6d1156e7818c56e62ee675dc418c207",
    hermes:
      "ghcr.io/nvidia/nemoclaw/hermes-sandbox@sha256:119076205d8ac366a1e0309a4c6a3822d616151d0c657b53df1e308ba690d46b",
    "langchain-deepagents-code":
      "ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox@sha256:3ba92564fb17de4082745b9f32608188e28504cf421a8af7c5ef18e13680028e",
  }),
}) satisfies Readonly<
  Record<
    NativeRuntimeQualificationArchitecture,
    Readonly<Record<NativeRuntimeQualificationAgent, string>>
  >
>;

const OLLAMA_IMAGES = Object.freeze({
  amd64:
    "docker.io/ollama/ollama@sha256:268c47cdc4718ded54babcd842579a7295ad79fd8d5c2ea64d7ba2e76872de6b",
  arm64:
    "docker.io/ollama/ollama@sha256:bcf5adbfacc0e13a975f981810959d05b6ee95632da0f27e5343bc868ad2c82d",
}) satisfies Readonly<Record<NativeRuntimeQualificationArchitecture, string>>;

export interface NativeRuntimeQualificationRunnerContract {
  readonly schemaVersion: 1;
  readonly kind: "nemoclaw-native-runtime-qualification-runner-v1";
  readonly architecture: NativeRuntimeQualificationArchitecture;
  readonly gpuProbeImageRef: string;
  readonly nim: {
    readonly imageRef: string;
    readonly model: string;
    readonly modelPath: string;
    readonly modelRevision: string;
  };
  readonly vllm: {
    readonly imageRef: string;
    readonly model: string;
    readonly modelPath: string;
    readonly modelRevision: string;
  };
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as UnknownRecord;
}

function exactKeys(value: UnknownRecord, expected: readonly string[], label: string): void {
  if (Object.keys(value).sort().join("\n") !== [...expected].sort().join("\n")) {
    throw new Error(`${label} fields are invalid`);
  }
}

function exactJson(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} does not match the trusted qualification definition`);
  }
}

export function parseNativeRuntimeQualificationRow(
  serialized: string,
): NativeRuntimeQualificationProducerPlanRow {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    throw new Error("Native runtime qualification row is not valid JSON");
  }
  const row = record(parsed, "Native runtime qualification row");
  exactKeys(
    row,
    [
      "id",
      "jobName",
      "artifactName",
      "runner",
      "installerSha256",
      "source",
      "case",
      "rootModes",
      "focusedOperations",
    ],
    "Native runtime qualification row",
  );
  const qualificationCase = PODMAN_PROTECTED_HOST_LOCAL_INFERENCE_QUALIFICATION.cases.find(
    (entry) => entry.id === row.id,
  );
  if (!qualificationCase) throw new Error("Native runtime qualification case is not canonical");
  exactJson(row.case, qualificationCase, "Native runtime qualification case");
  const source = record(row.source, "Native runtime qualification source");
  exactKeys(
    source,
    [
      "repository",
      "producerWorkflow",
      "pullRequestNumber",
      "candidateRepository",
      "candidateSha",
      "baseRef",
      "baseSha",
      "workflowSha",
      "producerRunId",
      "producerRunAttempt",
      "dispatchArtifact",
    ],
    "Native runtime qualification source",
  );
  if (
    source.repository !== "NVIDIA/NemoClaw" ||
    source.producerWorkflow !== ".github/workflows/e2e.yaml" ||
    source.candidateRepository !== "NVIDIA/NemoClaw" ||
    source.baseRef !== "main" ||
    !Number.isSafeInteger(source.pullRequestNumber) ||
    Number(source.pullRequestNumber) < 1 ||
    typeof source.candidateSha !== "string" ||
    !SHA.test(source.candidateSha) ||
    typeof source.baseSha !== "string" ||
    !SHA.test(source.baseSha) ||
    source.candidateSha === source.baseSha ||
    source.workflowSha !== source.baseSha ||
    !/^[1-9][0-9]{0,19}$/u.test(String(source.producerRunId)) ||
    source.producerRunAttempt !== 1
  ) {
    throw new Error("Native runtime qualification source identity is invalid");
  }
  const artifact = record(source.dispatchArtifact, "Native runtime dispatch artifact");
  exactKeys(artifact, ["id", "name", "digest", "sizeInBytes"], "Native runtime dispatch artifact");
  if (
    !/^[1-9][0-9]{0,19}$/u.test(String(artifact.id)) ||
    artifact.name !== `e2e-dispatch-${String(source.producerRunId)}-1` ||
    typeof artifact.digest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(artifact.digest) ||
    !Number.isSafeInteger(artifact.sizeInBytes) ||
    Number(artifact.sizeInBytes) < 1 ||
    Number(artifact.sizeInBytes) > 1_048_576
  ) {
    throw new Error("Native runtime dispatch artifact identity is invalid");
  }
  const focused = row.id === NATIVE_RUNTIME_QUALIFICATION_FOCUSED_CASE;
  exactJson(row.rootModes, focused ? ["rootless", "rootful"] : ["rootless"], "Root modes");
  exactJson(
    row.focusedOperations,
    focused ? NATIVE_RUNTIME_QUALIFICATION_FOCUSED_OPERATIONS : [],
    "Focused operations",
  );
  if (
    row.jobName !== `Native runtime qualification / ${String(row.id)}` ||
    row.artifactName !==
      `native-runtime-qualification-evidence-${String(source.candidateSha)}-${String(row.id)}` ||
    typeof row.runner !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(row.runner) ||
    typeof row.installerSha256 !== "string" ||
    !SHA256.test(row.installerSha256)
  ) {
    throw new Error("Native runtime qualification plan metadata is invalid");
  }
  return parsed as NativeRuntimeQualificationProducerPlanRow;
}

export function assertCredentialFreeQualificationEnvironment(environment: NodeJS.ProcessEnv): void {
  const present = Object.keys(environment).filter((name) => SENSITIVE_ENVIRONMENT.test(name));
  if (present.length > 0) {
    throw new Error(
      `Native runtime qualification environment contains forbidden credential names: ${present.sort().join(", ")}`,
    );
  }
}

export function nativeRuntimeQualificationPodmanExecutable(
  environment: NodeJS.ProcessEnv,
  uid: number,
): string {
  const executable = environment.NEMOCLAW_NATIVE_RUNTIME_QUALIFICATION_PODMAN_EXECUTABLE ?? "";
  const expected = new RegExp(
    `^/nemoclaw-native-runtime-podman-[1-9][0-9]*-[1-9][0-9]*-${String(uid)}$`,
    "u",
  );
  if (!Number.isSafeInteger(uid) || uid <= 0 || !expected.test(executable)) {
    throw new Error("Native runtime qualification Podman executable path is invalid");
  }
  return executable;
}

function exactRunnerRuntime(
  value: unknown,
  label: "NIM" | "vLLM",
): {
  readonly imageRef: string;
  readonly model: string;
  readonly modelPath: string;
  readonly modelRevision: string;
} {
  const runtime = record(value, `${label} runner contract`);
  exactKeys(
    runtime,
    ["imageRef", "model", "modelPath", "modelRevision"],
    `${label} runner contract`,
  );
  if (
    typeof runtime.imageRef !== "string" ||
    !OCI_DIGEST.test(runtime.imageRef) ||
    typeof runtime.model !== "string" ||
    !MODEL.test(runtime.model) ||
    typeof runtime.modelPath !== "string" ||
    !ABSOLUTE_MODEL.test(runtime.modelPath) ||
    runtime.modelRevision !== NATIVE_RUNTIME_QUALIFICATION_MODEL_REVISION
  ) {
    throw new Error(`${label} runner contract is invalid`);
  }
  return Object.freeze({
    imageRef: runtime.imageRef,
    model: runtime.model,
    modelPath: runtime.modelPath,
    modelRevision: runtime.modelRevision,
  });
}

export function parseNativeRuntimeQualificationRunnerContract(
  value: unknown,
  architecture: NativeRuntimeQualificationArchitecture,
): NativeRuntimeQualificationRunnerContract {
  const contract = record(value, "Native runtime qualification runner contract");
  exactKeys(
    contract,
    ["schemaVersion", "kind", "architecture", "gpuProbeImageRef", "nim", "vllm"],
    "Native runtime qualification runner contract",
  );
  if (
    contract.schemaVersion !== 1 ||
    contract.kind !== "nemoclaw-native-runtime-qualification-runner-v1" ||
    contract.architecture !== architecture ||
    typeof contract.gpuProbeImageRef !== "string" ||
    !OCI_DIGEST.test(contract.gpuProbeImageRef)
  ) {
    throw new Error("Native runtime qualification runner contract identity is invalid");
  }
  const nim = exactRunnerRuntime(contract.nim, "NIM");
  const vllm = exactRunnerRuntime(contract.vllm, "vLLM");
  return Object.freeze({
    schemaVersion: 1,
    kind: "nemoclaw-native-runtime-qualification-runner-v1",
    architecture,
    gpuProbeImageRef: contract.gpuProbeImageRef,
    nim: Object.freeze({
      imageRef: nim.imageRef,
      model: nim.model,
      modelPath: nim.modelPath,
      modelRevision: nim.modelRevision,
    }),
    vllm: Object.freeze({
      imageRef: vllm.imageRef,
      model: vllm.model,
      modelPath: vllm.modelPath,
      modelRevision: vllm.modelRevision,
    }),
  });
}

export function readNativeRuntimeQualificationRunnerContract(
  architecture: NativeRuntimeQualificationArchitecture,
  file: string,
): NativeRuntimeQualificationRunnerContract {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.uid !== 0n ||
      before.gid !== 0n ||
      (before.mode & 0o777n) !== 0o444n ||
      before.size < 1n ||
      before.size > 65_536n
    ) {
      throw new Error("runner contract must be a bounded root-owned regular file");
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mode !== after.mode ||
      before.uid !== after.uid ||
      before.gid !== after.gid ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw new Error("runner contract changed during its stable read");
    }
    return parseNativeRuntimeQualificationRunnerContract(
      JSON.parse(bytes.toString("utf8")) as unknown,
      architecture,
    );
  } catch (error) {
    throw new Error(
      `Native runtime qualification runner contract is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function nativeRuntimeQualificationRunnerContractPath(
  environment: NodeJS.ProcessEnv,
  uid: number,
): string {
  const file = environment.NEMOCLAW_NATIVE_RUNTIME_QUALIFICATION_RUNNER_CONTRACT ?? "";
  const expected = new RegExp(
    `^/run/nemoclaw-native-runtime-[1-9][0-9]*-[1-9][0-9]*-${String(uid)}/runner-contract\\.json$`,
    "u",
  );
  if (!Number.isSafeInteger(uid) || uid <= 0 || !expected.test(file)) {
    throw new Error("Native runtime qualification runner contract path is invalid");
  }
  return file;
}

function stableModelFileDigest(file: string, expected: (typeof MODEL_FILES)[number]): string {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.uid !== 0n ||
      before.gid !== 0n ||
      (before.mode & 0o777n) !== 0o444n ||
      before.size !== BigInt(expected.size)
    ) {
      throw new Error(`model file metadata is invalid: ${expected.path}`);
    }
    const digest = createHash(expected.algorithm);
    if (expected.algorithm === "sha1") digest.update(`blob ${String(expected.size)}\0`);
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      digest.update(buffer.subarray(0, count));
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mode !== after.mode ||
      before.uid !== after.uid ||
      before.gid !== after.gid ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw new Error(`model file changed during its stable read: ${expected.path}`);
    }
    return digest.digest("hex");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertStableRootOwnedDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const metadata = fstatSync(descriptor);
    if (
      !metadata.isDirectory() ||
      metadata.uid !== 0 ||
      metadata.gid !== 0 ||
      (metadata.mode & 0o777) !== 0o555
    ) {
      throw new Error(`Runner model resource is not root-owned and read-only: ${directory}`);
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function assertNativeRuntimeQualificationModelResource(
  directory: string,
  uid: number,
  contractFile: string,
): void {
  const contractMatch = contractFile.match(
    /^\/run\/nemoclaw-native-runtime-([1-9][0-9]*)-([1-9][0-9]*)-([1-9][0-9]*)\/runner-contract\.json$/u,
  );
  const modelMatch = directory.match(
    /^\/var\/tmp\/nemoclaw-native-runtime-resources-([1-9][0-9]*)-([1-9][0-9]*)-([1-9][0-9]*)\/model$/u,
  );
  if (
    !contractMatch ||
    !modelMatch ||
    contractMatch.slice(1).join(":") !== modelMatch.slice(1).join(":") ||
    contractMatch[3] !== String(uid)
  ) {
    throw new Error("Runner model resource does not match the run-owned contract identity");
  }
  assertStableRootOwnedDirectory(path.dirname(directory));
  assertStableRootOwnedDirectory(directory);
  const actual = readdirSync(directory).sort();
  const expectedFiles = MODEL_FILES.map((entry) => entry.path).sort();
  if (actual.join("\n") !== expectedFiles.join("\n")) {
    throw new Error("Runner model resource file set is invalid");
  }
  for (const expected of MODEL_FILES) {
    if (stableModelFileDigest(path.join(directory, expected.path), expected) !== expected.digest) {
      throw new Error(`Runner model resource digest is invalid: ${expected.path}`);
    }
  }
}

export function nativeRuntimeQualificationAgentImage(
  architecture: NativeRuntimeQualificationArchitecture,
  agent: NativeRuntimeQualificationAgent,
): string {
  return AGENT_IMAGES[architecture][agent];
}

export function nativeRuntimeQualificationInferenceImage(input: {
  readonly architecture: NativeRuntimeQualificationArchitecture;
  readonly acceleration: NativeRuntimeQualificationAcceleration;
  readonly inference: NativeRuntimeQualificationInference;
  readonly runnerContract?: NativeRuntimeQualificationRunnerContract;
}): {
  readonly imageRef: string;
  readonly model: string;
  readonly modelPath?: string;
  readonly modelRevision?: string;
} {
  if (input.inference === "ollama") {
    return Object.freeze({
      imageRef: OLLAMA_IMAGES[input.architecture],
      model: "qwen3:0.6b",
    });
  }
  if (input.acceleration !== "nvidia-gpu" || !input.runnerContract) {
    throw new Error(`${input.inference} qualification requires the reviewed GPU runner contract`);
  }
  if (input.inference === "nim") {
    return Object.freeze({
      imageRef: input.runnerContract.nim.imageRef,
      model: input.runnerContract.nim.model,
      modelPath: input.runnerContract.nim.modelPath,
      modelRevision: input.runnerContract.nim.modelRevision,
    });
  }
  return Object.freeze({
    imageRef: input.runnerContract.vllm.imageRef,
    model: input.runnerContract.vllm.model,
    modelPath: input.runnerContract.vllm.modelPath,
    modelRevision: input.runnerContract.vllm.modelRevision,
  });
}

export function digestFromImageReference(reference: string): string {
  if (!OCI_DIGEST.test(reference)) throw new Error("Managed image reference is not immutable");
  return reference.slice(reference.lastIndexOf("@") + 1);
}
