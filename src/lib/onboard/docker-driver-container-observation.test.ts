// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { findLabeledSandboxContainers } from "./docker-driver-container-observation";

describe("findLabeledSandboxContainers", () => {
  it("parses labeled running and stopped containers", () => {
    expect(
      findLabeledSandboxContainers("e2e-x", {
        dockerCapture: () =>
          "openshell-e2e-x\tUp 2 hours\n" +
          "openshell-e2e-x-nemoclaw-gpu-backup-1\tExited (0) 10 minutes ago\n",
      }),
    ).toEqual([
      { name: "openshell-e2e-x", status: "Up 2 hours", running: true },
      {
        name: "openshell-e2e-x-nemoclaw-gpu-backup-1",
        status: "Exited (0) 10 minutes ago",
        running: false,
      },
    ]);
  });

  it("returns no rows for an empty observation", () => {
    expect(findLabeledSandboxContainers("e2e-x", { dockerCapture: () => "" })).toEqual([]);
  });

  it("can propagate an observation failure instead of reporting absence", () => {
    expect(() =>
      findLabeledSandboxContainers("e2e-x", {
        ignoreError: false,
        dockerCapture: (_args, options) => {
          expect(options?.ignoreError).toBe(false);
          throw new Error("Docker observation failed");
        },
      }),
    ).toThrow("Docker observation failed");
  });
});
