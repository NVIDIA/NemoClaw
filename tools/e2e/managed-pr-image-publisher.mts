// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";

const AGENTS = ["openclaw", "hermes", "langchain-deepagents-code"] as const;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/u;
const RELEASE_PATTERN = /^v[0-9]+(?:[.][0-9]+){1,3}(?:[-.][0-9A-Za-z][0-9A-Za-z.-]*)?$/u;
const MAX_LAYOUT_FILES = 300;
const MAX_LAYOUT_BYTES = 12 * 1024 * 1024 * 1024;
const MANIFEST_MEDIA_TYPES = new Set([
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
]);
const CONFIG_MEDIA_TYPES = new Set([
  "application/vnd.oci.image.config.v1+json",
  "application/vnd.docker.container.image.v1+json",
]);
const LAYER_MEDIA_TYPES = new Set([
  "application/vnd.oci.image.layer.v1.tar",
  "application/vnd.oci.image.layer.v1.tar+gzip",
  "application/vnd.oci.image.layer.v1.tar+zstd",
  "application/vnd.oci.image.layer.nondistributable.v1.tar",
  "application/vnd.oci.image.layer.nondistributable.v1.tar+gzip",
  "application/vnd.docker.image.rootfs.diff.tar.gzip",
  "application/vnd.docker.image.rootfs.foreign.diff.tar.gzip",
]);

type JsonRecord = Record<string, unknown>;
type Agent = (typeof AGENTS)[number];
type Platform = "linux/amd64" | "linux/arm64";

export interface ManagedPrImageExpectedIdentity {
  readonly agent: Agent;
  readonly candidateSha: string;
  readonly image: string;
  readonly platform: Platform;
  readonly runAttempt: string;
  readonly runId: string;
}

export interface ValidatedManagedPrImageBundle {
  readonly cohort: string;
  readonly layoutReference: string;
  readonly manifestDigest: string;
  readonly release: string;
}

export interface ManagedPrImagePublication {
  readonly expected: ManagedPrImageExpectedIdentity;
  readonly validated: ValidatedManagedPrImageBundle;
}

export interface ManagedPrImageRegistryClient {
  login(): Promise<void> | void;
  logout(): Promise<void> | void;
  publish(publication: ManagedPrImagePublication): Promise<string> | string;
}

export interface PublishedManagedPrImage {
  readonly digest: string;
  readonly release: string;
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as JsonRecord;
}

function exactString(value: unknown, expected: string | number, label: string): void {
  if (value !== expected) throw new Error(`${label} must be ${expected}`);
}

function boundedJson(file: string, label: string): unknown {
  let descriptor: number;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    throw new Error(`${label} must be a bounded regular file`);
  }
  try {
    const metadata = fs.fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size > 4 * 1024 * 1024) {
      throw new Error(`${label} must be a bounded regular file`);
    }
    const contents = fs.readFileSync(descriptor);
    if (contents.byteLength > 4 * 1024 * 1024) {
      throw new Error(`${label} must be a bounded regular file`);
    }
    return JSON.parse(contents.toString("utf8")) as unknown;
  } finally {
    fs.closeSync(descriptor);
  }
}

function descriptor(value: unknown, label: string): JsonRecord {
  const candidate = record(value, label);
  if (!DIGEST_PATTERN.test(String(candidate.digest))) {
    throw new Error(`${label} digest is invalid`);
  }
  if (!Number.isSafeInteger(candidate.size) || Number(candidate.size) < 0) {
    throw new Error(`${label} size is invalid`);
  }
  return candidate;
}

function expectedBlobPath(layoutRoot: string, digest: string): string {
  return path.join(layoutRoot, "blobs", "sha256", digest.slice("sha256:".length));
}

