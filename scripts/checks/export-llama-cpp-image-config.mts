// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import YAML from "yaml";

import {
  LLAMA_CPP_DGX_SPARK_PROTOCOL_PROBES,
  llamaCppDgxSparkExecutionPlanSha256,
  parseLlamaCppDgxSparkExecutionPlan,
} from "./llama-cpp-dgx-spark-qualification-contract.mts";

type ServerImageManifest = {
  apiVersion?: unknown;
  kind?: unknown;
  metadata?: { id?: unknown };
  spec?: {
    build?: {
      backendDirectory?: unknown;
      cmake?: unknown;
      compiler?: unknown;
      packages?: unknown;
      target?: unknown;
    };
    cuda?: { developmentBase?: unknown; runtimeBase?: unknown };
    platforms?: Array<{
      cudaArchitectures?: unknown;
      platform?: unknown;
      runner?: unknown;
    }>;
    publication?: {
      allowedRef?: unknown;
      candidateTagTemplate?: unknown;
      enabled?: unknown;
      evidence?: {
        anonymousPull?: unknown;
        provenance?: unknown;
        receipt?: unknown;
        sbom?: unknown;
        signature?: unknown;
        vulnerability?: unknown;
      };
      platforms?: unknown;
      qualification?: {
        environment?: unknown;
        execution?: unknown;
        gpu?: unknown;
        model?: unknown;
        platform?: unknown;
        probeBounds?: unknown;
        probes?: unknown;
        profile?: unknown;
        recipeRef?: unknown;
        required?: unknown;
        runner?: unknown;
      };
      repository?: unknown;
      trigger?: unknown;
    };
    repository?: unknown;
    runtime?: {
      entrypoint?: unknown;
      forbiddenPaths?: unknown;
      gid?: unknown;
      packages?: unknown;
      port?: unknown;
      requiredPaths?: unknown;
      uid?: unknown;
      writablePaths?: unknown;
    };
    source?: {
      archiveSha256?: unknown;
      repository?: unknown;
      revision?: unknown;
    };
  };
};

type LlamaCppQualificationRecipe = {
  apiVersion: string;
  kind: string;
  metadata: { id: string };
  spec: {
    backend: string;
    providerId: string;
    server: {
      technology: string;
      source: { repository: string; revision: string };
    };
    model: {
      acquisition: { downloaderImage: string };
      id: string;
      revision: string;
      servedName: string;
      files: Array<{
        path: string;
        digest: string;
        sizeBytes: number;
        format: string;
        quantization: string;
        license: string;
      }>;
    };
    runtime: {
      image: string;
      imageDownloadSizeBytes: number;
      platforms: string[];
      containerRuntime: string;
      networkExposure: string;
      restartPolicy: string;
      hosts: number;
      cuda: { baseImage: string; minimumDriverVersion: string };
      gpu: { vendor: string; count: number; offload: string; cpuFallback: string };
      resources: { memoryBytes: number; writableStorageBytes: number; pidsLimit: number };
    };
    execution: { receiptRef: string; materializerRef: string; lifecycleRef: string };
    serve: {
      protocol: string;
      authentication: string;
      port: number;
      chatTemplate: string;
      contextSize: number;
      slots: number;
      idleSleepSeconds: number;
      batchSize: number;
      microBatchSize: number;
      flashAttention: string;
      kvCache: { key: string; value: string };
      speculativeDecoding: string;
      limits: {
        requestTimeoutSeconds: number;
      };
    };
    readiness: {
      contractRef: string;
      timeoutSeconds: number;
      expectedModel: string;
      probeImage: string;
      probes: { models: boolean; health: boolean; properties: boolean; metrics: boolean };
    };
    policy: { egress: string; modelSource: string; modelDownloads: string };
    surfaces: Record<string, string>;
    capabilities: Record<string, unknown>;
  };
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const manifestPath = path.join(repoRoot, "managed-inference", "images", "llama-cpp", "image.yaml");
const recipePath = path.join(
  repoRoot,
  "managed-inference",
  "recipes",
  "llama-cpp.nemotron-3-nano-30b-a3b.spark-single.v1.yaml",
);
const recipeSchemaPath = path.join(repoRoot, "managed-inference", "schemas", "recipe.schema.json");

const nvidiaCudaDigestReference = /^docker\.io\/nvidia\/cuda@sha256:[0-9a-f]{64}$/u;
const fullRevision = /^[0-9a-f]{40}$/u;
const sha256 = /^sha256:[0-9a-f]{64}$/u;
const protectedDgxSparkRunner =
  /^linux-arm64-gpu-dgx-spark-gb10-[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const protectedDgxSparkEnvironment = /^approve-dgx-spark-[a-z0-9](?:[a-z0-9-]{0,109}[a-z0-9])?$/u;
const absoluteModelPath = /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.gguf$/u;

function requiredString(value: unknown, name: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`invalid ${name}`);
  }
  return value;
}

