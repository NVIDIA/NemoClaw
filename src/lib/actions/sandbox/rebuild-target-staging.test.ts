// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  createRebuildProviderReconfigureHandoff,
  type RegistryInferenceRoute,
  validateRebuildProviderReconfigureHandoff,
} from "../../onboard/rebuild-route-handoff";
import type { SandboxBaseImageResolutionMetadata } from "../../sandbox-base-image";
import type { RebuildSandboxEntry } from "./rebuild-flow-helpers";
import { prepareRebuildRecreateOptions } from "./rebuild-target-staging";

const SANDBOX_ENTRY = {
  name: "alpha",
  dashboardPort: 18789,
  gatewayName: "nemoclaw",
  gatewayPort: 8080,
} as RebuildSandboxEntry;

const REGISTRY_ROUTE: RegistryInferenceRoute = {
  provider: "compatible-endpoint",
  model: "nvidia/model",
  endpointUrl: "https://inference.example.test/v1",
  preferredInferenceApi: "openai-completions",
  source: "registry",
};

const BASE_IMAGE_RESOLUTION_HINT: SandboxBaseImageResolutionMetadata = {
  schema: 1,
  key: "base-resolution-key",
  imageName: "ghcr.io/nvidia/nemoclaw/sandbox-base",
  ref: "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:abc",
  digest: "sha256:abc",
  source: "version-tag",
  imageId: "sha256:image",
  os: "linux",
  architecture: "amd64",
  glibcVersion: "2.41",
  requireOpenshellSandboxAbi: true,
  minGlibcVersion: "2.39",
};

const bail = (message: string): never => {
  throw new Error(message);
};

describe("prepareRebuildRecreateOptions", () => {
  it("binds provider reconfiguration authority to the exact rebuild target (#6114)", () => {
    const handoff = createRebuildProviderReconfigureHandoff({
      sandboxName: "alpha",
      provider: "compatible-endpoint",
      model: "nvidia/model",
      credentialEnv: "COMPATIBLE_API_KEY",
      endpointUrl: "https://inference.example.test/v1",
    });

    expect(Object.isFrozen(handoff)).toBe(true);
    expect(validateRebuildProviderReconfigureHandoff(handoff, handoff)).toBe(true);
    expect(() =>
      validateRebuildProviderReconfigureHandoff(handoff, {
        ...handoff,
        endpointUrl: "https://other.example.test/v1",
      }),
    ).toThrow("does not match the authoritative target");
  });

  it("carries the immutable pre-delete registry route into the one-shot onboard call", () => {
    const options = prepareRebuildRecreateOptions(
      "alpha",
      SANDBOX_ENTRY,
      "openclaw",
      null,
      REGISTRY_ROUTE,
      true,
      BASE_IMAGE_RESOLUTION_HINT,
      bail,
    );

    expect(options?.baseImageResolutionHint).toBe(BASE_IMAGE_RESOLUTION_HINT);
    expect(options?.rebuildRegistryInferenceRoute).toEqual({
      sandboxName: "alpha",
      route: REGISTRY_ROUTE,
    });
    expect(options?.rebuildRegistryInferenceRoute?.route).not.toBe(REGISTRY_ROUTE);
    expect(Object.isFrozen(options?.rebuildRegistryInferenceRoute)).toBe(true);
    expect(Object.isFrozen(options?.rebuildRegistryInferenceRoute?.route)).toBe(true);
  });

  it("omits registry authority when preflight did not produce a complete registry route", () => {
    const options = prepareRebuildRecreateOptions(
      "alpha",
      SANDBOX_ENTRY,
      "openclaw",
      null,
      null,
      true,
      null,
      bail,
    );

    expect(options?.baseImageResolutionHint).toBeNull();
    expect(options).not.toHaveProperty("rebuildRegistryInferenceRoute");
  });
});
