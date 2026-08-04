// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

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
        gpu?: unknown;
        model?: unknown;
        platform?: unknown;
        probes?: unknown;
        profile?: unknown;
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

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const manifestPath = path.join(repoRoot, "managed-inference", "images", "llama-cpp", "image.yaml");

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

export function loadLlamaCppImageConfig(source = fs.readFileSync(manifestPath, "utf8")) {
  const manifest = YAML.parse(source) as ServerImageManifest;
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
    "gpu",
    "model",
    "platform",
    "probes",
    "profile",
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
  const qualificationModel = qualification?.model as
    | { digest?: unknown; hostPath?: unknown; id?: unknown }
    | undefined;
  const qualificationGpu = qualification?.gpu as
    | { cpuFallback?: unknown; fullOffload?: unknown; vendor?: unknown }
    | undefined;
  const qualificationHostPath = qualificationModel?.hostPath;
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
    qualification?.platform !== "linux/arm64" ||
    qualificationModel?.id !== "unsloth/Nemotron-3-Nano-30B-A3B-GGUF" ||
    qualificationModel?.digest !==
      "sha256:627f5b04aedc97f967332f331bd75b7a4ed2f33ca83e6ee74b44235cc1887890" ||
    !matchesExactRecord(qualification?.gpu, {
      cpuFallback: "reject",
      fullOffload: true,
      vendor: "nvidia",
    }) ||
    JSON.stringify(qualification?.probes) !== JSON.stringify(["health", "completion"])
  ) {
    throw new Error("invalid llama.cpp image publication contract");
  }
  if (publicationRepository !== spec?.repository) {
    throw new Error("publication repository must match the image repository");
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
  if (!publicationEnabled && !infrastructureUnset && !infrastructureComplete) {
    throw new Error("disabled publication must not bind partial infrastructure");
  }
  const normalizedQualification = {
    environment: qualificationEnvironment,
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
    probes: qualification?.probes,
    profile: qualification?.profile,
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const output = githubOutput(loadLlamaCppImageConfig());
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
