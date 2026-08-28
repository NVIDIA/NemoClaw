// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { managedImagePublicationRequired } from "../../../tools/e2e/pr-managed-image-publication.mts";

describe("PR managed-image source selection", () => {
  it("matches only reviewed image input paths", () => {
    const patterns = ["Dockerfile", "agents/**", "src/lib/actions/sandbox/mcp-bridge-*.ts"];

    expect(managedImagePublicationRequired(["Dockerfile"], patterns)).toBe(true);
    expect(managedImagePublicationRequired(["agents/hermes/Dockerfile"], patterns)).toBe(true);
    expect(
      managedImagePublicationRequired(
        ["src/lib/actions/sandbox/mcp-bridge-adapter-openclaw.ts"],
        patterns,
      ),
    ).toBe(true);
    expect(managedImagePublicationRequired(["docs/My Guide.md"], patterns)).toBe(false);
    expect(() =>
      managedImagePublicationRequired(["src/lib/onboard/file.ts\nother"], patterns),
    ).toThrow("changed-file path is invalid");
  });
});
