// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY = "localhost:5000/nemoclaw-managed-protected/openclaw";
const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const COHORT = /^protected-([1-9][0-9]{0,19})-([1-9][0-9]{0,9})$/u;
const METADATA_LIMIT = 8 * 1024 * 1024;

export interface OpenClawImageIdentity {
  revision: string;
  workflowSha: string;
  cohort: string;
  platform: string;
  runtimeUser: string;
  baseReference: string;
}

type Receipt = OpenClawImageIdentity & {
  version: 1;
  configDigest: string;
  sourceReference: string;
  archiveSha256: string;
  archiveSize: number;
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OpenClaw image handoff metadata must be an object");
  }
  return value as Record<string, unknown>;
}

function validateIdentity(identity: OpenClawImageIdentity): void {
  if (
    !SHA.test(identity.revision) ||
    !SHA.test(identity.workflowSha) ||
    !COHORT.test(identity.cohort) ||
    !["linux/amd64", "linux/arm64"].includes(identity.platform) ||
    identity.runtimeUser !== "sandbox" ||
    !/^(?:ghcr\.io\/nvidia\/nemoclaw\/sandbox-base|localhost:5000\/nemoclaw-managed-protected-base\/openclaw)@sha256:[a-f0-9]{64}$/u.test(
      identity.baseReference,
    )
  )
    throw new Error("OpenClaw image handoff identity is invalid");
}

function regularFile(filename: string): number {
  const fd = fs.openSync(
    filename,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  if (!fs.fstatSync(fd).isFile()) {
    fs.closeSync(fd);
    throw new Error("OpenClaw image handoff input must be a regular file");
  }
  return fd;
}

function archiveDigest(filename: string): { archiveSha256: string; archiveSize: number } {
  const fd = regularFile(filename);
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let count: number;
    let archiveSize = 0;
    while ((count = fs.readSync(fd, buffer)) !== 0) {
      hash.update(buffer.subarray(0, count));
      archiveSize += count;
    }
    if (archiveSize === 0 || archiveSize !== fs.fstatSync(fd).size) {
      throw new Error("OpenClaw image archive size changed or is empty");
    }
    return { archiveSha256: hash.digest("hex"), archiveSize };
  } finally {
    fs.closeSync(fd);
  }
}

function readReceipt(directory: string): Receipt {
  const fd = regularFile(path.join(directory, "receipt.json"));
  try {
    if (fs.fstatSync(fd).size > METADATA_LIMIT)
      throw new Error("OpenClaw image receipt is too large");
    return object(JSON.parse(fs.readFileSync(fd, "utf8"))) as unknown as Receipt;
  } finally {
    fs.closeSync(fd);
  }
}

