// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const DOCKERFILE_BASE = path.join(import.meta.dirname, "..", "Dockerfile.base");

describe("sandbox base image packages", () => {
  it("pins GitHub CLI in apt install list", () => {
    const dockerfile = fs.readFileSync(DOCKERFILE_BASE, "utf-8");
    expect(dockerfile).toMatch(/\bgh=2\.23\.0\+dfsg1-1\b/);
  });
});