function requiredRuntimeId(value: unknown, name: string): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 65535) {
    throw new Error(`invalid ${name}`);
  }
  return String(value);
}

function requiredBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`invalid ${name}`);
  }
  return value;
}

function requiredInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`invalid ${name}`);
  }
  return value;
}

function matchesExactRecord(value: unknown, expected: Record<string, unknown>): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.keys(value).length === Object.keys(expected).length &&
    Object.entries(expected).every(
      ([key, expectedValue]) => (value as Record<string, unknown>)[key] === expectedValue,
    )
  );
}

function assertExactKeys(value: unknown, name: string, expected: string[]): void {
  if (
    typeof value !== "object" ||
    value === null ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())
  ) {
    throw new Error(`invalid ${name} fields`);
  }
}

function parseQualificationRecipe(
  source: string,
  schemaSource: string,
): LlamaCppQualificationRecipe {
  const document = YAML.parseDocument(source, { strict: true, uniqueKeys: true });
  const issues = [...document.errors, ...document.warnings];
  if (issues.length > 0) {
    throw new Error(`invalid llama.cpp qualification recipe YAML: ${issues.join("; ")}`);
  }
  const value = document.toJS({ maxAliasCount: 0 }) as unknown;
  const schema = JSON.parse(schemaSource) as object;
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  if (!validate(value)) {
    const details = (validate.errors ?? [])
      .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
      .join("; ");
    throw new Error(`invalid llama.cpp qualification recipe: ${details}`);
  }
  return value as LlamaCppQualificationRecipe;
}

function parseImageManifest(source: string): ServerImageManifest {
  const document = YAML.parseDocument(source, { strict: true, uniqueKeys: true });
  const issues = [...document.errors, ...document.warnings];
  if (issues.length > 0) {
    throw new Error(`invalid llama.cpp image manifest YAML: ${issues.join("; ")}`);
  }
  return document.toJS({ maxAliasCount: 0 }) as ServerImageManifest;
}

