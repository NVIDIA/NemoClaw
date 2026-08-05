// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { HuggingFaceModelAcquisitionRequest } from "../model-acquisition/hugging-face";
import { acquireVerifiedLlamaCppGguf, verifyLlamaCppGgufCacheEntry } from "./gguf-acquisition";
import type { LlamaCppGgufCachePlan } from "./gguf-cache-plan";

const CONTENT = Buffer.from("verified GGUF fixture\n", "utf8");
const DIGEST = `sha256:${createHash("sha256").update(CONTENT).digest("hex")}`;
const REPOSITORY = "nvidia/test-gguf";
const REVISION = "a".repeat(40);
const FILENAME = "model.Q4_K_M.gguf";

function plan(
  overrides: {
    readonly digest?: string;
    readonly filename?: string;
    readonly repository?: string;
    readonly revision?: string;
    readonly sizeBytes?: number;
  } = {},
): LlamaCppGgufCachePlan {
  const file = {
    path: overrides.filename ?? FILENAME,
    digest: overrides.digest ?? DIGEST,
    sizeBytes: overrides.sizeBytes ?? CONTENT.length,
  };
  const repository = overrides.repository ?? REPOSITORY;
  const revision = overrides.revision ?? REVISION;
  return {
    schemaVersion: 1,
    recipeId: "test.llama.recipe",
    acquisition: {
      ref: "hugging-face-exact-file/v1",
      url: `https://huggingface.co/${repository}/resolve/${revision}/${file.path}`,
      authentication: { mode: "optional", environment: "HF_TOKEN" },
      source: { repository, revision, file },
    },
    cache: {
      ref: "llama-cpp.gguf-content-addressed/v1",
      receiptRef: "llama-cpp.gguf-cache-entry.receipt/v1",
      root: "user-cache",
      key: `sha256-${"b".repeat(64)}`,
      quotaBytes: 4096,
      stagingHeadroomBytes: 1024,
      staging: "same-filesystem",
      publication: "atomic-no-clobber",
      reuse: "verified-only-offline",
      sharing: "owner-only",
      cleanup: "receipt-owner-only",
    },
    planDigest: `sha256:${"c".repeat(64)}`,
  };
}

function modelCacheRoot(cacheRoot: string): string {
  return path.join(cacheRoot, "hub", "models--nvidia--test-gguf");
}

function snapshotEntry(cacheRoot: string, revision = REVISION): string {
  return path.join(modelCacheRoot(cacheRoot), "snapshots", revision, FILENAME);
}

async function createSnapshot(
  cacheRoot: string,
  content: Buffer = CONTENT,
  revision = REVISION,
): Promise<{ blob: string; entry: string }> {
  const modelRoot = modelCacheRoot(cacheRoot);
  const blob = path.join(modelRoot, "blobs", "fixture-blob");
  const entry = snapshotEntry(cacheRoot, revision);
  await mkdir(path.dirname(blob), { recursive: true });
  await mkdir(path.dirname(entry), { recursive: true });
  await writeFile(blob, content);
  await symlink(path.relative(path.dirname(entry), blob), entry);
  return { blob, entry };
}

const temporaryDirectories: string[] = [];

