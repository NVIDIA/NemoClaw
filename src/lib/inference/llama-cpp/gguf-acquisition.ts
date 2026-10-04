// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import {
  acquireHuggingFaceModel,
  type HuggingFaceModelAcquisitionObserver,
  type HuggingFaceModelAcquisitionRequest,
  isValidHuggingFaceRepositoryId,
} from "../model-acquisition/hugging-face";
import type { LlamaCppGgufCachePlan } from "./gguf-cache-plan";
import type { VerifiedLocalModelArtifact } from "./host-local-runtime";

const GGUF_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,249}\.gguf$/u;
const IMMUTABLE_HUGGING_FACE_REVISION = /^[0-9a-f]{40,64}$/u;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const HASH_BUFFER_BYTES = 1024 * 1024;

type HuggingFaceExecutionRequest = Omit<
  HuggingFaceModelAcquisitionRequest,
  "filename" | "repository" | "revision"
>;

export interface LlamaCppGgufAcquisitionRequest {
  /** Revalidate the exact Docker endpoint before and after forwarding credentials. */
  readonly assertDockerAuthority?: () => void;
  readonly execution: HuggingFaceExecutionRequest;
  readonly observer: HuggingFaceModelAcquisitionObserver;
  readonly plan: LlamaCppGgufCachePlan;
}

export interface LlamaCppGgufAcquisitionDependencies {
  readonly acquireHuggingFaceModel?: typeof acquireHuggingFaceModel;
}

export class LlamaCppGgufAcquisitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlamaCppGgufAcquisitionError";
  }
}

function fail(message: string): never {
  throw new LlamaCppGgufAcquisitionError(message);
}

function validatePlanSource(plan: LlamaCppGgufCachePlan): void {
  const { file, repository, revision } = plan.acquisition.source;
  if (
    plan.acquisition.ref !== "hugging-face-exact-file/v1" ||
    !isValidHuggingFaceRepositoryId(repository) ||
    !IMMUTABLE_HUGGING_FACE_REVISION.test(revision) ||
    !GGUF_FILENAME.test(file.path) ||
    !SHA256_DIGEST.test(file.digest) ||
    !Number.isSafeInteger(file.sizeBytes) ||
    file.sizeBytes < 1
  ) {
    fail("The llama.cpp GGUF acquisition plan has an invalid model identity.");
  }
}

function isDescendant(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileState(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function requireCanonicalDirectory(directory: string, label: string): Promise<string> {
  let canonical: string;
  let status: BigIntStats;
  try {
    canonical = await realpath(directory);
    status = await lstat(canonical, { bigint: true });
  } catch {
    fail(`${label} is unavailable.`);
  }
  if (!status.isDirectory()) fail(`${label} is not a directory.`);
  return canonical;
}

async function hashOpenFile(
  handle: Awaited<ReturnType<typeof open>>,
): Promise<{ digest: string; sizeBytes: number }> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  let sizeBytes = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    sizeBytes += bytesRead;
    if (!Number.isSafeInteger(sizeBytes)) {
      fail("The acquired GGUF size exceeds the JavaScript safe-integer range.");
    }
  }
  return { digest: `sha256:${hash.digest("hex")}`, sizeBytes };
}

function modelCacheEntryPath(plan: LlamaCppGgufCachePlan, hostCacheDir: string): string {
  const { file, repository, revision } = plan.acquisition.source;
  const modelCacheKey = `models--${repository.replaceAll("/", "--")}`;
  return path.join(hostCacheDir, "hub", modelCacheKey, "snapshots", revision, file.path);
}

