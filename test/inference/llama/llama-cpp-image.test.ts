// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { loadLlamaCppImageConfig } from "../../../scripts/checks/export-llama-cpp-image-config.mts";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const imageRoot = path.join(repoRoot, "managed-inference", "images", "llama-cpp");
const manifestPath = path.join(imageRoot, "image.yaml");
const dockerfilePath = path.join(imageRoot, "Dockerfile");
const recipePath = path.join(
  repoRoot,
  "managed-inference",
  "recipes",
  "llama-cpp.nemotron-3-nano-30b-a3b.spark-single.v1.yaml",
);
const agentQualificationPath = path.join(
  repoRoot,
  "managed-inference",
  "qualifications",
  "llama-cpp.openclaw.spark-single.v1.yaml",
);
const exporterPath = path.join(repoRoot, "scripts", "checks", "export-llama-cpp-image-config.mts");

type ImageManifest = {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    annotations?: { "nemoclaw.nvidia.com/request-guard-state"?: string };
    id?: string;
  };
  spec?: {
    build?: {
      backendDirectory?: string;
      cmake?: Record<string, boolean>;
      compiler?: { c?: string; cudaHostCxx?: string; cxx?: string };
      packages?: Record<string, string>;
      requestGuardToolchain?: {
        archives?: { amd64?: string; arm64?: string };
        version?: string;
      };
      target?: string;
    };
    cuda?: { developmentBase?: string; runtimeBase?: string };
    platforms?: Array<{
      cudaArchitectures?: string;
      platform?: string;
      runner?: string;
    }>;
    publication?: {
      allowedRef?: string;
      candidateTagTemplate?: string;
      enabled?: boolean;
      evidence?: {
        anonymousPull?: { exactDigest?: boolean };
        provenance?: { predicateType?: string };
        receipt?: { retentionDays?: number; schemaVersion?: number };
        sbom?: { format?: string };
        signature?: {
          certificateIdentity?: string;
          certificateOidcIssuer?: string;
          mode?: string;
          transparencyLog?: string;
        };
        vulnerability?: {
          onlyFixed?: boolean;
          scanner?: string;
          severityCutoff?: string;
        };
      };
      platforms?: string[];
      qualification?: {
        environment?: string | null;
        execution?: string;
        gpu?: { cpuFallback?: string; fullOffload?: boolean; vendor?: string };
        model?: { digest?: string; hostPath?: string | null; id?: string };
        platform?: string;
        probeBounds?: Record<string, unknown>;
        probes?: string[];
        profile?: string;
        recipeRef?: string;
        required?: boolean;
        runner?: string | null;
      };
      repository?: string;
      trigger?: string;
    };
    repository?: string;
    runtime?: {
      entrypoint?: string;
      forbiddenPaths?: string[];
      gid?: number;
      packages?: Record<string, string>;
      port?: number;
      requiredPaths?: string[];
      uid?: number;
      writablePaths?: string[];
    };
    source?: { archiveSha256?: string; repository?: string; revision?: string };
  };
};

type ServingRecipe = {
  spec?: {
    runtime?: { cuda?: { baseImage?: string } };
    server?: { source?: { repository?: string; revision?: string } };
    serve?: { port?: number };
  };
};

function parseOutput(value: string): Record<string, string> {
  return Object.fromEntries(
    value
      .trim()
      .split("\n")
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)] as [string, string];
      }),
  );
}

function configureQualification(
  source: string,
  options: { execution: "disabled" | "enabled"; publicationEnabled: boolean },
): string {
  const candidate = YAML.parse(source) as ImageManifest;
  const publication = candidate.spec!.publication!;
  const qualification = publication.qualification!;
  const model = qualification.model!;

  publication.enabled = options.publicationEnabled;
  qualification.execution = options.execution;
  qualification.runner =
    options.execution === "enabled" ? "linux-arm64-gpu-dgx-spark-gb10-protected-1" : null;
  qualification.environment =
    options.execution === "enabled" ? "approve-dgx-spark-image-qualification" : null;
  model.hostPath =
    options.execution === "enabled"
      ? "/var/lib/nemoclaw/models/Nemotron-3-Nano-30B-A3B-UD-Q4_K_XL.gguf"
      : null;
  return YAML.stringify(candidate);
}