async function validateBlob(
  layoutRoot: string,
  value: unknown,
  label: string,
  mediaTypes: ReadonlySet<string>,
): Promise<{ digest: string; json?: unknown }> {
  const candidate = descriptor(value, label);
  if (!mediaTypes.has(String(candidate.mediaType))) {
    throw new Error(`${label} media type is invalid`);
  }
  const digest = String(candidate.digest);
  const file = expectedBlobPath(layoutRoot, digest);
  const handle = await fs.promises
    .open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    .catch(() => {
      throw new Error(`${label} blob metadata does not match its descriptor`);
    });
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size !== candidate.size) {
      throw new Error(`${label} blob metadata does not match its descriptor`);
    }
    if (mediaTypes !== LAYER_MEDIA_TYPES && metadata.size > 4 * 1024 * 1024) {
      throw new Error(`${label} must be a bounded regular file`);
    }
    const digestBuilder = createHash("sha256");
    let json: unknown;
    if (mediaTypes === LAYER_MEDIA_TYPES) {
      await pipeline(handle.createReadStream({ autoClose: false }), digestBuilder);
    } else {
      const contents = await handle.readFile();
      digestBuilder.update(contents);
      json = JSON.parse(contents.toString("utf8")) as unknown;
    }
    if (`sha256:${digestBuilder.digest("hex")}` !== digest) {
      throw new Error(`${label} blob digest does not match`);
    }
    return { digest, json };
  } finally {
    await handle.close();
  }
}

function validateExpectedIdentity(expected: ManagedPrImageExpectedIdentity): void {
  if (!AGENTS.includes(expected.agent)) throw new Error("managed-image agent is invalid");
  if (!SHA_PATTERN.test(expected.candidateSha)) throw new Error("candidate SHA is invalid");
  if (expected.platform !== "linux/amd64" && expected.platform !== "linux/arm64") {
    throw new Error("managed-image platform is invalid");
  }
  if (!RUN_ID_PATTERN.test(expected.runId) || !RUN_ID_PATTERN.test(expected.runAttempt)) {
    throw new Error("source workflow identity is invalid");
  }
  if (!/^ghcr[.]io\/nvidia\/nemoclaw\/[a-z0-9-]+-sandbox$/u.test(expected.image)) {
    throw new Error("managed-image repository is invalid");
  }
}

function validateLayoutTree(layoutRoot: string): Set<string> {
  const files = new Set<string>();
  const directories = new Set<string>();
  let totalBytes = 0;
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory)) {
      const entry = path.join(directory, name);
      const relative = path.relative(layoutRoot, entry);
      if (
        relative === "" ||
        relative.startsWith("..") ||
        path.isAbsolute(relative) ||
        /[\0\r\n\\]/u.test(relative)
      ) {
        throw new Error("OCI layout contains an invalid path");
      }
      const metadata = fs.lstatSync(entry);
      if (metadata.isSymbolicLink()) throw new Error("OCI layout must not contain symbolic links");
      if (metadata.isDirectory()) {
        directories.add(relative);
        visit(entry);
        continue;
      }
      if (!metadata.isFile()) throw new Error("OCI layout may contain only files and directories");
      totalBytes += metadata.size;
      if (files.size >= MAX_LAYOUT_FILES || totalBytes > MAX_LAYOUT_BYTES) {
        throw new Error("OCI layout exceeds its file or byte limit");
      }
      files.add(relative);
    }
  };
  visit(layoutRoot);
  for (const directory of directories) {
    if (directory !== "blobs" && directory !== path.join("blobs", "sha256")) {
      throw new Error("OCI layout contains an unexpected directory");
    }
  }
  return files;
}

