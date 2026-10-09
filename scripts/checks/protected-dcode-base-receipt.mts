// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROTECTED_MANAGED_IMAGE_AGENTS } from "./protected-managed-image-contract.ts";

export const PROTECTED_DCODE_BASE_REPOSITORY =
  "localhost:5000/nemoclaw-managed-protected-base/langchain-deepagents-code";
const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const COHORT = /^protected-[1-9][0-9]{0,19}-[1-9][0-9]{0,9}$/u;
const MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const CONFIG = "application/vnd.oci.image.config.v1+json";
const LAYERS = new Set([
  "application/vnd.oci.image.layer.v1.tar",
  "application/vnd.oci.image.layer.v1.tar+gzip",
  "application/vnd.oci.image.layer.v1.tar+zstd",
]);

export type ProtectedDcodeBaseIdentity = {
  sourceRevision: string;
  workflowSha: string;
  cohort: string;
  platform: "linux/amd64" | "linux/arm64";
};

export type ProtectedDcodeBaseReceipt = ProtectedDcodeBaseIdentity & {
  version: 1;
  digest: string;
  imageId: string;
  reference: string;
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("protected DCode base metadata must be an object");
  }
  return value as Record<string, unknown>;
}

function validateIdentity(identity: ProtectedDcodeBaseIdentity): void {
  if (
    !SHA.test(identity.sourceRevision) ||
    !SHA.test(identity.workflowSha) ||
    !COHORT.test(identity.cohort) ||
    !["linux/amd64", "linux/arm64"].includes(identity.platform)
  ) {
    throw new Error("protected DCode base identity is invalid");
  }
}