function enablePublication(source: string): string {
  return configureQualification(source, {
    execution: "enabled",
    publicationEnabled: true,
  });
}

function addUnexpectedPublicationField(source: string): string {
  const candidate = YAML.parse(source) as ImageManifest;
  const publication = candidate.spec!.publication! as Record<string, unknown>;
  publication.consumerAlias = "latest";
  return YAML.stringify(candidate);
}

function configureManifestAnnotations(source: string, annotations: Record<string, string>): string {
  const candidate = YAML.parse(source) as { metadata: { annotations?: Record<string, string> } };
  candidate.metadata.annotations = annotations;
  return YAML.stringify(candidate);
}

function removeManifestAnnotations(source: string): string {
  const candidate = YAML.parse(source) as { metadata: { annotations?: Record<string, string> } };
  delete candidate.metadata.annotations;
  return YAML.stringify(candidate);
}

describe("declarative llama.cpp server image", () => {
  const manifestSource = fs.readFileSync(manifestPath, "utf8");
  const manifest = YAML.parse(manifestSource) as ImageManifest;
  const recipe = YAML.parse(fs.readFileSync(recipePath, "utf8")) as ServingRecipe;
  const dockerfile = fs.readFileSync(dockerfilePath, "utf8");

  it("binds the llama.cpp image build to the DGX Spark serving recipe (#8231)", () => {
    expect(manifest).toMatchObject({
      apiVersion: "nemoclaw.nvidia.com/managed-inference/v1",
      kind: "ServerImageBuild",
      metadata: {
        id: "llama-cpp-server.v1",
        annotations: {
          "nemoclaw.nvidia.com/request-guard-state": "dormant",
        },
      },
      spec: {
        repository: "ghcr.io/nvidia/nemoclaw/llama-cpp-server",
        build: { backendDirectory: "/opt/llama.cpp/lib" },
        runtime: {
          entrypoint: "/usr/local/bin/llama-server",
          forbiddenPaths: expect.arrayContaining(["/bin/sh", "/usr/bin/sh"]),
          port: 8081,
          requiredPaths: expect.arrayContaining([
            "/opt/llama.cpp/lib/libggml-cuda.so",
            "/usr/local/bin/llama-server",
            "/usr/local/bin/nemoclaw-llama-cpp-request-guard",
            "/usr/local/share/licenses/go/LICENSE",
            "/usr/local/share/licenses/llama.cpp/LICENSE",
          ]),
          writablePaths: ["/tmp"],
        },
        source: { repository: "https://github.com/ggml-org/llama.cpp" },
      },
    });
    expect(manifest.spec?.source?.revision).toBe(recipe.spec?.server?.source?.revision);
    expect(manifest.spec?.cuda?.runtimeBase).toBe(recipe.spec?.runtime?.cuda?.baseImage);
    expect(manifest.spec?.runtime?.port).toBe(recipe.spec?.serve?.port);
    expect(manifest.spec?.source?.archiveSha256).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(manifest.spec?.cuda?.developmentBase).toMatch(
      /^docker\.io\/nvidia\/cuda@sha256:[0-9a-f]{64}$/u,
    );
    expect(manifest.spec?.runtime?.uid).toBeGreaterThan(0);
    expect(manifest.spec?.runtime?.gid).toBeGreaterThan(0);
    expect(manifest.spec?.build?.requestGuardToolchain).toEqual({
      archives: {
        amd64: "sha256:708effb774be8237570d0add163225abbdfaf4fca28b2611df167beba4feef89",
        arm64: "sha256:d0507e9e9d7fe012aae570108cbd76c15de879e17130ab8cb90d4d7445cb1f2e",
      },
      version: "1.26.6",
    });
  });

  it("declares native amd64 and DGX Spark arm64 compilation explicitly (#8231)", () => {
    expect(manifest.spec?.platforms).toEqual([
      {
        cudaArchitectures: "89-real;100-real;120-real",
        platform: "linux/amd64",
        runner: "ubuntu-24.04",
      },
      {
        cudaArchitectures: "121a-real",
        platform: "linux/arm64",
        runner: "ubuntu-24.04-arm",
      },
    ]);
  });

  it("compiles the repository-declared publication and qualification state (#8260)", () => {
    const output = loadLlamaCppImageConfig(manifestSource);
    const qualification = JSON.parse(output.publication_qualification) as NonNullable<
      NonNullable<ImageManifest["spec"]>["publication"]
    >["qualification"];

    expect(output).toMatchObject({
      publication_allowed_ref: "refs/heads/main",
      publication_candidate_tag_template: "llama-cpp-candidate-{runId}-{runAttempt}",
      publication_enabled: String(manifest.spec?.publication?.enabled),
      publication_platforms: '["linux/amd64","linux/arm64"]',
      publication_repository: "ghcr.io/nvidia/nemoclaw/llama-cpp-server",
      publication_trigger: "workflow_dispatch",
    });
    expect(qualification).toEqual(manifest.spec?.publication?.qualification);
    expect(qualification).toMatchObject({
      recipeRef: "llama-cpp.nemotron-3-nano-30b-a3b.spark-single.v1",
      required: true,
    });
    expect(JSON.parse(output.publication_qualification_plan)).toMatchObject({
      contractVersion: 1,
      imageBuild: {
        platform: { cudaArchitectures: "121a-real", platform: "linux/arm64" },
        source: { revision: manifest.spec?.source?.revision },
      },
      qualification: {
        agentQualification: {
          execution: "enabled",
          image: {
            reference:
              "ghcr.io/nvidia/nemoclaw/openclaw-sandbox@sha256:3648441718cdd6c2bc4c8fe39fa0d04d3931656b2063af34215cc51841cd0d5e",
            sourceRevision: "eb1d2f5700393892f227ac9fd56f485fc6718bce",
          },
          probes: [
            "synchronous-chat",
            "streaming-chat",
            "agent-normal-turn",
            "agent-tool-call",
            "agent-tool-result-continuation",
            "agent-multi-turn",
          ],
        },
        requestGuard: "required",
      },
      recipe: {
        id: "llama-cpp.nemotron-3-nano-30b-a3b.spark-single.v1",
        model: {
          id: "unsloth/Nemotron-3-Nano-30B-A3B-GGUF",
          servedName: "nvidia-nemotron-3-nano-30b-a3b",
        },
        runtime: { gpu: { count: 1, cpuFallback: "reject", offload: "full" } },
      },
    });
    expect(output.publication_qualification_plan_sha256).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(output.qualification_execution).toBe(qualification?.execution);
  });

  it("compiles the fail-closed workflow inputs from YAML (#8231)", () => {
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", exporterPath],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, GITHUB_OUTPUT: "" },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const output = parseOutput(result.stdout);
    expect(output).toMatchObject({
      backend_directory: manifest.spec?.build?.backendDirectory,
      compiler_c: manifest.spec?.build?.compiler?.c,
      compiler_cuda_host_cxx: manifest.spec?.build?.compiler?.cudaHostCxx,
      compiler_cxx: manifest.spec?.build?.compiler?.cxx,
      cuda_dev_image: manifest.spec?.cuda?.developmentBase,
      cuda_runtime_image: manifest.spec?.cuda?.runtimeBase,
      image: manifest.spec?.repository,
      publication_allowed_ref: manifest.spec?.publication?.allowedRef,
      publication_anonymous_exact_digest_pull: String(
        manifest.spec?.publication?.evidence?.anonymousPull?.exactDigest,
      ),
      publication_candidate_tag_template: manifest.spec?.publication?.candidateTagTemplate,
      publication_enabled: String(manifest.spec?.publication?.enabled),
      publication_platforms: JSON.stringify(manifest.spec?.publication?.platforms),
      publication_provenance_predicate_type:
        manifest.spec?.publication?.evidence?.provenance?.predicateType,
      publication_receipt_retention_days: String(
        manifest.spec?.publication?.evidence?.receipt?.retentionDays,
      ),
      publication_receipt_schema_version: String(
        manifest.spec?.publication?.evidence?.receipt?.schemaVersion,
      ),
      publication_repository: manifest.spec?.publication?.repository,
      publication_sbom_format: manifest.spec?.publication?.evidence?.sbom?.format,
      publication_signature_identity:
        manifest.spec?.publication?.evidence?.signature?.certificateIdentity,
      publication_signature_issuer:
        manifest.spec?.publication?.evidence?.signature?.certificateOidcIssuer,
      publication_signature_mode: manifest.spec?.publication?.evidence?.signature?.mode,
      publication_signature_transparency_log:
        manifest.spec?.publication?.evidence?.signature?.transparencyLog,
      publication_trigger: manifest.spec?.publication?.trigger,
      publication_vulnerability_only_fixed: String(
        manifest.spec?.publication?.evidence?.vulnerability?.onlyFixed,
      ),
      publication_vulnerability_scanner:
        manifest.spec?.publication?.evidence?.vulnerability?.scanner,
      publication_vulnerability_severity_cutoff:
        manifest.spec?.publication?.evidence?.vulnerability?.severityCutoff,
      request_guard_go_version: manifest.spec?.build?.requestGuardToolchain?.version,
      runtime_forbidden_paths: JSON.stringify(manifest.spec?.runtime?.forbiddenPaths),
      runtime_gid: String(manifest.spec?.runtime?.gid),
      runtime_required_paths: JSON.stringify(manifest.spec?.runtime?.requiredPaths),
      runtime_uid: String(manifest.spec?.runtime?.uid),
      source_archive_sha256: manifest.spec?.source?.archiveSha256,
      source_revision: manifest.spec?.source?.revision,
    });
    expect(JSON.parse(output.matrix ?? "null")).toEqual({
      include: manifest.spec?.platforms?.map(({ cudaArchitectures, platform, runner }) => {
        const arch = platform?.slice("linux/".length) as "amd64" | "arm64";
        return {
          arch,
          cuda_architectures: cudaArchitectures,
          platform,
          request_guard_go_archive_sha256:
            manifest.spec?.build?.requestGuardToolchain?.archives?.[arch],
          runner,
        };
      }),
    });
    expect(JSON.parse(output.publication_qualification ?? "null")).toEqual(
      manifest.spec?.publication?.qualification,
    );
  });

  it.each([
    [
      "a non-NVIDIA base image",
      manifestSource.replace("docker.io/nvidia/cuda@", "docker.io/example/cuda@"),
    ],
    [
      "a runner that does not match the platform",
      manifestSource.replace("runner: ubuntu-24.04", "runner: ubuntu-latest"),
    ],
    [
      "a malformed base image digest",
      manifestSource.replace(
        "sha256:ef2203909e80b8b976cfc672f7e2ae2b00bc0e25c404ee86d89e10a3802f1c52",
        "sha256:invalid",
      ),
    ],
    [
      "an unreviewed request guard Go version",
      manifestSource.replace("version: 1.26.6", "version: 1.26.5"),
    ],
    [
      "a substituted request guard Go archive",
      manifestSource.replace(
        "sha256:708effb774be8237570d0add163225abbdfaf4fca28b2611df167beba4feef89",
        `sha256:${"0".repeat(64)}`,
      ),
    ],
    [
      "a duplicate platform",
      manifestSource
        .replace("platform: linux/arm64", "platform: linux/amd64")
        .replace("runner: ubuntu-24.04-arm", "runner: ubuntu-24.04"),
    ],
    [
      "an unexpected fixed CMake field",
      manifestSource.replace(
        "      ggmlBackendDl: true",
        "      ggmlBackendDl: true\n      ggmlWidgets: true",
      ),
    ],
    [
      "an unexpected top-level field",
      manifestSource.replace("kind: ServerImageBuild", "kind: ServerImageBuild\nunexpected: true"),
    ],
    ["a missing request guard state annotation", removeManifestAnnotations(manifestSource)],
    [
      "a non-dormant request guard state annotation",
      configureManifestAnnotations(manifestSource, {
        "nemoclaw.nvidia.com/request-guard-state": "active",
      }),
    ],
    [
      "an unexpected image annotation",
      configureManifestAnnotations(manifestSource, {
        "nemoclaw.nvidia.com/request-guard-state": "dormant",
        "nemoclaw.nvidia.com/unexpected": "true",
      }),
    ],
  ])("rejects %s before exporting image build inputs (#8231)", (_case, candidate) => {
    expect(() => loadLlamaCppImageConfig(candidate)).toThrow();
  });

  it("accepts publication enablement only when all protected DGX Spark inputs are bound (#8250)", () => {
    const output = loadLlamaCppImageConfig(enablePublication(manifestSource));

    expect(output.publication_enabled).toBe("true");
    expect(JSON.parse(output.publication_qualification)).toMatchObject({
      environment: "approve-dgx-spark-image-qualification",
      execution: "enabled",
      model: {
        hostPath: "/var/lib/nemoclaw/models/Nemotron-3-Nano-30B-A3B-UD-Q4_K_XL.gguf",
      },
      runner: "linux-arm64-gpu-dgx-spark-gb10-protected-1",
    });
  });

  it("keeps publication disabled when complete DGX Spark infrastructure is configured (#8250)", () => {
    const candidate = configureQualification(manifestSource, {
      execution: "enabled",
      publicationEnabled: false,
    });

    expect(loadLlamaCppImageConfig(candidate).publication_enabled).toBe("false");
  });

  it("rejects serving-recipe drift before compiling the protected DGX Spark plan (#8260)", () => {
    const recipeSource = fs.readFileSync(recipePath, "utf8");

    expect(() =>
      loadLlamaCppImageConfig(
        manifestSource,
        recipeSource.replace("offload: full", "offload: partial"),
      ),
    ).toThrow();
    expect(() =>
      loadLlamaCppImageConfig(
        manifestSource,
        recipeSource.replace("toolCalls: true", "toolCalls: false"),
      ),
    ).toThrow("capability claims are invalid");
    expect(() =>
      loadLlamaCppImageConfig(
        manifestSource,
        recipeSource.replace("batchSize: 2048", "batchSize: 1024"),
      ),
    ).not.toThrow();
    expect(
      JSON.parse(
        loadLlamaCppImageConfig(
          manifestSource,
          recipeSource.replace("batchSize: 2048", "batchSize: 1024"),
        ).publication_qualification_plan,
      ).recipe.serve.batchSize,
    ).toBe(1024);
  });

  it("canonicalizes the protected plan independently of YAML key order (#8260)", () => {
    const recipeSource = fs.readFileSync(recipePath, "utf8");
    const reorderedRecipe = YAML.parse(recipeSource) as {
      spec: { serve: Record<string, unknown> };
    };
    reorderedRecipe.spec.serve = Object.fromEntries(
      Object.entries(reorderedRecipe.spec.serve).reverse(),
    );
    const baseline = loadLlamaCppImageConfig(manifestSource, recipeSource);
    const reordered = loadLlamaCppImageConfig(manifestSource, YAML.stringify(reorderedRecipe));

    expect(reordered.publication_qualification_plan).toBe(baseline.publication_qualification_plan);
    expect(reordered.publication_qualification_plan_sha256).toBe(
      baseline.publication_qualification_plan_sha256,
    );
  });

  it("uses only the strict agent-qualification YAML to activate OpenClaw probes", () => {
    const recipeSource = fs.readFileSync(recipePath, "utf8");
    const qualificationSource = fs.readFileSync(agentQualificationPath, "utf8");
    const enabled = loadLlamaCppImageConfig(
      manifestSource,
      recipeSource,
      undefined,
      qualificationSource,
    );

    expect(JSON.parse(enabled.publication_qualification_plan)).toMatchObject({
      qualification: { agentQualification: { execution: "enabled" } },
    });
    expect(() =>
      loadLlamaCppImageConfig(
        manifestSource,
        recipeSource,
        undefined,
        qualificationSource.replace("provider: llama-cpp-local", "provider: vllm-local"),
      ),
    ).toThrow(/agent qualification is invalid/u);
    expect(() =>
      loadLlamaCppImageConfig(
        manifestSource,
        recipeSource,
        undefined,
        qualificationSource.replace(
          "kind: AgentQualification",
          "kind: AgentQualification\nextra: true",
        ),
      ),
    ).toThrow(/agent qualification document fields/u);
  });

  it("rejects YAML parser warnings in image and recipe inputs (#8260)", () => {
    const recipeSource = fs.readFileSync(recipePath, "utf8");

    expect(() =>
      loadLlamaCppImageConfig(
        manifestSource.replace("kind: ServerImageBuild", "kind: !unknown ServerImageBuild"),
        recipeSource,
      ),
    ).toThrow(/Unresolved tag/u);
    expect(() =>
      loadLlamaCppImageConfig(
        manifestSource,
        recipeSource.replace("kind: ServingRecipe", "kind: !unknown ServingRecipe"),
      ),
    ).toThrow(/Unresolved tag/u);
  });

  it.each([
    ["an unexpected publication field", addUnexpectedPublicationField(manifestSource)],
    ["automatic publication", manifestSource.replace("workflow_dispatch", "push")],
    ["an untrusted ref", manifestSource.replace("refs/heads/main", "refs/heads/release")],
    [
      "a mutable repository reference",
      manifestSource.replace(
        "repository: ghcr.io/nvidia/nemoclaw/llama-cpp-server\n    candidateTagTemplate",
        "repository: ghcr.io/nvidia/nemoclaw/llama-cpp-server:latest\n    candidateTagTemplate",
      ),
    ],
    [
      "a non-unique candidate tag",
      manifestSource.replace(
        "llama-cpp-candidate-{runId}-{runAttempt}",
        "llama-cpp-candidate-{runId}",
      ),
    ],
    [
      "a duplicate publication platform",
      manifestSource.replace(
        "    platforms:\n      - linux/amd64\n      - linux/arm64\n    evidence:",
        "    platforms:\n      - linux/amd64\n      - linux/amd64\n    evidence:",
      ),
    ],
    ["a non-SPDX SBOM", manifestSource.replace("format: spdx-json", "format: cyclonedx-json")],
    [
      "legacy provenance",
      manifestSource.replace("https://slsa.dev/provenance/v1", "https://slsa.dev/provenance/v0.2"),
    ],
    [
      "a signing identity outside main",
      manifestSource.replace(
        "llama-cpp-image-attest.yaml@refs/heads/main",
        "llama-cpp-image-attest.yaml@refs/heads/feature",
      ),
    ],
    [
      "a non-GitHub OIDC issuer",
      manifestSource.replace(
        "https://token.actions.githubusercontent.com",
        "https://issuer.example.test",
      ),
    ],
    [
      "an optional transparency log",
      manifestSource.replace("transparencyLog: required", "transparencyLog: optional"),
    ],
    [
      "a different scan cutoff",
      manifestSource.replace("severityCutoff: high", "severityCutoff: critical"),
    ],
    [
      "scanning outside the fixed-finding policy",
      manifestSource.replace("onlyFixed: true", "onlyFixed: false"),
    ],
    ["an authenticated pull", manifestSource.replace("exactDigest: true", "exactDigest: false")],
    ["an unversioned receipt", manifestSource.replace("schemaVersion: 1", "schemaVersion: 0")],
    [
      "a shortened receipt lifetime",
      manifestSource.replace("retentionDays: 90", "retentionDays: 1"),
    ],
    [
      "optional DGX Spark qualification",
      manifestSource.replace("required: true", "required: false"),
    ],
    [
      "unknown DGX Spark qualification execution",
      configureQualification(manifestSource, {
        execution: "disabled",
        publicationEnabled: false,
      }).replace("execution: disabled", "execution: automatic"),
    ],
    [
      "duplicate DGX Spark qualification keys",
      configureQualification(manifestSource, {
        execution: "disabled",
        publicationEnabled: false,
      }).replace(
        "      execution: disabled",
        "      execution: disabled\n      execution: disabled",
      ),
    ],
    [
      "an unbound qualification recipe",
      manifestSource.replace(
        "recipeRef: llama-cpp.nemotron-3-nano-30b-a3b.spark-single.v1",
        "recipeRef: llama-cpp.untrusted.v1",
      ),
    ],
    ["CPU fallback", manifestSource.replace("cpuFallback: reject", "cpuFallback: allow")],
    ["partial GPU offload", manifestSource.replace("fullOffload: true", "fullOffload: false")],
    [
      "partial disabled infrastructure",
      configureQualification(manifestSource, {
        execution: "disabled",
        publicationEnabled: false,
      }).replace("runner: null", "runner: linux-arm64-gpu-dgx-spark-gb10-protected-1"),
    ],
    [
      "enablement without infrastructure",
      configureQualification(manifestSource, {
        execution: "disabled",
        publicationEnabled: true,
      }),
    ],
    [
      "enablement on a generic runner",
      enablePublication(manifestSource).replace(
        "linux-arm64-gpu-dgx-spark-gb10-protected-1",
        "ubuntu-latest",
      ),
    ],
    [
      "enablement without an approval environment",
      enablePublication(manifestSource).replace(
        "approve-dgx-spark-image-qualification",
        "production",
      ),
    ],
    [
      "enablement with a relative model path",
      enablePublication(manifestSource).replace(
        "/var/lib/nemoclaw/models/Nemotron-3-Nano-30B-A3B-UD-Q4_K_XL.gguf",
        "models/Nemotron-3-Nano-30B-A3B-UD-Q4_K_XL.gguf",
      ),
    ],
  ])("rejects %s in the publication contract (#8250)", (_case, candidate) => {
    expect(() => loadLlamaCppImageConfig(candidate)).toThrow();
  });

  it("builds only the pinned non-root llama-server runtime surfaces (#8231)", () => {
    const cmakeMarkers: Record<string, string> = {
      ggmlBackendDl: "-DGGML_BACKEND_DL=ON",
      ggmlCpuAllVariants: "-DGGML_CPU_ALL_VARIANTS=ON",
      ggmlCuda: "-DGGML_CUDA=ON",
      ggmlCurl: "-DGGML_CURL=ON",
      ggmlNative: "-DGGML_NATIVE=OFF",
      ggmlRpc: "-DGGML_RPC=OFF",
      llamaBuildApp: "-DLLAMA_BUILD_APP=OFF",
      llamaBuildExamples: "-DLLAMA_BUILD_EXAMPLES=OFF",
      llamaBuildServer: "-DLLAMA_BUILD_SERVER=ON",
      llamaBuildTests: "-DLLAMA_BUILD_TESTS=OFF",
      llamaBuildTools: "-DLLAMA_BUILD_TOOLS=ON",
      llamaBuildUi: "-DLLAMA_BUILD_UI=OFF",
      llamaOpenSsl: "-DLLAMA_OPENSSL=ON",
      llamaSubprocess: "-DLLAMA_SUBPROCESS=OFF",
      llamaUsePrebuiltUi: "-DLLAMA_USE_PREBUILT_UI=OFF",
    };
    Object.entries(cmakeMarkers).forEach(([field, marker]) => {
      expect(manifest.spec?.build?.cmake?.[field]).toBe(marker.endsWith("=ON"));
      expect(dockerfile).toContain(marker);
    });

    expect(manifest.spec?.build?.target).toBe("llama-server");
    expect(dockerfile).toContain("--target llama-server");
    expect(dockerfile).toContain('-DGGML_BACKEND_DIR="${GGML_BACKEND_DIR}"');
    expect(dockerfile).toContain('test -f "${GGML_BACKEND_DIR}/libggml-cuda.so"');
    expect(
      Object.entries({
        ...manifest.spec?.build?.packages,
        ...manifest.spec?.runtime?.packages,
      }).every(([packageName, version]) => dockerfile.includes(`${packageName}=${version}`)),
    ).toBe(true);
    expect(dockerfile).toContain("USER ${RUNTIME_UID}:${RUNTIME_GID}");
    expect(dockerfile).toContain('SHELL ["/bin/bash", "-o", "pipefail", "-c"]');
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/local/bin/llama-server"]');
    expect(dockerfile).toContain("go test ./...");
    expect(dockerfile).toContain("CGO_ENABLED=0 go build");
    expect(dockerfile).toContain("GOTOOLCHAIN=local");
    expect(dockerfile).toContain(
      '"https://go.dev/dl/go${REQUEST_GUARD_GO_VERSION}.linux-${TARGETARCH}.tar.gz"',
    );
    expect(dockerfile).toContain('"${REQUEST_GUARD_GO_ARCHIVE_SHA256#sha256:}" "$go_archive"');
    expect(dockerfile).toContain('test "$(go env GOVERSION)" = "go${REQUEST_GUARD_GO_VERSION}"');
    expect(dockerfile).toContain("test ! -e /usr/local/go");
    expect(dockerfile).toContain("cp /usr/local/go/LICENSE /opt/llama.cpp/licenses/go/LICENSE");
    expect(dockerfile).toContain(
      'io.nvidia.nemoclaw.inference-server.request-guard.go.version="${REQUEST_GUARD_GO_VERSION}"',
    );
    expect(dockerfile).toContain(
      'io.nvidia.nemoclaw.inference-server.request-guard.go.archive-sha256="${REQUEST_GUARD_GO_ARCHIVE_SHA256}"',
    );
    expect(dockerfile).not.toContain("golang-go=");
    expect(dockerfile).toContain(
      "COPY --from=build --chmod=0555 /opt/llama.cpp/bin/nemoclaw-llama-cpp-request-guard /usr/local/bin/nemoclaw-llama-cpp-request-guard",
    );
    expect(dockerfile).toContain(
      "COPY --from=build /opt/llama.cpp/licenses/ /usr/local/share/licenses/",
    );
    expect(dockerfile).toContain("ENV CC=${C_COMPILER}");
    expect(dockerfile).toContain("CXX=${CXX_COMPILER}");
    expect(dockerfile).toContain("CUDAHOSTCXX=${CUDA_HOST_CXX_COMPILER}");
    expect(
      (
        manifest.spec?.runtime?.forbiddenPaths?.filter(
          (forbiddenPath) => forbiddenPath !== "/opt/llama.cpp/ui",
        ) ?? []
      ).every((shellPath) => dockerfile.includes(shellPath)),
    ).toBe(true);
    expect(dockerfile).toContain("sha256sum --check --strict");
    expect(dockerfile).toContain("cp LICENSE AUTHORS");
    expect(dockerfile).toContain("find /opt/llama.cpp/licenses -type d -exec chmod 0555");
    expect(dockerfile).toContain("find /opt/llama.cpp/licenses -type f -exec chmod 0444");
    expect(dockerfile).not.toContain("COPY --from=build --chmod=0444");
    expect(dockerfile).not.toContain("# syntax=");
    expect(dockerfile).not.toContain("git clone");
    expect(dockerfile).not.toContain(" huggingface");
    expect(dockerfile).not.toMatch(/[0-9a-f]{40}/u);
    expect(dockerfile).not.toMatch(/sha256:[0-9a-f]{64}/u);
  });
});
