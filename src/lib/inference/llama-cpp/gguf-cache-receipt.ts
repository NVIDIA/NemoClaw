// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { LlamaCppGgufCachePlan } from "./gguf-cache-plan";

export const LLAMA_CPP_GGUF_CACHE_RECEIPT_SCHEMA_VERSION = 1 as const;

export interface LlamaCppGgufCacheOwner {
  readonly id: string;
  readonly generation: string;
}

export interface LlamaCppGgufCacheEntryReceipt {
  readonly schemaVersion: typeof LLAMA_CPP_GGUF_CACHE_RECEIPT_SCHEMA_VERSION;
  readonly receiptRef: "llama-cpp.gguf-cache-entry.receipt/v1";
  readonly planDigest: string;
  readonly recipeId: string;
  readonly cache: {
    readonly ref: "llama-cpp.gguf-content-addressed/v1";
    readonly key: string;
  };
  readonly model: {
    readonly repository: string;
    readonly revision: string;
    readonly file: {
      readonly path: string;
      readonly digest: string;
      readonly sizeBytes: number;
    };
  };
  readonly owner: LlamaCppGgufCacheOwner;
}

export class LlamaCppGgufCacheReceiptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlamaCppGgufCacheReceiptError";
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LlamaCppGgufCacheReceiptError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new LlamaCppGgufCacheReceiptError(`${label} has invalid fields.`);
  }
}

function validateOwner(value: unknown, expected: LlamaCppGgufCacheOwner): LlamaCppGgufCacheOwner {
  const owner = record(value, "GGUF cache receipt owner");
  requireExactKeys(owner, ["generation", "id"], "GGUF cache receipt owner");
  if (
    typeof owner.id !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(owner.id) ||
    typeof owner.generation !== "string" ||
    !/^[0-9a-f]{32}$/u.test(owner.generation) ||
    owner.id !== expected.id ||
    owner.generation !== expected.generation
  ) {
    throw new LlamaCppGgufCacheReceiptError("GGUF cache receipt owner does not match.");
  }
  return { id: owner.id, generation: owner.generation };
}

export function createLlamaCppGgufCacheEntryReceipt(
  plan: LlamaCppGgufCachePlan,
  owner: LlamaCppGgufCacheOwner,
): LlamaCppGgufCacheEntryReceipt {
  validateOwner(owner, owner);
  return {
    schemaVersion: LLAMA_CPP_GGUF_CACHE_RECEIPT_SCHEMA_VERSION,
    receiptRef: plan.cache.receiptRef,
    planDigest: plan.planDigest,
    recipeId: plan.recipeId,
    cache: { ref: plan.cache.ref, key: plan.cache.key },
    model: plan.acquisition.source,
    owner,
  };
}

export function verifyLlamaCppGgufCacheEntryReceipt(
  value: unknown,
  plan: LlamaCppGgufCachePlan,
  expectedOwner: LlamaCppGgufCacheOwner,
): LlamaCppGgufCacheEntryReceipt {
  const receipt = record(value, "GGUF cache receipt");
  requireExactKeys(
    receipt,
    ["cache", "model", "owner", "planDigest", "receiptRef", "recipeId", "schemaVersion"],
    "GGUF cache receipt",
  );
  const cache = record(receipt.cache, "GGUF cache receipt cache identity");
  requireExactKeys(cache, ["key", "ref"], "GGUF cache receipt cache identity");
  const model = record(receipt.model, "GGUF cache receipt model identity");
  requireExactKeys(model, ["file", "repository", "revision"], "GGUF cache receipt model identity");
  const file = record(model.file, "GGUF cache receipt model file");
  requireExactKeys(file, ["digest", "path", "sizeBytes"], "GGUF cache receipt model file");

  const expected = createLlamaCppGgufCacheEntryReceipt(plan, expectedOwner);
  if (
    receipt.schemaVersion !== expected.schemaVersion ||
    receipt.receiptRef !== expected.receiptRef ||
    receipt.planDigest !== expected.planDigest ||
    receipt.recipeId !== expected.recipeId ||
    cache.ref !== expected.cache.ref ||
    cache.key !== expected.cache.key ||
    model.repository !== expected.model.repository ||
    model.revision !== expected.model.revision ||
    file.path !== expected.model.file.path ||
    file.digest !== expected.model.file.digest ||
    file.sizeBytes !== expected.model.file.sizeBytes
  ) {
    throw new LlamaCppGgufCacheReceiptError("GGUF cache receipt identity does not match the plan.");
  }

  return { ...expected, owner: validateOwner(receipt.owner, expectedOwner) };
}

export function parseLlamaCppGgufCacheEntryReceipt(
  source: string,
  plan: LlamaCppGgufCachePlan,
  expectedOwner: LlamaCppGgufCacheOwner,
): LlamaCppGgufCacheEntryReceipt {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new LlamaCppGgufCacheReceiptError("GGUF cache receipt is not valid JSON.");
  }
  return verifyLlamaCppGgufCacheEntryReceipt(value, plan, expectedOwner);
}