/** Verify one exact GGUF in the Hugging Face Hub cache by hashing it in 1 MiB chunks. */
export async function verifyLlamaCppGgufCacheEntry(
  plan: LlamaCppGgufCachePlan,
  hostCacheDir: string,
): Promise<VerifiedLocalModelArtifact> {
  validatePlanSource(plan);
  const cacheRoot = await requireCanonicalDirectory(hostCacheDir, "The Hugging Face cache root");
  const modelCachePath = path.join(
    hostCacheDir,
    "hub",
    `models--${plan.acquisition.source.repository.replaceAll("/", "--")}`,
  );
  const modelCacheRoot = await requireCanonicalDirectory(
    modelCachePath,
    "The Hugging Face model cache",
  );
  if (!isDescendant(cacheRoot, modelCacheRoot)) {
    fail("The Hugging Face model cache resolves outside the configured cache root.");
  }

  const snapshotEntry = modelCacheEntryPath(plan, hostCacheDir);
  let canonicalTarget: string;
  try {
    canonicalTarget = await realpath(snapshotEntry);
  } catch {
    fail("The acquired GGUF cache entry is unavailable.");
  }
  if (!isDescendant(modelCacheRoot, canonicalTarget)) {
    fail("The acquired GGUF cache entry resolves outside its model cache.");
  }

  let handle: Awaited<ReturnType<typeof open>>;
  if (typeof constants.O_NOFOLLOW !== "number" || typeof constants.O_NONBLOCK !== "number") {
    fail("The host does not provide the file flags required for GGUF verification.");
  }
  try {
    handle = await open(
      canonicalTarget,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    fail("The acquired GGUF cache entry is not a readable regular file.");
  }

  try {
    const beforeDescriptor = await handle.stat({ bigint: true });
    const beforePath = await lstat(canonicalTarget, { bigint: true });
    if (
      !beforeDescriptor.isFile() ||
      !beforePath.isFile() ||
      !sameFileIdentity(beforeDescriptor, beforePath)
    ) {
      fail("The acquired GGUF cache entry does not resolve to the opened regular file.");
    }

    const expectedSize = BigInt(plan.acquisition.source.file.sizeBytes);
    if (beforeDescriptor.size !== expectedSize) {
      fail("The acquired GGUF size does not match the declarative model identity.");
    }

    const actual = await hashOpenFile(handle);
    const afterDescriptor = await handle.stat({ bigint: true });
    let afterPath: BigIntStats;
    let targetAfterVerification: string;
    let cacheRootAfterVerification: string;
    let modelCacheRootAfterVerification: string;
    try {
      afterPath = await lstat(canonicalTarget, { bigint: true });
      targetAfterVerification = await realpath(snapshotEntry);
      cacheRootAfterVerification = await realpath(hostCacheDir);
      modelCacheRootAfterVerification = await realpath(modelCachePath);
    } catch {
      fail("The acquired GGUF cache entry changed during verification.");
    }
    if (
      !afterPath.isFile() ||
      !sameFileState(beforeDescriptor, afterDescriptor) ||
      !sameFileState(afterDescriptor, afterPath) ||
      targetAfterVerification !== canonicalTarget ||
      cacheRootAfterVerification !== cacheRoot ||
      modelCacheRootAfterVerification !== modelCacheRoot
    ) {
      fail("The acquired GGUF cache entry changed during verification.");
    }
    if (actual.sizeBytes !== plan.acquisition.source.file.sizeBytes) {
      fail("The acquired GGUF size does not match the declarative model identity.");
    }
    if (actual.digest !== plan.acquisition.source.file.digest) {
      fail("The acquired GGUF digest does not match the declarative model identity.");
    }

    return {
      digest: actual.digest,
      filesystemIdentity: {
        ctimeNs: afterDescriptor.ctimeNs,
        dev: afterDescriptor.dev,
        ino: afterDescriptor.ino,
        mtimeNs: afterDescriptor.mtimeNs,
        size: afterDescriptor.size,
      },
      hostPath: canonicalTarget,
      sizeBytes: actual.sizeBytes,
    };
  } finally {
    await handle.close();
  }
}

/** Acquire the plan-selected Hugging Face file and return its verified local artifact. */
export async function acquireVerifiedLlamaCppGguf(
  request: LlamaCppGgufAcquisitionRequest,
  dependencies: LlamaCppGgufAcquisitionDependencies = {},
): Promise<VerifiedLocalModelArtifact> {
  validatePlanSource(request.plan);
  const acquire = dependencies.acquireHuggingFaceModel ?? acquireHuggingFaceModel;
  const { file, repository, revision } = request.plan.acquisition.source;
  request.assertDockerAuthority?.();
  let result: Awaited<ReturnType<typeof acquire>>;
  try {
    result = await acquire(
      {
        ...request.execution,
        filename: file.path,
        repository,
        revision,
      },
      request.observer,
    );
  } finally {
    request.assertDockerAuthority?.();
  }
  if (!result.ok) fail(`Hugging Face model acquisition failed: ${result.reason}`);
  return verifyLlamaCppGgufCacheEntry(request.plan, request.execution.hostCacheDir);
}
