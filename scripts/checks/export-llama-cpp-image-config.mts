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
    source?: { archiveSha256?: unknown; repository?: unknown; revision?: unknown };
  };
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const manifestPath = path.join(repoRoot, "managed-inference", "images", "llama-cpp", "image.yaml");

const nvidiaCudaDigestReference = /^docker\.io\/nvidia\/cuda@sha256:[0-9a-f]{64}$/u;
const fullRevision = /^[0-9a-f]{40}$/u;
const sha256 = /^sha256:[0-9a-f]{64}$/u;

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
  if (
    manifest?.apiVersion !== "nemoclaw.nvidia.com/managed-inference/v1" ||
    manifest?.kind !== "ServerImageBuild" ||
    manifest?.metadata?.id !== "llama-cpp-server.v1"
  ) {
    throw new Error("invalid llama.cpp server image manifest identity");
  }

  const spec = manifest.spec;
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
    fs.appendFileSync(githubOutputPath, output, { encoding: "utf8", mode: 0o600 });
  } else {
    process.stdout.write(output);
  }
}
