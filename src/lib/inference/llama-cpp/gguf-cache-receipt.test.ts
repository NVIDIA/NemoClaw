// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { LlamaCppGgufCachePlan } from "./gguf-cache-plan";
import {
  createLlamaCppGgufCacheEntryReceipt,
  parseLlamaCppGgufCacheEntryReceipt,
  verifyLlamaCppGgufCacheEntryReceipt,
} from "./gguf-cache-receipt";

const PLAN: LlamaCppGgufCachePlan = {
  schemaVersion: 1,
  recipeId: "test.llama.recipe",
  acquisition: {
    ref: "hugging-face-exact-file/v1",
    url: `https://huggingface.co/test/model/resolve/${"a".repeat(40)}/model.gguf`,
    authentication: { mode: "optional", environment: "HF_TOKEN" },
    source: {
      repository: "test/model",
      revision: "a".repeat(40),
      file: { path: "model.gguf", digest: `sha256:${"b".repeat(64)}`, sizeBytes: 1024 },
    },
  },
  cache: {
    ref: "llama-cpp.gguf-content-addressed/v1",
    receiptRef: "llama-cpp.gguf-cache-entry.receipt/v1",
    root: "user-cache",
    key: `sha256-${"c".repeat(64)}`,
    quotaBytes: 2048,
    stagingHeadroomBytes: 512,
    staging: "same-filesystem",
    publication: "atomic-no-clobber",
    reuse: "verified-only-offline",
    sharing: "owner-only",
    cleanup: "receipt-owner-only",
  },
  planDigest: `sha256:${"d".repeat(64)}`,
};
const OWNER = { id: "gateway.primary", generation: "e".repeat(32) } as const;

describe("GGUF cache entry receipt", () => {
  it("round-trips the exact plan and owner identity without host paths or credentials (#8279)", () => {
    const receipt = createLlamaCppGgufCacheEntryReceipt(PLAN, OWNER);
    const serialized = JSON.stringify(receipt);

    expect(parseLlamaCppGgufCacheEntryReceipt(serialized, PLAN, OWNER)).toEqual(receipt);
    expect(serialized).not.toContain(PLAN.acquisition.url);
    expect(serialized).not.toContain("HF_TOKEN");
    expect(serialized).not.toMatch(/\/(?:Users|home|var)\//u);
  });

  it.each([
    ["an extra field", (receipt: Record<string, unknown>) => ({ ...receipt, path: "/tmp/model" })],
    [
      "a substituted plan digest",
      (receipt: Record<string, unknown>) => ({
        ...receipt,
        planDigest: `sha256:${"0".repeat(64)}`,
      }),
    ],
    [
      "a substituted cache key",
      (receipt: Record<string, unknown>) => ({
        ...receipt,
        cache: { ...(receipt.cache as object), key: `sha256-${"0".repeat(64)}` },
      }),
    ],
    [
      "a substituted model file",
      (receipt: Record<string, unknown>) => ({
        ...receipt,
        model: {
          ...(receipt.model as object),
          file: { ...(receipt.model as { file: object }).file, path: "other.gguf" },
        },
      }),
    ],
    [
      "a foreign owner",
      (receipt: Record<string, unknown>) => ({
        ...receipt,
        owner: { id: "gateway.foreign", generation: OWNER.generation },
      }),
    ],
  ])("rejects %s (#8279)", (_case, mutate) => {
    const receipt = createLlamaCppGgufCacheEntryReceipt(PLAN, OWNER);
    expect(() =>
      verifyLlamaCppGgufCacheEntryReceipt(
        mutate(receipt as unknown as Record<string, unknown>),
        PLAN,
        OWNER,
      ),
    ).toThrow();
  });

  it("rejects malformed receipt JSON (#8279)", () => {
    expect(() => parseLlamaCppGgufCacheEntryReceipt("not-json", PLAN, OWNER)).toThrow(
      "not valid JSON",
    );
  });

  it("rejects an owner ID that contains a path separator (#8279)", () => {
    expect(() =>
      createLlamaCppGgufCacheEntryReceipt(PLAN, {
        id: "../foreign",
        generation: OWNER.generation,
      }),
    ).toThrow("owner does not match");
  });
});