function receiptIdentity(
  receipt: JsonRecord,
  expected: ManagedPrImageExpectedIdentity,
): { cohort: string; manifestDigest: string; release: string } {
  exactString(receipt.bundleVersion, 1, "candidate bundle version");
  exactString(receipt.agent, expected.agent, "candidate bundle agent");
  exactString(receipt.platform, expected.platform, "candidate bundle platform");
  exactString(receipt.image, expected.image, "candidate bundle repository");
  const manifestDigest = String(receipt.manifestDigest);
  if (!DIGEST_PATTERN.test(manifestDigest)) throw new Error("candidate manifest digest is invalid");
  const source = record(receipt.source, "candidate bundle source");
  exactString(source.repository, "NVIDIA/NemoClaw", "candidate source repository");
  exactString(source.revision, expected.candidateSha, "candidate source revision");
  exactString(source.runId, expected.runId, "candidate source run ID");
  exactString(source.runAttempt, expected.runAttempt, "candidate source run attempt");
  const cohort = String(source.cohort);
  exactString(cohort, `ghrun-${expected.runId}-${expected.runAttempt}`, "candidate source cohort");
  const release = String(source.release);
  if (!RELEASE_PATTERN.test(release)) throw new Error("candidate release is invalid");
  return { cohort, manifestDigest, release };
}

/** Validate an authenticated workflow artifact without executing candidate image content. */
export async function validateManagedPrImageBundle(
  bundleRoot: string,
  expected: ManagedPrImageExpectedIdentity,
): Promise<ValidatedManagedPrImageBundle> {
  validateExpectedIdentity(expected);
  const bundleMetadata = fs.lstatSync(bundleRoot);
  if (!bundleMetadata.isDirectory() || bundleMetadata.isSymbolicLink()) {
    throw new Error("candidate bundle root must be a regular directory");
  }
  const receipt = record(
    boundedJson(path.join(bundleRoot, "receipt.json"), "candidate bundle receipt"),
    "candidate bundle receipt",
  );
  const identity = receiptIdentity(receipt, expected);
  const layoutRoot = path.join(bundleRoot, "layout");
  const layoutMetadata = fs.lstatSync(layoutRoot);
  if (!layoutMetadata.isDirectory() || layoutMetadata.isSymbolicLink()) {
    throw new Error("candidate OCI layout must be a regular directory");
  }
  const files = validateLayoutTree(layoutRoot);
  const layoutVersion = record(
    boundedJson(path.join(layoutRoot, "oci-layout"), "OCI layout version"),
    "OCI layout version",
  );
  exactString(layoutVersion.imageLayoutVersion, "1.0.0", "OCI image layout version");
  const index = record(boundedJson(path.join(layoutRoot, "index.json"), "OCI index"), "OCI index");
  exactString(index.schemaVersion, 2, "OCI index schema version");
  if (!Array.isArray(index.manifests) || index.manifests.length !== 1) {
    throw new Error("OCI index must contain exactly one platform manifest");
  }
  const manifestDescriptor = descriptor(index.manifests[0], "OCI platform manifest");
  exactString(manifestDescriptor.digest, identity.manifestDigest, "OCI platform manifest digest");
  const expectedArch = expected.platform.slice("linux/".length);
  const platform = record(manifestDescriptor.platform, "OCI manifest platform");
  exactString(platform.os, "linux", "OCI manifest operating system");
  exactString(platform.architecture, expectedArch, "OCI manifest architecture");
  const manifestBlob = await validateBlob(
    layoutRoot,
    manifestDescriptor,
    "OCI platform manifest",
    MANIFEST_MEDIA_TYPES,
  );
  const manifest = record(manifestBlob.json, "OCI manifest");
  exactString(manifest.schemaVersion, 2, "OCI manifest schema version");
  const configBlob = await validateBlob(
    layoutRoot,
    manifest.config,
    "OCI image config",
    CONFIG_MEDIA_TYPES,
  );
  if (
    !Array.isArray(manifest.layers) ||
    manifest.layers.length < 1 ||
    manifest.layers.length > 256
  ) {
    throw new Error("OCI manifest layer list is invalid");
  }
  const referenced = new Set([manifestBlob.digest, configBlob.digest]);
  for (const [indexValue, layer] of manifest.layers.entries()) {
    const validated = await validateBlob(
      layoutRoot,
      layer,
      `OCI image layer ${indexValue}`,
      LAYER_MEDIA_TYPES,
    );
    referenced.add(validated.digest);
  }
  const config = record(configBlob.json, "OCI image configuration");
  exactString(config.os, "linux", "OCI image operating system");
  exactString(config.architecture, expectedArch, "OCI image architecture");
  const runtime = record(config.config, "OCI runtime configuration");
  if (
    runtime.User !== undefined &&
    runtime.User !== "" &&
    runtime.User !== "0" &&
    runtime.User !== "root"
  ) {
    throw new Error("candidate image must retain a root startup user");
  }
  if (
    runtime.OnBuild !== undefined &&
    runtime.OnBuild !== null &&
    (!Array.isArray(runtime.OnBuild) || runtime.OnBuild.length !== 0)
  ) {
    throw new Error("candidate image must not execute ONBUILD commands in the trusted publisher");
  }
  const labels = record(runtime.Labels, "OCI image labels");
  exactString(labels["io.nvidia.nemoclaw.agent"], expected.agent, "managed-image agent label");
  exactString(
    labels["io.nvidia.nemoclaw.managed-image.contract"],
    "1",
    "managed-image contract label",
  );
  exactString(
    labels["io.nvidia.nemoclaw.managed-image.platform"],
    expected.platform,
    "managed-image platform label",
  );
  exactString(
    labels["io.nvidia.nemoclaw.managed-image.startup-profile"],
    "1",
    "managed-image startup label",
  );
  exactString(
    labels["io.nvidia.nemoclaw.managed-image.capabilities"],
    "1",
    "managed-image capability label",
  );
  exactString(
    labels["io.nvidia.nemoclaw.managed-image.cohort"],
    identity.cohort,
    "managed-image cohort label",
  );
  exactString(
    labels["org.opencontainers.image.revision"],
    expected.candidateSha,
    "managed-image revision label",
  );
  exactString(
    labels["org.opencontainers.image.version"],
    identity.release,
    "managed-image release label",
  );
  const expectedFiles = new Set([
    "index.json",
    "oci-layout",
    ...[...referenced].map((digest) => path.join("blobs", "sha256", digest.slice(7))),
  ]);
  if (files.size !== expectedFiles.size || [...files].some((file) => !expectedFiles.has(file))) {
    throw new Error("OCI layout contains an unreferenced or missing file");
  }
  return {
    cohort: identity.cohort,
    layoutReference: `${layoutRoot}@${identity.manifestDigest}`,
    manifestDigest: identity.manifestDigest,
    release: identity.release,
  };
}

