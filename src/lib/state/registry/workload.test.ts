// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import * as configIo from "../config-io";
import { load, save } from "./persistence";
import type { SandboxWorkloadReceipt } from "./types";
import { cloneSandboxWorkloadReceipt } from "./workload";

function appliedWorkload(): Extract<SandboxWorkloadReceipt, { kind: "legacy-dockerfile" }> {
  return {
    schemaVersion: 1,
    kind: "legacy-dockerfile",
    reference: "custom-hermes:build-1",
    shared: false,
    platformProof: {
      schemaVersion: 1,
      source: "applied-image-inspect",
      sandboxName: "alpha",
      sandboxIdentityFingerprint: "a".repeat(64),
      reference: "custom-hermes:build-1",
      runtimeImageContentId: `sha256:${"b".repeat(64)}`,
      platform: "linux/amd64",
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("custom image platform receipt persistence", () => {
  it("retains applied image proof through registry save and load (#10435)", () => {
    const read = vi.spyOn(configIo, "readConfigFile").mockReturnValue({});
    const write = vi.spyOn(configIo, "writeConfigFile").mockImplementation(() => {});
    const workload = appliedWorkload();
    save({
      defaultSandbox: "alpha",
      sandboxes: { alpha: { name: "alpha", workload } },
    });
    const serialized = write.mock.calls[0]?.[1];
    read.mockReturnValue(JSON.parse(JSON.stringify(serialized)));
    expect(load().sandboxes.alpha?.workload).toEqual(workload);
    expect(load().sandboxes.alpha?.workload).not.toBe(workload);
  });

  it("keeps a legacy receipt without inferred platform proof (#10435)", () => {
    const { platformProof: _proof, ...legacy } = appliedWorkload();
    expect(cloneSandboxWorkloadReceipt(legacy)).toEqual(legacy);
  });

  it("rejects accessor proof fields without evaluating them (#10435)", () => {
    const workload = appliedWorkload();
    const readPlatform = vi.fn(() => "linux/amd64");
    const platformProof = { ...workload.platformProof };
    Object.defineProperty(platformProof, "platform", { enumerable: true, get: readPlatform });
    expect(
      cloneSandboxWorkloadReceipt({ ...workload, platformProof } as SandboxWorkloadReceipt),
    ).toBeUndefined();
    expect(readPlatform).not.toHaveBeenCalled();
  });

  it.each(["load", "save"] as const)(
    "rejects mismatched image proof during registry %s (#10435)",
    (operation) => {
      const workload = appliedWorkload();
      const invalid = {
        ...workload,
        platformProof: { ...workload.platformProof!, reference: "different-image" },
      };
      const registry = {
        defaultSandbox: "alpha",
        sandboxes: { alpha: { name: "alpha", workload: invalid } },
      };
      vi.spyOn(configIo, "readConfigFile").mockReturnValue(registry);
      const write = vi.spyOn(configIo, "writeConfigFile").mockImplementation(() => {});
      expect(() => (operation === "load" ? load() : save(registry))).toThrow(
        "invalid workload receipt",
      );
      expect(write).not.toHaveBeenCalled();
    },
  );
});