export function loadLlamaCppImageConfig(
  source = fs.readFileSync(manifestPath, "utf8"),
  recipeSource = fs.readFileSync(recipePath, "utf8"),
  recipeSchemaSource = fs.readFileSync(recipeSchemaPath, "utf8"),
) {
  const manifest = parseImageManifest(source);
  const recipe = parseQualificationRecipe(recipeSource, recipeSchemaSource);
  assertExactKeys(manifest, "manifest", ["apiVersion", "kind", "metadata", "spec"]);
  assertExactKeys(manifest.metadata, "metadata", ["id"]);
  assertExactKeys(manifest.spec, "spec", [
    "build",
    "cuda",
    "platforms",
    "publication",
    "repository",
    "runtime",
    "source",
  ]);
  assertExactKeys(manifest.spec?.build, "build", [
    "backendDirectory",
    "cmake",
    "compiler",
    "packages",
    "target",
  ]);
  assertExactKeys(manifest.spec?.cuda, "cuda", ["developmentBase", "runtimeBase"]);
  assertExactKeys(manifest.spec?.runtime, "runtime", [
    "entrypoint",
    "forbiddenPaths",
    "gid",
    "packages",
    "port",
    "requiredPaths",
    "uid",
    "writablePaths",
  ]);
  assertExactKeys(manifest.spec?.source, "source", ["archiveSha256", "repository", "revision"]);
  assertExactKeys(manifest.spec?.publication, "publication", [
    "allowedRef",
    "candidateTagTemplate",
    "enabled",
    "evidence",
    "platforms",
    "qualification",
    "repository",
    "trigger",
  ]);
  assertExactKeys(manifest.spec?.publication?.evidence, "publication evidence", [
    "anonymousPull",
    "provenance",
    "receipt",
    "sbom",
    "signature",
    "vulnerability",
  ]);
  assertExactKeys(manifest.spec?.publication?.evidence?.anonymousPull, "anonymous pull", [
    "exactDigest",
  ]);
  assertExactKeys(manifest.spec?.publication?.evidence?.provenance, "provenance", [
    "predicateType",
  ]);
  assertExactKeys(manifest.spec?.publication?.evidence?.receipt, "publication receipt", [
    "retentionDays",
    "schemaVersion",
  ]);
  assertExactKeys(manifest.spec?.publication?.evidence?.sbom, "SBOM", ["format"]);
  assertExactKeys(manifest.spec?.publication?.evidence?.signature, "signature", [
    "certificateIdentity",
    "certificateOidcIssuer",
    "mode",
    "transparencyLog",
  ]);
  assertExactKeys(manifest.spec?.publication?.evidence?.vulnerability, "vulnerability", [
    "onlyFixed",
    "scanner",
    "severityCutoff",
  ]);
  assertExactKeys(manifest.spec?.publication?.qualification, "publication qualification", [
    "environment",
    "execution",
    "gpu",
    "model",
    "platform",
    "probeBounds",
    "probes",
    "profile",
    "recipeRef",
    "required",
    "runner",
  ]);
  assertExactKeys(manifest.spec?.publication?.qualification?.gpu, "qualification GPU", [
    "cpuFallback",
    "fullOffload",
    "vendor",
  ]);
  assertExactKeys(manifest.spec?.publication?.qualification?.model, "qualification model", [
    "digest",
    "hostPath",
    "id",
  ]);
  if (
    manifest?.apiVersion !== "nemoclaw.nvidia.com/managed-inference/v1" ||
    manifest?.kind !== "ServerImageBuild" ||
    manifest?.metadata?.id !== "llama-cpp-server.v1"
  ) {
    throw new Error("invalid llama.cpp server image manifest identity");
  }

  const spec = manifest.spec;
  const publication = spec?.publication;
  const evidence = publication?.evidence;
  const qualification = publication?.qualification;
  const publicationEnabled = requiredBoolean(publication?.enabled, "publication enablement");
  const publicationRepository = requiredString(
    publication?.repository,
    "publication repository",
    /^ghcr\.io\/nvidia\/nemoclaw\/llama-cpp-server$/u,
  );
  const publicationPlatforms = publication?.platforms;
  const qualificationRunner = qualification?.runner;
  const qualificationEnvironment = qualification?.environment;
  const qualificationExecution = requiredString(
    qualification?.execution,
    "qualification execution",
    /^(?:disabled|enabled)$/u,
  );
  const qualificationRecipeRef = requiredString(
    qualification?.recipeRef,
    "qualification recipe reference",
    /^llama-cpp\.nemotron-3-nano-30b-a3b\.spark-single\.v1$/u,
  );
  const qualificationModel = qualification?.model as
    | { digest?: unknown; hostPath?: unknown; id?: unknown }
    | undefined;
  const qualificationGpu = qualification?.gpu as
    | { cpuFallback?: unknown; fullOffload?: unknown; vendor?: unknown }
    | undefined;
  const qualificationHostPath = qualificationModel?.hostPath;
  const recipeModelFile = recipe.spec.model.files[0];
  const expectedSurfaces = {
    agentMode: "disabled",
    mcpProxy: "disabled",
    multimodalProjection: "disabled",
    router: "disabled",
    serverTools: "disabled",
    slotInspection: "disabled",
    ui: "disabled",
  };
  if (
    publication?.trigger !== "workflow_dispatch" ||
    publication?.allowedRef !== "refs/heads/main" ||
    publication?.candidateTagTemplate !== "llama-cpp-candidate-{runId}-{runAttempt}" ||
    JSON.stringify(publicationPlatforms) !== JSON.stringify(["linux/amd64", "linux/arm64"]) ||
    evidence?.sbom === undefined ||
    !matchesExactRecord(evidence.sbom, { format: "spdx-json" }) ||
    evidence?.provenance === undefined ||
    !matchesExactRecord(evidence.provenance, {
      predicateType: "https://slsa.dev/provenance/v1",
    }) ||
    evidence?.signature === undefined ||
    !matchesExactRecord(evidence.signature, {
      certificateIdentity:
        "https://github.com/NVIDIA/NemoClaw/.github/workflows/llama-cpp-image-attest.yaml@refs/heads/main",
      certificateOidcIssuer: "https://token.actions.githubusercontent.com",
      mode: "sigstore-keyless",
      transparencyLog: "required",
    }) ||
    evidence?.vulnerability === undefined ||
    !matchesExactRecord(evidence.vulnerability, {
      onlyFixed: true,
      scanner: "grype",
      severityCutoff: "high",
    }) ||
    evidence?.anonymousPull === undefined ||
    !matchesExactRecord(evidence.anonymousPull, { exactDigest: true }) ||
    evidence?.receipt === undefined ||
    !matchesExactRecord(evidence.receipt, {
      retentionDays: 90,
      schemaVersion: 1,
    }) ||
    qualification?.required !== true ||
    qualification?.profile !== "dgx-spark-gb10-single" ||
    qualificationRecipeRef !== recipe.metadata.id ||
    qualification?.platform !== "linux/arm64" ||
    qualificationModel?.id !== recipe.spec.model.id ||
    qualificationModel?.digest !== recipeModelFile?.digest ||
    !matchesExactRecord(qualification?.gpu, {
      cpuFallback: "reject",
      fullOffload: true,
      vendor: "nvidia",
    }) ||
    JSON.stringify(qualification?.probes) !== JSON.stringify(LLAMA_CPP_DGX_SPARK_PROTOCOL_PROBES)
  ) {
    throw new Error("invalid llama.cpp image publication contract");
  }
  if (publicationRepository !== spec?.repository) {
    throw new Error("publication repository must match the image repository");
  }
  if (
    recipe.apiVersion !== "nemoclaw.nvidia.com/managed-inference/v1" ||
    recipe.kind !== "ServingRecipe" ||
    recipe.spec.backend !== "install-llama-cpp" ||
    recipe.spec.providerId !== "llama-cpp-local" ||
    recipe.spec.server.technology !== "llama.cpp" ||
    recipe.spec.server.source.repository !== "ggml-org/llama.cpp" ||
    recipe.spec.server.source.revision !== spec?.source?.revision ||
    recipe.spec.model.files.length !== 1 ||
    recipeModelFile?.format !== "gguf" ||
    recipe.spec.runtime.containerRuntime !== "docker" ||
    recipe.spec.runtime.networkExposure !== "loopback" ||
    recipe.spec.runtime.hosts !== 1 ||
    !recipe.spec.runtime.platforms.includes("linux/arm64") ||
    recipe.spec.runtime.cuda.baseImage !== spec?.cuda?.runtimeBase ||
    !matchesExactRecord(recipe.spec.runtime.gpu, {
      count: 1,
      cpuFallback: "reject",
      offload: "full",
      vendor: "nvidia",
    }) ||
    !matchesExactRecord(recipe.spec.execution, {
      lifecycleRef: "llama-cpp.host-local.lifecycle/v1",
      materializerRef: "llama-cpp.host-local/v1",
      receiptRef: "llama-cpp.host-local.receipt/v1",
    }) ||
    recipe.spec.serve.protocol !== "openai-completions" ||
    recipe.spec.serve.authentication !== "bearer" ||
    recipe.spec.serve.port !== spec?.runtime?.port ||
    recipe.spec.serve.slots !== 1 ||
    recipe.spec.serve.idleSleepSeconds !== -1 ||
    recipe.spec.serve.flashAttention !== "enabled" ||
    recipe.spec.serve.speculativeDecoding !== "disabled" ||
    recipe.spec.serve.microBatchSize > recipe.spec.serve.batchSize ||
    recipe.spec.readiness.contractRef !== "llama-cpp.server-readiness/v1" ||
    recipe.spec.readiness.expectedModel !== recipe.spec.model.servedName ||
    !matchesExactRecord(recipe.spec.readiness.probes, {
      health: true,
      metrics: true,
      models: true,
      properties: true,
    }) ||
    !matchesExactRecord(recipe.spec.policy, {
      egress: "disabled",
      modelDownloads: "disabled",
      modelSource: "verified-local",
    }) ||
    !matchesExactRecord(recipe.spec.surfaces, expectedSurfaces)
  ) {
    throw new Error("invalid llama.cpp DGX Spark qualification recipe contract");
  }
  const infrastructureComplete =
    typeof qualificationRunner === "string" &&
    protectedDgxSparkRunner.test(qualificationRunner) &&
    typeof qualificationEnvironment === "string" &&
    protectedDgxSparkEnvironment.test(qualificationEnvironment) &&
    typeof qualificationHostPath === "string" &&
    absoluteModelPath.test(qualificationHostPath) &&
    !qualificationHostPath.split("/").includes("..") &&
    !qualificationHostPath.split("/").includes(".");
  const infrastructureUnset =
    qualificationRunner === null &&
    qualificationEnvironment === null &&
    qualificationHostPath === null;
  if (publicationEnabled && !infrastructureComplete) {
    throw new Error("publication qualification infrastructure is incomplete");
  }
  if (publicationEnabled && qualificationExecution !== "enabled") {
    throw new Error("publication requires enabled DGX Spark qualification execution");
  }
  if (qualificationExecution === "enabled" && !infrastructureComplete) {
    throw new Error("enabled DGX Spark qualification infrastructure is incomplete");
  }
  if (!publicationEnabled && !infrastructureUnset && !infrastructureComplete) {
    throw new Error("disabled publication must not bind partial infrastructure");
  }
  const normalizedQualification = {
    environment: qualificationEnvironment,
    execution: qualificationExecution,
    gpu: {
      cpuFallback: qualificationGpu?.cpuFallback,
      fullOffload: qualificationGpu?.fullOffload,
      vendor: qualificationGpu?.vendor,
    },
    model: {
      digest: qualificationModel?.digest,
      hostPath: qualificationHostPath,
      id: qualificationModel?.id,
    },
    platform: qualification?.platform,
    probeBounds: qualification?.probeBounds,
    probes: qualification?.probes,
    profile: qualification?.profile,
    recipeRef: qualificationRecipeRef,
    required: qualification?.required,
    runner: qualificationRunner,
  };
  const expectedCmake = {
    ggmlBackendDl: true,
    ggmlCpuAllVariants: true,
    ggmlCuda: true,
    ggmlCurl: true,
    ggmlNative: false,
    ggmlRpc: false,
    llamaBuildApp: false,
    llamaBuildExamples: false,
    llamaBuildServer: true,
    llamaBuildTests: false,
    llamaBuildTools: true,
    llamaBuildUi: false,
    llamaOpenSsl: true,
    llamaSubprocess: false,
    llamaUsePrebuiltUi: false,
  };
  const expectedBuildPackages = {
    "build-essential": "12.10ubuntu1",
    "ca-certificates": "20260601~24.04.1",
    cmake: "3.28.3-1build7",
    curl: "8.5.0-2ubuntu10.11",
    "g++-14": "14.2.0-4ubuntu2~24.04.1",
    "gcc-14": "14.2.0-4ubuntu2~24.04.1",
    "libcurl4-openssl-dev": "8.5.0-2ubuntu10.11",
    "libssl-dev": "3.0.13-0ubuntu3.12",
  };
  const expectedCompiler = {
    c: "gcc-14",
    cudaHostCxx: "g++-14",
    cxx: "g++-14",
  };
  const expectedRuntimePackages = {
    "ca-certificates": "20260601~24.04.1",
    libcurl4t64: "8.5.0-2ubuntu10.11",
    libgomp1: "14.2.0-4ubuntu2~24.04.1",
  };
  const expectedRequiredPaths = [
    "/opt/llama.cpp/lib/libggml-cuda.so",
    "/usr/local/bin/llama-server",
    "/usr/local/share/licenses/llama.cpp/AUTHORS",
    "/usr/local/share/licenses/llama.cpp/LICENSE",
  ];
  const expectedForbiddenPaths = [
    "/bin/bash",
    "/bin/dash",
    "/bin/rbash",
    "/bin/sh",
    "/opt/llama.cpp/ui",
    "/usr/bin/bash",
    "/usr/bin/dash",
    "/usr/bin/rbash",
    "/usr/bin/sh",
  ];
  const cmake = spec?.build?.cmake;
  if (
    spec?.source?.repository !== "https://github.com/ggml-org/llama.cpp" ||
    spec?.build?.target !== "llama-server" ||
    spec?.build?.backendDirectory !== "/opt/llama.cpp/lib" ||
    !matchesExactRecord(cmake, expectedCmake) ||
    !matchesExactRecord(spec?.build?.compiler, expectedCompiler) ||
    !matchesExactRecord(spec?.build?.packages, expectedBuildPackages) ||
    !matchesExactRecord(spec?.runtime?.packages, expectedRuntimePackages) ||
    spec?.runtime?.entrypoint !== "/usr/local/bin/llama-server" ||
    spec?.runtime?.port !== 8081 ||
    JSON.stringify(spec?.runtime?.requiredPaths) !== JSON.stringify(expectedRequiredPaths) ||
    JSON.stringify(spec?.runtime?.forbiddenPaths) !== JSON.stringify(expectedForbiddenPaths) ||
    JSON.stringify(spec?.runtime?.writablePaths) !== JSON.stringify(["/tmp"])
  ) {
    throw new Error("invalid llama.cpp server image build or runtime contract");
  }
  const platforms = Array.isArray(spec?.platforms) ? spec.platforms : [];
  if (platforms.length !== 2) {
    throw new Error("llama.cpp server image manifest must declare exactly two platforms");
  }

  const include = platforms.map((entry) => {
    assertExactKeys(entry, "platform", ["cudaArchitectures", "platform", "runner"]);
    const platform = requiredString(entry?.platform, "platform", /^linux\/(?:amd64|arm64)$/u);
    const expectedRunner = platform === "linux/amd64" ? "ubuntu-24.04" : "ubuntu-24.04-arm";
    if (entry?.runner !== expectedRunner) {
      throw new Error(`invalid native runner for ${platform}`);
    }
    const cudaArchitectures = requiredString(
      entry?.cudaArchitectures,
      `CUDA architectures for ${platform}`,
      /^[0-9]+[a-z]?(?:-real)?(?:;[0-9]+[a-z]?(?:-real)?)*$/u,
    );
    return {
      arch: platform.slice("linux/".length),
      cuda_architectures: cudaArchitectures,
      platform,
      runner: expectedRunner,
    };
  });
  if (new Set(include.map(({ platform }) => platform)).size !== 2) {
    throw new Error("llama.cpp server image platforms must be unique");
  }
  const arm64 = include.find(({ platform }) => platform === "linux/arm64");
  if (!arm64) {
    throw new Error("llama.cpp qualification requires one native linux/arm64 build");
  }
  const qualificationPlan = {
    contractVersion: 1,
    imageBuild: {
      backendDirectory: "/opt/llama.cpp/lib",
      compiler: expectedCompiler,
      cuda: {
        developmentBase: spec?.cuda?.developmentBase,
        runtimeBase: spec?.cuda?.runtimeBase,
      },
      platform: {
        cudaArchitectures: arm64.cuda_architectures,
        platform: arm64.platform,
      },
      repository: publicationRepository,
      runtime: {
        gid: spec?.runtime?.gid,
        port: spec?.runtime?.port,
        uid: spec?.runtime?.uid,
      },
      source: {
        archiveSha256: spec?.source?.archiveSha256,
        repository: spec?.source?.repository,
        revision: spec?.source?.revision,
      },
    },
    qualification: {
      probeBounds: qualification?.probeBounds,
      probes: qualification?.probes,
    },
    recipe: {
      capabilities: recipe.spec.capabilities,
      id: recipe.metadata.id,
      model: {
        acquisition: {
          downloaderImage: recipe.spec.model.acquisition.downloaderImage,
        },
        file: recipeModelFile,
        id: recipe.spec.model.id,
        revision: recipe.spec.model.revision,
        servedName: recipe.spec.model.servedName,
      },
      policy: recipe.spec.policy,
      readiness: recipe.spec.readiness,
      runtime: {
        cuda: recipe.spec.runtime.cuda,
        gpu: recipe.spec.runtime.gpu,
        resources: recipe.spec.runtime.resources,
        restartPolicy: recipe.spec.runtime.restartPolicy,
      },
      serve: recipe.spec.serve,
      server: recipe.spec.server,
      surfaces: recipe.spec.surfaces,
    },
  };
  const canonicalQualificationPlan = parseLlamaCppDgxSparkExecutionPlan(qualificationPlan);
  const qualificationPlanJson = JSON.stringify(canonicalQualificationPlan);
  const qualificationPlanSha256 = llamaCppDgxSparkExecutionPlanSha256(canonicalQualificationPlan);

  return {
    backend_directory: "/opt/llama.cpp/lib",
    compiler_c: expectedCompiler.c,
    compiler_cuda_host_cxx: expectedCompiler.cudaHostCxx,
    compiler_cxx: expectedCompiler.cxx,
    cuda_dev_image: requiredString(
      spec?.cuda?.developmentBase,
      "CUDA development base",
      nvidiaCudaDigestReference,
    ),
    cuda_runtime_image: requiredString(
      spec?.cuda?.runtimeBase,
      "CUDA runtime base",
      nvidiaCudaDigestReference,
    ),
    image: requiredString(
      spec?.repository,
      "image repository",
      /^ghcr\.io\/nvidia\/nemoclaw\/llama-cpp-server$/u,
    ),
    matrix: JSON.stringify({ include }),
    publication_allowed_ref: requiredString(
      publication.allowedRef,
      "publication allowed ref",
      /^refs\/heads\/main$/u,
    ),
    publication_candidate_tag_template: requiredString(
      publication.candidateTagTemplate,
      "publication candidate tag template",
      /^llama-cpp-candidate-\{runId\}-\{runAttempt\}$/u,
    ),
    publication_enabled: String(publicationEnabled),
    publication_platforms: JSON.stringify(publicationPlatforms),
    publication_repository: publicationRepository,
    publication_trigger: requiredString(
      publication.trigger,
      "publication trigger",
      /^workflow_dispatch$/u,
    ),
    publication_sbom_format: requiredString(
      (evidence?.sbom as { format?: unknown }).format,
      "publication SBOM format",
      /^spdx-json$/u,
    ),
    publication_provenance_predicate_type: requiredString(
      (evidence?.provenance as { predicateType?: unknown }).predicateType,
      "publication provenance predicate type",
      /^https:\/\/slsa\.dev\/provenance\/v1$/u,
    ),
    publication_signature_mode: requiredString(
      (evidence?.signature as { mode?: unknown }).mode,
      "publication signature mode",
      /^sigstore-keyless$/u,
    ),
    publication_signature_identity: requiredString(
      (evidence?.signature as { certificateIdentity?: unknown }).certificateIdentity,
      "publication signature identity",
      /^https:\/\/github\.com\/NVIDIA\/NemoClaw\/\.github\/workflows\/llama-cpp-image-attest\.yaml@refs\/heads\/main$/u,
    ),
    publication_signature_issuer: requiredString(
      (evidence?.signature as { certificateOidcIssuer?: unknown }).certificateOidcIssuer,
      "publication signature issuer",
      /^https:\/\/token\.actions\.githubusercontent\.com$/u,
    ),
    publication_signature_transparency_log: requiredString(
      (evidence?.signature as { transparencyLog?: unknown }).transparencyLog,
      "publication signature transparency log",
      /^required$/u,
    ),
    publication_vulnerability_scanner: requiredString(
      (evidence?.vulnerability as { scanner?: unknown }).scanner,
      "publication vulnerability scanner",
      /^grype$/u,
    ),
    publication_vulnerability_severity_cutoff: requiredString(
      (evidence?.vulnerability as { severityCutoff?: unknown }).severityCutoff,
      "publication vulnerability severity cutoff",
      /^high$/u,
    ),
    publication_vulnerability_only_fixed: String(
      requiredBoolean(
        (evidence?.vulnerability as { onlyFixed?: unknown }).onlyFixed,
        "publication vulnerability only-fixed policy",
      ),
    ),
    publication_anonymous_exact_digest_pull: String(
      requiredBoolean(
        (evidence?.anonymousPull as { exactDigest?: unknown }).exactDigest,
        "publication anonymous exact-digest pull",
      ),
    ),
    publication_receipt_schema_version: String(
      requiredInteger(
        (evidence?.receipt as { schemaVersion?: unknown }).schemaVersion,
        "publication receipt schema version",
        1,
        1,
      ),
    ),
    publication_receipt_retention_days: String(
      requiredInteger(
        (evidence?.receipt as { retentionDays?: unknown }).retentionDays,
        "publication receipt retention days",
        90,
        90,
      ),
    ),
    publication_qualification: JSON.stringify(normalizedQualification),
    publication_qualification_plan: qualificationPlanJson,
    publication_qualification_plan_sha256: qualificationPlanSha256,
    qualification_environment:
      typeof qualificationEnvironment === "string" ? qualificationEnvironment : "",
    qualification_execution: qualificationExecution,
    qualification_model_host_path:
      typeof qualificationHostPath === "string" ? qualificationHostPath : "",
    qualification_runner: typeof qualificationRunner === "string" ? qualificationRunner : "",
    runtime_gid: requiredRuntimeId(spec?.runtime?.gid, "runtime gid"),
    runtime_forbidden_paths: JSON.stringify(expectedForbiddenPaths),
    runtime_required_paths: JSON.stringify(expectedRequiredPaths),
    runtime_uid: requiredRuntimeId(spec?.runtime?.uid, "runtime uid"),
    source_archive_sha256: requiredString(
      spec?.source?.archiveSha256,
      "source archive SHA-256",
      sha256,
    ),
    source_revision: requiredString(spec?.source?.revision, "source revision", fullRevision),
  };
}