function docker(args: string[]): string {
  return execFileSync("docker", args, {
    encoding: "utf8",
    maxBuffer: METADATA_LIMIT,
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function inspectImage(reference: string, identity: OpenClawImageIdentity): string {
  const entries = JSON.parse(docker(["image", "inspect", reference]));
  if (!Array.isArray(entries) || entries.length !== 1)
    throw new Error("OpenClaw handoff requires one image");
  const image = object(entries[0]);
  if (
    typeof image.Id !== "string" ||
    !DIGEST.test(image.Id) ||
    `${image.Os}/${image.Architecture}` !== identity.platform
  ) {
    throw new Error("OpenClaw image does not match the content ID or platform");
  }
  validateConfig(image.Config, identity);
  return image.Id;
}

function validateConfig(value: unknown, identity: OpenClawImageIdentity): void {
  const config = object(value);
  const labels = object(config.Labels);
  const expectedLabels = {
    "org.opencontainers.image.source": "https://github.com/NVIDIA/NemoClaw",
    "org.opencontainers.image.revision": identity.revision,
    "io.nvidia.nemoclaw.agent": "openclaw",
    "io.nvidia.nemoclaw.managed-image.contract": "1",
    "io.nvidia.nemoclaw.managed-image.platform": identity.platform,
    "io.nvidia.nemoclaw.managed-image.startup-profile": "1",
    "io.nvidia.nemoclaw.managed-image.capabilities": "1",
    "io.nvidia.nemoclaw.managed-image.cohort": identity.cohort,
  };
  if (
    config.User !== identity.runtimeUser ||
    Object.entries(expectedLabels).some(([key, value]) => labels[key] !== value)
  ) {
    throw new Error("OpenClaw image does not match the source, cohort, platform or runtime user");
  }
}

function archiveEntry(archive: string, entry: string): string {
  return execFileSync("tar", ["-xOf", archive, entry], {
    encoding: "utf8",
    maxBuffer: METADATA_LIMIT,
  });
}

function imageTag(identity: OpenClawImageIdentity): string {
  return `${REPOSITORY}:${identity.revision}`;
}

function archiveNames(archive: string): Set<string> {
  // Inspect raw member types: bsdtar displays a regular member ending in /
  // as a directory, whereas Docker's importer treats it as a regular file.
  const members: { name: string; type: string }[] = JSON.parse(
    execFileSync(
      "python3",
      [
        "-c",
        `
import json, sys, tarfile
with tarfile.open(sys.argv[1], "r:") as archive:
    print(json.dumps([{"name": entry.name, "type": "-" if entry.isreg() else "d" if entry.isdir() else "unsupported"} for entry in archive]))
`,
        archive,
      ],
      { encoding: "utf8", maxBuffer: METADATA_LIMIT },
    ),
  );
  const seen = new Set<string>();
  const files = new Set<string>();
  for (const { name, type } of members) {
    const canonical = type === "d" && name.endsWith("/") ? name.slice(0, -1) : name;
    if (
      !["-", "d"].includes(type) ||
      !/^[a-zA-Z0-9._/-]+$/u.test(canonical) ||
      canonical === "." ||
      canonical === ".." ||
      canonical.endsWith("/") ||
      path.posix.normalize(canonical) !== canonical ||
      canonical.startsWith("/") ||
      canonical.startsWith("../") ||
      seen.has(canonical)
    ) {
      throw new Error(
        "OpenClaw archive paths must be regular files or directories with unique canonical names",
      );
    }
    seen.add(canonical);
    if (type === "-") files.add(canonical);
  }
  return files;
}

function descriptor(value: unknown): { digest: string; size: number; mediaType: string } {
  const result = object(value);
  if (
    typeof result.digest !== "string" ||
    !DIGEST.test(result.digest) ||
    typeof result.size !== "number" ||
    !Number.isSafeInteger(result.size) ||
    result.size < 0 ||
    typeof result.mediaType !== "string" ||
    result.urls !== undefined ||
    result.data !== undefined
  ) {
    throw new Error("OpenClaw OCI descriptor is invalid or requires external content");
  }
  return { digest: result.digest, size: result.size, mediaType: result.mediaType };
}

function validateNames(value: unknown, identity: OpenClawImageIdentity): void {
  const annotations = object(value ?? {});
  if (
    (annotations["io.containerd.image.name"] !== undefined &&
      annotations["io.containerd.image.name"] !== imageTag(identity)) ||
    (annotations["org.opencontainers.image.ref.name"] !== undefined &&
      annotations["org.opencontainers.image.ref.name"] !== identity.revision)
  ) {
    throw new Error("OpenClaw OCI archive contains an unexpected image alias");
  }
}

function validateOciArchive(
  archive: string,
  names: Set<string>,
  receipt: Pick<Receipt, "configDigest">,
  identity: OpenClawImageIdentity,
  layers: string[],
  configSize: number,
): void {
  if (!names.has("oci-layout") && !names.has("index.json")) return;
  if (
    !names.has("oci-layout") ||
    !names.has("index.json") ||
    object(JSON.parse(archiveEntry(archive, "oci-layout"))).imageLayoutVersion !== "1.0.0"
  ) {
    throw new Error("OpenClaw OCI layout is incomplete or unsupported");
  }
  const index = object(JSON.parse(archiveEntry(archive, "index.json")));
  if (
    index.schemaVersion !== 2 ||
    !Array.isArray(index.manifests) ||
    index.manifests.length !== 1 ||
    index.subject !== undefined
  ) {
    throw new Error("OpenClaw OCI index must select one image");
  }
  validateNames(index.annotations, identity);
  const selected = object(index.manifests[0]);
  validateNames(selected.annotations, identity);
  const desc = descriptor(selected);
  if (
    ![
      "application/vnd.oci.image.manifest.v1+json",
      "application/vnd.docker.distribution.manifest.v2+json",
    ].includes(desc.mediaType)
  ) {
    throw new Error("OpenClaw OCI index must select an image manifest");
  }
  // Docker's graphdriver exporter constructs an OCI manifest from uncompressed
  // layers. Its digest need not equal the registry manifest's digest. Verify
  // the archive descriptor itself, then bind its config and layers to the
  // CPU-tested config and Docker archive below.
  const bytes = archiveEntry(archive, `blobs/sha256/${desc.digest.slice(7)}`);
  if (
    Buffer.byteLength(bytes) !== desc.size ||
    `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== desc.digest
  ) {
    throw new Error("OpenClaw OCI manifest does not match its descriptor");
  }
  const manifest = object(JSON.parse(bytes));
  const config = descriptor(manifest.config);
  if (
    manifest.schemaVersion !== 2 ||
    manifest.mediaType !== desc.mediaType ||
    manifest.subject !== undefined ||
    config.digest !== receipt.configDigest ||
    config.size !== configSize ||
    ![
      "application/vnd.oci.image.config.v1+json",
      "application/vnd.docker.container.image.v1+json",
    ].includes(config.mediaType) ||
    !Array.isArray(manifest.layers) ||
    manifest.layers.length !== layers.length
  ) {
    throw new Error("OpenClaw OCI manifest does not match the archived config and layers");
  }
  validateNames(manifest.annotations, identity);
  for (const [i, value] of manifest.layers.entries()) {
    const layer = descriptor(value);
    if (
      !/^application\/vnd\.(?:oci\.image\.layer\.v1\.tar(?:\+gzip|\+zstd)?|docker\.image\.rootfs\.diff\.tar\.gzip)$/u.test(
        layer.mediaType,
      ) ||
      layers[i] !== `blobs/sha256/${layer.digest.slice(7)}` ||
      !names.has(layers[i])
    ) {
      throw new Error("OpenClaw OCI layer is missing or differs from the Docker manifest");
    }
  }
}

function validateArchiveManifest(
  archive: string,
  receipt: Pick<Receipt, "configDigest" | "sourceReference">,
  identity: OpenClawImageIdentity,
): void {
  const names = archiveNames(archive);
  const manifest = JSON.parse(archiveEntry(archive, "manifest.json"));
  if (!Array.isArray(manifest) || manifest.length !== 1)
    throw new Error("OpenClaw archive must contain one image");
  const entry = object(manifest[0]);
  const hex = receipt.configDigest.slice(7);
  if (
    typeof entry.Config !== "string" ||
    ![`${hex}.json`, `blobs/sha256/${hex}`].includes(entry.Config) ||
    !Array.isArray(entry.RepoTags) ||
    entry.RepoTags.length !== 1 ||
    entry.RepoTags[0] !== imageTag(identity) ||
    !Array.isArray(entry.Layers) ||
    !entry.Layers.every((layer): layer is string => typeof layer === "string" && names.has(layer))
  ) {
    throw new Error("OpenClaw archive must contain only the selected config and revision tag");
  }
  const configBytes = archiveEntry(archive, entry.Config);
  if (`sha256:${createHash("sha256").update(configBytes).digest("hex")}` !== receipt.configDigest) {
    throw new Error("OpenClaw archived config does not match the config digest");
  }
  const config = object(JSON.parse(configBytes));
  if (`${config.os}/${config.architecture}` !== identity.platform)
    throw new Error("OpenClaw archived platform does not match the selected platform");
  validateConfig(config.config, identity);
  validateOciArchive(
    archive,
    names,
    receipt,
    identity,
    entry.Layers,
    Buffer.byteLength(configBytes),
  );
}

export function exportOpenClawImage(
  directory: string,
  identity: OpenClawImageIdentity,
  reference: string,
): void {
  validateIdentity(identity);
  if (
    !reference.startsWith(`${REPOSITORY}@`) ||
    !DIGEST.test(reference.slice(REPOSITORY.length + 1))
  ) {
    throw new Error("OpenClaw source reference is not immutable");
  }
  const imageId = inspectImage(reference, identity);
  const tag = imageTag(identity);
  if (!docker(["image", "ls", "--quiet", "--no-trunc", tag]).trim())
    docker(["image", "tag", reference, tag]);
  if (inspectImage(tag, identity) !== imageId)
    throw new Error("OpenClaw revision tag changed before export");
  const manifestBytes = docker(["buildx", "imagetools", "inspect", reference, "--raw"]);
  if (
    `${REPOSITORY}@sha256:${createHash("sha256").update(manifestBytes).digest("hex")}` !== reference
  ) {
    throw new Error("OpenClaw source manifest does not match its immutable reference");
  }
  const configDigest = descriptor(object(JSON.parse(manifestBytes)).config).digest;
  fs.mkdirSync(directory, { mode: 0o700 });
  const archive = path.join(directory, "image.tar");
  docker(["image", "save", "--output", archive, tag]);
  validateArchiveManifest(archive, { configDigest, sourceReference: reference }, identity);
  const receipt: Receipt = {
    version: 1,
    ...identity,
    configDigest,
    sourceReference: reference,
    ...archiveDigest(archive),
  };
  fs.writeFileSync(path.join(directory, "receipt.json"), `${JSON.stringify(receipt)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}

export function restoreOpenClawImage(
  directory: string,
  identity: OpenClawImageIdentity,
): string | undefined {
  validateIdentity(identity);
  if (!fs.lstatSync(directory).isDirectory())
    throw new Error("OpenClaw image handoff directory must not be a symlink");
  const receipt = readReceipt(directory);
  validateIdentity(receipt);
  const producer = COHORT.exec(receipt.cohort)!;
  const consumer = COHORT.exec(identity.cohort)!;
  if (
    receipt.version !== 1 ||
    !DIGEST.test(receipt.configDigest) ||
    !receipt.sourceReference.startsWith(`${REPOSITORY}@`) ||
    !DIGEST.test(receipt.sourceReference.slice(REPOSITORY.length + 1)) ||
    !/^[a-f0-9]{64}$/u.test(receipt.archiveSha256) ||
    !Number.isSafeInteger(receipt.archiveSize) ||
    receipt.archiveSize <= 0 ||
    producer[1] !== consumer[1] ||
    BigInt(producer[2]) > BigInt(consumer[2]) ||
    Object.entries(identity).some(
      ([key, value]) => key !== "cohort" && receipt[key as keyof Receipt] !== value,
    )
  ) {
    throw new Error("OpenClaw image receipt does not match this workflow, candidate or input");
  }
  const archive = path.join(directory, "image.tar");
  const actual = archiveDigest(archive);
  if (
    actual.archiveSha256 !== receipt.archiveSha256 ||
    actual.archiveSize !== receipt.archiveSize
  ) {
    throw new Error("OpenClaw image archive does not match its receipt");
  }
  validateArchiveManifest(archive, receipt, receipt);
  // Earlier-attempt labels must not be presented as the current cohort.
  // The existing offline build remains the owner for that case.
  if (receipt.cohort !== identity.cohort) return undefined;
  const tag = imageTag(identity);
  if (docker(["image", "ls", "--quiet", "--no-trunc", tag]).trim())
    throw new Error("OpenClaw destination tag already exists");
  docker(["image", "load", "--input", archive]);
  inspectImage(tag, identity);
  docker(["image", "push", tag]);
  const manifest = docker(["buildx", "imagetools", "inspect", tag, "--raw"]);
  if (object(object(JSON.parse(manifest)).config).digest !== receipt.configDigest) {
    throw new Error("Published OpenClaw image changed its config digest");
  }
  // Docker can re-encode a manifest during push. Pin the resulting manifest,
  // while requiring the CPU-tested config and uncompressed layer identities.
  return `sha256:${createHash("sha256").update(manifest).digest("hex")}`;
}

function main(): void {
  const [
    command,
    directory,
    revision,
    cohort,
    platform,
    runtimeUser,
    baseReference,
    output,
    ...extra
  ] = process.argv.slice(2);
  if (!["export", "restore"].includes(command) || !directory || !output || extra.length) {
    throw new Error(
      "usage: protected-openclaw-image-handoff.mts <export|restore> <directory> <revision> <cohort> <platform> <runtime-user> <base-reference> <reference|metadata-output>",
    );
  }
  const identity = {
    revision,
    cohort,
    platform,
    runtimeUser,
    baseReference,
    workflowSha: process.env.NEMOCLAW_PROTECTED_MANAGED_IMAGE_WORKFLOW_SHA ?? "",
  };
  if (command === "export") exportOpenClawImage(directory, identity, output);
  else {
    const digest = restoreOpenClawImage(directory, identity);
    if (digest)
      fs.writeFileSync(output, JSON.stringify({ "containerimage.digest": digest }), {
        flag: "wx",
        mode: 0o600,
      });
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
