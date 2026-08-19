// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DCODE_BASE_IMAGE = "ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base";
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const GLIBC_PATTERN = /^[0-9]+[.][0-9]+$/u;
const PLATFORM_PATTERN = /^linux\/(amd64|arm64)$/u;

type DcodeBaseResolutionInput = {
  imageName: string;
  reference: string;
  digest: string;
  sourceRevision: string;
  imageId: string;
  os: string;
  architecture: string;
  platform: string;
  glibcVersion: string;
};

type DockerImageInspect = {
  Id?: unknown;
  Os?: unknown;
  Architecture?: unknown;
  Config?: { Labels?: Record<string, unknown> } | null;
};

function fail(message: string): never {
  throw new Error(`Deep Agents Code base-resolution label: ${message}`);
}

export function createDcodeBaseResolutionMetadata(input: DcodeBaseResolutionInput) {
  if (input.imageName !== DCODE_BASE_IMAGE) fail("image repository is invalid");
  if (!DIGEST_PATTERN.test(input.digest)) fail("platform digest is invalid");
  if (input.reference !== `${input.imageName}@${input.digest}`) {
    fail("reference is not bound to the immutable platform digest");
  }
  if (!PLATFORM_PATTERN.test(input.platform)) fail("platform is invalid");
  const [os, architecture] = input.platform.split("/");
  if (input.os !== os || input.architecture !== architecture) {
    fail("inspected platform does not match the immutable contract");
  }
  if (!DIGEST_PATTERN.test(input.imageId)) fail("local image identity is invalid");
  if (!REVISION_PATTERN.test(input.sourceRevision)) fail("source revision is invalid");
  if (!GLIBC_PATTERN.test(input.glibcVersion)) fail("glibc version is invalid");

  const authority = {
    imageName: input.imageName,
    ref: input.reference,
    digest: input.digest,
    sourceRevision: input.sourceRevision,
    imageId: input.imageId,
    os,
    architecture,
    glibcVersion: input.glibcVersion,
    requireOpenshellSandboxAbi: true,
    minGlibcVersion: "2.39",
  };
  return {
    schema: 1,
    key: createHash("sha256").update(JSON.stringify(authority)).digest("hex"),
    ...authority,
    source: "override",
  };
}

export function encodeDcodeBaseResolutionMetadata(
  metadata: ReturnType<typeof createDcodeBaseResolutionMetadata>,
): string {
  return Buffer.from(JSON.stringify(metadata), "utf8").toString("base64url");
}

function parseArguments(argv: string[]): Map<string, string> {
  const values = new Map<string, string>();
  const allowed = new Set<string>([
    "reference",
    "inspect-reference",
    "platform",
    "output",
    "local-oci-receipt",
    "expected-source-revision",
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const argument = argv[index];
    const value = argv[index + 1];
    const key = argument?.startsWith("--") ? argument.slice(2) : "";
    if (!allowed.has(key) || value === undefined || values.has(key)) {
      fail("arguments are invalid");
    }
    values.set(key, value);
  }
  for (const key of ["reference", "inspect-reference", "platform", "output"]) {
    if (!values.get(key)) fail(`${key} is required`);
  }
  return values;
}

function requiredValue(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (!value) fail(`${key} is required`);
  return value;
}

function runDocker(arguments_: string[]): string {
  return execFileSync("docker", arguments_, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function validateLocalOciReceipt(receipt: string, digest: string): void {
  const separator = receipt.lastIndexOf("@sha256:");
  if (separator < 1) fail("local OCI receipt is invalid");
  const layoutRoot = receipt.slice(0, separator);
  const receiptDigest = receipt.slice(separator + 1);
  if (!path.isAbsolute(layoutRoot) || receiptDigest !== digest) {
    fail("local OCI receipt does not match the immutable platform digest");
  }
  const index = JSON.parse(readFileSync(path.join(layoutRoot, "index.json"), "utf8")) as {
    manifests?: Array<{ digest?: unknown }>;
  };
  if (
    !Array.isArray(index.manifests) ||
    index.manifests.length !== 1 ||
    index.manifests[0]?.digest !== digest
  ) {
    fail("local OCI receipt does not contain the immutable platform manifest");
  }
}

export function exportDcodeBaseResolutionLabel(argv: string[]) {
  const values = parseArguments(argv);
  const reference = requiredValue(values, "reference");
  const inspectReference = requiredValue(values, "inspect-reference");
  const platform = requiredValue(values, "platform");
  const output = requiredValue(values, "output");
  const localOciReceipt = values.get("local-oci-receipt");
  const expectedSourceRevision = values.get("expected-source-revision");
  const digest = reference.slice(reference.lastIndexOf("@") + 1);

  if (reference !== `${DCODE_BASE_IMAGE}@${digest}` || !DIGEST_PATTERN.test(digest)) {
    fail("reference is not an exact Deep Agents Code platform reference");
  }
  if (!PLATFORM_PATTERN.test(platform)) fail("platform is invalid");
  if (expectedSourceRevision && !REVISION_PATTERN.test(expectedSourceRevision)) {
    fail("expected source revision is invalid");
  }
  if (!path.isAbsolute(output) || /[\r\n]/u.test(output)) fail("output path is invalid");

  if (inspectReference === reference) {
    if (localOciReceipt) fail("remote inspection cannot use a local OCI receipt");
    runDocker(["pull", "--platform", platform, reference]);
  } else {
    if (!localOciReceipt) fail("a mutable inspection reference needs its exact local OCI receipt");
    validateLocalOciReceipt(localOciReceipt, digest);
  }

  const inspectedImages = JSON.parse(runDocker(["image", "inspect", inspectReference])) as unknown;
  if (!Array.isArray(inspectedImages) || inspectedImages.length !== 1) {
    fail("inspection did not return one image");
  }
  const inspected = inspectedImages[0] as DockerImageInspect;
  const sourceRevision = inspected?.Config?.Labels?.["org.opencontainers.image.revision"];
  if (typeof sourceRevision !== "string" || !REVISION_PATTERN.test(sourceRevision)) {
    fail("inspected source revision is missing");
  }
  if (expectedSourceRevision && sourceRevision !== expectedSourceRevision) {
    fail("inspected source revision does not match the immutable contract");
  }
  const glibcOutput = runDocker([
    "run",
    "--rm",
    "--platform",
    platform,
    "--entrypoint",
    "getconf",
    inspectReference,
    "GNU_LIBC_VERSION",
  ]);
  const glibcVersion = /^glibc ([0-9]+[.][0-9]+)$/u.exec(glibcOutput)?.[1] ?? "";
  const imageId = inspected.Id;
  const os = inspected.Os;
  const architecture = inspected.Architecture;
  if (typeof imageId !== "string" || typeof os !== "string" || typeof architecture !== "string") {
    fail("inspected image identity is incomplete");
  }
  const metadata = createDcodeBaseResolutionMetadata({
    imageName: DCODE_BASE_IMAGE,
    reference,
    digest,
    sourceRevision,
    imageId,
    os,
    architecture,
    platform,
    glibcVersion,
  });
  appendFileSync(
    output,
    `resolution_key=${metadata.key}\nresolution_label=${encodeDcodeBaseResolutionMetadata(metadata)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return metadata;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    exportDcodeBaseResolutionLabel(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Deep Agents Code label export failed");
    process.exitCode = 1;
  }
}
