// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import type { LlamaCppServingRecipe } from "../serving/types";

export const LLAMA_CPP_GGUF_CACHE_PLAN_SCHEMA_VERSION = 1 as const;

export interface LlamaCppGgufCachePlan {
  readonly schemaVersion: typeof LLAMA_CPP_GGUF_CACHE_PLAN_SCHEMA_VERSION;
  readonly recipeId: string;
  readonly acquisition: {
    readonly ref: "hugging-face-exact-file/v1";
    readonly downloaderImage: string;
    readonly url: string;
    readonly authentication: {
      readonly mode: "optional";
      readonly environment: "HF_TOKEN";
    };
    readonly source: {
      readonly repository: string;
      readonly revision: string;
      readonly file: {
        readonly path: string;
        readonly digest: string;
        readonly sizeBytes: number;
      };
    };
  };
  readonly cache: {
    readonly ref: "hugging-face-shared-cache/v1";
    readonly root: "user-cache";
    readonly key: string;
    readonly reuse: "verify-exact-file";
    readonly sharing: "host-user";
    readonly cleanup: "preserve";
  };
  readonly planDigest: string;
}

export class LlamaCppGgufCachePlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlamaCppGgufCachePlanError";
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeForCanonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeForCanonicalJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, nested]) => [key, normalizeForCanonicalJson(nested)]),
    );
  }
  return value;
}

function digest(value: unknown): string {
  const canonicalJson = JSON.stringify(normalizeForCanonicalJson(value));
  return `sha256:${createHash("sha256").update(canonicalJson).digest("hex")}`;
}

/** Reject a plan whose recorded digest does not match its canonical declarative payload. */
export function assertLlamaCppGgufCachePlanDigest(plan: LlamaCppGgufCachePlan): void {
  const { planDigest, ...payload } = plan;
  if (planDigest !== digest(payload)) {
    throw new LlamaCppGgufCachePlanError(
      "The llama.cpp GGUF cache plan digest does not match its canonical payload.",
    );
  }
}

function assertDeclarativeContract(recipe: LlamaCppServingRecipe): void {
  const { acquisition, cache, files } = recipe.spec.model;
  if (recipe.spec.backend !== "install-llama-cpp" || recipe.spec.providerId !== "llama-cpp-local") {
    throw new LlamaCppGgufCachePlanError("The recipe is not a typed llama.cpp recipe.");
  }
  if (
    acquisition.ref !== "hugging-face-exact-file/v1" ||
    !/@sha256:[0-9a-f]{64}$/u.test(acquisition.downloaderImage) ||
    acquisition.authentication.mode !== "optional" ||
    acquisition.authentication.environment !== "HF_TOKEN"
  ) {
    throw new LlamaCppGgufCachePlanError("The recipe has an unsupported acquisition contract.");
  }
  if (
    cache.ref !== "hugging-face-shared-cache/v1" ||
    cache.root !== "user-cache" ||
    cache.reuse !== "verify-exact-file" ||
    cache.sharing !== "host-user" ||
    cache.cleanup !== "preserve"
  ) {
    throw new LlamaCppGgufCachePlanError("The recipe has an unsupported cache contract.");
  }
  if (
    recipe.spec.policy.egress !== "disabled" ||
    recipe.spec.policy.modelSource !== "verified-local" ||
    recipe.spec.policy.modelDownloads !== "disabled"
  ) {
    throw new LlamaCppGgufCachePlanError("The recipe permits runtime model acquisition.");
  }
  if (files.length !== 1) {
    throw new LlamaCppGgufCachePlanError("The recipe must identify one GGUF file.");
  }
}

function huggingFaceExactFileUrl(repository: string, revision: string, path: string): string {
  const [namespace, name] = repository.split("/");
  if (!namespace || !name || repository.split("/").length !== 2) {
    throw new LlamaCppGgufCachePlanError("The model repository identity is invalid.");
  }
  return `https://huggingface.co/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/resolve/${encodeURIComponent(revision)}/${encodeURIComponent(path)}`;
}

export function compileLlamaCppGgufCachePlan(recipe: LlamaCppServingRecipe): LlamaCppGgufCachePlan {
  assertDeclarativeContract(recipe);
  const file = recipe.spec.model.files[0]!;
  const { acquisition, cache } = recipe.spec.model;
  const source = {
    repository: recipe.spec.model.id,
    revision: recipe.spec.model.revision,
    file: {
      path: file.path,
      digest: file.digest,
      sizeBytes: file.sizeBytes,
    },
  } as const;
  const cacheKey = digest(source).replace("sha256:", "sha256-");
  const payload = {
    schemaVersion: LLAMA_CPP_GGUF_CACHE_PLAN_SCHEMA_VERSION,
    recipeId: recipe.metadata.id,
    acquisition: {
      ref: acquisition.ref,
      downloaderImage: acquisition.downloaderImage,
      url: huggingFaceExactFileUrl(source.repository, source.revision, source.file.path),
      authentication: acquisition.authentication,
      source,
    },
    cache: {
      ref: cache.ref,
      root: cache.root,
      key: cacheKey,
      reuse: cache.reuse,
      sharing: cache.sharing,
      cleanup: cache.cleanup,
    },
  } as const;

  return { ...payload, planDigest: digest(payload) };
}
