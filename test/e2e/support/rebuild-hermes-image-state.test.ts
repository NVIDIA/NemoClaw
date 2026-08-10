// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  cleanupTrackedRebuildHermesImage,
  rebuildHermesRegistryImageState,
  requireRebuildHermesInitialImageTag,
  requireRebuildHermesReplacementLifecycleReceipt,
} from "../live/rebuild-hermes-image-state.ts";

describe("Hermes rebuild fixture image ownership", () => {
  it("runs exact-tag cleanup only after a fixture image is tracked", async () => {
    const remove = vi.fn(async (_imageTag: string) => undefined);

    await cleanupTrackedRebuildHermesImage(null, remove);
    expect(remove).not.toHaveBeenCalled();

    await cleanupTrackedRebuildHermesImage("openshell/sandbox-from:1784010200", remove);
    expect(remove).toHaveBeenCalledExactlyOnceWith("openshell/sandbox-from:1784010200");
  });

  it("accepts only the initial local image owned by the fixture sandbox", () => {
    const sandboxName = "e2e-rebuild-hermes-123";
    const imageTag = `nemoclaw-sandbox-local:${sandboxName}-1784010000`;

    expect(requireRebuildHermesInitialImageTag(imageTag, sandboxName)).toBe(imageTag);
    expect(() => requireRebuildHermesInitialImageTag(undefined, sandboxName)).toThrow("<missing>");
    expect(() =>
      requireRebuildHermesInitialImageTag(
        "nemoclaw-sandbox-local:another-sandbox-1784010000",
        sandboxName,
      ),
    ).toThrow("owned");
    expect(() =>
      requireRebuildHermesInitialImageTag(
        `nemoclaw-sandbox-local:${sandboxName}-base-1784010000`,
        sandboxName,
      ),
    ).toThrow("owned");
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
