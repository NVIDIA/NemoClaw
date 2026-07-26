// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  cleanupTrackedRebuildHermesImage,
  rebuildHermesRegistryImageState,
  requireRebuildHermesInitialImageTag,
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

  it("retains the exact OpenShell-derived tag in managed rebuild state", () => {
    expect(
      rebuildHermesRegistryImageState(
        [
          "Successfully tagged openshell/sandbox-from:1784010200",
          "  Built image openshell/sandbox-from:1784010200",
        ].join("\n"),
      ),
    ).toEqual({
      imageTag: "openshell/sandbox-from:1784010200",
      fromDockerfile: null,
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