/** Validate the authenticated artifact before the registry client can receive package authority. */
export async function publishManagedPrImageBundle(
  bundleRoot: string,
  expected: ManagedPrImageExpectedIdentity,
  registry: ManagedPrImageRegistryClient,
): Promise<PublishedManagedPrImage> {
  const validated = await validateManagedPrImageBundle(bundleRoot, expected);
  try {
    await registry.login();
    const digest = await registry.publish({ expected, validated });
    if (!DIGEST_PATTERN.test(digest)) throw new Error("published image digest is invalid");
    return { digest, release: validated.release };
  } finally {
    await registry.logout();
  }
}

export function managedPrImageContract(
  expected: ManagedPrImageExpectedIdentity,
  digest: string,
  release: string,
): JsonRecord {
  validateExpectedIdentity(expected);
  if (!DIGEST_PATTERN.test(digest)) throw new Error("published image digest is invalid");
  if (!RELEASE_PATTERN.test(release)) throw new Error("published image release is invalid");
  return {
    contractVersion: 1,
    agent: expected.agent,
    platform: expected.platform,
    image: expected.image,
    digest,
    reference: `${expected.image}@${digest}`,
    source: {
      repository: "NVIDIA/NemoClaw",
      revision: expected.candidateSha,
      release,
      cohort: `ghrun-${expected.runId}-${expected.runAttempt}`,
    },
    startupProfileContractVersion: 1,
    capabilityContractVersion: 1,
  };
}

