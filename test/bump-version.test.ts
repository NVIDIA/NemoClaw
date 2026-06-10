// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { collectDocsVersionSegments, rewriteDocsPublicUrls } from "../scripts/bump-version";

describe("bump-version docs URL helpers", () => {
  it("rewrites latest and versioned docs URL segments while preserving suffix delimiters", () => {
    const content = [
      "See https://docs.nvidia.com/nemoclaw/latest/get-started/quickstart",
      "Query https://docs.nvidia.com/nemoclaw/0.0.60?view=all#install",
      "Markdown [docs](https://docs.nvidia.com/nemoclaw/0.0.59/)",
      "Leave https://docs.nvidia.com/nemoclaw/api/reference unchanged",
    ].join("\n");

    const result = rewriteDocsPublicUrls(content, "https://docs.nvidia.com/nemoclaw/0.0.61");

    expect(result.count).toBe(3);
    expect(result.updated).toContain(
      "https://docs.nvidia.com/nemoclaw/0.0.61/get-started/quickstart",
    );
    expect(result.updated).toContain("https://docs.nvidia.com/nemoclaw/0.0.61?view=all#install");
    expect(result.updated).toContain("https://docs.nvidia.com/nemoclaw/0.0.61/)");
    expect(result.updated).toContain("https://docs.nvidia.com/nemoclaw/api/reference");
  });

  it("reports no rewrites for non-version docs URL segments", () => {
    const content = "See https://docs.nvidia.com/nemoclaw/api/reference for generated API docs";

    const result = rewriteDocsPublicUrls(content, "https://docs.nvidia.com/nemoclaw/latest");

    expect(result.count).toBe(0);
    expect(result.updated).toBe(content);
  });

  it("collects docs URL segments for release verification", () => {
    const content = [
      "https://docs.nvidia.com/nemoclaw/latest/",
      "https://docs.nvidia.com/nemoclaw/0.0.60?view=all",
      "https://docs.nvidia.com/nemoclaw/api/reference",
    ].join("\n");

    expect(collectDocsVersionSegments(content)).toEqual(["latest", "0.0.60", "api"]);
  });
});
