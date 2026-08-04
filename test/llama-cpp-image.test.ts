// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { loadLlamaCppImageConfig } from "../scripts/checks/export-llama-cpp-image-config.mts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const imageRoot = path.join(repoRoot, "managed-inference", "images", "llama-cpp");
const manifestPath = path.join(imageRoot, "image.yaml");
const dockerfilePath = path.join(imageRoot, "Dockerfile");
const recipePath = path.join(
  repoRoot,
  "managed-inference",
  "recipes",
  "llama-cpp.nemotron-3-nano-30b-a3b.spark-single.v1.yaml",
);
const exporterPath = path.join(repoRoot, "scripts", "checks", "export-llama-cpp-image-config.mts");

type ImageManifest = {
  apiVersion?: string;
  kind?: string;
  metadata?: { id?: string };
  spec?: {
    build?: {
      backendDirectory?: string;
      cmake?: Record<string, boolean>;
      compiler?: { c?: string; cudaHostCxx?: string; cxx?: string };
      packages?: Record<string, string>;
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
        gpu?: { cpuFallback?: string; fullOffload?: boolean; vendor?: string };
        model?: { digest?: string; hostPath?: string | null; id?: string };
        platform?: string;
        probes?: string[];
        profile?: string;
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

function enablePublication(source: string): string {
  return source
    .replace("    enabled: false", "    enabled: true")
    .replace("      runner: null", "      runner: linux-arm64-gpu-dgx-spark-gb10-protected-1")
    .replace("      environment: null", "      environment: approve-dgx-spark-image-qualification")
    .replace(
      "        hostPath: null",
      "        hostPath: /var/lib/nemoclaw/models/Nemotron-3-Nano-30B-A3B-UD-Q4_K_XL.gguf",
    );
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
      metadata: { id: "llama-cpp-server.v1" },
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

  it("keeps publication manual and disabled while protected DGX Spark inputs are unset (#8250)", () => {
    const output = loadLlamaCppImageConfig(manifestSource);

    expect(output).toMatchObject({
      publication_allowed_ref: "refs/heads/main",
      publication_candidate_tag_template: "llama-cpp-candidate-{runId}-{runAttempt}",
      publication_enabled: "false",
      publication_platforms: '["linux/amd64","linux/arm64"]',
      publication_repository: "ghcr.io/nvidia/nemoclaw/llama-cpp-server",
      publication_trigger: "workflow_dispatch",
    });
    expect(JSON.parse(output.publication_qualification)).toMatchObject({
      environment: null,
      model: { hostPath: null },
      required: true,
      runner: null,
    });
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
      runtime_forbidden_paths: JSON.stringify(manifest.spec?.runtime?.forbiddenPaths),
      runtime_gid: String(manifest.spec?.runtime?.gid),
      runtime_required_paths: JSON.stringify(manifest.spec?.runtime?.requiredPaths),
      runtime_uid: String(manifest.spec?.runtime?.uid),
      source_archive_sha256: manifest.spec?.source?.archiveSha256,
      source_revision: manifest.spec?.source?.revision,
    });
    expect(JSON.parse(output.matrix ?? "null")).toEqual({
      include: manifest.spec?.platforms?.map(({ cudaArchitectures, platform, runner }) => ({
        arch: platform?.slice("linux/".length),
        cuda_architectures: cudaArchitectures,
        platform,
        runner,
      })),
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
  ])("rejects %s before exporting image build inputs (#8231)", (_case, candidate) => {
    expect(() => loadLlamaCppImageConfig(candidate)).toThrow();
  });

  it("accepts publication enablement only when all protected DGX Spark inputs are bound (#8250)", () => {
    const output = loadLlamaCppImageConfig(enablePublication(manifestSource));

    expect(output.publication_enabled).toBe("true");
    expect(JSON.parse(output.publication_qualification)).toMatchObject({
      environment: "approve-dgx-spark-image-qualification",
      model: {
        hostPath: "/var/lib/nemoclaw/models/Nemotron-3-Nano-30B-A3B-UD-Q4_K_XL.gguf",
      },
      runner: "linux-arm64-gpu-dgx-spark-gb10-protected-1",
    });
  });

  it("keeps publication disabled when complete DGX Spark infrastructure is configured (#8250)", () => {
    const candidate = enablePublication(manifestSource).replace("enabled: true", "enabled: false");

    expect(loadLlamaCppImageConfig(candidate).publication_enabled).toBe("false");
  });

  it.each([
    [
      "an unexpected publication field",
      manifestSource.replace("    enabled: false", "    enabled: false\n    consumerAlias: latest"),
    ],
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
    ["CPU fallback", manifestSource.replace("cpuFallback: reject", "cpuFallback: allow")],
    ["partial GPU offload", manifestSource.replace("fullOffload: true", "fullOffload: false")],
    [
      "partial disabled infrastructure",
      manifestSource.replace("runner: null", "runner: linux-arm64-gpu-dgx-spark-gb10-protected-1"),
    ],
    [
      "enablement without infrastructure",
      manifestSource.replace("enabled: false", "enabled: true"),
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
    for (const [field, marker] of Object.entries(cmakeMarkers)) {
      expect(manifest.spec?.build?.cmake?.[field]).toBe(marker.endsWith("=ON"));
      expect(dockerfile).toContain(marker);
    }

    expect(manifest.spec?.build?.target).toBe("llama-server");
    expect(dockerfile).toContain("--target llama-server");
    expect(dockerfile).toContain('-DGGML_BACKEND_DIR="${GGML_BACKEND_DIR}"');
    expect(dockerfile).toContain('test -f "${GGML_BACKEND_DIR}/libggml-cuda.so"');
    for (const [packageName, version] of Object.entries({
      ...manifest.spec?.build?.packages,
      ...manifest.spec?.runtime?.packages,
    })) {
      expect(dockerfile).toContain(`${packageName}=${version}`);
    }
    expect(dockerfile).toContain("USER ${RUNTIME_UID}:${RUNTIME_GID}");
    expect(dockerfile).toContain('SHELL ["/bin/bash", "-o", "pipefail", "-c"]');
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/local/bin/llama-server"]');
    expect(dockerfile).toContain("ENV CC=${C_COMPILER}");
    expect(dockerfile).toContain("CXX=${CXX_COMPILER}");
    expect(dockerfile).toContain("CUDAHOSTCXX=${CUDA_HOST_CXX_COMPILER}");
    for (const shellPath of manifest.spec?.runtime?.forbiddenPaths?.filter(
      (forbiddenPath) => forbiddenPath !== "/opt/llama.cpp/ui",
    ) ?? []) {
      expect(dockerfile).toContain(shellPath);
    }
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