function requiredEnvironment(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function runDocker(args: string[], input?: string): void {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    input,
    stdio: input === undefined ? "inherit" : ["pipe", "inherit", "inherit"],
  });
  if (result.error) {
    throw new Error(
      `docker ${args.slice(0, 2).join(" ")} could not start: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(`docker ${args.slice(0, 2).join(" ")} failed with status ${result.status}`);
  }
}

class DockerManagedPrImageRegistryClient implements ManagedPrImageRegistryClient {
  readonly #env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv) {
    this.#env = env;
  }

  login(): void {
    runDocker(
      [
        "login",
        "ghcr.io",
        "--username",
        requiredEnvironment(this.#env, "REGISTRY_USERNAME"),
        "--password-stdin",
      ],
      `${requiredEnvironment(this.#env, "REGISTRY_PASSWORD")}\n`,
    );
  }

  logout(): void {
    runDocker(["logout", "ghcr.io"]);
  }

  publish(publication: ManagedPrImagePublication): string {
    const repositoryRoot = path.resolve(import.meta.dirname, "../..");
    const metadataRoot = fs.mkdtempSync(
      path.join(requiredEnvironment(this.#env, "RUNNER_TEMP"), "managed-pr-publisher-"),
    );
    const metadataFile = path.join(metadataRoot, "build-metadata.json");
    try {
      runDocker([
        "buildx",
        "build",
        "--builder",
        requiredEnvironment(this.#env, "BUILDX_BUILDER"),
        "--platform",
        publication.expected.platform,
        "--file",
        path.join(repositoryRoot, "tools/e2e/managed-pr-image-publisher.Dockerfile"),
        "--build-context",
        `candidate=oci-layout://${publication.validated.layoutReference}`,
        "--output",
        `type=image,name=${publication.expected.image},push-by-digest=true,name-canonical=true,push=true`,
        "--provenance=false",
        "--sbom=false",
        "--metadata-file",
        metadataFile,
        repositoryRoot,
      ]);
      const metadata = record(
        boundedJson(metadataFile, "managed-image publication metadata"),
        "managed-image publication metadata",
      );
      return String(metadata["containerimage.digest"]);
    } finally {
      fs.rmSync(metadataRoot, { force: true, recursive: true });
    }
  }
}

function expectedFromEnvironment(env: NodeJS.ProcessEnv): ManagedPrImageExpectedIdentity {
  return {
    agent: String(env.AGENT) as Agent,
    candidateSha: String(env.CANDIDATE_SHA),
    image: String(env.IMAGE),
    platform: String(env.PLATFORM) as Platform,
    runAttempt: String(env.SOURCE_RUN_ATTEMPT),
    runId: String(env.SOURCE_RUN_ID),
  };
}

export async function main(argv = process.argv.slice(2), env = process.env): Promise<void> {
  const expected = expectedFromEnvironment(env);
  if (argv[0] === "publish" && argv.length === 2) {
    const published = await publishManagedPrImageBundle(
      argv[1]!,
      expected,
      new DockerManagedPrImageRegistryClient(env),
    );
    if (!env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
    fs.appendFileSync(
      env.GITHUB_OUTPUT,
      `digest=${published.digest}\nrelease=${published.release}\n`,
    );
    return;
  }
  if (argv[0] === "contract" && argv.length === 2) {
    const contract = managedPrImageContract(
      expected,
      String(env.PUBLISHED_DIGEST),
      String(env.RELEASE),
    );
    fs.mkdirSync(path.dirname(path.resolve(argv[1]!)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(argv[1]!, `${JSON.stringify(contract)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return;
  }
  throw new Error("expected publish <bundle-directory> or contract <output-path>");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
