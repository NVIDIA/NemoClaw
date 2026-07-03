// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  buildFernPreviewArgs,
  DEFAULT_FERN_PREVIEW_INSTANCE,
  resolveFernPreviewInstance,
} from "../scripts/fern-preview-config";

describe("Fern preview configuration", () => {
  it("uses the staging docs instance when no override is provided", () => {
    expect(resolveFernPreviewInstance(undefined)).toBe(DEFAULT_FERN_PREVIEW_INSTANCE);
  });

  it("trims and accepts a valid hostname/path override", () => {
    expect(resolveFernPreviewInstance("  preview.docs.buildwithfern.com/nemoclaw  ")).toBe(
      "preview.docs.buildwithfern.com/nemoclaw",
    );
  });

  it.each([
    "",
    "   ",
    "--help",
    "preview.docs.buildwithfern.com",
    "preview.docs.buildwithfern.com/my docs",
    "https://preview.docs.buildwithfern.com/nemoclaw",
    "preview.docs.buildwithfern.com/nemoclaw?draft=true",
    "preview.docs.buildwithfern.com/nemoclaw#draft",
    "preview.docs.buildwithfern.com/../nemoclaw",
  ])("rejects an invalid explicit instance override: %j", (value) => {
    expect(() => resolveFernPreviewInstance(value)).toThrow(
      "FERN_STAGING_INSTANCE must use the Fern <hostname>/<path> format",
    );
  });

  it("builds the Fern preview arguments in the required order", () => {
    expect(
      buildFernPreviewArgs({
        fernVersion: "3.67.1",
        instance: "preview.docs.buildwithfern.com/nemoclaw",
        previewId: "fix-docs-preview",
      }),
    ).toEqual([
      "--yes",
      "fern-api@3.67.1",
      "generate",
      "--docs",
      "--instance",
      "preview.docs.buildwithfern.com/nemoclaw",
      "--preview",
      "--id",
      "fix-docs-preview",
      "--force",
    ]);
  });
});