function regularFile(filename: string): number {
  const fd = fs.openSync(
    filename,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  if (!fs.fstatSync(fd).isFile()) {
    fs.closeSync(fd);
    throw new Error("protected DCode base input must be a regular file");
  }
  return fd;
}

function readJson(filename: string): Record<string, unknown> {
  const fd = regularFile(filename);
  try {
    if (fs.fstatSync(fd).size > 8 * 1024 * 1024) {
      throw new Error("protected DCode base metadata is too large");
    }
    return record(JSON.parse(fs.readFileSync(fd, "utf8")));
  } finally {
    fs.closeSync(fd);
  }
}

function descriptor(value: unknown, types: ReadonlySet<string>) {
  const entry = record(value);
  if (
    typeof entry.digest !== "string" ||
    !DIGEST.test(entry.digest) ||
    !Number.isSafeInteger(entry.size) ||
    Number(entry.size) < 0 ||
    typeof entry.mediaType !== "string" ||
    !types.has(entry.mediaType) ||
    entry.urls !== undefined ||
    entry.data !== undefined
  ) {
    throw new Error("protected DCode base descriptor is invalid or requires external content");
  }
  return { digest: entry.digest, size: Number(entry.size) };
}

function verifyBlob(layout: string, entry: { digest: string; size: number }, collect: true): Buffer;
function verifyBlob(layout: string, entry: { digest: string; size: number }, collect?: false): void;
function verifyBlob(
  layout: string,
  entry: { digest: string; size: number },
  collect = false,
): Buffer | void {
  if (collect && entry.size > 8 * 1024 * 1024) {
    throw new Error("protected DCode base metadata is too large");
  }
  const filename = path.join(layout, "blobs", "sha256", entry.digest.slice(7));
  const fd = regularFile(filename);
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    if (fs.fstatSync(fd).size !== entry.size) {
      throw new Error("protected DCode base blob size does not match its descriptor");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let count: number;
    while ((count = fs.readSync(fd, buffer)) !== 0) {
      const bytes = buffer.subarray(0, count);
      hash.update(bytes);
      if (collect) chunks.push(Buffer.from(bytes));
      total += count;
    }
    if (total !== entry.size) {
      throw new Error("protected DCode base blob size does not match its descriptor");
    }
    if (`sha256:${hash.digest("hex")}` !== entry.digest) {
      throw new Error("protected DCode base blob digest does not match its descriptor");
    }
  } finally {
    fs.closeSync(fd);
  }
  if (collect) return Buffer.concat(chunks, total);
}

function verifiedJsonBlob(layout: string, entry: { digest: string; size: number }) {
  return record(JSON.parse(verifyBlob(layout, entry, true).toString("utf8")));
}

/** Verify all OCI content before the protected runner accepts an offline base. */
export function inspectProtectedDcodeBase(
  layout: string,
  expected: ProtectedDcodeBaseIdentity,
  agent: (typeof PROTECTED_MANAGED_IMAGE_AGENTS)[number] = "langchain-deepagents-code",
): ProtectedDcodeBaseReceipt {
  validateIdentity(expected);
  if (!PROTECTED_MANAGED_IMAGE_AGENTS.includes(agent)) {
    throw new Error("protected base agent is not supported");
  }
  for (const directory of [layout, path.join(layout, "blobs"), path.join(layout, "blobs/sha256")]) {
    if (!fs.lstatSync(directory).isDirectory()) {
      throw new Error("protected DCode base layout directories must not be symlinks");
    }
  }
  if (readJson(path.join(layout, "oci-layout")).imageLayoutVersion !== "1.0.0") {
    throw new Error("protected DCode base OCI layout version is invalid");
  }
  const index = readJson(path.join(layout, "index.json"));
  if (
    index.schemaVersion !== 2 ||
    !Array.isArray(index.manifests) ||
    index.manifests.length !== 1
  ) {
    throw new Error("protected DCode base must contain one OCI image manifest");
  }
  const manifestDescriptor = descriptor(index.manifests[0], new Set([MANIFEST]));
  const manifest = verifiedJsonBlob(layout, manifestDescriptor);
  if (
    manifest.schemaVersion !== 2 ||
    manifest.mediaType !== MANIFEST ||
    !Array.isArray(manifest.layers)
  ) {
    throw new Error("protected DCode base image manifest is invalid");
  }
  const configDescriptor = descriptor(manifest.config, new Set([CONFIG]));
  const config = verifiedJsonBlob(layout, configDescriptor);
  for (const layer of manifest.layers) verifyBlob(layout, descriptor(layer, LAYERS));
  const labels = record(record(config.config).Labels);
  if (
    `${config.os}/${config.architecture}` !== expected.platform ||
    labels["org.opencontainers.image.revision"] !== expected.sourceRevision ||
    labels["org.opencontainers.image.source"] !== "https://github.com/NVIDIA/NemoClaw" ||
    labels["io.nvidia.nemoclaw.managed-image.cohort"] !== expected.cohort ||
    labels["io.nvidia.nemoclaw.agent"] !== agent
  ) {
    throw new Error(
      "protected DCode base config does not match the selected source, run or platform",
    );
  }
  return {
    version: 1,
    ...expected,
    digest: manifestDescriptor.digest,
    imageId: configDescriptor.digest,
    reference: `localhost:5000/nemoclaw-managed-protected-base/${agent}@${manifestDescriptor.digest}`,
  };
}

export function verifyProtectedDcodeBaseReceipt(
  layout: string,
  receiptPath: string,
  expected: ProtectedDcodeBaseIdentity,
  agent: (typeof PROTECTED_MANAGED_IMAGE_AGENTS)[number] = "langchain-deepagents-code",
): ProtectedDcodeBaseReceipt {
  const receipt = readJson(receiptPath);
  const actual = inspectProtectedDcodeBase(layout, expected, agent);
  const keys = Object.keys(actual) as (keyof ProtectedDcodeBaseReceipt)[];
  if (
    Object.keys(receipt).length !== keys.length ||
    keys.some((key) => receipt[key] !== actual[key])
  ) {
    throw new Error(
      "protected DCode base receipt does not match verified OCI content and dispatch identity",
    );
  }
  return actual;
}

function main(): void {
  const [command, layout, receiptPath, agent = "langchain-deepagents-code", ...extra] =
    process.argv.slice(2);
  if (!["write", "verify"].includes(command) || !layout || !receiptPath || extra.length) {
    throw new Error(
      "usage: protected-dcode-base-receipt.mts <write|verify> <OCI layout> <receipt> [agent]",
    );
  }
  const expected: ProtectedDcodeBaseIdentity = {
    sourceRevision: process.env.CHECKOUT_SHA ?? "",
    workflowSha: process.env.NEMOCLAW_PROTECTED_MANAGED_IMAGE_WORKFLOW_SHA ?? "",
    cohort: process.env.NEMOCLAW_PROTECTED_MANAGED_IMAGE_COHORT ?? "",
    platform: (process.env.NEMOCLAW_PROTECTED_MANAGED_IMAGE_PLATFORM ??
      "") as ProtectedDcodeBaseIdentity["platform"],
  };
  const receipt =
    command === "write"
      ? inspectProtectedDcodeBase(
          layout,
          expected,
          agent as (typeof PROTECTED_MANAGED_IMAGE_AGENTS)[number],
        )
      : verifyProtectedDcodeBaseReceipt(
          layout,
          receiptPath,
          expected,
          agent as (typeof PROTECTED_MANAGED_IMAGE_AGENTS)[number],
        );
  if (command === "write") {
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  }
  process.stdout.write(`${receipt.reference}\n`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "invalid protected DCode base receipt");
    process.exitCode = 1;
  }
}