async function temporaryCache(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nemoclaw-gguf-acquisition-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function filesystemIdentity(file: string) {
  const status = await lstat(file, { bigint: true });
  return {
    ctimeNs: status.ctimeNs,
    dev: status.dev,
    ino: status.ino,
    mtimeNs: status.mtimeNs,
    size: status.size,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("llama.cpp GGUF acquisition", () => {
  it("passes the exact compiled repository, revision, and filename to Hugging Face (#8279)", async () => {
    const cacheRoot = await temporaryCache();
    const { blob } = await createSnapshot(cacheRoot);
    const acquire = vi.fn().mockResolvedValue({ ok: true });
    const execution = {
      credentialEnv: { HF_TOKEN: "hf_test_token" },
      dockerEnv: { DOCKER_HOST: "ssh://spark.example.test" },
      downloaderImage: `nvcr.io/nvidia/vllm@sha256:${"d".repeat(64)}`,
      hostCacheDir: cacheRoot,
      spawnDocker: vi.fn(),
      userIdentity: "1001:1001",
    } satisfies Omit<HuggingFaceModelAcquisitionRequest, "filename" | "repository" | "revision">;
    const observer = { logLine: vi.fn(), onRateLimit: vi.fn() };

    await expect(
      acquireVerifiedLlamaCppGguf(
        { execution, observer, plan: plan() },
        { acquireHuggingFaceModel: acquire },
      ),
    ).resolves.toEqual({
      digest: DIGEST,
      filesystemIdentity: await filesystemIdentity(blob),
      hostPath: await realpath(blob),
      sizeBytes: CONTENT.length,
    });
    expect(acquire).toHaveBeenCalledWith(
      {
        ...execution,
        filename: FILENAME,
        repository: REPOSITORY,
        revision: REVISION,
      },
      observer,
    );
  });

  it("resolves the standard snapshot symlink to its canonical regular blob (#8279)", async () => {
    const cacheRoot = await temporaryCache();
    const { blob } = await createSnapshot(cacheRoot);

    await expect(verifyLlamaCppGgufCacheEntry(plan(), cacheRoot)).resolves.toEqual({
      digest: DIGEST,
      filesystemIdentity: await filesystemIdentity(blob),
      hostPath: await realpath(blob),
      sizeBytes: CONTENT.length,
    });
  });

  it("accepts a compiler-valid 64-character immutable revision (#8279)", async () => {
    const cacheRoot = await temporaryCache();
    const revision = "d".repeat(64);
    const { blob } = await createSnapshot(cacheRoot, CONTENT, revision);

    await expect(verifyLlamaCppGgufCacheEntry(plan({ revision }), cacheRoot)).resolves.toEqual({
      digest: DIGEST,
      filesystemIdentity: await filesystemIdentity(blob),
      hostPath: await realpath(blob),
      sizeBytes: CONTENT.length,
    });
  });

  it("rejects a snapshot symlink that resolves outside its model cache (#8279)", async () => {
    const cacheRoot = await temporaryCache();
    const outside = path.join(cacheRoot, "outside.gguf");
    const entry = snapshotEntry(cacheRoot);
    await mkdir(path.dirname(entry), { recursive: true });
    await writeFile(outside, CONTENT);
    await symlink(path.relative(path.dirname(entry), outside), entry);

    await expect(verifyLlamaCppGgufCacheEntry(plan(), cacheRoot)).rejects.toThrow(
      "resolves outside its model cache",
    );
  });

  it("rejects a model cache that resolves outside the configured cache root (#8279)", async () => {
    const cacheRoot = await temporaryCache();
    const outsideModelCache = await temporaryCache();
    await mkdir(path.join(cacheRoot, "hub"), { recursive: true });
    await symlink(outsideModelCache, modelCacheRoot(cacheRoot), "dir");

    await expect(verifyLlamaCppGgufCacheEntry(plan(), cacheRoot)).rejects.toThrow(
      "resolves outside the configured cache root",
    );
  });

  it("rejects a path-bearing filename before acquisition (#8279)", async () => {
    const cacheRoot = await temporaryCache();
    const acquire = vi.fn();
    const execution = {
      dockerEnv: {},
      downloaderImage: `nvcr.io/nvidia/vllm@sha256:${"d".repeat(64)}`,
      hostCacheDir: cacheRoot,
      spawnDocker: vi.fn(),
      userIdentity: "1001:1001",
    } satisfies Omit<HuggingFaceModelAcquisitionRequest, "filename" | "repository" | "revision">;

    await expect(
      acquireVerifiedLlamaCppGguf(
        {
          execution,
          observer: { logLine: vi.fn(), onRateLimit: vi.fn() },
          plan: plan({ filename: "nested/model.gguf" }),
        },
        { acquireHuggingFaceModel: acquire },
      ),
    ).rejects.toThrow("invalid model identity");
    expect(acquire).not.toHaveBeenCalled();
  });

  it("rejects an invalid repository before direct cache verification (#8279)", async () => {
    const cacheRoot = await temporaryCache();

    await expect(
      verifyLlamaCppGgufCacheEntry(plan({ repository: "nvidia/model/foreign" }), cacheRoot),
    ).rejects.toThrow("invalid model identity");
  });

  it("rejects a cache entry that is not a regular file (#8279)", async () => {
    const cacheRoot = await temporaryCache();
    await mkdir(snapshotEntry(cacheRoot), { recursive: true });

    await expect(verifyLlamaCppGgufCacheEntry(plan(), cacheRoot)).rejects.toThrow(
      "does not resolve to the opened regular file",
    );
  });

  it("rejects a GGUF whose size differs from the compiled size (#8279)", async () => {
    const cacheRoot = await temporaryCache();
    await createSnapshot(cacheRoot);

    await expect(
      verifyLlamaCppGgufCacheEntry(plan({ sizeBytes: CONTENT.length + 1 }), cacheRoot),
    ).rejects.toThrow("size does not match");
  });

  it("rejects a GGUF whose SHA-256 differs from the compiled digest (#8279)", async () => {
    const cacheRoot = await temporaryCache();
    await createSnapshot(cacheRoot);

    await expect(
      verifyLlamaCppGgufCacheEntry(plan({ digest: `sha256:${"0".repeat(64)}` }), cacheRoot),
    ).rejects.toThrow("digest does not match");
  });
});
