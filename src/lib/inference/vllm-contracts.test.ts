// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dockerPullWithProgressWatchdog: vi.fn(),
}));

vi.mock("../adapters/docker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/docker")>()),
  dockerPullWithProgressWatchdog: mocks.dockerPullWithProgressWatchdog,
}));

import {
  assertVllmRegistryDigestRef,
  detectVllmProfile,
  pullImage,
  resolveVllmServedModelId,
  VLLM_IMAGES,
} from "./vllm";
import { VLLM_MODELS } from "./vllm-models";

beforeEach(() => vi.clearAllMocks());

describe("vLLM served route identity", () => {
  it("uses one safe served-model override and rejects ambiguous aliases (#6315)", () => {
    expect(resolveVllmServedModelId("catalog/model", [])).toBe("catalog/model");
    expect(resolveVllmServedModelId("catalog/model", ["--served-model-name", "served/model"])).toBe(
      "served/model",
    );
    expect(() =>
      resolveVllmServedModelId("catalog/model", [
        "--served-model-name",
        "served/one",
        "served/two",
      ]),
    ).toThrow("exactly one safe model ID");
  });
});

describe("managed vLLM image distribution boundary", () => {
  const digest = `sha256:${"a".repeat(64)}`;

  it("accepts repository-qualified immutable registry digests", () => {
    expect(() => assertVllmRegistryDigestRef(`vllm/vllm-openai@${digest}`)).not.toThrow();
    expect(() =>
      assertVllmRegistryDigestRef(`registry.example.test:5000/team/runtime@${digest}`),
    ).not.toThrow();
  });

  it.each([
    `sha256:${"a".repeat(64)}`,
    "vllm/vllm-openai:latest",
    `ubuntu@${digest}`,
    `vllm/vllm-openai@sha256:${"A".repeat(64)}`,
    `vllm/vllm-openai@${digest}suffix`,
    ` vllm/vllm-openai@${digest}`,
    `vllm/vllm-openai@${digest} `,
  ])("rejects an unpullable or mutable product image reference %j", (image) => {
    expect(() => assertVllmRegistryDigestRef(image)).toThrow(
      /pullable immutable registry reference/,
    );
  });

  it("keeps every shipped managed-vLLM image on a registry digest", () => {
    const platformRefs = Object.values(VLLM_IMAGES).flatMap((imageSet) =>
      Object.values(imageSet)
        .map((value) =>
          typeof value === "object" && value !== null && "ref" in value ? String(value.ref) : null,
        )
        .filter((ref): ref is string => ref !== null),
    );
    const runtimeRefs = VLLM_MODELS.map((model) => model.runtime?.image).filter(
      (ref): ref is string => typeof ref === "string",
    );
    const refs = new Set([...platformRefs, ...runtimeRefs]);

    expect(refs.size).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(() => assertVllmRegistryDigestRef(ref), ref).not.toThrow();
    }
  });

  it("refuses a local image ID before invoking Docker pull", async () => {
    const profile = {
      ...detectVllmProfile({ platform: "station", type: "nvidia" })!,
      image: `sha256:${"a".repeat(64)}`,
    };

    await expect(pullImage(profile)).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining("Local image IDs"),
    });
    expect(mocks.dockerPullWithProgressWatchdog).not.toHaveBeenCalled();
  });
});
