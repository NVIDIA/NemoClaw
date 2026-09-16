// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { resolveSandboxImageTagFromCreateOutput, SANDBOX_IMAGE_REPOS } from "./image-tag";

describe("resolveSandboxImageTagFromCreateOutput", () => {
  /** Changing the publication authority must not hide older images from orphan cleanup. */
  it("keeps current and legacy Portable repositories eligible for orphan cleanup", () => {
    expect(SANDBOX_IMAGE_REPOS).toContain("127.0.0.1:5000/nemoclaw-sandbox-local");
    expect(SANDBOX_IMAGE_REPOS).toContain("localhost:5000/nemoclaw-sandbox-local");
  });
  it("uses the sandbox image tag reported by OpenShell create output", () => {
    const warn = vi.fn();

    expect(
      resolveSandboxImageTagFromCreateOutput(
        "Uploaded\nBuilt image openshell/sandbox-from:1776766054\nCreated sandbox alpha",
        "1776766054999",
        warn,
      ),
    ).toBe("openshell/sandbox-from:1776766054");
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to the millisecond build id when OpenShell output omits the image tag", () => {
    const warn = vi.fn();

    expect(
      resolveSandboxImageTagFromCreateOutput("Created sandbox alpha", "1776766054999", warn),
    ).toBe("openshell/sandbox-from:1776766054999");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not parse image tag"));
  });
});
