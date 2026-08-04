// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { SandboxEntry } from "../../state/registry";
import { retireReplacedSandboxWorkload } from "../sandbox-recreate-transaction";
import { createDockerRuntimeProviderBundle } from "./docker";
import { createRuntimeProviderBundleRegistry } from "./registry";

const SOURCE_IMAGE = "openshell/sandbox-from:old";
const REPLACEMENT_IMAGE = "openshell/sandbox-from:new";
const TARGET_IDENTITY = "target-identity";

function entry(imageTag: string, generation: string): SandboxEntry {
  return {
    name: "alpha",
    imageTag,
    workload: {
      schemaVersion: 1,
      kind: "legacy-dockerfile",
      reference: imageTag,
      shared: false,
    },
    lifecycleGeneration: generation,
    lifecycleLiveIdentityFingerprint: `${generation}-identity`,
  } as SandboxEntry;
}

type DockerRuntimeProviderOverrides = NonNullable<
  Parameters<typeof createDockerRuntimeProviderBundle>[0]
>;
type DockerRemoveImage = NonNullable<DockerRuntimeProviderOverrides["removeImage"]>;

function providers(removeImage: DockerRemoveImage) {
  return createRuntimeProviderBundleRegistry([
    ["docker", createDockerRuntimeProviderBundle({ removeImage })],
  ]);
}

describe("same-name replacement workload cleanup", () => {
  it("removes the obsolete owned image after the replacement identity is registered", () => {
    const removeImage = vi.fn(() => ({ status: 0 }));

    expect(
      retireReplacedSandboxWorkload(
        "alpha",
        "target",
        TARGET_IDENTITY,
        entry(SOURCE_IMAGE, "source"),
        entry(REPLACEMENT_IMAGE, "target"),
        {
          runtimeProviders: providers(removeImage),
        },
      ),
    ).toEqual({
      status: "removed",
      engineDisplayName: "Docker",
      reference: SOURCE_IMAGE,
    });
    expect(removeImage).toHaveBeenCalledExactlyOnceWith(SOURCE_IMAGE, expect.any(Object));
  });

  it("does not remove an image reused by the registered replacement", () => {
    const removeImage = vi.fn(() => ({ status: 0 }));

    expect(
      retireReplacedSandboxWorkload(
        "alpha",
        "target",
        TARGET_IDENTITY,
        entry(SOURCE_IMAGE, "source"),
        entry(SOURCE_IMAGE, "target"),
        {
          runtimeProviders: providers(removeImage),
        },
      ),
    ).toEqual({ status: "skipped", reason: "image-reused" });
    expect(removeImage).not.toHaveBeenCalled();
  });

  it("retains a source workload recorded as shared", () => {
    const removeImage = vi.fn(() => ({ status: 0 }));
    const recordedSource = entry(SOURCE_IMAGE, "source");
    const source = {
      ...recordedSource,
      workload: { ...recordedSource.workload, shared: true },
    } as unknown as SandboxEntry;

    expect(
      retireReplacedSandboxWorkload(
        "alpha",
        "target",
        TARGET_IDENTITY,
        source,
        entry(REPLACEMENT_IMAGE, "target"),
        { runtimeProviders: providers(removeImage) },
      ),
    ).toEqual({ status: "skipped", reason: "shared-image" });
    expect(removeImage).not.toHaveBeenCalled();
  });

  it("does not remove the source image before replacement registration is proven", () => {
    const removeImage = vi.fn(() => ({ status: 0 }));
    const { lifecycleLiveIdentityFingerprint: _identity, ...replacement } = entry(
      REPLACEMENT_IMAGE,
      "target",
    );

    expect(
      retireReplacedSandboxWorkload(
        "alpha",
        "target",
        TARGET_IDENTITY,
        entry(SOURCE_IMAGE, "source"),
        replacement,
        { runtimeProviders: providers(removeImage) },
      ),
    ).toEqual({ status: "skipped", reason: "replacement-unproven" });
    expect(removeImage).not.toHaveBeenCalled();
  });

  it("does not trust a same-name registry row from another replacement generation", () => {
    const removeImage = vi.fn(() => ({ status: 0 }));

    expect(
      retireReplacedSandboxWorkload(
        "alpha",
        "expected-target",
        "foreign-target-identity",
        entry(SOURCE_IMAGE, "source"),
        entry(REPLACEMENT_IMAGE, "foreign-target"),
        { runtimeProviders: providers(removeImage) },
      ),
    ).toEqual({ status: "skipped", reason: "replacement-unproven" });
    expect(removeImage).not.toHaveBeenCalled();
  });

  it("does not trust a replacement whose live identity differs from the journal", () => {
    const removeImage = vi.fn(() => ({ status: 0 }));

    expect(
      retireReplacedSandboxWorkload(
        "alpha",
        "target",
        "different-target-identity",
        entry(SOURCE_IMAGE, "source"),
        entry(REPLACEMENT_IMAGE, "target"),
        { runtimeProviders: providers(removeImage) },
      ),
    ).toEqual({ status: "skipped", reason: "replacement-unproven" });
    expect(removeImage).not.toHaveBeenCalled();
  });

  it("skips image cleanup only for expected provider-selection failures", () => {
    const removeImage = vi.fn(() => ({ status: 0 }));

    expect(
      retireReplacedSandboxWorkload(
        "alpha",
        "target",
        TARGET_IDENTITY,
        entry(SOURCE_IMAGE, "source"),
        entry(REPLACEMENT_IMAGE, "target"),
        { runtimeProviders: {} },
      ),
    ).toEqual({ status: "skipped", reason: "authority-unproven" });
    expect(removeImage).not.toHaveBeenCalled();
  });

  it("does not hide unexpected provider registry failures", () => {
    const brokenProviders = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => {
          throw new TypeError("broken provider registry");
        },
      },
    );

    expect(() =>
      retireReplacedSandboxWorkload(
        "alpha",
        "target",
        TARGET_IDENTITY,
        entry(SOURCE_IMAGE, "source"),
        entry(REPLACEMENT_IMAGE, "target"),
        { runtimeProviders: brokenProviders },
      ),
    ).toThrow(/broken provider registry/u);
  });
});
