// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  cleanupTrackedRebuildHermesImage,
  rebuildHermesRegistryImageState,
  requireRebuildHermesFinalImageRef,
  requireRebuildHermesReplacementLifecycleReceipt,
  verifyRebuildHermesManagedImageIdentity,
} from "../live/rebuild-hermes-image-state.ts";

describe("Hermes rebuild fixture image ownership", () => {
  it("runs exact-tag cleanup only after a fixture image is tracked", async () => {
    const remove = vi.fn(async (_imageTag: string) => undefined);

    await cleanupTrackedRebuildHermesImage(null, remove);
    expect(remove).not.toHaveBeenCalled();

    await cleanupTrackedRebuildHermesImage("openshell/sandbox-from:1784010200", remove);
    expect(remove).toHaveBeenCalledExactlyOnceWith("openshell/sandbox-from:1784010200");
  });

  it("accepts only an immutable managed image or local image owned by the fixture sandbox", () => {
    const sandboxName = "e2e-rebuild-hermes-123";
    const localImageRef = `nemoclaw-sandbox-local:${sandboxName}-1784010000`;
    const managedImageRef = `ghcr.io/nvidia/nemoclaw/hermes-sandbox@sha256:${"a".repeat(64)}`;

    expect(requireRebuildHermesFinalImageRef(localImageRef, sandboxName)).toBe(localImageRef);
    expect(requireRebuildHermesFinalImageRef(managedImageRef, sandboxName)).toBe(managedImageRef);
    expect(() => requireRebuildHermesFinalImageRef(undefined, sandboxName)).toThrow("<missing>");
    expect(() =>
      requireRebuildHermesFinalImageRef(
        "nemoclaw-sandbox-local:another-sandbox-1784010000",
        sandboxName,
      ),
    ).toThrow("owned");
    expect(() =>
      requireRebuildHermesFinalImageRef(
        `nemoclaw-sandbox-local:${sandboxName}-base-1784010000`,
        sandboxName,
      ),
    ).toThrow("owned");
    expect(() =>
      requireRebuildHermesFinalImageRef(
        `ghcr.io/nvidia/nemoclaw/openclaw-sandbox@sha256:${"a".repeat(64)}`,
        sandboxName,
      ),
    ).toThrow("immutable");
    expect(() =>
      requireRebuildHermesFinalImageRef(
        "ghcr.io/nvidia/nemoclaw/hermes-sandbox:latest",
        sandboxName,
      ),
    ).toThrow("immutable");
  });

  it("requires the replacement registry row to carry its journaled live identity", () => {
    const receipt = {
      lifecycleGeneration: "5f63a0a3-e0f0-4e41-847b-8bc7c1f135ad",
      lifecycleLiveIdentityFingerprint: "a".repeat(64),
    };

    expect(requireRebuildHermesReplacementLifecycleReceipt(receipt)).toEqual(receipt);
    expect(() => requireRebuildHermesReplacementLifecycleReceipt({})).toThrow(
      "lifecycle generation",
    );
    expect(() =>
      requireRebuildHermesReplacementLifecycleReceipt({
        ...receipt,
        lifecycleGeneration: "5f63a0a3-e0f0-1e41-847b-8bc7c1f135ad",
      }),
    ).toThrow("lifecycle generation");
    expect(() =>
      requireRebuildHermesReplacementLifecycleReceipt({
        ...receipt,
        lifecycleLiveIdentityFingerprint: "unproven",
      }),
    ).toThrow("live lifecycle identity");
  });

  it("binds the running managed image to its exact immutable registry receipt", () => {
    const reference = `ghcr.io/nvidia/nemoclaw/hermes-sandbox@sha256:${"a".repeat(64)}`;
    const inspect = JSON.stringify({
      Id: `sha256:${"b".repeat(64)}`,
      RepoDigests: [reference],
      Os: "linux",
      Architecture: "amd64",
    });

    expect(verifyRebuildHermesManagedImageIdentity(reference, inspect)).toEqual({
      lane: "managed-image",
      reference,
      imageId: `sha256:${"b".repeat(64)}`,
      os: "linux",
      architecture: "amd64",
      repoDigestVerified: true,
    });
    expect(() =>
      verifyRebuildHermesManagedImageIdentity(
        `ghcr.io/nvidia/nemoclaw/hermes-sandbox@sha256:${"c".repeat(64)}`,
        inspect,
      ),
    ).toThrow("exact managed image receipt");
    expect(() => verifyRebuildHermesManagedImageIdentity(reference, "not-json")).toThrow(
      "not valid JSON",
    );
  });

  it("retains the exact OpenShell-derived tag in managed rebuild state", () => {
    expect(
      rebuildHermesRegistryImageState(
        [
          "Successfully tagged openshell/sandbox-from:1784010200",
          "  Built image openshell/sandbox-from:1784010200",
        ].join("\n"),
      ),
    ).toEqual({
      openshellDriver: "docker",
      imageTag: "openshell/sandbox-from:1784010200",
      fromDockerfile: null,
      workload: {
        schemaVersion: 1,
        kind: "legacy-dockerfile",
        reference: "openshell/sandbox-from:1784010200",
        shared: false,
      },
    });
  });

  it("rejects missing, fabricated, or non-fixture create tags", () => {
    expect(() => rebuildHermesRegistryImageState("Created sandbox fixture")).toThrow("<missing>");
    expect(() =>
      rebuildHermesRegistryImageState("Successfully tagged openshell/sandbox-from:latest"),
    ).toThrow("exact");
    expect(() =>
      rebuildHermesRegistryImageState("Successfully tagged unrelated/image:1784010200"),
    ).toThrow("exact");
  });
});