export function githubOutput(config: Record<string, string>): string {
  return `${Object.entries(config)
    .map(([name, value]) => `${name}=${value}`)
    .join("\n")}\n`;
}

function readBoundedRegularFile(root: string, relativePath: string): string {
  const file = path.resolve(root, relativePath);
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`invalid qualification source path: ${relativePath}`);
  }
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const status = fs.fstatSync(descriptor);
    if (!status.isFile() || status.size < 1 || status.size > 1024 * 1024) {
      throw new Error(`qualification source must be a bounded regular file: ${relativePath}`);
    }
    return fs.readFileSync(descriptor, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

export function loadLlamaCppImageConfigFromRoot(sourceRoot: string) {
  const root = fs.realpathSync(sourceRoot);
  return loadLlamaCppImageConfig(
    readBoundedRegularFile(root, "managed-inference/images/llama-cpp/image.yaml"),
    readBoundedRegularFile(
      root,
      "managed-inference/recipes/llama-cpp.nemotron-3-nano-30b-a3b.spark-single.v1.yaml",
    ),
    fs.readFileSync(recipeSchemaPath, "utf8"),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let sourceRoot = repoRoot;
  if (args.length > 0) {
    if (args.length !== 2 || args[0] !== "--source-root" || !args[1]) {
      throw new Error("usage: export-llama-cpp-image-config.mts [--source-root PATH]");
    }
    sourceRoot = args[1];
  }
  const output = githubOutput(loadLlamaCppImageConfigFromRoot(sourceRoot));
  const githubOutputPath = process.env.GITHUB_OUTPUT;
  if (githubOutputPath) {
    fs.appendFileSync(githubOutputPath, output, {
      encoding: "utf8",
      mode: 0o600,
    });
  } else {
    process.stdout.write(output);
  }
}
