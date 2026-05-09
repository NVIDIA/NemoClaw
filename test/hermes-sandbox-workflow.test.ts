// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");

describe("Hermes sandbox image workflow", () => {
  it("checks the current generated config path copied into the image", () => {
    const workflow = fs.readFileSync(
      path.join(repoRoot, ".github/workflows/sandbox-images-and-e2e.yaml"),
      "utf8",
    );

    expect(workflow).toContain("test -r /opt/nemoclaw-hermes-config/generate-config.ts");
    expect(workflow).not.toContain("/opt/nemoclaw-generate-config.ts");
  });
});
