// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { loadManagedInferenceCatalog } from "./catalog-loader";
import {
  type HuggingFaceReferenceFetch,
  verifyHuggingFaceModelReferences,
} from "./hugging-face-model-verification";
import type { ServingModelDefinition } from "./types";

function model(id = "nvidia/Test-Model", revision = "a".repeat(40)): ServingModelDefinition {
  const source = loadManagedInferenceCatalog().models[0]!;
  return {
    ...source,
    metadata: { ...source.metadata, id: "vllm.test-model.v1" },
    spec: { ...source.spec, id, revision },
  };
}

function response(status: number, statusText = ""): Pick<Response, "ok" | "status" | "statusText"> {
  return { ok: status >= 200 && status < 300, status, statusText };
}

describe("Hugging Face model reference verification", () => {
  it("checks every catalog model at its pinned config without credentials", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchReference: HuggingFaceReferenceFetch = vi.fn(async (input, init) => {
      requests.push({ url: String(input), init });
      return response(200);
    });
    const catalog = loadManagedInferenceCatalog();

    await verifyHuggingFaceModelReferences(catalog.models, {
      fetch: fetchReference,
      sleep: async () => {},
    });

    expect(requests.map(({ url }) => url)).toEqual(
      catalog.models.map(
        ({ spec }) =>
          `https://huggingface.co/${spec.id}/resolve/${encodeURIComponent(spec.revision)}/config.json`,
      ),
    );
    expect(requests.every(({ init }) => init.method === "HEAD")).toBe(true);
    expect(requests.every(({ init }) => !new Headers(init.headers).has("authorization"))).toBe(
      true,
    );
  });

  it("rejects an unknown repository or revision without retrying", async () => {
    const fetchReference: HuggingFaceReferenceFetch = vi.fn(async () => response(404, "Not Found"));
    const wait = vi.fn(async () => {});

    await expect(
      verifyHuggingFaceModelReferences([model()], { fetch: fetchReference, sleep: wait }),
    ).rejects.toThrow(/returned HTTP 404 Not Found/u);
    expect(fetchReference).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });

  it("retries only transient responses with a bounded delay", async () => {
    const fetchReference: HuggingFaceReferenceFetch = vi
      .fn()
      .mockResolvedValueOnce(response(429))
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(200));
    const wait = vi.fn(async () => {});

    await expect(
      verifyHuggingFaceModelReferences([model()], { fetch: fetchReference, sleep: wait }),
    ).resolves.toBeUndefined();
    expect(fetchReference).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toEqual([[250], [1_000]]);
  });

  it("retries transport failures with the bounded delay schedule", async () => {
    const fetchReference: HuggingFaceReferenceFetch = vi.fn(async () => {
      throw new Error("network unavailable");
    });
    const wait = vi.fn(async () => {});

    await expect(
      verifyHuggingFaceModelReferences([model()], { fetch: fetchReference, sleep: wait }),
    ).rejects.toThrow(/after 3 attempts: network unavailable/u);
    expect(fetchReference).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toEqual([[250], [1_000]]);
  });

  it("requires credential-free metadata for private model references", async () => {
    const fetchReference: HuggingFaceReferenceFetch = vi.fn(async () => response(401));

    await expect(
      verifyHuggingFaceModelReferences([model()], {
        fetch: fetchReference,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/must be visible to credential-free pull request validation/u);
  });

  it.each([
    ["model ID", "https://example.com/model", "a".repeat(40)],
    ["model ID", "../model", "a".repeat(40)],
    ["revision", "nvidia/Test-Model", "main"],
  ])("rejects an invalid %s before making a request", async (_field, id, revision) => {
    const fetchReference: HuggingFaceReferenceFetch = vi.fn(async () => response(200));

    await expect(
      verifyHuggingFaceModelReferences([model(id, revision)], { fetch: fetchReference }),
    ).rejects.toThrow(/Invalid Hugging Face/u);
    expect(fetchReference).not.toHaveBeenCalled();
  });
});
