// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("exec approvals path regression guard", () => {
  it("Dockerfile.base patches OpenClaw exec approvals JSON path to .openclaw-data", () => {
    const dockerfileBase = path.join(import.meta.dirname, "..", "Dockerfile.base");
    const src = fs.readFileSync(dockerfileBase, "utf-8");

    expect(src).toContain("exec-approvals-*.js");
    expect(src).toContain("exec-approvals-effective-*.js");
    expect(src).toContain("~/.openclaw/exec-approvals.json");
    expect(src).toContain("~/.openclaw-data/exec-approvals.json");
  });
});
