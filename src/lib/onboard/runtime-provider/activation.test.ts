// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { createInMemoryRuntimeProviderBundle } from "../../../../test/helpers/runtime-provider-bundle";
import {
  createRuntimeProviderActivationCatalog,
  RUNTIME_PROVIDER_ACTIVATION_CONTRACT_VERSION,
  type RuntimeProviderActivationRegistration,
} from "./activation";
import { CURRENT_RUNTIME_PROVIDER_BUNDLES } from "./current";

function registration(providerId: string): RuntimeProviderActivationRegistration {
  return {
    declaration: {
      contractVersion: RUNTIME_PROVIDER_ACTIVATION_CONTRACT_VERSION,
      providerId,
    },
    bundle: createInMemoryRuntimeProviderBundle({
      providerId,
      workloadProfile: {
        support: null,
        hostArchitectures: [],
        managedImageSelectionPolicy: "prefer-managed",
        legacyDockerfileBuilds: true,
      },
    }),
  };
}

describe("runtime provider activation catalog", () => {
  it("indexes generic provider bundles without changing production selection (#9143)", () => {
    const activations = [
      registration("podman-rootful"),
      registration("podman-rootless"),
      registration("mxc"),
    ];
    const catalog = createRuntimeProviderActivationCatalog(activations);

    expect(Object.keys(catalog)).toEqual(["podman-rootful", "podman-rootless", "mxc"]);
    expect(Object.isFrozen(catalog.mxc?.declaration)).toBe(true);
    expect(Object.isFrozen(catalog.mxc?.bundle)).toBe(true);
    expect(CURRENT_RUNTIME_PROVIDER_BUNDLES).not.toHaveProperty("podman-rootful");
    expect(CURRENT_RUNTIME_PROVIDER_BUNDLES).not.toHaveProperty("podman-rootless");
    expect(CURRENT_RUNTIME_PROVIDER_BUNDLES).not.toHaveProperty("mxc");
  });

  it("rejects a declaration that does not match its provider bundle (#9143)", () => {
    const mismatch = registration("mxc");
    expect(() =>
      createRuntimeProviderActivationCatalog([
        {
          ...mismatch,
          declaration: { ...mismatch.declaration, providerId: "podman-rootless" },
        },
      ]),
    ).toThrow("does not match a valid contract-v1 identity");
  });

  it("rejects a malformed activation declaration (#9143)", () => {
    const malformed = {
      ...registration("mxc"),
      declaration: null,
    } as unknown as RuntimeProviderActivationRegistration;

    expect(() => createRuntimeProviderActivationCatalog([malformed])).toThrow(
      "declaration identity is malformed",
    );
  });

  it("rejects duplicate activation identities (#9143)", () => {
    expect(() =>
      createRuntimeProviderActivationCatalog([registration("mxc"), registration("mxc")]),
    ).toThrow("duplicate provider identity 'mxc'");
  });
});
