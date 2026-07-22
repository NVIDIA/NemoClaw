// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type {
  ProviderRecoveryReceipt,
  RegistryInferenceRoute,
} from "../../onboard/rebuild-route-handoff";
import type { SandboxBaseImageResolutionMetadata } from "../../sandbox-base-image";
import {
  stageRebuildBaseImageResolutionHandoff,
  stageRegistryProviderRecoveryReceipt,
} from "./rebuild-preflight-target-phase";

const target = {
  sandboxName: "alpha",
  gatewayName: "nemoclaw",
  provider: "compatible-endpoint",
  model: "nvidia/model",
};

const registryRoute: RegistryInferenceRoute = {
  provider: target.provider,
  model: target.model,
  endpointUrl: "https://inference.example.test/v1",
  endpointSource: null,
  preferredInferenceApi: "openai-completions",
  source: "registry",
};

describe("stageRegistryProviderRecoveryReceipt", () => {
  it("leaves recovery authority absent without a registry-derived route", () => {
    const recreateOptions: { providerRecoveryReceipt?: ProviderRecoveryReceipt } = {};

    stageRegistryProviderRecoveryReceipt(recreateOptions, target, null, {
      nonce: "nonce-without-route",
      expiresAtMs: 1_000,
    });

    expect(recreateOptions).not.toHaveProperty("providerRecoveryReceipt");
  });

  it("binds recovery authority to the captured registry route", () => {
    const recreateOptions: { providerRecoveryReceipt?: ProviderRecoveryReceipt } = {};

    stageRegistryProviderRecoveryReceipt(recreateOptions, target, registryRoute, {
      nonce: "nonce-with-route",
      expiresAtMs: 1_000,
    });

    expect(recreateOptions.providerRecoveryReceipt).toEqual({
      ...target,
      route: registryRoute,
      nonce: "nonce-with-route",
      expiresAtMs: 1_000,
      sessionId: null,
    });
  });
});

describe("stageRebuildBaseImageResolutionHandoff", () => {
  it("binds outer resolver provenance to its immutable local handoff (#7144)", () => {
    const imageId = `sha256:${"a".repeat(64)}`;
    const current = { key: "current", imageId } as SandboxBaseImageResolutionMetadata;
    const recreateOptions: { preResolvedBaseImageMetadata?: SandboxBaseImageResolutionMetadata } =
      {};

    stageRebuildBaseImageResolutionHandoff(recreateOptions, {
      ok: true,
      imageRef: `nemoclaw-hermes-sandbox-base-local:image-${"a".repeat(64)}`,
      overrideEnvVar: "NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF",
      resolutionMetadata: current,
    });

    expect(recreateOptions.preResolvedBaseImageMetadata).toBe(current);
  });

  it("binds provenance to a temporary immutable rebuild handoff (#7144)", () => {
    const imageId = `sha256:${"a".repeat(64)}`;
    const current = { key: "current", imageId } as SandboxBaseImageResolutionMetadata;
    const recreateOptions: { preResolvedBaseImageMetadata?: SandboxBaseImageResolutionMetadata } =
      {};

    stageRebuildBaseImageResolutionHandoff(recreateOptions, {
      ok: true,
      imageRef: `nemoclaw-hermes-sandbox-base-local:rebuild-123-${"b".repeat(16)}-image-${"a".repeat(64)}`,
      overrideEnvVar: "NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF",
      resolutionMetadata: current,
    });

    expect(recreateOptions.preResolvedBaseImageMetadata).toBe(current);
  });

  it("binds provenance to the exact immutable remote rebuild handoff (#7144)", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const imageRef = `ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@${digest}`;
    const current = {
      key: "current",
      imageName: "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base",
      imageId: `sha256:${"b".repeat(64)}`,
      ref: imageRef,
      digest,
      source: "pinned",
    } as SandboxBaseImageResolutionMetadata;
    const recreateOptions: { preResolvedBaseImageMetadata?: SandboxBaseImageResolutionMetadata } =
      {};

    stageRebuildBaseImageResolutionHandoff(recreateOptions, {
      ok: true,
      imageRef,
      overrideEnvVar: "NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF",
      resolutionMetadata: current,
    });

    expect(recreateOptions.preResolvedBaseImageMetadata).toBe(current);
  });

  it("rejects provenance that is not bound to the immutable local handoff", () => {
    const current = {
      key: "current",
      imageId: `sha256:${"a".repeat(64)}`,
    } as SandboxBaseImageResolutionMetadata;
    const recreateOptions: { preResolvedBaseImageMetadata?: SandboxBaseImageResolutionMetadata } =
      {};

    expect(() =>
      stageRebuildBaseImageResolutionHandoff(recreateOptions, {
        ok: true,
        imageRef: `nemoclaw-hermes-sandbox-base-local:image-${"b".repeat(64)}`,
        overrideEnvVar: "NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF",
        resolutionMetadata: current,
      }),
    ).toThrow("provenance did not match its immutable handoff");
  });
});
